// What is accepted as the picture of a collectible, and what is stored: the kind is decided by the first
// bytes, never by the name or the content type; the picture is decoded and re-encoded as a WebP of at most
// 512x512 with its aspect ratio kept; everything else is refused; sources over 16 megapixels are refused from
// the header; at most two pictures are decoded at a time.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ImageError,
  MAX_CONCURRENT_DECODES,
  MAX_UPLOAD_BYTES,
  STORED_MIME,
  _decodeQueue,
  processImage,
  readUpload,
  sniffImage,
} from '../src/lib/collectibleImage.js';
import { imageDimensions } from '../src/lib/imageSize.js';
import { HTML, SVG, makePicture, pngClaiming, upload } from './helpers/collectibleFixtures.js';

const refused = async (bytes, pattern, status) => {
  await assert.rejects(
    () => processImage(bytes),
    (err) => {
      assert.ok(err instanceof ImageError, `an ImageError, not ${err}`);
      if (pattern) assert.match(err.message, pattern);
      if (status) assert.equal(err.status, status);
      return true;
    }
  );
};

test('the kind of a file comes from its first bytes', async () => {
  assert.equal(sniffImage(await makePicture(8, 8, 'png')), 'png');
  assert.equal(sniffImage(await makePicture(8, 8, 'jpeg')), 'jpeg');
  assert.equal(sniffImage(await makePicture(8, 8, 'webp')), 'webp');
  for (const other of [
    SVG,
    HTML,
    Buffer.from('GIF89a' + 'x'.repeat(20)),
    Buffer.from('BM' + 'x'.repeat(40)),
  ]) {
    assert.equal(sniffImage(other), null);
  }
  // too short, empty, or not even a buffer
  assert.equal(sniffImage(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage('PNG'), null);
});

test('PNG, JPEG and WebP are accepted and stored as a WebP', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const out = await processImage(await makePicture(64, 32, format));
    assert.equal(out.kind, format);
    assert.equal(out.mime, 'image/webp');
    assert.equal(STORED_MIME, 'image/webp');
    assert.equal(sniffImage(out.data), 'webp', `${format} is re-encoded as a WebP`);
    assert.deepEqual(imageDimensions(out.data), { width: 64, height: 32 });
  }
});

test('a large picture is scaled down to fit 512x512 with its aspect ratio kept, a small one is not enlarged', async () => {
  const size = async (bytes) => {
    const out = await processImage(bytes);
    assert.deepEqual(imageDimensions(out.data), { width: out.width, height: out.height });
    return [out.width, out.height];
  };
  assert.deepEqual(await size(await makePicture(1000, 500)), [512, 256]);
  assert.deepEqual(await size(await makePicture(300, 1200, 'jpeg')), [128, 512]);
  assert.deepEqual(await size(await makePicture(2000, 2000, 'webp')), [512, 512]);
  assert.deepEqual(await size(await makePicture(40, 20)), [40, 20]);
  assert.deepEqual(await size(await makePicture(1, 1)), [1, 1]);
});

test('a stored picture is small: a flat badge is a few kilobytes', async () => {
  const out = await processImage(await makePicture(512, 512));
  assert.ok(out.data.length < 20_000, `${out.data.length} bytes`);
});

test('what is stored is a new WebP: metadata and data appended after the picture are gone', async () => {
  const picture = await makePicture(32, 32);
  const iend = picture.indexOf(Buffer.from('IEND')) - 4;
  const text = Buffer.concat([
    Buffer.from([0, 0, 0, 22]),
    Buffer.from('tEXtComment\0SECRET-METADATA'),
    Buffer.alloc(4),
  ]);
  const loaded = Buffer.concat([
    picture.subarray(0, iend),
    text,
    picture.subarray(iend),
    Buffer.from('APPENDED-PAYLOAD'),
  ]);
  const out = await processImage(loaded);
  assert.equal(out.data.includes(Buffer.from('SECRET-METADATA')), false);
  assert.equal(out.data.includes(Buffer.from('APPENDED-PAYLOAD')), false);
  assert.equal(out.data.includes(Buffer.from('tEXt')), false);
});

test('SVG, HTML and other formats are refused, however they are named', async () => {
  await refused(SVG, /PNG, JPEG or WebP/);
  await refused(HTML, /PNG, JPEG or WebP/);
  await refused(Buffer.from('GIF89a' + 'x'.repeat(40)), /PNG, JPEG or WebP/);
  await refused(Buffer.from('%PDF-1.7 ' + 'x'.repeat(40)), /PNG, JPEG or WebP/);
  await refused(Buffer.alloc(0), /Choose an image/);
});

test('a file that starts like a picture but is not one is refused', async () => {
  const png = await makePicture(32, 32);
  // right magic bytes, the rest is HTML
  await refused(Buffer.concat([png.subarray(0, 8), HTML]), /valid image|too large/);
  // a PNG cut in the middle of its data
  await refused(png.subarray(0, 40), /valid image|too large/);
  // JPEG and WebP magic bytes with nothing behind them
  await refused(
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]),
    /valid image|too large/
  );
  await refused(Buffer.concat([Buffer.from('RIFF....WEBPVP8 '), Buffer.alloc(40)]), /valid image|too large/);
});

