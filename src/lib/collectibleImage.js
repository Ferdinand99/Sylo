// Turns an uploaded file into the image Sylo keeps for a collectible, or refuses it.
//
// Nothing a member of staff uploads is ever stored or served as it came in:
//   1. the size is checked (at most 2 MB);
//   2. the kind is decided by the first bytes of the file (the magic bytes), never by the name or the
//      content type the browser sent: only PNG, JPEG and WebP pass. SVG, HTML and everything else is refused;
//   3. the pixel size is read from the header before anything is decoded (a tiny file can claim 30000x30000);
//   4. the picture is decoded by @napi-rs/canvas and drawn onto a new canvas of at most 512x512 (the aspect
//      ratio kept, never enlarged), and that canvas is encoded as a PNG.
// The bytes that are stored are the new PNG, so metadata, appended data and anything that was not a real
// picture are gone. A still image only: an animated WebP or GIF becomes its first frame (a GIF is refused).
import { log } from './log.js';
import { imageDimensions } from './imageSize.js';

/** The largest upload, in bytes. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
/** The stored image fits in a square of this many pixels. */
export const MAX_SIDE = 512;
// What the decoder is willing to open: a side of at most 8192 pixels and 25 million pixels in all.
const MAX_SOURCE_SIDE = 8192;
const MAX_SOURCE_PIXELS = 25_000_000;

/** A refusal with a sentence for the person who uploaded and the HTTP status to answer with. */
export class ImageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ImageError';
    this.status = status;
  }
}

/** The kind of image a buffer is by its first bytes: 'png', 'jpeg' or 'webp', or null for anything else. */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

let canvasMod;
async function canvas() {
  if (canvasMod === undefined) {
    try {
      canvasMod = await import('@napi-rs/canvas');
    } catch (err) {
      log.warn('collectibles', 'canvas unavailable: images cannot be processed', err.message);
      canvasMod = null;
    }
  }
  return canvasMod;
}

/**
 * Check and re-encode an uploaded file.
 * @param {Buffer} buf  the bytes of the file
 * @returns {Promise<{ png: Buffer, width: number, height: number, kind: string }>}
 * @throws {ImageError}
 */
export async function processImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new ImageError('Choose an image to upload.');
  if (buf.length > MAX_UPLOAD_BYTES) throw new ImageError('The image is larger than 2 MB.', 413);
  const kind = sniffImage(buf);
  if (!kind) throw new ImageError('Use a PNG, JPEG or WebP image.');

  const size = imageDimensions(buf);
  if (
    !size ||
    !(size.width >= 1 && size.height >= 1) ||
    size.width > MAX_SOURCE_SIDE ||
    size.height > MAX_SOURCE_SIDE ||
    size.width * size.height > MAX_SOURCE_PIXELS
  ) {
    throw new ImageError('That image is too large in pixels, or it is not a valid image.');
  }

  const mod = await canvas();
  if (!mod) throw new ImageError('This server cannot process images right now.', 503);
  let img;
  try {
    img = await mod.loadImage(buf);
  } catch {
    throw new ImageError('That file is not a valid image.');
  }
  const w = Number(img?.width);
  const h = Number(img?.height);
  if (!(w >= 1 && h >= 1) || w * h > MAX_SOURCE_PIXELS)
    throw new ImageError('That file is not a valid image.');

  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  const surface = mod.createCanvas(width, height);
  const ctx = surface.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  const png = await surface.encode('png');
  return { png, width, height, kind };
}

/**
 * Read the file of a multipart upload (the field `file`) from a request, with a hard limit on the bytes
 * read, and return it as a Buffer. The multipart envelope is parsed by the platform's own parser
 * (Response.formData()), after the size has been capped, so nothing larger than the limit is ever held.
 * @param {import('express').Request} req
 * @returns {Promise<Buffer>}
 * @throws {ImageError}
 */
export async function readUpload(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) {
    throw new ImageError('Send the image as a multipart upload.', 415);
  }
  // The envelope adds a little to the file: allow 64 KB for it.
  const limit = MAX_UPLOAD_BYTES + 64 * 1024;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw new ImageError('The image is larger than 2 MB.', 413);
  }
  // Read to the end, keeping at most `limit` bytes. A body that goes on far past the limit (a lying or
  // missing Content-Length) is cut off; a body just past it is read and dropped so the refusal can be sent.
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total <= limit) chunks.push(chunk);
      else if (total > limit * 4) req.destroy();
    });
    req.on('end', resolve);
    req.on('close', resolve);
    req.on('error', reject);
  });
  if (total > limit) throw new ImageError('The image is larger than 2 MB.', 413);
  let form;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new ImageError('The upload could not be read.');
  }
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    throw new ImageError('Choose an image to upload.');
  }
  if (file.size > MAX_UPLOAD_BYTES) throw new ImageError('The image is larger than 2 MB.', 413);
  return Buffer.from(await file.arrayBuffer());
}
