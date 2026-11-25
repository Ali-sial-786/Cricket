// Broadcast graphics drawn into the canvas panels: the score bug (HUD), the
// stadium big screen, the event stings (FOUR / SIX / WICKET / decisions /
// REPLAY) and the result scorecard. Pure canvas 2D, drawn only when the
// panel's data changes (see ui.js); nothing here runs per frame.
import { C, TEAMS, font, rr, slant, vgrad, hgrad, caps, chip, teamBlock, ballDot, drawIcon, drawWordmark, teamByName, shadow } from './theme.js';
import { fitText, reportOverflow } from './panel.js';

const oversOf = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;

// Darken (k < 0) or lighten (k > 0) a #rrggbb colour.
export function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16), ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const t = k < 0 ? 0 : 255, a = Math.abs(k);
  return '#' + ch.map((c) => Math.round(c + (t - c) * a).toString(16).padStart(2, '0')).join('');
}

// One line, shrunk to fit maxW (never below min); returns the size used.
function fit(g, text, x, y, maxW, weight, size, min, color, align = 'left', N = 'panel') {
  const r = fitText(g, text, { maxW, size, min, weight });
  if (!r.fits) reportOverflow(N, text, r.width, maxW);
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
  g.fillText(text, x, y);
  return r;
}

// Runs of [text, weight, size, color] side by side, scaled together to fit maxW.
function runs(g, parts, x, y, maxW, align = 'left', gap = 0.28) {
  const width = (k) => parts.reduce((t, p, i) => { g.font = font(p[1], p[2] * k); return t + g.measureText(p[0]).width + (i ? p[2] * k * gap : 0); }, 0);
  let k = 1;
  for (let i = 0; i < 12 && width(k) > maxW; i++) k *= 0.94;
  const w = width(k);
  let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  g.textAlign = 'left'; g.textBaseline = 'middle';
  parts.forEach((p, i) => {
    if (i) cx += p[2] * k * gap;
    g.font = font(p[1], p[2] * k); g.fillStyle = p[3];
    g.fillText(p[0], cx, y + (p[4] || 0) * k);
    cx += g.measureText(p[0]).width;
  });
  return w;
}

// Text leaning forward (the sporty cut), sheared about its own baseline so
// (x, y) stays where it is drawn.
function skewText(g, text, x, y, k) {
  g.save();
  g.transform(1, 0, -k, 1, k * y, 0);
  g.fillText(text, x, y);
  g.restore();
}

// ------------------------------------------------------------- state
// What the score graphics show, read from the session's innings (null in
// nets / menus: the panels fall back to the session's text lines).
export function matchState(game) {
  const s = game && game.session, inn = s && s.innings;
  if (!inn) return null;
  const card = inn.card;
  const team = teamByName((card && card.team) || inn.label || (inn.batting === 'player' ? TEAMS.HK.name : TEAMS.SS.name));
  let over = inn.thisOver.slice(), overLabel = 'THIS OVER';
  if (!over.length && inn.log.length) {
    const last = inn.log[inn.log.length - 1].over;
    over = inn.log.filter((l) => l.over === last).map((l) => l.sym);
    overLabel = 'LAST OVER';
  }
  const legal = inn.legal, ballsLeft = inn.ballsLeft;
  return {
    team, runs: inn.runs, wkts: inn.wickets, overs: inn.overs, oversLimit: oversOf(inn.ballsLimit).replace(/\.0$/, ''),
    target: inn.target, need: inn.runsNeeded, ballsLeft,
    rrr: inn.target != null && ballsLeft > 0 ? (inn.runsNeeded * 6) / ballsLeft : null,
    crr: legal ? (inn.runs * 6) / legal : 0,
    over, overLabel, freeHit: !!inn.freeHit, wicketsLeft: inn.wicketsLeft,
    striker: card ? card.onStrike : null, non: card ? card.offStrike : null, bowler: card ? card.bowler : null,
    reviews: s.reviews ? { left: s.reviews.player, per: s.reviews.per } : null,
  };
}

const speedOf = (...texts) => {
  for (const t of texts) { const m = /(\d{2,3})\s?km\/h/.exec(t || ''); if (m) return m[1]; }
  return null;
};

