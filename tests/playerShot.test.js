// Reading your shot from the bat, your head and the delivery (src/render/playerShot.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, shotOf, ShotReader } from '../src/render/playerShot.js';

const F = (o) => ({ sweep: null, cross: 0, peak: 12, vx: 0, vy: 0, vz: -10, front: 0.6, ballY: 0.6, ...o });

test('classify: the shot from the swing', () => {
  assert.equal(classify(F({})), 'straight');
  assert.equal(classify(F({ vx: 6, vz: -8 })), 'cover');
  assert.equal(classify(F({ vy: 9, vz: -6 })), 'lofted');
  assert.equal(classify(F({ vx: -7, vz: -6 })), 'flick');
  assert.equal(classify(F({ peak: 3 })), 'defend');
  assert.equal(classify(F({ peak: 3, front: -0.6 })), 'backdef');
  assert.equal(classify(F({ front: -0.6 })), 'punch');
  assert.equal(classify(F({ cross: 0.9, vx: -10, vz: -2, front: -0.5, ballY: 0.9 })), 'pull');
  assert.equal(classify(F({ cross: 0.9, vx: -10, vz: -2, front: -0.5, ballY: 1.5 })), 'hook');
  assert.equal(classify(F({ cross: 0.9, vx: 10, vz: -1, front: -0.5 })), 'cut');
  assert.equal(classify(F({ cross: 0.9, vx: 4, vz: 9, front: -0.5 })), 'latecut');
  assert.equal(classify(F({ sweep: { slog: false, reverse: false } })), 'sweep');
  assert.equal(classify(F({ sweep: { slog: true, reverse: false } })), 'slog');
  assert.equal(classify(F({ sweep: { slog: false, reverse: true } })), 'reverse');
  assert.equal(shotOf('cover').type, 'drive');
  assert.ok(shotOf('lofted').want.loft > 0.22);
});

// A scripted swing: stance, backlift, then the bat driven down and through toward the bowler.
function drive(reader, info, opts = {}) {
  const dt = 1 / 60;
  let out = null;
  for (let i = 0; i <= 120; i++) {
    const t = i * dt;
    let y = 0.3, z = -1.0, x = 0.35;
    if (t > 0.3 && t < 0.8) y = 0.3 + 0.9 * Math.sin(Math.PI / 2 * (t - 0.3) / 0.5);           // up
    else if (t >= 0.8) { const k = Math.min(1, (t - 0.8) / 0.1); y = 1.2 - 1.0 * k; z = -1.0 - 0.9 * k; x = 0.35 + (opts.vx || 0) * k; }
    const head = { x: 0.1, y: 1.6, z: -0.9 - (opts.lunge ? Math.min(1, Math.max(0, (t - 0.7) / 0.3)) * 0.3 : 0) };
    out = reader.update(t, { x, y, z }, { x: 0, y: 1, z: 0 }, head, info) || out;
  }
  return out;
}

test('ShotReader: a swing at a coming ball becomes a shot timed to the ball', () => {
  const r = new ShotReader();
  const info = { sweep: null, ball: { id: 1, live: true, arrive: 1.05, y: 0.5, length: 3 }, hit: null };
  const c = drive(r, info, { lunge: true });
  assert.ok(c, 'a shot');
  assert.ok(Math.abs(c.Tc - 1.05) < 1e-9, 'contact when the ball arrives');
  assert.ok(c.tTop > 0.5 && c.tTop < 0.85, 'backlift top ' + c.tTop);
  assert.equal(c.cls, 'straight');
  const r2 = new ShotReader();
  assert.equal(drive(r2, info, { lunge: true, vx: 0.8 }).cls, 'cover');
});

test('ShotReader: no swing (a leave) is no shot; nothing between deliveries', () => {
  const r = new ShotReader();
  const info = { sweep: null, ball: { id: 1, live: true, arrive: 1.0, y: 0.5, length: 3 }, hit: null };
  let c = null;
  for (let i = 0; i < 120; i++) c = r.update(i / 60, { x: 0.3, y: 0.3, z: -1 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 1.6, z: -0.9 }, info) || c;
  assert.equal(c, null);
  const dead = { sweep: null, ball: { id: 1, live: false, arrive: 1.0 }, hit: null };
  assert.equal(drive(new ShotReader(), dead), null);
});
