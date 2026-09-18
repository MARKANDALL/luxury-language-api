// lib/image-crop.js
// Cut a normalized region out of a data-URI picture, server side.
//
// Exists so the vision model can be shown ONE target at a time, with nothing
// else in frame. Asking "does this box contain a parking ticket?" while the
// model can see the whole street invites it to agree, because a parking ticket
// IS in the picture; asking the same question of the crop alone does not.
//
// ffmpeg rather than a new image library, because ffmpeg is already a
// dependency of this backend and already proven in this runtime: routes/assess
// and routes/dictate both shell out to it through the same installer, with the
// same tmpdir pattern. Adding sharp for this would mean a native binary in the
// function bundle for a job the existing toolchain already does.

import ffmpeg from "fluent-ffmpeg";
import { cropWindow } from "./crop-window.js";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const SELF = "lib/image-crop.js";

// ── The source, written once ────────────────────────────────────────────────
//
// Every crop used to base64-decode the WHOLE picture and write it to disk
// again. A scan cuts one crop per instance — ten to forty of them — so a 3 MB
// phone photo was decoded and written forty times to produce forty thumbnails,
// and the decode is synchronous: it blocks the event loop, which quietly
// serializes the very crop checks the worker pool exists to run in parallel.
//
// So the source is written once and the file is reused. A one-entry cache
// rather than a handle threaded through every caller, because every call in a
// scan is for the same picture — the second entry would never be read.
let source = null;

async function sourceFile(dataUri) {
  if (source && source.uri === dataUri) return source.file;
  await releaseSource();
  const file = await writeTemp(dataUri);
  source = { uri: dataUri, file };
  return file;
}

/**
 * Drop the cached source. Call when a scan is done: the file is a real file,
 * and a serverless container that stays warm would otherwise keep the last
 * picture of every scan it ever served.
 */
export { cropWindow };

export async function releaseSource() {
  if (!source) return;
  const { file } = source;
  source = null;
  await fs.unlink(file).catch(() => {});
}

/**
 * Width and height of a data-URI image, read from its header.
 *
 * NO BINARY, and that is the whole fix. This used to be `ffmpeg.ffprobe`, and
 * ffprobe is a SEPARATE executable from ffmpeg. @ffmpeg-installer ships ffmpeg
 * and nothing else, and nothing here ever set an ffprobe path, so on Vercel the
 * call failed with "Cannot find ffprobe" on every scan. verifyTargets treats a
 * picture it cannot size as a picture it cannot check, and returned every
 * target unaudited: no crop check, no instance verdict, no tighten. It worked
 * on the development machine only because a system-wide FFmpeg install put
 * ffprobe on PATH there, so every proof ever taken of the crop check was taken
 * somewhere the host did not match.
 *
 * The file header above says ffmpeg is "already proven in this runtime", and
 * for the ffmpeg binary that is true: assess and dictate shell out to it. It
 * was never true of ffprobe.
 *
 * The four formats a conversation picture or a still can arrive in. Reported as
 * STORED, not as displayed, which is what ffprobe reported too: the crop that
 * follows is cut from the stored pixels. Anything unrecognised throws, and the
 * caller already knows what to do with a picture it cannot size.
 */
export async function imageSize(dataUri) {
  const comma = String(dataUri || "").indexOf(",");
  if (comma < 0) throw new Error("not a data uri");
  const b64 = dataUri.slice(comma + 1);
  // The header is near the front. A JPEG can carry an EXIF block with its own
  // thumbnail before the frame header, so the prefix is generous, and the
  // whole picture is decoded only when the prefix was not enough.
  const PREFIX = 262144; // base64 characters, a multiple of 4
  const head = headerSize(Buffer.from(b64.slice(0, PREFIX), "base64"));
  if (head) return head;
  const whole = b64.length > PREFIX ? headerSize(Buffer.from(b64, "base64")) : null;
  if (whole) return whole;
  throw new Error("could not read image dimensions from its header");
}