// ------------------------------------------------------------- score bug
// The HUD panel beside the pitch (between balls). d: the HUD text fields
// (ui.hudData); st: matchState() or null. Returns the y where the message
// area starts.
export function drawScoreBug(g, W, H, d, st) {
  const N = 'hud', M = 26;
  // Title strip, review pips on the right.
  let pipsW = 0;
  if (st && st.reviews) {
    const n = st.reviews.per, r = 9;
    for (let i = 0; i < n; i++) {
      const cx = W - M - r - i * (2 * r + 8);
      g.beginPath(); g.arc(cx, 38, r, 0, Math.PI * 2);
      g.fillStyle = i < st.reviews.left ? C.info : 'rgba(255,255,255,0.14)'; g.fill();
    }
    pipsW = n * (2 * r + 8) + 8;
    pipsW += caps(g, 'REVIEWS', W - M - pipsW, 38, 17, C.text3, { align: 'right', weight: 800 }) + 12;
  }
  caps(g, String(d.title || '').toUpperCase(), M, 38, 26, C.accent, { maxW: W - 2 * M - pipsW - 10, weight: 900, track: 0.06 });

  // Score band: team block, score, overs; the last ball's speed on the right.
  // (None in the menus / mixed-reality set-up: nothing to score yet.)
  const by = 64, bh = st || d.score ? 88 : -12;
  const speed = bh > 0 ? speedOf(d.last, d.big) : null;
  let right = W - M;
  if (speed) {
    caps(g, 'LAST BALL', right, by + 16, 16, C.text3, { align: 'right' });
    g.font = font(500, 20); const kw = g.measureText('km/h').width;
    g.fillStyle = C.text3; g.textAlign = 'right'; g.fillText('km/h', right, by + 62);
    g.font = font(900, 48); g.fillStyle = C.text; g.fillText(speed, right - kw - 6, by + 58);
    right -= kw + 6 + g.measureText(speed).width + 22;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(right + 8, by + 8, 2, bh - 16);
  }
  const team = st ? st.team : TEAMS.NETS;
  if (bh > 0) teamBlock(g, team, M, by + 2, 116, bh - 4, team.short.length > 2 ? 30 : 42);
  const sx = M + 132;
  if (st) {
    g.font = font(900, 80); g.textAlign = 'left'; g.textBaseline = 'middle';
    const score = `${st.runs}/${st.wkts}`;
    const r = fit(g, score, sx, by + bh / 2 + 4, Math.max(120, right - sx - 150), 900, 80, 48, C.text, 'left', N);
    g.font = font(900, r.size);
    const ox = sx + Math.min(r.width, right - sx - 150) + 22;
    caps(g, 'OVERS', ox, by + 22, 16, C.text3);
    runs(g, [[st.overs, 800, 40, C.text], [`/ ${st.oversLimit}`, 600, 24, C.text3, 3]], ox, by + 60, Math.max(60, right - ox - 6));
  } else if (d.score) {
    fit(g, String(d.score || ''), sx, by + bh / 2 + 2, Math.max(80, right - sx - 8), 800, 56, 30, C.text, 'left', N);
  }

  let y = by + bh + 12;
  // Status bar: the chase equation (or the session's line).
  const bar = (h, col) => {
    rr(g, M, y, W - 2 * M, h, 10); g.fillStyle = 'rgba(255,255,255,0.07)'; g.fill();
    g.save(); rr(g, M, y, W - 2 * M, h, 10); g.clip(); g.fillStyle = col; g.fillRect(M, y, 6, h); g.restore();
  };
  if (st && st.target != null) {
    bar(48, C.accent);
    let rx = W - M - 16;
    if (st.freeHit) rx -= chip(g, 'FREE HIT', rx, y + 9, 30, { bg: C.warn, fg: '#1a1205', px: 18, align: 'right' }) + 12;
    if (st.rrr != null) { g.font = font(700, 24); rx -= runs(g, [['RRR', 800, 18, C.text3, 1], [st.rrr.toFixed(2), 800, 26, C.text]], rx, y + 25, 190, 'right') + 16; }
    runs(g, [['NEED', 800, 20, C.text3, 1], [String(st.need), 900, 32, C.accentHi], ['OFF', 800, 20, C.text3, 1], [String(st.ballsLeft), 900, 32, C.text], [st.ballsLeft === 1 ? 'BALL' : 'BALLS', 800, 20, C.text3, 1]], M + 22, y + 25, rx - M - 34);
    y += 58;
  } else if (d.sub) {
    // One line, or two when it must (machine settings).
    const r = fitText(g, d.sub, { maxW: W - 2 * M - 40 - (st && st.freeHit ? 150 : 0), maxH: 30 + 30 * 1.2, size: 30, min: 20, weight: 600, wrap: true, lineHeight: 1.2 });
    if (!r.fits) reportOverflow(N, d.sub, r.width, W - 2 * M - 40);
    const h = 18 + r.size + (r.lines.length - 1) * r.lh;
    bar(h, st ? st.team.c2 : C.primary);
    g.fillStyle = C.text2; g.textAlign = 'left';
    r.lines.forEach((ln, i) => g.fillText(ln, M + 22, y + 9 + r.size / 2 + i * r.lh + 1));
    if (st && st.freeHit) chip(g, 'FREE HIT', W - M - 14, y + h / 2 - 15, 30, { bg: C.warn, fg: '#1a1205', px: 18, align: 'right' });
    y += h + 10;
  }

  // Batters (striker lit), then the bowler and this over.
  if (st && st.striker) {
    const half = (W - 2 * M) / 2;
    [[st.striker, true], [st.non, false]].forEach(([b, on], i) => {
      if (!b) return;
      const x = M + i * half;
      if (on) { g.fillStyle = C.accent; g.beginPath(); g.moveTo(x + 2, y + 10); g.lineTo(x + 16, y + 21); g.lineTo(x + 2, y + 32); g.fill(); }
      runs(g, [[b.name, on ? 800 : 600, 28, on ? C.text : C.text2], [`${b.runs}${b.out ? '' : '*'}`, 900, 28, on ? C.accentHi : C.text2], [`(${b.balls})`, 600, 22, C.text3, 1]], x + 24, y + 21, half - 34);
    });
    y += 46;
  } else if (d.players || d.drs) {
    const t = [d.players, st ? '' : d.drs].filter(Boolean).join('   ·   ');
    if (t) { fit(g, t, M, y + 18, W - 2 * M, 600, 26, 18, '#ffe9a8', 'left', N); y += 42; }
  }
  if (st && (st.bowler || st.over.length)) {
    const half = (W - 2 * M) * 0.5;
    if (st.bowler) {
      const b = st.bowler;
      drawIcon(g, 'ball', M + 12, y + 20, 24, C.text3);
      runs(g, [[b.name, 700, 26, C.text2], [`${oversOf(b.balls)}-${b.runs}-${b.wickets}`, 900, 26, C.text]], M + 32, y + 20, half - 40);
    }
    if (st.over.length) {
      caps(g, st.overLabel, M + half + 4, y + 20, 15, C.text3);
      g.font = font(800, 15);
      const x0 = M + half + 4 + 100, avail = W - M - x0;
      let r = 16, wsum;
      for (;;) { wsum = st.over.reduce((t, s) => t + (String(s).length > 1 ? r * (2.2 + String(s).length * 0.84) : 2 * r) + 6, -6); if (wsum <= avail || r <= 10) break; r -= 1; }
      let cx = x0;
      for (const s of st.over) { const w = String(s).length > 1 ? r * (2.2 + String(s).length * 0.84) : 2 * r; ballDot(g, cx + w / 2, y + 20, r, s); cx += w + 6; }
    }
    y += 44;
  }
  g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(M, y + 2, W - 2 * M, 2);
  return y + 12;
}

