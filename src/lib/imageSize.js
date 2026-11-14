// The pixel size of an image, read from its header without decoding it. A file can be tiny
// and still claim 30000×30000 pixels; decoding that would take gigabytes of memory.

/** @returns {{ width: number, height: number } | null}  null for an unknown or broken file */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null;
  // PNG: signature, then the IHDR chunk with width and height.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: the logical screen size, widened to the largest frame (see gifDimensions).
  if (buf.toString('ascii', 0, 3) === 'GIF') return gifDimensions(buf);
  // BMP: width and height in the info header (a negative height is a top-down bitmap).
  if (buf.length >= 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegDimensions(buf);
  // WebP: RIFF container with a VP8 (lossy), VP8L (lossless) or VP8X (extended) chunk.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8 ')
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

// The decoder draws the image-descriptor frames, not the logical screen, and a file can declare a
// 1×1 screen around a 6000×6000 frame. So report the largest of the screen and every frame
// descriptor reached by hopping over the data sub-blocks (linear, no decoding).
function gifDimensions(buf) {
  let width = buf.readUInt16LE(6);
  let height = buf.readUInt16LE(8);
  const flags = buf[10];
  let i = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  const skipSubBlocks = () => {
    while (i < buf.length && buf[i] !== 0) i += 1 + buf[i];
    i += 1; // the zero-length terminator
  };
  for (let blocks = 0; i < buf.length && blocks < 4096; blocks++) {
    const type = buf[i];
    if (type === 0x21) {
      i += 2; // extension introducer and label
      skipSubBlocks();
    } else if (type === 0x2c) {
      if (i + 10 > buf.length) break;
      width = Math.max(width, buf.readUInt16LE(i + 5));
      height = Math.max(height, buf.readUInt16LE(i + 7));
      const local = buf[i + 9];
      i += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1; // + the LZW minimum code size
      skipSubBlocks();
    } else {
      break; // trailer (0x3B) or anything we do not understand
    }
  }
  return { width, height };
}

function jpegDimensions(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    // A decoder skips stray bytes up to the next 0xFF, and a marker without a length (TEM, RSTn,
    // SOI) is followed directly by the next marker. Reading a length after those, as this walker
    // once did, let a prefix steer it onto a small fake frame header inside a comment.
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // standalone marker
      continue;
    }
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) return null; // end or scan data, no frame header seen
    const length = buf.readUInt16BE(i + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}