/** { w, h } from the bytes of a JPEG, PNG, GIF or WebP, or null. */
export function headerSize(buf) {
  if (!buf || buf.length < 12) return null;

  // PNG: an eight-byte signature, then IHDR, whose first fields are the size.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
  }

  // GIF: the logical screen size, little-endian, right after "GIF8xa".
  if (buf.toString("latin1", 0, 4) === "GIF8") {
    return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
  }

  // WebP: RIFF....WEBP, then one of three chunk layouts.
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8 " && buf.length >= 30) {
      return ok(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    }
    if (kind === "VP8L" && buf.length >= 25) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (kind === "VP8X" && buf.length >= 30) {
      return ok(1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    }
    return null;
  }

  // JPEG: walk the segments to the first start-of-frame, which holds the size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m === 0xff) { i += 1; continue; } // fill byte
      // Markers with no length field.
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m === 0xd9 || m === 0xda) return null; // end of image, or scan data: no frame header found
      const len = buf.readUInt16BE(i + 2);
      // Start-of-frame: C0 to CF except C4 (huffman), C8 (reserved) and CC (arithmetic).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return ok(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      }
      i += 2 + len;
    }
    return null;
  }

  return null;
}

function ok(w, h) {
  return w > 0 && h > 0 ? { w, h } : null;
}

async function writeTemp(dataUri) {
  const comma = String(dataUri || "").indexOf(",");
  if (comma < 0) throw new Error("not a data uri");
  const head = dataUri.slice(0, comma);
  const ext = /image\/(\w+)/.exec(head)?.[1] || "jpg";
  const file = path.join(
    tmpdir(),
    `lux_ispy_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext === "jpeg" ? "jpg" : ext}`,
  );
  await fs.writeFile(file, Buffer.from(dataUri.slice(comma + 1), "base64"));
  return file;
}

/**
 * The picture's region around `box`, padded, as a JPEG data URI.
 *
 * @param {string} dataUri the whole picture
 * @param {{x:number,y:number,w:number,h:number}} box normalized
 * @param {{w:number,h:number}} [size] the picture's pixel size, if already known
 * @returns {Promise<string|null>} data URI, or null when it could not be cut
 */
export async function cropRegion(dataUri, box, size) {
  let output = null;
  try {
    if (!dataUri || !box) return null;
    const dim = size || (await imageSize(dataUri));
    if (!dim?.w || !dim?.h) return null;

    const win = cropWindow(box, dim);
    if (!win) return null;
    const { x, y, w: cw, h: ch } = win;

    const input = await sourceFile(dataUri);
    output = path.join(tmpdir(), `lux_ispy_crop_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`);

    await new Promise((resolve, reject) => {
      ffmpeg(input)
        // UPSCALED, not merely capped. `min(512,iw)` left a small crop at its
        // own size, so a wedding ring cut out of a 1600px photo reached the
        // model as a 250px smear and came back "no wedding ring visible here".
        // Measured on the v13 sweep: nine of fifteen candidates died that way,
        // and the reasons named a nose, lips, an ear and a ring in a photograph
        // that plainly contains all four. A crop is looked at, never stored, so
        // upscaling costs one resample and buys the detail the answer needs.
        .outputOptions([`-vf crop=${cw}:${ch}:${x}:${y},scale=768:-1:flags=lanczos`, "-frames:v 1", "-q:v 4"])
        .on("end", resolve)
        .on("error", reject)
        .save(output);
    });

    const buf = await fs.readFile(output);
    if (!buf?.length) return null;
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn(`[${SELF}] crop failed:`, err?.message || err);
    return null;
  } finally {
    // The source is NOT unlinked here: it is the shared one, and the next crop
    // of this scan wants it. Only the cut-out is this call's to clean up.
    if (output) await fs.unlink(output).catch(() => {});
  }
}
