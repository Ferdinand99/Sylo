// Where the images of collectibles live on disk, and the only code that touches them.
//
//   <data folder>/collectibles/<server folder>/<id>.png
//
// The data folder is the folder of DATABASE_PATH (config.dataDir). The server folder is made from the
// server key, and only from a key of the shape this module accepts, so no other text ever becomes part
// of a path. The id is 128 random bits as 32 hex characters, made here and never taken from a request
// without being checked against that exact shape first.
//
// Every path is built by `pathOf`, which refuses anything that is not that shape and double-checks that
// the result is inside the collectibles folder. A file is only ever read when it is a plain file (not a
// link) at that path. Nothing here knows about the database: whether an image is still in use is decided
// by db/economyShop.js (releaseImage), which calls `deleteImage` only when nothing refers to it.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { config } from '../config.js';

/** An image id: 128 random bits, lower-case hex. */
export const IMAGE_ID_RE = /^[0-9a-f]{32}$/;
/** A server key: a Discord id, or "fluxer:<id>". */
const GUILD_KEY_RE = /^(fluxer:)?\d{17,20}$/;

/** The folder every collectible image lives under. */
export const collectiblesRoot = () => resolve(config.dataDir, 'collectibles');

/** The folder name of a server key ("fluxer:123" becomes "fluxer-123"), or null for any other text. */
export function folderOf(guildKey) {
  const key = String(guildKey ?? '');
  return GUILD_KEY_RE.test(key) ? key.replace(':', '-') : null;
}

/** The path of one image, or null when the server key or the id does not have the exact shape. */
export function pathOf(guildKey, imageId) {
  const folder = folderOf(guildKey);
  if (!folder || typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) return null;
  const root = collectiblesRoot();
  const file = join(root, folder, `${imageId}.png`);
  const rel = relative(root, file);
  // Belt and braces: the shapes above cannot leave the folder, this proves it.
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}

/** Save PNG bytes as a new image of a server and return its id. The id is new, so nothing is overwritten. */
export async function saveImage(guildKey, png) {
  const folder = folderOf(guildKey);
  if (!folder) throw new Error('bad server key');
  const id = randomBytes(16).toString('hex');
  const file = pathOf(guildKey, id);
  await mkdir(join(collectiblesRoot(), folder), { recursive: true });
  await writeFile(file, png, { flag: 'wx' });
  return id;
}

/** The bytes of an image, or null when it does not exist, is not a plain file, or the key or id is not valid. */
export async function readImage(guildKey, imageId) {
  const file = pathOf(guildKey, imageId);
  if (!file) return null;
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Delete one image file. A file that is already gone is fine. Never throws. */
export async function deleteImage(guildKey, imageId) {
  const file = pathOf(guildKey, imageId);
  if (!file) return false;
  try {
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** Delete every image of a server (the server's data is purged). Never throws. */
export async function removeGuildImages(guildKey) {
  const folder = folderOf(guildKey);
  if (!folder) return false;
  try {
    await rm(join(collectiblesRoot(), folder), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
