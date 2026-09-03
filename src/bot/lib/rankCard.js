// Renders a MEE6-style rank card to a PNG buffer with @napi-rs/canvas.
// The native module and its platform binary are optional: if they fail to load
// (unsupported arch, missing prebuild), renderRankCard() returns null and the
// caller falls back to a plain embed.
import { existsSync } from 'node:fs';
import { log } from '../../lib/log.js';

let canvasMod = null;
try {
  canvasMod = await import('@napi-rs/canvas');
} catch (err) {
  log.warn('rank-card', 'canvas unavailable — /rank will use a text embed', err.message);
}

export const rankCardAvailable = Boolean(canvasMod);

// Register a bundled/system font so text isn't rendered as tofu on a bare
// container. The Docker image installs font-dejavu; dev machines use system
// fonts. Family name "CardSans" when we registered one, else a sans stack.
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

/** "45m" / "3h 12m" / "2d 4h" from a whole-minute count. */
function humanMins(n) {
  const m = Math.max(0, Math.round(Number(n) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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
 * @param {string} o.name         Display name.
 * @param {string} o.avatarUrl    PNG avatar URL.
 * @param {number} o.level
 * @param {number} o.rank         1-based position.
 * @param {number} [o.totalRanked]
 * @param {number} o.xpInto       XP earned within the current level.
 * @param {number} o.xpNeed       XP required to finish the current level.
 * @param {number} o.messages
 * @param {number} [o.totalXp]      Lifetime XP total (for the chat/voice split).
 * @param {number} [o.voiceXp]      XP earned in voice; a split line is drawn when > 0.
 * @param {number} [o.voiceMinutes] Whole minutes spent in voice, shown next to voice XP.
 * @param {string} [o.accent]     Hex accent colour.
 * @returns {Promise<Buffer|null>}
 */
export async function renderRankCard(o) {
  if (!canvasMod) return null;
  const { createCanvas, loadImage } = canvasMod;
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent || '') ? o.accent : '#5b7cfa';

  const voiceXp = Math.max(0, Math.round(Number(o.voiceXp) || 0));
  const hasVoice = voiceXp > 0;

  const W = 900;
  const H = hasVoice ? 296 : 260;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background.
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fillStyle = '#1e2126';
  ctx.fill();
  roundRect(ctx, 10, 10, W - 20, H - 20, 22);
  ctx.fillStyle = '#26292f';
  ctx.fill();

  // Avatar.
  const AV = 168;
  const ax = 46;
  const ay = (H - AV) / 2;
  const img = await loadImage(o.avatarUrl).catch(() => null);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + AV / 2, ay + AV / 2, AV / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, ax, ay, AV, AV);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(ax + AV / 2, ay + AV / 2, AV / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#36393f';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(ax + AV / 2, ay + AV / 2, AV / 2, 0, Math.PI * 2);
  ctx.lineWidth = 6;
  ctx.strokeStyle = accent;
  ctx.stroke();

  const tx = ax + AV + 40;

  // Name.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 46px ${FONT}`;
  ctx.fillText(ellipsize(ctx, o.name, W - tx - 60), tx, 96);

  // Level / rank, top-right.
  ctx.textAlign = 'right';
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillStyle = accent;
  ctx.fillText(`LEVEL ${fmt(o.level)}`, W - 46, 74);
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText(`RANK #${fmt(o.rank)}${o.totalRanked ? ` / ${fmt(o.totalRanked)}` : ''}`, W - 46, 110);

  // Progress bar.
  const bx = tx;
  const by = 150;
  const bw = W - tx - 46;
  const bh = 36;
  roundRect(ctx, bx, by, bw, bh, bh / 2);
  ctx.fillStyle = '#15171a';
  ctx.fill();
  const pct = o.xpNeed > 0 ? Math.min(1, Math.max(0, o.xpInto / o.xpNeed)) : 0;
  if (pct > 0) {
    roundRect(ctx, bx, by, Math.max(bh, bw * pct), bh, bh / 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  ctx.font = `600 22px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#dcddde';
  ctx.fillText(`${fmt(o.xpInto)} / ${fmt(o.xpNeed)} XP`, bx + 2, by + bh + 32);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8e9297';
  ctx.fillText(`${fmt(o.messages)} messages`, bx + bw, by + bh + 32);

  if (hasVoice) {
    const chatXp = Math.max(0, Math.round(Number(o.totalXp) || 0) - voiceXp);
    const y2 = by + bh + 64;
    ctx.font = `600 20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8e9297';
    ctx.fillText(`Chat ${fmt(chatXp)} XP`, bx + 2, y2);
    ctx.textAlign = 'right';
    ctx.fillStyle = accent;
    const vmin = Math.round(Number(o.voiceMinutes) || 0);
    ctx.fillText(`Voice ${fmt(voiceXp)} XP${vmin > 0 ? ` · ${humanMins(vmin)}` : ''}`, bx + bw, y2);
  }

  return canvas.toBuffer('image/png');
}

const BADGE = { 1: '#f0b232', 2: '#b9bbbe', 3: '#cd7f32' }; // gold / silver / bronze

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.iconUrl]        Guild icon PNG URL.
 * @param {Array<{ rank:number, name:string, avatarUrl:string, level:number, xp:number }>} o.rows
 * @param {string} [o.footer]
 * @param {string} [o.accent]
 * @returns {Promise<Buffer|null>}
 */
export async function renderLeaderboardCard(o) {
  if (!canvasMod) return null;
  const { createCanvas, loadImage } = canvasMod;
  const accent = /^#[0-9a-f]{6}$/i.test(o.accent || '') ? o.accent : '#5b7cfa';
  const rows = (o.rows || []).slice(0, 10);

  // Fetch every avatar up front so the row loop can draw synchronously.
  await Promise.all(
    rows.map(async (r) => {
      r._img = r.avatarUrl ? await loadImage(r.avatarUrl).catch(() => null) : null;
    })
  );

  const W = 920;
  const PAD = 34;
  const HEAD = 92;
  const ROW = 64;
  const FOOT = o.footer ? 44 : 18;
  const H = HEAD + rows.length * ROW + FOOT;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fillStyle = '#1e2126';
  ctx.fill();

  // Header.
  const icon = o.iconUrl ? await loadImage(o.iconUrl).catch(() => null) : null;
  let titleX = PAD;
  if (icon) {
    const S = 48;
    ctx.save();
    ctx.beginPath();
    ctx.arc(PAD + S / 2, HEAD / 2, S / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(icon, PAD, HEAD / 2 - S / 2, S, S);
    ctx.restore();
    titleX = PAD + S + 16;
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 34px ${FONT}`;
  ctx.fillText(ellipsize(ctx, o.title, W - titleX - PAD), titleX, HEAD / 2 + 12);

  rows.forEach((r, i) => {
    const y = HEAD + i * ROW;
    if (i % 2 === 0) {
      ctx.fillStyle = '#24272d';
      roundRect(ctx, PAD - 10, y + 4, W - 2 * (PAD - 10), ROW - 8, 12);
      ctx.fill();
    }
    const midY = y + ROW / 2;

    // Rank badge.
    const badge = BADGE[r.rank];
    ctx.beginPath();
    ctx.arc(PAD + 16, midY, 18, 0, Math.PI * 2);
    ctx.fillStyle = badge || '#2f3237';
    ctx.fill();
    ctx.fillStyle = badge ? '#1e2126' : '#b9bbbe';
    ctx.font = `bold 18px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(r.rank), PAD + 16, midY + 6);

    // Avatar (pre-loaded by preloadLeaderboardAvatars).
    const AV = 40;
    const avx = PAD + 46;
    const img = r._img || null;
    ctx.save();
    ctx.beginPath();
    ctx.arc(avx + AV / 2, midY, AV / 2, 0, Math.PI * 2);
    ctx.clip();
    if (img) ctx.drawImage(img, avx, midY - AV / 2, AV, AV);
    else {
      ctx.fillStyle = '#36393f';
      ctx.fillRect(avx, midY - AV / 2, AV, AV);
    }
    ctx.restore();

    // Name.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(ellipsize(ctx, r.name, W - (avx + AV + 14) - 240), avx + AV + 14, midY + 8);

    // Level + XP, right-aligned.
    ctx.textAlign = 'right';
    ctx.fillStyle = accent;
    ctx.font = `bold 20px ${FONT}`;
    ctx.fillText(`Lv ${fmt(r.level)}`, W - PAD - 120, midY + 7);
    ctx.fillStyle = '#8e9297';
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(`${fmt(r.xp)} XP`, W - PAD, midY + 7);
  });

  if (o.footer) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8e9297';
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(o.footer, PAD, H - 16);
  }

  return canvas.toBuffer('image/png');
}
