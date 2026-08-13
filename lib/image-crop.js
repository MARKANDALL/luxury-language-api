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
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import path from "path";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const SELF = "lib/image-crop.js";

// Room around the box. A crop cut exactly to a bounding box shows the object
// with its edges shaved and nothing to place it by, which reads as a texture
// rather than a thing. Generous, and generous DOWNWARD in particular: a box
// drawn a little high on an object (the commonest way a box is wrong) still
// contains it once the crop reaches further below than above.
const PAD = 0.55;
const PAD_DOWN = 0.85;

// No crop smaller than this fraction of the shorter side. A 40px square blown
// up for a model to look at is a smear; the model then says "no" to a target
// that was fine, and the target is dropped for being unphotographable rather
// than for being wrong.
const MIN_FRACTION = 0.16;

/** width and height of a data-URI image, without decoding it fully. */
export async function imageSize(dataUri) {
  const file = await writeTemp(dataUri);
  try {
    return await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) return reject(err);
        const s = (data?.streams || []).find((x) => x.width && x.height);
        if (!s) return reject(new Error("no video stream in image"));
        resolve({ w: s.width, h: s.height });
      });
    });
  } finally {
    await fs.unlink(file).catch(() => {});
  }
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
  let input = null;
  let output = null;
  try {
    if (!dataUri || !box) return null;
    const dim = size || (await imageSize(dataUri));
    if (!dim?.w || !dim?.h) return null;

    const bw = box.w * dim.w;
    const bh = box.h * dim.h;
    let cw = bw * (1 + PAD * 2);
    let ch = bh * (1 + PAD + PAD_DOWN);
    const floor = Math.min(dim.w, dim.h) * MIN_FRACTION;
    cw = Math.max(cw, floor);
    ch = Math.max(ch, floor);
    cw = Math.min(Math.round(cw), dim.w);
    ch = Math.min(Math.round(ch), dim.h);

    // The extra room goes below the box, not around its centre, which is what
    // "extend downward when in doubt" means in pixels.
    const cx = (box.x + box.w / 2) * dim.w;
    const cy = (box.y + box.h / 2) * dim.h + (ch * (PAD_DOWN - PAD)) / (2 * (1 + PAD + PAD_DOWN));
    const x = Math.min(Math.max(Math.round(cx - cw / 2), 0), dim.w - cw);
    const y = Math.min(Math.max(Math.round(cy - ch / 2), 0), dim.h - ch);

    input = await writeTemp(dataUri);
    output = path.join(tmpdir(), `lux_ispy_crop_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`);

    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .outputOptions([`-vf crop=${cw}:${ch}:${x}:${y},scale='min(512,iw)':-1`, "-frames:v 1", "-q:v 4"])
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
    if (input) await fs.unlink(input).catch(() => {});
    if (output) await fs.unlink(output).catch(() => {});
  }
}
