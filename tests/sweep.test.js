// The sweep's outcome (src/game/sweepShot.js): the ball as your bat played
// it - same speed, its own side - helped halfway into a sweeper's arc; a
// slog sweep goes up, a sweep stays down; edges are left alone; no dice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepShot, SWEEP } from '../src/game/sweepShot.js';
import { Vec3 } from '../src/physics/math.js';
import { CONFIG } from '../src/config.js';

const FACE = { isEdge: false, face: 'front' };
const az = (v) => Math.atan2(v.x, -v.z) * 180 / Math.PI, el = (v) => Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI;
const dir = (azDeg, elDeg, sp) => { const a = azDeg / 57.2958, e = elDeg / 57.2958; return new Vec3(Math.sin(a) * Math.cos(e) * sp, Math.sin(e) * sp, -Math.cos(a) * Math.cos(e) * sp); };

test('a sweep keeps the speed your bat gave it, stays down, and is helped halfway into the arc square on the leg side', () => {
  const v = dir(-30, 25, 22);                       // off the bat: fine of mid-wicket, in the air
  assert.equal(sweepShot(v, FACE, {}), 'sweep');
  assert.ok(Math.abs(v.length() - 22) < 1e-9, 'speed unchanged');
  assert.ok(el(v) <= SWEEP.flat * 57.3 + 1e-6, `kept down (${el(v).toFixed(1)} deg)`);
  assert.ok(Math.abs(az(v) - (-30 + (-SWEEP.arc[0] * 57.29578 + 30) * SWEEP.help)) < 1e-3, `bearing ${az(v).toFixed(1)}`);
  // already square: left where it is
  const w = dir(-100, 5, 15); sweepShot(w, FACE, {}); assert.ok(Math.abs(az(w) + 100) < 1e-4, `${az(w)}`);
});

test('the reverse sweep: the off side, from where the ball went, or (straight) from the way the bat swept', () => {
  const v = dir(70, 5, 18);
  assert.equal(sweepShot(v, FACE, { reverse: false }), 'reverse sweep');
  assert.ok(az(v) > 50 && az(v) < 150);
  const s = dir(5, 5, 18);
  assert.equal(sweepShot(s, FACE, { reverse: true }), 'reverse sweep');
  assert.ok(az(s) > 0);
  const l = dir(5, 5, 18);
  assert.equal(sweepShot(l, FACE, { reverse: false }), 'sweep');
  assert.ok(az(l) < 0);
});

test('the slog sweep goes up in front of square; edges and the back of the bat are left alone; the same every time', () => {
  const v = dir(-120, 5, 25);
  assert.equal(sweepShot(v, FACE, { slog: true }), 'slog sweep');
  const L = CONFIG.bat.sweepLift.map((x) => x * 57.2958);
  assert.ok(el(v) > 5 && el(v) <= L[1] + 1e-6, `lifted to ${el(v).toFixed(1)} deg`);
  assert.ok(az(v) > -120 && az(v) < -60, `toward in front of square (${az(v).toFixed(0)})`);
  for (const ev of [{ isEdge: true, face: 'front' }, { isEdge: false, face: 'back' }, null]) {
    const e = dir(-20, 10, 20), before = e.clone();
    assert.equal(sweepShot(e, ev, {}), null);
    assert.ok(e.x === before.x && e.y === before.y && e.z === before.z);
  }
  const a = dir(-40, 12, 20), b = dir(-40, 12, 20);
  sweepShot(a, FACE, { slog: true }); sweepShot(b, FACE, { slog: true });
  assert.ok(a.x === b.x && a.y === b.y && a.z === b.z, 'deterministic');
});

// The session and the game (need three.js through their imports; skipped without it).
let BattingSession = null, Game = null;
try {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  ({ BattingSession } = await import('../src/game/batting.js'));
  ({ Game } = await import('../src/game/game.js'));
} catch { BattingSession = null; }
const skip = BattingSession ? false : 'three.js is not installed (npm install)';
const { Quat, Pose } = await import('../src/physics/math.js');

// Down low yourself: eyes at `eye` m (standing 1.62), the bat's middle at `mid` lying `flat` (or upright), moving at `v` m/s.
function lowRead(steps) {
  const pose = new Pose(), R = { connected: true, linVel: new Vec3(), angVel: new Vec3() };
  const g = { input: { xr: true, headRef: { p: { x: 0, y: 1.56, z: 0 } }, right: R }, standEye: 1.62, playerBatProvider: { curr: { pose } }, rig: { position: { y: 0 } } };
  const s = Object.create(BattingSession.prototype);
  s.game = g;
  const out = [];
  for (const st of steps) for (let i = 0; i < st.n; i++) {
    g.input.headRef.p.y = st.eye;
    // the bat: flat (handle to the leg side, toe to the off side) or upright (handle up), its middle at st.mid
    if (st.flat) pose.q.setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 2); else pose.q.set(0, 1, 0, 0);
    const up = new Vec3(0, 1, 0).applyQuat(pose.q);
    pose.p.set(0.1, st.mid, -1.2).addScaled(up, 0.62);
    R.linVel.set(0, 0, -(st.v || 0));
    out.push(s.readLowSweep(1 / 72));
  }
  return out;
}