// The result readout under the score bug ('big'): a tinted bar in its colour.
export function drawBigBar(g, W, y, text, color) {
  const M = 26, h = 84;
  g.save();
  rr(g, M, y, W - 2 * M, h, 14);
  g.fillStyle = hgrad(g, M, W - M, hexA(color, 0.26), hexA(color, 0.08)); g.fill();
  g.save(); rr(g, M, y, W - 2 * M, h, 14); g.clip(); g.fillStyle = color; g.fillRect(M, y, 8, h); g.restore();
  fit(g, text, W / 2 + 4, y + h / 2 + 2, W - 2 * M - 40, 900, 64, 28, color, 'center', 'hud');
  g.restore();
  return y + h;
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------- stings
// What kind of call a prompt is (its look): from its words.
export function stingKind(text) {
  const t = String(text || '').toUpperCase();
  if (/^SIX\b/.test(t)) return 'six';
  if (/^FOUR\b/.test(t)) return 'four';
  if (/NOT OUT/.test(t)) return 'notout';
  if (/^(OUT(?![-\w])|BOWLED|CAUGHT|STUMPED|RUN OUT|GIVEN OUT|LBW|HIT WICKET|DECISION: OUT)/.test(t)) return 'wicket';
  if (/THIRD UMPIRE|UNDER REVIEW|^YOU REVIEW|^THE .+ REVIEWS$/.test(t)) return 'review';
  if (/REACHES \d+/.test(t)) return 'milestone';
  return 'info';
}
const STING = {
  four: { c0: '#075a9c', c1: '#1fa8f0', icon: 'ball', tag: 'BOUNDARY', word: 'FOUR' },
  six: { c0: '#7a1590', c1: '#d94df0', icon: 'ball', tag: 'MAXIMUM', word: 'SIX' },
  wicket: { c0: '#8c0f22', c1: '#e8283f', icon: 'stumps', tag: 'WICKET', word: 'WICKET' },
  notout: { c0: '#0b6b43', c1: '#1db978', icon: 'check', tag: 'DECISION', word: 'NOT OUT' },
  review: { c0: '#123f8f', c1: '#2f7cf6', icon: 'eye', tag: 'REVIEW', word: 'DECISION PENDING' },
  milestone: { c0: '#8a5d05', c1: '#e3a417', icon: 'trophy', tag: 'MILESTONE', word: 'MILESTONE' },
  replay: { c0: '#0c1a33', c1: '#1b3b6e', icon: 'replay', tag: 'ACTION REPLAY', word: 'REPLAY' },
};

// The message strip in front of you: a broadcast band for the big calls, a
// dark glass card (text in its colour) for the rest.
export function drawPromptCard(g, W, H, text, color, kind) {
  const N = 'prompt', st = STING[kind];
  if (!st) {
    rr(g, 6, 8, W - 12, H - 16, 22); g.fillStyle = 'rgba(8,12,22,0.86)'; g.fill();
    g.save(); rr(g, 6, 8, W - 12, H - 16, 22); g.clip();
    g.fillStyle = vgrad(g, 8, H - 8, 'rgba(120,160,220,0.12)', 'rgba(120,160,220,0)'); g.fillRect(0, 0, W, H);
    g.fillStyle = color; g.fillRect(6, 8, 10, H - 16);
    g.restore();
    rr(g, 6, 8, W - 12, H - 16, 22); g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.stroke();
    const r = fitText(g, text, { maxW: W - 80, maxH: H - 44, size: 44, min: 22, weight: 800, wrap: true });
    if (!r.fits) reportOverflow(N, text, r.width, W - 80);
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    const h = r.size + (r.lines.length - 1) * r.lh;
    r.lines.forEach((ln, i) => g.fillText(ln, W / 2 + 6, H / 2 - h / 2 + r.size / 2 + i * r.lh + 1));
    return;
  }
  const k = H * 0.2;
  shadow(g, () => { slant(g, 8, 14, W - 16, H - 28, k); g.fillStyle = st.c0; g.fill(); }, 16, 5);
  slant(g, 8, 14, W - 16, H - 28, k);
  g.fillStyle = hgrad(g, 8, W - 8, st.c0, st.c1); g.fill();
  g.save(); slant(g, 8, 14, W - 16, H - 28, k); g.clip();
  // A light sweep and pinstripes: the broadcast sheen.
  g.fillStyle = vgrad(g, 14, H - 14, 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0)'); g.fillRect(0, 14, W, (H - 28) * 0.5);
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 6;
  for (let x = -H; x < W; x += 26) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  // The tag block on the left.
  const tw = 128;
  slant(g, 8, 14, tw + k, H - 28, k); g.fillStyle = 'rgba(0,0,0,0.28)'; g.fill();
  g.restore();
  drawIcon(g, st.icon, 8 + k * 0.5 + tw / 2, H / 2 - 14, 48, '#ffffff', { weight: 2.4 });
  caps(g, st.tag, 8 + k * 0.5 + tw / 2, H / 2 + 36, 15, 'rgba(255,255,255,0.85)', { align: 'center', maxW: tw - 8 });
  // The call itself, leaning forward.
  const x0 = 8 + tw + k + 18, maxW = W - x0 - k - 22;
  const r = fitText(g, text, { maxW: maxW * 0.95, maxH: H - 50, size: 66, min: 26, weight: 900, wrap: text.length > 18, lineHeight: 1.05 });
  if (!r.fits) reportOverflow(N, text, r.width, maxW);
  g.save();
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
  const h = r.size + (r.lines.length - 1) * r.lh;
  r.lines.forEach((ln, i) => skewText(g, ln, x0 + maxW / 2, H / 2 - h / 2 + r.size / 2 + i * r.lh + 2, 0.12));
  g.restore();
}

// ------------------------------------------------------------- big screen
// The stadium screen (24 x 9 m, ~85 m from the crease): a scoreboard that
// reads from the middle, or a full-screen sting. Body text stays >= 48 px
// (~15 px in the headset at that range).
// The screen's ground (gradient and diagonal weave): the same every time, so painted once and
// copied in (it was half the raster of every score change). A CPU canvas like the panel's, so
// the copy is the very pixels the strokes made.
let _screenBg = null;
function screenBackground(W, H) {
  if (_screenBg && _screenBg.width === W && _screenBg.height === H) return _screenBg;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = vgrad(g, 0, H, '#0d1a33', '#050a15'); g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.025)'; g.lineWidth = 8;
  for (let x = -H; x < W; x += 28) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  return (_screenBg = c);
}

