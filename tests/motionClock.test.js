// Your movements are read on the real clock, whatever the slow motion
// (difficulty time scale, catching): the same physical swing gives the same
// controller velocity, the same shot reading and the same body at 72, 90 and
// 120 Hz and at every time scale. The ball, collisions, the log and the
// replay stay on the game clock. Pure JS apart from the Controller test
// (src/xr/input.js imports three.js: skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotSense } from '../src/render/shotSense.js';
import { shotTrack, SHOTS } from './battingTracks.js';
import { Vec3, Quat } from '../src/physics/math.js';

let input = null;
try { input = await import('../src/xr/input.js'); } catch { input = null; }

const axisOf = (q) => ({ x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) });
const faceOf = (q) => ({ x: 2 * (q.x * q.z + q.w * q.y), y: 2 * (q.y * q.z - q.w * q.x), z: 1 - 2 * (q.x * q.x + q.y * q.y) });

// A scripted track (real time) as the game logs it at time scale `ts`: the game clock (t, dt) runs
// ts times slower than the real one (mt, mdt) your movements are made on.
function slowed(trk, ts) {
  const t0 = trk[0].t;
  return trk.map((e) => ({ ...e, t: t0 + (e.t - t0) * ts, dt: e.dt * ts, mt: e.t, mdt: e.dt }));
}
// What the reader makes of a logged track, read the way PlayerBodyView.solve feeds it.
function readLogged(trk) {
  const S = new ShotSense();
  let maxE = 0, peak = 0;
  const shown = [];
  for (const e of trk) {
    const o = S.update(e.mt ?? e.t, e.mdt ?? e.dt, e.head.p, e.bp, axisOf(e.bq), e.off, { sweep: null, hitT: null, simT: e.t, live: true, face: faceOf(e.bq) });
    maxE = Math.max(maxE, o.engage);
    if (o.feat) peak = Math.max(peak, o.feat.peak);
    if (o.engage > 0.15 && o.leader && o.leader !== shown[shown.length - 1]) shown.push(o.leader);
  }
  return { maxE, peak, last: shown[shown.length - 1] || null };
}

test('shot reading: the same swing reads the same at every time scale (the real clock)', () => {
  for (const name of ['cover_drive', 'pull', 'forward_defence', 'sweep']) {
    const real = shotTrack(name);
    const ref = readLogged(slowed(real, 1));
    for (const ts of [0.85, 0.7, 0.22]) {
      const r = readLogged(slowed(real, ts));
      assert.equal(r.last, ref.last, `${name} at x${ts}: read as ${r.last}, at full speed ${ref.last}`);
      assert.ok(Math.abs(r.peak - ref.peak) < 1e-9, `${name} at x${ts}: peak bat speed ${r.peak.toFixed(3)} vs ${ref.peak.toFixed(3)} m/s`);
      assert.ok(Math.abs(r.maxE - ref.maxE) < 1e-9, `${name} at x${ts}: engagement ${r.maxE} vs ${ref.maxE}`);
    }
  }
});

test('shot reading: the same swing at 72, 90 and 120 Hz is the same shot at much the same speed', () => {
  for (const name of ['cover_drive', 'straight_drive', 'pull', 'cut', 'back_foot_punch']) {
    const rs = [72, 90, 120].map((hz) => readLogged(slowed(shotTrack(name, { hz }), 0.85)));
    for (const r of rs) {
      assert.ok(SHOTS[name].want.includes(r.last), `${name}: read as ${r.last}`);
      assert.ok(Math.abs(r.peak - rs[0].peak) / rs[0].peak < 0.12, `${name}: peak ${rs.map((x) => x.peak.toFixed(2)).join(' / ')} m/s`);
      assert.ok(r.maxE > 0.9);
    }
  }
});

test('a gap in the frames (a hitch, a replay) is not read as a swing', () => {
  const trk = shotTrack('waggle');
  const S = new ShotSense();
  let maxE = 0, t = 0;
  for (let i = 0; i < trk.length; i++) {
    const e = trk[i];
    // (half way through, 0.6 s of nothing, and the bat is somewhere else when the frames come back)
    if (i === 200) t += 0.6;
    const bp = i >= 200 ? { x: e.bp.x + 0.5, y: e.bp.y + 0.4, z: e.bp.z - 0.4 } : e.bp;
    const o = S.update(e.t + t, e.dt, e.head.p, bp, axisOf(e.bq), e.off, { sweep: null, hitT: null, live: false, face: faceOf(e.bq) });
    maxE = Math.max(maxE, o.engage);
  }
  assert.ok(maxE < 0.05, `a jump of the bat across a gap read as a stroke (${maxE.toFixed(2)})`);
});

