// A welcome card background is decoded in full by the canvas library, so a small file that
// claims 30000×30000 pixels (a decompression bomb) would take gigabytes. The size is read from
// the file header first, without decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { imageDimensions } from '../src/lib/imageSize.js';
import { fetchCardImage } from '../src/bot/lib/welcomeCard.js';

function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width, height) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpeg(width, height) {
  // SOI, an APP0 segment, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

test('imageDimensions reads PNG, GIF, JPEG and WebP headers', () => {
  assert.deepEqual(imageDimensions(png(1200, 400)), { width: 1200, height: 400 });
  assert.deepEqual(imageDimensions(gif(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 });
  assert.deepEqual(imageDimensions(webpVp8x(2000, 1000)), { width: 2000, height: 1000 });
  assert.equal(imageDimensions(Buffer.from('not an image')), null);
});

test('fetchCardImage refuses a private address', async () => {
  assert.equal(await fetchCardImage('http://127.0.0.1:9/bg.png'), null);
});

test('fetchCardImage refuses an image with too many pixels', async () => {
  const server = createServer((req, res) => res.end(req.url === '/big' ? png(30000, 30000) : png(1000, 340)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await fetchCardImage(`${base}/big`, { allowPrivate: true }), null);
    assert.ok(Buffer.isBuffer(await fetchCardImage(`${base}/ok`, { allowPrivate: true })));
  } finally {
    server.close();
  }
});

test('imageDimensions reads a BMP header', () => {
  const b = Buffer.alloc(26);
  b.write('BM', 0, 'ascii');
  b.writeInt32LE(800, 18);
  b.writeInt32LE(-300, 22); // negative: a top-down bitmap
  assert.deepEqual(imageDimensions(b), { width: 800, height: 300 });
});

// The pre-decode guard is only worth anything if it reads what the decoder uses.
function gifWithFrame(screen, frame) {
  const head = Buffer.alloc(13);
  head.write('GIF89a', 0, 'ascii');
  head.writeUInt16LE(screen.width, 6);
  head.writeUInt16LE(screen.height, 8);
  // image descriptor, no local colour table, LZW min code size, one data sub-block, terminator
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(frame.width, 5);
  desc.writeUInt16LE(frame.height, 7);
  const data = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
  return Buffer.concat([head, desc, data]);
}

test('imageDimensions: a GIF reports its largest frame, not only the logical screen', () => {
  assert.deepEqual(imageDimensions(gifWithFrame({ width: 1, height: 1 }, { width: 6000, height: 6000 })), {
    width: 6000,
    height: 6000,
  });
  assert.deepEqual(imageDimensions(gifWithFrame({ width: 300, height: 200 }, { width: 10, height: 10 })), {
    width: 300,
    height: 200,
  });
});

test('fetchCardImage refuses a GIF whose frame is larger than its logical screen', async () => {
  const server = createServer((req, res) =>
    res.end(
      gifWithFrame(
        { width: 1, height: 1 },
        req.url === '/big' ? { width: 6000, height: 6000 } : { width: 1, height: 1 }
      )
    )
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await fetchCardImage(`${base}/big`, { allowPrivate: true }), null);
    assert.ok(Buffer.isBuffer(await fetchCardImage(`${base}/ok`, { allowPrivate: true })));
  } finally {
    server.close();
  }
});

function sofSegment(width, height) {
  const b = Buffer.alloc(13);
  b.writeUInt16BE(0xffc0, 0);
  b.writeUInt16BE(11, 2);
  b[4] = 8;
  b.writeUInt16BE(height, 5);
  b.writeUInt16BE(width, 7);
  b[9] = 1;
  return b;
}

test('imageDimensions: a TEM marker does not steer the JPEG walker onto a fake frame header', () => {
  const fake = sofSegment(16, 16);
  const real = sofSegment(6000, 6000);
  const com = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0x00, 2 + 4 + fake.length]), // COM length: itself, 4 filler bytes, the fake header
    Buffer.alloc(4),
    fake,
  ]);
  // SOI, TEM, then two bytes a decoder skips but a length-reading walker takes as "10" (landing in the comment).
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x00, 0x0a]), com, real, Buffer.alloc(8)]);
  assert.deepEqual(imageDimensions(buf), { width: 6000, height: 6000 });
});
