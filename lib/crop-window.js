// lib/crop-window.js
// Where a verification crop is actually cut from.
//
// Pure arithmetic, in its own file, because two very different callers need it
// and one of them must not drag ffmpeg in behind it. image-crop.js cuts the
// pixels; the targets route needs the same window to map a model's "the thing
// is over here in the crop" back into the picture, which is the whole of the
// v11 centring check. Two copies of this would drift, and a drift here reads as
// the model being wrong.

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

/**
 * The exact pixel window `cropRegion` cuts for a box.
 *
 * Pure, and exported, because the crop is PADDED and the padding is the whole
 * reason a displaced box could pass verification. The verifier asks the model
 * where in the crop the thing is; without this arithmetic that answer cannot be
 * mapped back to the picture, and a sliver of jacket sitting in the 55 percent
 * of context around a window's box reads as "yes, a jacket is here".
 *
 * @param {{x:number,y:number,w:number,h:number}} box normalized
 * @param {{w:number,h:number}} dim the picture's pixel size
 * @returns {{x:number,y:number,w:number,h:number}|null} in PIXELS
 */
export function cropWindow(box, dim) {
  if (!box || !dim?.w || !dim?.h) return null;
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
  return { x, y, w: cw, h: ch };
}
