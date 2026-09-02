// Renders a welcome banner card to a PNG buffer with @napi-rs/canvas. Same
// optional-native pattern as rankCard.js: if the module or its platform binary
// can't load, renderWelcomeCard() returns null and the caller sends a plain
// message instead.
import { existsSync } from 'node:fs';
import { log } from '../../lib/log.js';

let canvasMod = null;
try {
  canvasMod = await import('@napi-rs/canvas');
} catch (err) {
  log.warn('welcome-card', 'canvas unavailable — welcome images disabled', err.message);
}

export const welcomeCardAvailable = Boolean(canvasMod);

let FONT = '"DejaVu Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
if (canvasMod) {
  const candidates = [
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  ];
  let registered = false;
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      canvasMod.GlobalFonts.registerFromPath(p, 'CardSans');
      registered = true;
    } catch {
      /* keep trying */
    }
  }
  if (registered) FONT = 'CardSans';
}

const nf = new Intl.NumberFormat('en-US');
const fmt = (n) => nf.format(Math.max(0, Math.round(Number(n) || 0)));

/** loadImage with a hard timeout — a slow/hanging URL must not stall a join. */
function loadImageBounded(loadImage, url, ms = 6000) {
  if (!url) return Promise.resolve(null);
  return Promise.race([
    loadImage(url).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.()),
  ]);
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  let s = String(text ?? '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * @param {object} o
 * @param {string} o.name           Display name, centred under "WELCOME".
 * @param {string} o.avatarUrl      PNG avatar URL.
 * @param {number} [o.memberCount]  Shown as "MEMBER #N" when > 0.
 * @param {string} [o.title]        Heading (default "WELCOME").
 * @param {string} [o.accent]       Hex accent colour.
 * @param {string} [o.backgroundUrl] Optional cover image behind a dark scrim.
 * @returns {Promise<Buffer|null>}
 */
export async function renderWelcomeCard(o) {
  if (!canvasMod) return null;
  const { createCanvas, loadImage } = canvasMod;
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent || '') ? o.accent : '#5b7cfa';

  const W = 1000;
  const H = 340;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background: a cover-fit image behind a scrim, else an accent gradient.
  const bg = await loadImageBounded(loadImage, o.backgroundUrl);
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.save();
  ctx.clip();
  if (bg) {
    const scale = Math.max(W / bg.width, H / bg.height);
    const dw = bg.width * scale;
    const dh = bg.height * scale;
    ctx.drawImage(bg, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.fillStyle = 'rgba(20, 22, 26, 0.62)';
    ctx.fillRect(0, 0, W, H);
  } else {
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#1e2126');
    grad.addColorStop(1, '#26292f');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();

  // Inner accent border.
  roundRect(ctx, 8, 8, W - 16, H - 16, 22);
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.stroke();

  // Avatar, centred horizontally near the top.
  const AV = 150;
  const ax = (W - AV) / 2;
  const ay = 40;
  const img = await loadImageBounded(loadImage, o.avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax + AV / 2, ay + AV / 2, AV / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) ctx.drawImage(img, ax, ay, AV, AV);
  else {
    ctx.fillStyle = '#36393f';
    ctx.fillRect(ax, ay, AV, AV);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(ax + AV / 2, ay + AV / 2, AV / 2, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.textAlign = 'center';

  // Heading.
  ctx.fillStyle = accent;
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText(
    String(o.title || 'WELCOME')
      .toUpperCase()
      .slice(0, 40),
    W / 2,
    ay + AV + 46
  );

  // Name.
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(ellipsize(ctx, o.name, W - 120), W / 2, ay + AV + 96);

  // Member number.
  if (Number(o.memberCount) > 0) {
    ctx.fillStyle = '#b9bbbe';
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(`MEMBER #${fmt(o.memberCount)}`, W / 2, ay + AV + 132);
  }

  return canvas.toBuffer('image/png');
}
