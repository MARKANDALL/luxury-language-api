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

/** width and height of a data-URI image, without decoding it fully. */
export async function imageSize(dataUri) {
  const file = await sourceFile(dataUri);
  return await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      const s = (data?.streams || []).find((x) => x.width && x.height);
      if (!s) return reject(new Error("no video stream in image"));
      resolve({ w: s.width, h: s.height });
    });
  });
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