export function drawBigScreen(g, W, H, { lines = [], st = null, title = '', sting = null } = {}) {
  const N = 'scoreboard';
  g.drawImage(screenBackground(W, H), 0, 0);
  if (sting) { drawScreenSting(g, W, H, sting); return; }
  const M = 24;
  if (lines[0] === 'CREASE VR' && !st) {
    g.save(); g.font = font(900, 112);
    const ww = drawWordmarkWidth(g, 104);
    drawWordmark(g, (W - ww) / 2, 140, 104);
    g.restore();
    if (lines[1]) fit(g, lines[1], W / 2, 268, W - 2 * M, 800, 64, 40, C.text, 'center', N);
    if (lines[2]) fit(g, lines[2], W / 2, 340, W - 2 * M, 600, 46, 30, C.text2, 'center', N);
    return;
  }
  // Header strip: what is on, the brand on the right.
  g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, 0, W, 62);
  g.fillStyle = hgrad(g, 0, W, C.primary, C.accent); g.fillRect(0, 62, W, 4);
  const wmW = drawWordmarkWidth(g, 30);
  drawWordmark(g, W - M - wmW, 30, 30, { crease: false });
  caps(g, String(title || lines[0] || '').toUpperCase(), M, 32, 40, C.accent, { maxW: W - 3 * M - wmW, weight: 900, track: 0.05 });
  if (!st) {
    // Nets: the session's lines (a big one, then two rows).
    if (lines[1]) fit(g, lines[1], W / 2, 150, W - 2 * M, 900, 96, 52, C.text, 'center', N);
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(M, 226, W - 2 * M, 2);
    if (lines[2]) fit(g, lines[2], W / 2, 266, W - 2 * M, 700, 52, 40, C.text2, 'center', N);
    if (lines[3]) fit(g, lines[3], W / 2, 342, W - 2 * M, 700, 52, 40, C.text2, 'center', N);
    return;
  }
  // Score row.
  const y0 = 74, h0 = 146;
  teamBlock(g, st.team, M, y0 + 6, 180, h0 - 12, st.team.short.length > 2 ? 52 : 76);
  const boxW = 220, bx = W - M - boxW;
  const sx = M + 204;
  const r = fit(g, `${st.runs}/${st.wkts}`, sx, y0 + h0 / 2 + 6, 360, 900, 140, 90, '#ffffff', 'left', N);
  g.font = font(900, r.size);
  const ox = sx + Math.min(360, r.width) + 28;
  caps(g, 'OVERS', ox, y0 + 30, 30, C.text3);
  runs(g, [[st.overs, 800, 84, C.text], [`/${st.oversLimit}`, 700, 44, C.text3, 10]], ox, y0 + 98, bx - ox - 16);
  rr(g, bx, y0 + 6, boxW, h0 - 12, 16); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fill();
  if (st.target != null) {
    caps(g, 'NEED', bx + boxW / 2, y0 + 30, 28, C.text3, { align: 'center' });
    fit(g, String(st.need), bx + boxW / 2, y0 + 84, boxW - 20, 900, 76, 50, C.accentHi, 'center', N);
    fit(g, `OFF ${st.ballsLeft}`, bx + boxW / 2, y0 + 122, boxW - 20, 800, 30, 24, C.text2, 'center', N);
  } else {
    caps(g, 'RUN RATE', bx + boxW / 2, y0 + 32, 28, C.text3, { align: 'center' });
    fit(g, st.crr.toFixed(2), bx + boxW / 2, y0 + 96, boxW - 20, 900, 72, 48, C.text, 'center', N);
  }
  // Batters.
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(M, 226, W - 2 * M, 2);
  const half = (W - 2 * M) / 2;
  [[st.striker, true], [st.non, false]].forEach(([b, on], i) => {
    if (!b) return;
    const x = M + i * half + (i ? 16 : 0);
    if (on) { g.fillStyle = C.accent; g.beginPath(); g.moveTo(x, 248); g.lineTo(x + 24, 266); g.lineTo(x, 284); g.fill(); }
    runs(g, [[b.name, 700, 50, on ? '#ffffff' : C.text2], [`${b.runs}${b.out ? '' : '*'}`, 900, 54, on ? C.accentHi : C.text2], [`(${b.balls})`, 600, 38, C.text3, 3]], x + (on ? 34 : 0), 266, half - 40 - (on ? 34 : 0));
  });
  // Bowler, this over.
  g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(M, 306, W - 2 * M, 2);
  if (st.bowler) runs(g, [[st.bowler.name, 700, 48, C.text2], [`${oversOf(st.bowler.balls)}-${st.bowler.runs}-${st.bowler.wickets}`, 900, 52, '#ffffff']], M, 345, half - 20);
  else if (st.target != null) runs(g, [['TARGET', 800, 36, C.text3, 2], [String(st.target), 900, 52, C.accentHi]], M, 345, half - 20);
  if (st.over.length) {
    let rD = 26, wsum;
    const x1 = W - M;
    const wOf = (s, r) => (String(s).length > 1 ? r * (2.2 + String(s).length * 0.84) : 2 * r);
    for (;;) { wsum = st.over.reduce((t, s) => t + wOf(s, rD) + 10, -10); if (wsum <= half - 10 || rD <= 16) break; rD -= 1; }
    let cx = x1 - wsum;
    for (const s of st.over) { const w = wOf(s, rD); ballDot(g, cx + w / 2, 345, rD, s); cx += w + 10; }
  }
  if (st.freeHit) chip(g, 'FREE HIT', W / 2 + 16, 322, 46, { bg: C.warn, fg: '#1a1205', px: 30 });
}

