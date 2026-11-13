// What is accepted as the picture of a collectible, and what is stored: the kind is decided by the first
// bytes, never by the name or the content type; the picture is decoded and re-encoded as a PNG of at most
// 512x512 with its aspect ratio kept; everything else is refused. And the paths of the stored files: built only
// from a server key and an id of the exact shape, so no text from a request can leave the folder.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ImageError,
  MAX_UPLOAD_BYTES,
  processImage,
  readUpload,
  sniffImage,
} from '../src/lib/collectibleImage.js';
import {
  collectiblesRoot,
  deleteImage,
  folderOf,
  pathOf,
  readImage,
  removeGuildImages,
  saveImage,
} from '../src/lib/collectibleFiles.js';
import { HTML, SVG, makePicture, pngClaiming, pngSize, upload } from './helpers/collectibleFixtures.js';

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

test('PNG, JPEG and WebP are accepted and stored as a PNG', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const out = await processImage(await makePicture(64, 32, format));
    assert.equal(out.kind, format);
    assert.equal(sniffImage(out.png), 'png', `${format} is re-encoded as a PNG`);
    assert.deepEqual(pngSize(out.png), { width: 64, height: 32 });
  }
});

test('a large picture is scaled down to fit 512x512 with its aspect ratio kept, a small one is not enlarged', async () => {
  const wide = await processImage(await makePicture(1000, 500));
  assert.deepEqual(pngSize(wide.png), { width: 512, height: 256 });
  assert.deepEqual([wide.width, wide.height], [512, 256]);
  const tall = await processImage(await makePicture(300, 1200, 'jpeg'));
  assert.deepEqual(pngSize(tall.png), { width: 128, height: 512 });
  const square = await processImage(await makePicture(2000, 2000, 'webp'));
  assert.deepEqual(pngSize(square.png), { width: 512, height: 512 });
  const small = await processImage(await makePicture(40, 20));
  assert.deepEqual(pngSize(small.png), { width: 40, height: 20 });
  const one = await processImage(await makePicture(1, 1));
  assert.deepEqual(pngSize(one.png), { width: 1, height: 1 });
});

test('what is stored is a new PNG: metadata and data appended after the picture are gone', async () => {
  const picture = await makePicture(32, 32);
  // a text chunk with a secret before the image data, and a payload after the end of the file
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
  assert.equal(out.png.includes(Buffer.from('SECRET-METADATA')), false);
  assert.equal(out.png.includes(Buffer.from('APPENDED-PAYLOAD')), false);
  assert.equal(out.png.includes(Buffer.from('tEXt')), false);
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

test('a file over 2 MB is refused, and so is a picture that claims an enormous size', async () => {
  await refused(
    Buffer.concat([await makePicture(8, 8), Buffer.alloc(MAX_UPLOAD_BYTES)]),
    /larger than 2 MB/,
    413
  );
  // 30000 x 30000 in a 33-byte header: refused from the header, before anything is decoded
  await refused(pngClaiming(30000, 30000), /too large in pixels/);
  await refused(pngClaiming(8193, 10), /too large in pixels/);
  await refused(pngClaiming(0, 10), /too large in pixels|valid image/);
});

test('an upload is read from a multipart request, with the size limited before it is held', async () => {
  const { Readable } = await import('node:stream');
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

test('a stored picture lives under collectibles/<server>/<id>.png and nowhere else', async () => {
  const G = '900000000000000555';
  const png = (await processImage(await makePicture(20, 20))).png;
  const id = await saveImage(G, png);
  assert.match(id, /^[0-9a-f]{32}$/);
  const file = pathOf(G, id);
  assert.equal(file, join(collectiblesRoot(), G, `${id}.png`));
  assert.ok(existsSync(file));
  assert.ok((await readImage(G, id)).equals(png));
  // two saves never share an id
  assert.notEqual(await saveImage(G, png), id);
  // a Fluxer key becomes a folder name without the colon
  assert.equal(folderOf('fluxer:900000000000000555'), 'fluxer-900000000000000555');
  assert.equal(
    pathOf('fluxer:900000000000000555', id),
    join(collectiblesRoot(), 'fluxer-900000000000000555', `${id}.png`)
  );
  await deleteImage(G, id);
  assert.equal(existsSync(file), false);
  assert.equal(await readImage(G, id), null);
  assert.equal(await deleteImage(G, id), false, 'a file that is gone is not an error');
  await removeGuildImages(G);
  assert.equal(existsSync(join(collectiblesRoot(), G)), false);
});

test('no server key or id that is not of the exact shape ever becomes a path', async () => {
  const good = 'a'.repeat(32);
  const G = '900000000000000555';
  const hostile = [
    '../../etc/passwd',
    '..',
    '.',
    '',
    `${good}/../../x`,
    `${good}.png`,
    good.toUpperCase(),
    `${good}\0`,
    'a'.repeat(31),
    'a'.repeat(33),
    `..\\${good}`,
    '%2e%2e%2f',
    null,
    undefined,
    42,
  ];
  for (const id of hostile) assert.equal(pathOf(G, id), null, `id ${JSON.stringify(id)}`);
  for (const key of [
    '..',
    '../x',
    '/abs',
    'x',
    '900000000000000555/..',
    '9'.repeat(30),
    'fluxer:',
    'a:123',
    null,
    undefined,
    '',
  ]) {
    assert.equal(pathOf(key, good), null, `key ${JSON.stringify(key)}`);
    assert.equal(folderOf(key), null);
  }
  // and whatever passes stays inside the root
  const inside = pathOf(G, good);
  assert.ok(resolve(inside).startsWith(resolve(collectiblesRoot())));
  assert.equal(await readImage('../..', good), null);
  assert.equal(await removeGuildImages('..'), false);
});
