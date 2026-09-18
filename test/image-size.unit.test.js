// test/image-size.unit.test.js
// imageSize reads the picture's header. It must not need a binary.
//
// It used to be ffmpeg.ffprobe, and ffprobe is a separate executable from
// ffmpeg. @ffmpeg-installer ships ffmpeg only, nothing set an ffprobe path, and
// on the Vercel host the call failed on every scan with "Cannot find ffprobe".
// verifyTargets cannot check a picture it cannot size, so production served
// every I Spy target unaudited: no crop check, no instance verdict, no tighten.
// Every local proof passed because this development machine has a system-wide
// FFmpeg on PATH.
//
// So these tests build the headers by hand, byte by byte, and the suite never
// touches a binary: a test that needed ffprobe to pass would be the same trap.
import { describe, it, expect } from "vitest";
import { headerSize, imageSize } from "../lib/image-crop.js";

const uri = (mime, buf) => `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;

function png(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// SOI, an APP0 segment, then a baseline frame header. The APP0 is there on
// purpose: the reader has to walk PAST a segment to find the size, which is the
// part a naive fixed-offset read gets wrong.
function jpeg(w, h, sof = 0xc0) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0", "latin1"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sofSeg = [0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Buffer.from([0xff, 0xd8, ...app0, ...sofSeg, 0xff, 0xd9]);
}

function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function webpX(w, h) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe("headerSize reads each format a picture arrives in", () => {
  // 731 x 419: unequal and odd, so a swapped width and height cannot pass.
  it("PNG", () => expect(headerSize(png(731, 419))).toEqual({ w: 731, h: 419 }));
  it("JPEG, walking past an APP0 segment", () => expect(headerSize(jpeg(731, 419))).toEqual({ w: 731, h: 419 }));
  it("JPEG, progressive frame (SOF2)", () => expect(headerSize(jpeg(1600, 900, 0xc2))).toEqual({ w: 1600, h: 900 }));
  it("GIF", () => expect(headerSize(gif(731, 419))).toEqual({ w: 731, h: 419 }));
  it("WebP (VP8X)", () => expect(headerSize(webpX(731, 419))).toEqual({ w: 731, h: 419 }));

  it("does not mistake a Huffman table (C4) for a frame header", () => {
    // C4 sits inside the C0..CF range that holds the frame headers. A reader
    // that took every Cx as a size would read table bytes as the dimensions.
    const dht = [0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02];
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, ...dht]), jpeg(640, 480).subarray(2)]);
    expect(headerSize(buf)).toEqual({ w: 640, h: 480 });
  });

  it("returns null for anything it does not recognise", () => {
    expect(headerSize(Buffer.from("not an image at all"))).toBe(null);
    expect(headerSize(Buffer.alloc(0))).toBe(null);
    expect(headerSize(null)).toBe(null);
  });
});

describe("imageSize, the call verifyTargets makes", () => {
  it("sizes a data URI with no binary on the path", async () => {
    await expect(imageSize(uri("image/png", png(1024, 768)))).resolves.toEqual({ w: 1024, h: 768 });
    await expect(imageSize(uri("image/jpeg", jpeg(1600, 900)))).resolves.toEqual({ w: 1600, h: 900 });
  });

  it("finds a frame header that sits beyond the fast-path prefix", async () => {
    // A phone JPEG can carry a large EXIF block, thumbnail included, in front of
    // the frame header. The prefix is a fast path, not a limit.
    const filler = [];
    for (let i = 0; i < 5; i++) {
      const seg = Buffer.alloc(65535 + 2);
      seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(65535, 2);
      filler.push(seg);
    }
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), ...filler, jpeg(4032, 3024).subarray(2)]);
    await expect(imageSize(uri("image/jpeg", buf))).resolves.toEqual({ w: 4032, h: 3024 });
  });

  it("throws on what it cannot read, which the caller already handles", async () => {
    await expect(imageSize("data:image/jpeg;base64,AAAA")).rejects.toThrow(/dimensions/);
    await expect(imageSize("not a data uri")).rejects.toThrow(/data uri/);
  });

  it("no longer calls ffprobe at all", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../lib/image-crop.js", import.meta.url), "utf8");
    // Code lines only: the doc comment names ffprobe to explain what it replaced.
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
    expect(code).not.toMatch(/ffprobe/);
  });
});