function drawWordmarkWidth(g, h) {
  // (the same measure drawWordmark uses, without drawing)
  g.save(); g.font = font(900, h * 1.02);
  const wC = g.measureText('CREASE').width; g.font = font(900, h * 0.62);
  const wV = g.measureText('VR').width + h * 0.34; g.restore();
  return 3 * h * 0.09 + 2 * h * 0.075 + h * 0.26 + wC + h * 0.18 + wV;
}

// Full-screen sting: the call huge, its colour, a line under it.
function drawScreenSting(g, W, H, s) {
  const st = STING[s.kind] || STING.replay;
  g.fillStyle = hgrad(g, 0, W, st.c0, st.c1); g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 18;
  for (let x = -H; x < W; x += 64) { g.beginPath(); g.moveTo(x, H); g.lineTo(x + H, 0); g.stroke(); }
  g.fillStyle = vgrad(g, 0, H * 0.5, 'rgba(255,255,255,0.18)', 'rgba(255,255,255,0)'); g.fillRect(0, 0, W, H * 0.5);
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, H - 92, W, 92);
  const word = s.word || st.word;
  const hasSub = !!s.sub;
  g.save();
  fitText(g, word, { maxW: W - 120, size: word.length > 8 ? 150 : 210, min: 80, weight: 900 });
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 14; g.shadowOffsetY = 6;
  skewText(g, word, W / 2, (hasSub ? 150 : 175) + 6, 0.14);
  g.restore();
  if (s.icon !== false) drawIcon(g, st.icon, 70, H - 46, 54, '#ffffff', { weight: 2.6 });
  // The line under it, between the icon and the brand.
  const wmW = drawWordmarkWidth(g, 30), x0 = 116, x1 = W - 28 - wmW - 24;
  if (hasSub) fit(g, String(s.sub).toUpperCase(), (x0 + x1) / 2, H - 46, x1 - x0, 800, 54, 34, '#ffffff', 'center', 'scoreboard');
  else caps(g, st.tag, (x0 + x1) / 2, H - 46, 44, 'rgba(255,255,255,0.9)', { align: 'center', maxW: x1 - x0 });
  drawWordmark(g, W - 28 - wmW, H - 46, 30, { crease: false, accent: '#ffffff' });
}