test('a file over 2 MB is refused, and so is a source over 16 megapixels or one that claims an enormous size', async () => {
  await refused(
    Buffer.concat([await makePicture(8, 8), Buffer.alloc(MAX_UPLOAD_BYTES)]),
    /larger than 2 MB/,
    413
  );
  // refused from the header, before anything is decoded
  await refused(pngClaiming(30000, 30000), /too large in pixels/);
  await refused(pngClaiming(8193, 10), /too large in pixels/);
  await refused(pngClaiming(4001, 4001), /16 megapixels/); // 16.008 million
  await refused(pngClaiming(5000, 3500), /16 megapixels/);
  await refused(pngClaiming(0, 10), /too large in pixels|valid image/);
  // 16 megapixels or fewer pass the header check: this one then fails to decode (it has no pixels behind it)
  await refused(pngClaiming(4000, 4000), /valid image/);
});

test('a 12 megapixel picture is accepted and scaled down', async () => {
  const out = await processImage(await makePicture(4000, 3000));
  assert.deepEqual([out.width, out.height], [512, 384]);
});

test('at most two pictures are decoded at a time; the others wait, and give up with a "busy" answer', async () => {
  const big = await makePicture(3000, 2500);
  // two take the places, three more wait with a very short patience
  const running = [processImage(big), processImage(big)];
  const impatient = [1, 2, 3].map(() =>
    processImage(big, { queueTimeoutMs: 1 }).then(
      () => 'done',
      (err) => err
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  const state = _decodeQueue();
  assert.ok(state.running <= MAX_CONCURRENT_DECODES, `running ${state.running}`);
  const results = await Promise.all(impatient);
  const busy = results.filter((r) => r instanceof ImageError && r.status === 503);
  assert.ok(busy.length >= 1, 'some waited too long');
  assert.match(busy[0].message, /busy/);
  for (const done of await Promise.all(running)) assert.equal(sniffImage(done.data), 'webp');
  assert.deepEqual(_decodeQueue(), { running: 0, waiting: 0 }, 'every place was given back');

  // patient ones all get their turn, two at a time
  const seen = [];
  const sampler = setInterval(() => seen.push(_decodeQueue().running), 2);
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => processImage(big, { queueTimeoutMs: 60_000 })));
  clearInterval(sampler);
  assert.equal(all.length, 5);
  assert.ok(Math.max(...seen, 0) <= MAX_CONCURRENT_DECODES);
  assert.deepEqual(_decodeQueue(), { running: 0, waiting: 0 });
});

test('a refused picture gives its place back', async () => {
  for (let i = 0; i < 6; i += 1) {
    await assert.rejects(() =>
      processImage(Buffer.concat([Buffer.from('RIFF....WEBPVP8 '), Buffer.alloc(40)]))
    );
  }
  assert.deepEqual(_decodeQueue(), { running: 0, waiting: 0 });
});

test('an upload is read from a multipart request, with the size limited before it is held', async () => {
  const requestOf = async (form, extra = {}) => {
    const probe = new Response(form);
    const body = Buffer.from(await probe.arrayBuffer());
    const req = Readable.from([body]);
    req.headers = {
      'content-type': probe.headers.get('content-type'),
      'content-length': String(body.length),
      ...extra,
    };
    return req;
  };
  const picture = await makePicture(16, 16);
  const ok = await readUpload(await requestOf(upload(picture)));
  assert.ok(ok.equals(picture));
  // no file field, a text field instead of a file, and a body that is not multipart
  const wrongField = await requestOf(upload(picture, { field: 'other' }));
  await assert.rejects(() => readUpload(wrongField), /Choose an image/);
  const textForm = new FormData();
  textForm.append('file', 'not a file');
  const asText = await requestOf(textForm);
  await assert.rejects(() => readUpload(asText), /Choose an image/);
  const json = Readable.from([Buffer.from('{}')]);
  json.headers = { 'content-type': 'application/json' };
  await assert.rejects(
    () => readUpload(json),
    (err) => err instanceof ImageError && err.status === 415
  );
  // a declared length far over the limit is refused without reading the body
  const big = await requestOf(upload(picture), { 'content-length': String(10 * MAX_UPLOAD_BYTES) });
  await assert.rejects(
    () => readUpload(big),
    (err) => err instanceof ImageError && err.status === 413
  );
  // a body past the limit that lies about its length is cut off at the limit
  const liar = await requestOf(upload(Buffer.concat([picture, Buffer.alloc(MAX_UPLOAD_BYTES)])), {
    'content-length': '100',
  });
  await assert.rejects(
    () => readUpload(liar),
    (err) => err instanceof ImageError && err.status === 413
  );
});