test('down low yourself with the bat across the line low: a sweep (and over once you stand up)', { skip }, () => {
  const o = lowRead([{ eye: 1.56, mid: 0.5, flat: false, n: 30 }, { eye: 0.95, mid: 0.3, flat: true, n: 30 }, { eye: 1.35, mid: 0.6, flat: false, n: 30 }]);
  assert.ok(!o[29], 'standing: no sweep');
  assert.ok(o.slice(30 + 9, 60).every(Boolean), 'down low with the bat flat: a sweep within 0.12 s');
  assert.ok(!o[89], 'stood back up: over');
  // swinging at the ball low down counts as well, the bat upright
  const sw = lowRead([{ eye: 0.95, mid: 0.3, flat: false, v: 6, n: 30 }]);
  assert.ok(sw[29], 'swinging at the ball, low');
});

test('not a sweep: a batting crouch, a lunge, a duck under a bouncer, a quick crouch to ground the bat', { skip }, () => {
  const crouch = lowRead([{ eye: 1.38, mid: 0.3, flat: true, n: 60 }]);                    // a deep batting crouch / forward-defence lunge
  const duck = lowRead([{ eye: 0.9, mid: 1.0, flat: false, n: 60 }]);                      // ducked, the bat up out of the way
  const duckFlat = lowRead([{ eye: 0.9, mid: 1.05, flat: true, n: 60 }]);                   // ducked, the bat held flat over the head
  const ground = lowRead([{ eye: 1.0, mid: 0.2, flat: false, n: 60 }]);                     // crouched, the bat grounded upright, still
  const blip = lowRead([{ eye: 0.95, mid: 0.3, flat: true, n: 6 }, { eye: 1.5, mid: 0.6, flat: false, n: 30 }]);   // down and up in 80 ms
  for (const [n, o] of [['crouch', crouch], ['duck', duck], ['duck, bat flat', duckFlat], ['grounding the bat', ground], ['a blip', blip]]) assert.ok(!o.some(Boolean), `${n}: read as a sweep`);
});

test('the sweep button drops your view to a kneeling sweeper\'s eyes in ~0.2 s, never twice, back up in ~0.3 s, not in a menu', { skip: Game ? false : skip }, () => {
  let held = true;
  const g = { input: { xr: true, headRef: { p: { y: 1.6 } }, refreshHeadWorld() {} }, mr: false, end: 'batting', state: 'play', ui: { menuOpen: false }, viewOverride: null, replay: { active: false },
    session: { isBowling: false, sweepSlog: false, sweepDrop: () => (held ? 1 : 0) }, playerBody: { kneelEyeY: () => 1.0 }, rig: { position: { y: 0 }, updateMatrixWorld() {} }, rigDrop: 0, rigDropV: 0 };
  const step = (n) => { const o = []; for (let i = 0; i < n; i++) { Game.prototype.updateRigDrop.call(g, 1 / 72); o.push(g.rigDrop); } return o; };
  const down = step(30);
  const t90 = down.findIndex((d) => d >= 0.9 * 0.6) / 72;
  assert.ok(t90 > 0 && t90 <= 0.25, `90% down in ${t90.toFixed(3)} s`);
  assert.ok(Math.max(...down) <= 0.6 + 1e-6, 'no overshoot');
  assert.ok(Math.abs(g.rig.position.y + g.rigDrop) < 1e-9, 'the rig moved down by the drop');
  // crouching yourself as well: the eyes stay at the kneeling height, the view does not drop twice
  g.input.headRef.p.y = 1.25; step(40);
  assert.ok(Math.abs(g.rigDrop - 0.25) < 0.01, `crouched: drop ${g.rigDrop.toFixed(3)}`);
  g.input.headRef.p.y = 0.9; step(40);
  assert.ok(g.rigDrop < 0.01, 'right down yourself: no drop');
  g.input.headRef.p.y = 1.6; step(40);
  held = false;
  const up = step(40), back = up.findIndex((d) => d <= 0.06) / 72;
  assert.ok(back > 0.15 && back <= 0.4, `back up in ${back.toFixed(3)} s`);
  assert.ok(up.every((d) => d >= 0), 'never above your real head');
  held = true; step(40); g.ui.menuOpen = true; step(60);
  assert.ok(g.rigDrop < 0.005, 'a menu opens: back up');
});

test('a bat riding the turf under the view drop: the contact physics turns it about its own (lifted) grip, and it is not going down', { skip: Game ? false : skip }, async () => {
  const THREE = await import('three');
  const { InterpolatedBatProvider } = await import('../src/physics/world.js');
  const { SwingLoad } = await import('../src/physics/swingLoad.js');
  const grip = new Pose(new Vec3(0.1, 0.3, -1.0), new Quat(0, 0, 0, 1));
  const g = { input: { xr: true, right: { connected: true, tracked: true, gripPose: grip, linVel: new Vec3(0, -3, -1), angVel: new Vec3(10, 0, 0) }, headPose: { p: new Vec3(-0.25, 1.1, -1.05) } },
    session: { isBowling: false }, state: 'play', ui: { menuOpen: false }, viewOverride: null, batMesh: new THREE.Object3D(), playerBat: { swing: new SwingLoad() },
    playerBatProvider: new InterpolatedBatProvider(), calibration: new Quat(0, 0, 0, 1), settings: {}, rigDrop: 0.5, simTime: 1, realNow: 1, rig: { position: { y: -0.5 } }, snapBat: false };
  Object.setPrototypeOf(g, Game.prototype);
  g.updatePlayerBat(false);
  const c = g.playerBatProvider.curr;
  assert.ok(g.batLift > 0.3, `the bat is lifted onto the turf (${g.batLift.toFixed(2)} m)`);
  assert.ok(c.grip.distanceTo(c.pose.p) < 1e-9, 'the grip the bat turns about is the lifted one');
  assert.ok(c.lin.y >= 0 && c.lin.z === -1, 'no downward speed into the turf; the rest kept');
});