// ------------------------------------------------------------- result card
// The scorecard on the result page. rect: the area between the banner and
// the buttons. inn: the innings just finished (or null); prev: the other
// innings of a match (or null); lines: the result's text lines (fallback).
export function drawResultBody(g, rect, { inn = null, prev = null, lines = [] } = {}) {
  const N = 'menu', { x, y, w, h } = rect;
  if (inn && prev) return drawTwoInnings(g, rect, prev, inn);
  if (!inn || !inn.card) {
    // Text only (the toss): a "home v away" line becomes two team blocks.
    const vs = lines.length && /^(.+?)(?: \(you\))? v (.+)$/.exec(lines[0]);
    let yy = y + 10, rest = lines;
    if (vs) {
      const a = teamByName(vs[1]), b = teamByName(vs[2]), bw = 150, bh = 92, cy = y + 60;
      teamBlock(g, a, x + w / 2 - 70 - bw, cy - bh / 2, bw, bh, 46);
      teamBlock(g, b, x + w / 2 + 70, cy - bh / 2, bw, bh, 46);
      caps(g, 'V', x + w / 2, cy, 34, C.text3, { align: 'center' });
      fit(g, `${a.name}${/\(you\)/.test(lines[0]) ? ' (you)' : ''}`, x + w / 2 - 70 - bw / 2, cy + 70, 300, 700, 26, 18, C.text2, 'center', N);
      fit(g, b.name, x + w / 2 + 70 + bw / 2, cy + 70, 300, 700, 26, 18, C.text2, 'center', N);
      yy = cy + 116; rest = lines.slice(1);
    }
    const r = fitText(g, rest.join('\n'), { maxW: w - 40, maxH: y + h - yy, size: 32, min: 18, weight: 600, wrap: true });
    if (!r.fits) reportOverflow(N, rest.join(' / '), r.width, w - 40);
    g.fillStyle = C.text; g.textAlign = 'center'; g.textBaseline = 'middle';
    const th = r.size + (r.lines.length - 1) * r.lh, top = yy + (y + h - yy - th) / 2;
    r.lines.forEach((ln, i) => g.fillText(ln, x + w / 2, top + r.size / 2 + i * r.lh));
    return;
  }
  const card = inn.card, team = teamByName(card.team || inn.label);
  const lw = Math.round(w * 0.6), rx = x + lw + 20, rw = w - lw - 20;
  // Batting card.
  const bats = card.battedList();
  const ex = card.extrasTotal();
  const rowsN = bats.length + 2;
  const rh = Math.max(30, Math.min(40, (h - 46) / rowsN)), fs = Math.round(Math.min(28, rh * 0.72));
  teamBlock(g, team, x, y, 66, 34, 20);
  caps(g, 'BATTING', x + 80, y + 17, 20, C.accent);
  caps(g, 'R', x + lw - 70, y + 17, 18, C.text3, { align: 'right' });
  caps(g, 'B', x + lw - 8, y + 17, 18, C.text3, { align: 'right' });
  let yy = y + 44;
  bats.forEach((b, i) => {
    if (i % 2 === 0) { g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(x, yy, lw, rh); }
    const cy = yy + rh / 2, atCrease = !b.out;
    g.font = font(700, fs);
    const nameW = Math.min(g.measureText(b.name).width, lw * 0.42);
    fit(g, b.name, x + 10, cy, lw * 0.42, 700, fs, 16, atCrease ? C.text : C.text2, 'left', N);
    fit(g, b.out || 'not out', x + 22 + nameW, cy + 1, lw - 160 - nameW - 22, 500, Math.round(fs * 0.78), 14, atCrease ? C.primaryHi : C.text3, 'left', N);
    fit(g, `${b.runs}${atCrease ? '*' : ''}`, x + lw - 70, cy, 70, 900, fs, 16, atCrease ? C.accentHi : C.text, 'right', N);
    fit(g, String(b.balls), x + lw - 8, cy, 50, 600, Math.round(fs * 0.86), 14, C.text3, 'right', N);
    yy += rh;
  });
  const e = card.extras;
  fit(g, `Extras  (b ${e.byes}, w ${e.wides}, nb ${e.noBalls})`, x + 10, yy + rh / 2, lw - 100, 500, Math.round(fs * 0.82), 14, C.text3, 'left', N);
  fit(g, String(ex), x + lw - 70, yy + rh / 2, 70, 800, Math.round(fs * 0.9), 14, C.text2, 'right', N);
  yy += rh;
  g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x, yy + 2, lw, 2);
  runs(g, [['TOTAL', 900, 20, C.text3, 1], [`${inn.runs}/${inn.wickets}`, 900, fs + 4, C.text], [`(${inn.overs} ov)`, 600, Math.round(fs * 0.8), C.text3, 1]], x + 10, yy + rh / 2 + 6, lw - 20);
  // Bowling figures.
  let ry = y;
  caps(g, 'BOWLING', rx, ry + 17, 20, C.accent);
  const cols = [['O', 118], ['R', 70], ['W', 12]];
  for (const [t, off] of cols) caps(g, t, rx + rw - off, ry + 17, 18, C.text3, { align: 'right' });
  ry += 44;
  const bowl = card.bowlers.filter((b) => b.balls > 0 || b.runs > 0).slice(0, 4);
  const bfs = Math.min(fs, 26);
  for (const b of bowl) {
    fit(g, b.name, rx + 4, ry + 16, rw - 150, 700, bfs, 14, C.text, 'left', N);
    fit(g, oversOf(b.balls), rx + rw - 118, ry + 16, 60, 600, bfs, 14, C.text2, 'right', N);
    fit(g, String(b.runs), rx + rw - 70, ry + 16, 50, 600, bfs, 14, C.text2, 'right', N);
    fit(g, String(b.wickets), rx + rw - 12, ry + 16, 40, 900, bfs, 14, b.wickets ? C.accentHi : C.text, 'right', N);
    ry += Math.max(34, bfs + 10);
  }
  // Fall of wickets.
  if (card.fow.length) {
    ry += 10;
    caps(g, 'FALL OF WICKETS', rx, ry + 12, 18, C.accent);
    ry += 34;
    const t = card.fow.map((f) => `${f.wicket}-${f.score.split('/')[0] || '?'} ${f.name.split(' ').pop()}${f.overs ? ` (${f.overs})` : ''}`).join(' · ');
    const r = fitText(g, t, { maxW: rw - 4, maxH: Math.max(24, y + h - ry - 64), size: 22, min: 16, weight: 500, wrap: true, lineHeight: 1.25 });
    if (!r.fits) reportOverflow(N, t, r.width, rw);
    g.fillStyle = C.text2; g.textAlign = 'left'; g.textBaseline = 'middle';
    r.lines.forEach((ln, i) => g.fillText(ln, rx + 4, ry + r.size / 2 + i * r.lh));
    ry += r.size + (r.lines.length - 1) * r.lh + 14;
  }
  // The balls (the last up to 12).
  const balls = inn.log.slice(-12).map((l) => l.sym);
  if (balls.length && ry < y + h - 50) {
    caps(g, inn.log.length > 12 ? 'LAST 12 BALLS' : 'BALL BY BALL', rx, ry + 12, 18, C.accent);
    ry += 40;
    const rD = 15;
    let cx = rx + 4;
    for (const s of balls) {
      const wd = String(s).length > 1 ? rD * (2.2 + String(s).length * 0.84) : 2 * rD;
      if (cx + wd > rx + rw) { cx = rx + 4; ry += 2 * rD + 8; if (ry > y + h - rD) break; }
      ballDot(g, cx + wd / 2, ry, rD, s); cx += wd + 6;
    }
  }
}

