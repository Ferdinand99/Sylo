// Pictures and uploads for the collectible tests: real PNG, JPEG and WebP files drawn with
// @napi-rs/canvas, hostile files that pretend to be pictures, and a multipart upload built the way a
// browser sends one.
import { createCanvas } from '@napi-rs/canvas';

/** A real picture of `w` x `h` pixels in the given format ('png', 'jpeg' or 'webp'). */
export async function makePicture(w, h, format = 'png') {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3498db';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#f1c40f';
  ctx.fillRect(0, 0, Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
  return canvas.encode(format, 80);
}

/** The width and height a PNG says it has. */
export const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/** A PNG header that claims a huge size and has no pixels behind it (a decompression bomb in miniature). */
export function pngClaiming(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // RGBA
  return header;
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>'
);
export const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

/** A multipart body like a browser's file input: the field `file`, with the name and type the page chose. */
export function upload(bytes, { name = 'picture.png', type = 'image/png', field = 'file' } = {}) {
  const form = new FormData();
  form.append(field, new Blob([bytes], { type }), name);
  return form;
}

/**
 * Give a collectible a stored picture the way the dashboard does (db/collectibleImages.js attachImage), with a
 * real WebP of `size` x `size` pixels. Returns the picture's id. (The import is dynamic so a test can load its
 * database helper first.)
 */
export async function putPicture(guildId, itemId, size = 32) {
  const { attachImage } = await import('../../src/db/collectibleImages.js');
  const data = await makePicture(size, size, 'webp');
  const out = await attachImage(guildId, itemId, { mime: 'image/webp', data });
  if (!out.ok) throw new Error(`no picture: ${out.reason}`);
  return out.imageId;
}

/** The stored pictures of a server, as rows without the bytes. */
export async function storedPictures(guildId) {
  const { db } = await import('../../src/db/index.js');
  return db
    .prepare('SELECT id, mime, bytes FROM collectible_images WHERE guild_id = ? ORDER BY created_at, id')
    .all(guildId)
    .map((r) => ({ ...r }));
}