test('controller velocity from poses is physical m/s at 72, 90 and 120 Hz; a long gap starts the history again', { skip: input ? false : 'three.js is not installed (npm install)' }, () => {
  const { Controller, MOTION_GAP } = input;
  for (const hz of [72, 90, 120]) {
    const c = new Controller('right');
    const axis = new Vec3(1, 0, 0), q0 = new Quat(0, 1, 0, 0), qa = new Quat();
    // 1 m/s along -Z, 2 rad/s about +X, sampled on the real frame clock
    for (let i = 0; i <= hz; i++) {
      const t = 100 + i / hz;
      c.gripPose.p.set(0, 1, -t + 100);
      qa.setFromAxisAngle(axis, 2 * (t - 100));
      c.gripPose.q.multiplyQuats(qa, q0);
      c._record(t, false);
    }
    assert.ok(Math.abs(c.linVel.length() - 1) < 1e-6, `${hz} Hz: ${c.linVel.length()} m/s`);
    assert.ok(Math.abs(c.angVel.length() - 2) < 1e-6, `${hz} Hz: ${c.angVel.length()} rad/s`);
    // the bat put somewhere else after a gap (the rig moved, tracking came back): no velocity, a new history
    c.gripPose.p.set(3, 1, 3);
    c._record(101 + MOTION_GAP + 0.1, false);
    assert.equal(c.linVel.length(), 0);
    assert.equal(c.history.length, 1);
  }
});


// The real caller: Game.frame samples the controllers on the frame clock, not the slowed game clock.
let Game = null;
if (input) {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  try { ({ Game } = await import('../src/game/game.js')); } catch { Game = null; }
}
test('Game.frame: the same physical motion gives the same controller velocity at every time scale and refresh rate', { skip: Game ? false : 'three.js is not installed (npm install)' }, () => {
  const { Controller } = input, stop = Symbol('sampled'), axis = new Vec3(0, 1, 0);
  for (const hz of [72, 90, 120]) for (const ts of [1, 0.85, 0.7]) {
    const c = new Controller('right');
    // (a stand-in game: Game.frame runs up to its input.update, which samples and stops it there)
    const g = { lastNow: null, stats: { fpsAccum: 0, frames: 0 }, ui: { menuOpen: false }, timeScale: ts, timeScaleTarget: ts, clock: 0, simTime: 0, session: {},
      input: { xr: false, update(t) { c._record(t, false); throw stop; } } };
    for (let i = 0; i < 100; i++) {
      const rt = i / hz;
      c.gripPose.p.set(rt, 0, 0); c.gripPose.q.setFromAxisAngle(axis, 2 * rt);
      try { Game.prototype.frame.call(g, 1000 + rt * 1000, null); } catch (e) { if (e !== stop) throw e; }
    }
    assert.ok(Math.abs(c.linVel.length() - 1) < 1e-6, `${hz} Hz x${ts}: ${c.linVel.length().toFixed(4)} m/s (1 m/s moved)`);
    assert.ok(Math.abs(c.angVel.length() - 2) < 1e-6, `${hz} Hz x${ts}: ${c.angVel.length().toFixed(4)} rad/s (2 rad/s turned)`);
    assert.ok(Math.abs(g.simTime - (99 / hz + 1 / 72) * ts) < 1e-9, `the game clock is still the slowed one (${g.simTime})`);
  }
});

// Bowling after a long slowed batting spell: the controller history is on the real clock, which by then
// is far ahead of the game clock; the release reads the fastest hand speed in the last 0.25 s of it.
let BowlingSession = null;
if (input) { try { ({ BowlingSession } = await import('../src/game/bowling.js')); } catch { BowlingSession = null; } }
test('bowling after a long slowed batting spell: the release reads the hand of the last 0.25 s (real clock)', { skip: BowlingSession ? false : 'three.js is not installed (npm install)' }, () => {
  const { Controller } = input, R = new Controller('right');
  // 100 s of real time have gone, 70 s of game time (easy's 0.7 while the ball was live)
  const t0 = 1100;
  let y = 2;
  for (let i = 0; i <= 72; i++) {
    const t = t0 + i / 72, k = i / 72;
    // a quick waggle of the arm half a second before (12 m/s), then the delivery itself at 6 m/s
    y -= (k > 0.3 && k < 0.45 ? 12 : k > 0.7 ? 6 : 0.5) / 72;
    R.gripPose.p.set(0.5, y, -19);
    R.gripPose.q.set(0, 0, 0, 1);
    R._record(t, false);
  }
  let got = null;
  const g = { simTime: 70, input: { xr: true, right: R }, ui: { prompt() {}, setHud() {} }, aiBatter: { reset() {} }, palmDir: (o) => o.set(0, 0, 1) };
  const s = Object.create(BowlingSession.prototype);
  Object.assign(s, { game: g, run: { canRelease: true, enabled: false, speed: 0 }, rigShift: 0, holding: true, updateHud() {}, bowl: (o) => { got = o; } });
  s.attemptRelease();
  assert.ok(got, 'a delivery (not "dropped it")');
  const peak = R.history.slice(-18).reduce((m, h) => Math.max(m, h.v.length()), 0);
  assert.ok(Math.abs(got.paceSpeed - peak) < 1e-9 && got.paceSpeed < 7, `pace from the last 0.25 s: ${got.paceSpeed.toFixed(2)} vs ${peak.toFixed(2)} m/s (not the waggle before)`);
});