// A match: both innings side by side (score, top batters, best bowling).
function drawTwoInnings(g, rect, a, b) {
  const N = 'menu', { x, y, w, h } = rect, cw = (w - 24) / 2;
  [a, b].forEach((inn, i) => {
    const cx = x + i * (cw + 24), card = inn.card, team = teamByName(card.team || inn.label);
    rr(g, cx, y, cw, h, 16); g.fillStyle = 'rgba(255,255,255,0.05)'; g.fill();
    teamBlock(g, team, cx + 16, y + 16, 96, 60, 32);
    runs(g, [[`${inn.runs}/${inn.wickets}`, 900, 52, C.text], [`(${inn.overs})`, 600, 26, C.text3, 4]], cx + 128, y + 48, cw - 144);
    fit(g, team.name, cx + 16, y + 98, cw - 32, 700, 22, 16, C.text3, 'left', N);
    let yy = y + 132;
    caps(g, 'TOP BATTERS', cx + 16, yy, 17, C.accent); yy += 30;
    const bats = card.battedList().slice().sort((p, q) => q.runs - p.runs || p.balls - q.balls).slice(0, 3);
    for (const bt of bats) {
      fit(g, bt.name, cx + 16, yy + 2, cw - 140, 700, 25, 16, C.text, 'left', N);
      runs(g, [[`${bt.runs}${bt.out ? '' : '*'}`, 900, 25, C.accentHi], [`(${bt.balls})`, 600, 19, C.text3, 1]], cx + cw - 16, yy + 2, 120, 'right');
      yy += 34;
    }
    const best = card.bowlers.filter((q) => q.balls > 0).sort((p, q) => q.wickets - p.wickets || p.runs - q.runs)[0];
    if (best && yy < y + h - 50) {
      yy += 8; caps(g, 'BEST BOWLING', cx + 16, yy, 17, C.accent); yy += 30;
      fit(g, best.name, cx + 16, yy + 2, cw - 140, 700, 25, 16, C.text, 'left', N);
      fit(g, `${best.wickets}/${best.runs} (${oversOf(best.balls)})`, cx + cw - 16, yy + 2, 130, 800, 24, 16, C.text, 'right', N);
    }
  });
}
