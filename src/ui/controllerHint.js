// Control hints: a small picture of the Touch controller with the button you
// need lit up (or the key on a desktop keyboard), plus what it does.
//
// hint = { hand: 'L' | 'R', button: 'trigger' | 'grip' | 'a' | 'b' | 'ab' | 'stick' |
//          'stickX' | 'stickY' | 'click', label: 'RUN', sub: 'press X', key: 'Space' }
// (On the left controller 'a' / 'b' are drawn as X / Y.)

const LIT = '#ffd34d', LIT_GLOW = 'rgba(255,211,77,0.55)';
const BODY = '#232a33', EDGE = '#8a96a3', DIM = '#46505c', TXT = '#e8eef5';

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function glow(g, on) {
  g.shadowColor = on ? LIT_GLOW : 'transparent';
  g.shadowBlur = on ? 18 : 0;
}

// Front view of a Touch Plus controller, fitted in a box of size s, centred at (cx, cy).
export function drawController(g, cx, cy, s, hand, button) {
  const L = hand === 'L', m = L ? -1 : 1;           // mirror the left one
  const on = (b) => button === b || (button === 'ab' && (b === 'a' || b === 'b'));
  g.save();
  g.translate(cx, cy);
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.lineWidth = s * 0.02;
  // Handle (drawn first, under the face).
  g.fillStyle = BODY; g.strokeStyle = EDGE;
  g.beginPath();
  g.moveTo(-s * 0.13, s * 0.02);
  g.quadraticCurveTo(-s * 0.14, s * 0.36, -s * 0.06, s * 0.45);
  g.lineTo(s * 0.06, s * 0.45);
  g.quadraticCurveTo(s * 0.14, s * 0.36, s * 0.13, s * 0.02);
  g.closePath(); g.fill(); g.stroke();
  // Grip button: along the inside edge of the handle (middle finger).
  glow(g, on('grip'));
  g.fillStyle = on('grip') ? LIT : DIM;
  rr(g, -m * s * 0.155 - s * 0.045, s * 0.05, s * 0.09, s * 0.3, s * 0.045);
  g.fill();
  glow(g, false);
  // Face.
  g.fillStyle = BODY; g.strokeStyle = EDGE;
  g.beginPath(); g.ellipse(0, -s * 0.14, s * 0.3, s * 0.22, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  // Trigger: a thick band over the top front (index finger).
  glow(g, on('trigger'));
  g.strokeStyle = on('trigger') ? LIT : DIM;
  g.lineWidth = s * 0.075;
  g.beginPath(); g.ellipse(0, -s * 0.14, s * 0.3, s * 0.22, 0, Math.PI * 1.18, Math.PI * 1.82); g.stroke();
  glow(g, false);
  g.lineWidth = s * 0.02;
  // Thumbstick (inboard).
  const sx = -m * s * 0.12, sy = -s * 0.12;
  const stickLit = on('stick') || on('stickX') || on('stickY') || on('click');
  glow(g, stickLit);
  g.fillStyle = stickLit ? LIT : DIM;
  g.beginPath(); g.arc(sx, sy, s * 0.085, 0, Math.PI * 2); g.fill();
  glow(g, false);
  if (on('click')) {
    g.strokeStyle = LIT; g.lineWidth = s * 0.025;
    g.beginPath(); g.arc(sx, sy, s * 0.125, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(sx, sy - s * 0.3); g.lineTo(sx, sy - s * 0.19); g.stroke();      // "push down"
    g.beginPath(); g.moveTo(sx - s * 0.04, sy - s * 0.23); g.lineTo(sx, sy - s * 0.18); g.lineTo(sx + s * 0.04, sy - s * 0.23); g.stroke();
  }
  if (on('stick') || on('stickX') || on('stickY')) {
    g.fillStyle = LIT;
    const arrows = on('stickY') ? [[0, -1], [0, 1]] : on('stickX') ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (const [ax, ay] of arrows) {
      const px = sx + ax * s * 0.15, py = sy + ay * s * 0.15;
      g.beginPath();
      g.moveTo(px + ax * s * 0.07, py + ay * s * 0.07);
      g.lineTo(px - ay * s * 0.05, py + ax * s * 0.05);
      g.lineTo(px + ay * s * 0.05, py - ax * s * 0.05);
      g.closePath(); g.fill();
    }
  }
  // Face buttons (outboard): A/B on the right controller, X/Y on the left.
  const names = L ? { a: 'X', b: 'Y' } : { a: 'A', b: 'B' };
  for (const [b, bx, by] of [['a', m * s * 0.1, -s * 0.06], ['b', m * s * 0.17, -s * 0.2]]) {
    glow(g, on(b));
    g.fillStyle = on(b) ? LIT : DIM;
    g.beginPath(); g.arc(bx, by, s * 0.062, 0, Math.PI * 2); g.fill();
    glow(g, false);
    g.fillStyle = on(b) ? '#1a1a1a' : '#c9d3dd';
    g.font = `800 ${Math.round(s * 0.075)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(names[b], bx, by + s * 0.004);
  }
  // Which hand.
  g.fillStyle = '#7f8fa0';
  g.font = `700 ${Math.round(s * 0.065)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.fillText(L ? 'LEFT' : 'RIGHT', 0, s * 0.3);
  g.restore();
}

// A keyboard key.
export function drawKey(g, cx, cy, s, key) {
  const w = Math.max(s * 0.42, s * 0.12 * key.length + s * 0.16), h = s * 0.34;
  g.save();
  glow(g, true);
  g.fillStyle = LIT;
  rr(g, cx - w / 2, cy - h / 2, w, h, s * 0.06);
  g.fill();
  glow(g, false);
  g.fillStyle = '#1a1a1a';
  g.font = `800 ${Math.round(s * 0.15)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(key, cx, cy + s * 0.01);
  g.restore();
}

// One card: picture on top, action and button underneath.
export function drawHintCard(g, x, y, w, h, hint, desktop) {
  g.save();
  g.fillStyle = 'rgba(10,15,24,0.78)';
  rr(g, x, y, w, h, 22);
  g.fill();
  g.strokeStyle = 'rgba(255,211,77,0.55)'; g.lineWidth = 3;
  g.stroke();
  const pic = h * 0.64;
  if (desktop && hint.key) drawKey(g, x + w / 2, y + pic * 0.55, pic, hint.key);
  else drawController(g, x + w / 2, y + pic * 0.52, pic * 1.12, hint.hand || 'R', hint.button);
  g.fillStyle = TXT; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 ${Math.round(h * 0.13)}px system-ui, sans-serif`;
  g.fillText(hint.label, x + w / 2, y + h * 0.77);
  g.fillStyle = '#9fb2c4';
  g.font = `600 ${Math.round(h * 0.075)}px system-ui, sans-serif`;
  g.fillText(desktop && hint.key ? `key ${hint.key}` : hint.sub || '', x + w / 2, y + h * 0.9);
  g.restore();
}

// Control hints shown with a picture of the controller (see ui/controllerHint.js).
export const HINTS = {
  stepOut:  { hand: 'R', button: 'trigger', label: 'STEP OUT', sub: 'hold trigger', key: 'Shift' },
  sweep:    { hand: 'R', button: 'grip', label: 'SWEEP', sub: 'hold grip', key: 'S' },
  next:     { hand: 'L', button: 'a', label: 'NEXT BALL', sub: 'press X', key: 'Space' },
  run:      { hand: 'L', button: 'a', label: 'RUN', sub: 'press X', key: 'Space' },
  another:  { hand: 'L', button: 'a', label: 'ANOTHER', sub: 'X when home', key: 'Space' },
  back:     { hand: 'L', button: 'trigger', label: 'GO BACK', sub: 'left trigger', key: 'G' },
  dive:     { hand: 'L', button: 'b', label: 'DIVE', sub: 'hold Y', key: 'V' },
  move:     { hand: 'L', button: 'stick', label: 'MOVE', sub: 'left stick', key: 'Arrows' },
  menu:     { hand: 'L', button: 'click', label: 'MENU', sub: 'click left stick', key: 'Esc' },
  review:   { hand: 'R', button: 'a', label: 'REVIEW', sub: 'press A', key: 'Z' },
  toKeeper: { hand: 'R', button: 'a', label: 'TO KEEPER', sub: 'press A', key: 'Z' },
  toBowler: { hand: 'R', button: 'b', label: "BOWLER'S END", sub: 'press B', key: 'X' },
  bowl:     { hand: 'R', button: 'trigger', label: 'BOWL', sub: 'hold, swing, let go', key: 'Mouse' },
  runIn:    { hand: 'R', button: 'grip', label: 'RUN IN', sub: 'hold grip', key: 'R' },
  delivery: { hand: 'R', button: 'ab', label: 'DELIVERY', sub: 'A next · B back', key: 'Z / X' },
  look:     { hand: 'R', button: 'stickX', label: 'LOOK', sub: 'right stick ◂ ▸', key: '' },
  // By feel only (Settings): the seam from A / B or the wrist.
  outswing: { hand: 'R', button: 'a', label: 'OUT-SWING', sub: 'or turn wrist left', key: 'Z' },
  inswing:  { hand: 'R', button: 'b', label: 'IN-SWING', sub: 'or turn wrist right', key: 'X' },
  aim:      { hand: 'L', button: 'stick', label: 'AIM', sub: 'left stick', key: 'Arrows' },
};
