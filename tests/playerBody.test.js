// Your own batting body (src/render/playerBody.js) on the real rig and the
// real shot captures, driven by scripted players (tests/battingTracks.js):
// the invariants the solver must keep in every stroke, and the replay
// re-solve giving exactly the body you had. Needs three.js (npm install);
// skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SHOTS, shotTrack } from './battingTracks.js';

let THREE = null;
try { THREE = await import('three'); } catch { THREE = null; }
const skip = THREE ? false : 'three.js is not installed (npm install)';

function shimBrowser() {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  globalThis.fetch = async (url) => {
    const buf = fs.readFileSync(new URL(url));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
}

let M = null;
async function load() {
  if (M) return M;
  shimBrowser();
  const root = new URL('../', import.meta.url).href;
  const humanoid = await import('../src/render/humanoid.js');
  const clips = await import('../src/render/clips.js');
  const shots = await import('../src/render/shots.js');
  await humanoid.loadAthlete(root + 'assets/models/');
  await clips.loadClips(root + 'assets/anim/');
  await shots.loadShots(root + 'assets/anim/');
  const { PlayerBodyView } = await import('../src/render/playerBody.js');
  const { PITCH } = await import('../src/physics/pitch.js');
  const body = new PlayerBodyView(new THREE.Scene());
  const A = body.actor, h = A.h;
  h.root.scale.setScalar(h.baseScale * 1.62 / (A.headRestY * h.baseScale + 0.11));       // your height (eyes 1.62 m), as the game sizes it
  return (M = { body, A, h, PITCH, shots });
}

const BODY = ['hips', 'spine', 'chest', 'neck', 'head', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const V = () => new THREE.Vector3();
// The same rotation (component-wise; angleTo of two equal quaternions can read ~1e-8 from acos round-off).
const same = (a, b, eps = 1e-9) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps && Math.abs(a.w - b.w) < eps;

// Closest distance between segments p1-q1 and p2-q2.
function segDist(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r), c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b;
  let s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0, t = e > 1e-9 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

// One scripted stroke through the live solver; per frame the pose and the measures.
function play(m, name, tweak = null) {
  const { body, A, h, PITCH } = m, trk = tweak ? tweak(shotTrack(name)) : shotTrack(name);
  body.reset();
  const bp = V(), bq = new THREE.Quaternion(), top = V(), sc = h.root.scale.x, ankleY = h.ankleHeight * sc;
  const ix = BODY.map((n) => h.boneList.indexOf(h.bones[n]));
  const stumps = [-0.1143, 0, 0.1143].map((x) => [new THREE.Vector3(x, 0, PITCH.battingStumpsZ), new THREE.Vector3(x, 0.71, PITCH.battingStumpsZ)]);
  const R = { frames: [], glove: 0, jump: 0, jumpAt: '', slide: 0, low: 0, guard: 0, headMax: 0, headMean: 0, stump: 9, tilt: 0, tiltUp: 0, trunkTurn: 0 };
  let prev = null;
  for (let i = 0; i < trk.length; i++) {
    const e = trk[i];
    bp.set(e.bp.x, e.bp.y, e.bp.z); bq.set(e.bq.x, e.bq.y, e.bq.z, e.bq.w);
    body.update(e.dt, e.t, bp, bq, null, e.head, e.extra, e.off, e.turn || 0, e.mt != null ? { t: e.mt, dt: e.mdt } : null);
    h.update();
    const f = { t: e.t, q: h.boneList.map((b) => b.quaternion.clone()), hp: h.bones.hips.position.clone(), rp: h.root.position.clone(),
      ankL: h.worldPos('ankleL', V()), ankR: h.worldPos('ankleR', V()), trunk: h.worldPos('neck', V()).sub(h.worldPos('hips', V())).normalize() };
    R.frames.push(f);
    // the gloves on the handle (bottom hand on the grip point, top hand a hand's width up)
    top.copy(bp).add(V().set(0, 0.105, 0).applyQuaternion(bq));
    R.glove = Math.max(R.glove, Math.abs(h.worldPos('handR', V()).distanceTo(bp) - 0.075), Math.abs(h.worldPos('handL', V()).distanceTo(top) - 0.075));
    if (prev && i > 3) {
      for (const k of ix) { const a = f.q[k].angleTo(prev.q[k]) * 180 / Math.PI; if (a > R.jump) { R.jump = a; R.jumpAt = h.boneList[k].name + '@' + (e.t - trk[0].t).toFixed(2); } }
      for (const sd of ['L', 'R']) {
        const a = f['ank' + sd], b = prev['ank' + sd];
        if (a.y < ankleY + 0.012 && b.y < ankleY + 0.012) R.slide = Math.max(R.slide, Math.hypot(a.x - b.x, a.z - b.z));
      }
      R.trunkTurn = Math.max(R.trunkTurn, Math.acos(Math.min(1, f.trunk.dot(prev.trunk))) * 180 / Math.PI);
    }
    R.low = Math.min(R.low, h.lowest());
    R.guard = Math.max(R.guard, h.guardLift || 0);
    const he = h.worldPos('head', V()).distanceTo(V().set(e.head.p.x, e.head.p.y - 0.11, e.head.p.z));
    R.headMax = Math.max(R.headMax, he); R.headMean += he / trk.length;
    for (const sd of ['L', 'R']) {
      const hip = h.worldPos('hip' + sd, V()), kn = h.worldPos('knee' + sd, V()), an = h.worldPos('ankle' + sd, V());
      for (const [s0, s1] of stumps) R.stump = Math.min(R.stump, segDist(hip, kn, s0, s1) - 0.12, segDist(kn, an, s0, s1) - 0.13);
    }
    const tilt = Math.acos(Math.min(1, f.trunk.y)) * 180 / Math.PI;
    R.tilt = Math.max(R.tilt, tilt);
    if (1.62 - e.head.p.y < 0.15) R.tiltUp = Math.max(R.tiltUp, tilt);
    prev = f;
  }
  return { trk, R };
}

const NAMES = Object.keys(SHOTS);
let RUNS = null;
async function runs() {
  if (RUNS) return RUNS;
  const m = await load();
  RUNS = {};
  for (const n of NAMES) RUNS[n] = play(m, n).R;
  return RUNS;
}

test('your gloves stay on your bat in every stroke', { skip }, async () => {
  for (const [n, R] of Object.entries(await runs())) assert.ok(R.glove < 0.005, `${n}: gloves ${(R.glove * 100).toFixed(2)} cm off the handle`);
});

test('no pops: no body joint turns more than 35 deg in a frame, the trunk never tips (<= 8 deg a frame)', { skip }, async () => {
  for (const [n, R] of Object.entries(await runs())) {
    assert.ok(R.jump < 35, `${n}: ${R.jump.toFixed(1)} deg at ${R.jumpAt}`);
    assert.ok(R.trunkTurn < 8, `${n}: trunk turns ${R.trunkTurn.toFixed(1)} deg in a frame`);
  }
});

test('the trunk stays upright as a batter\'s does: never past 60 deg, and within 45 deg while your head is up', { skip }, async () => {
  for (const [n, R] of Object.entries(await runs())) {
    assert.ok(R.tilt < 60, `${n}: trunk tilted ${R.tilt.toFixed(1)} deg`);
    assert.ok(R.tiltUp < 45, `${n}: trunk tilted ${R.tiltUp.toFixed(1)} deg with your head within 15 cm of standing`);
  }
});

test('planted feet do not slide; nothing goes through the turf or the stumps', { skip }, async () => {
  for (const [n, R] of Object.entries(await runs())) {
    assert.ok(R.slide < 0.006, `${n}: a planted foot slides ${(R.slide * 100).toFixed(2)} cm in a frame`);
    assert.ok(R.low > -0.005, `${n}: ${(R.low * 100).toFixed(1)} cm under the turf`);
    assert.ok(R.guard < 0.03, `${n}: the ground guard had to lift the figure ${(R.guard * 100).toFixed(1)} cm`);
    assert.ok(R.stump > 0, `${n}: legs ${(R.stump * 100).toFixed(1)} cm into the stumps`);
  }
});

test('the head is on your head: within 4 cm on average, 15 cm at worst', { skip }, async () => {
  for (const [n, R] of Object.entries(await runs())) {
    assert.ok(R.headMean < 0.04, `${n}: mean head error ${(R.headMean * 100).toFixed(1)} cm`);
    assert.ok(R.headMax < 0.15, `${n}: head ${(R.headMax * 100).toFixed(1)} cm off yours`);
  }
});

test('replay: the sliced re-solve gives exactly the body you had, and the gloves stay on in the replay', { skip }, async () => {
  const m = await load(), { body, A, h } = m;
  for (const n of ['cover_drive', 'sweep', 'hook', 'advance_drive', 'turn_round']) {
    const { trk, R } = play(m, n);
    const live = new Map(R.frames.map((f) => [f.t, f]));
    const before = h.boneList.map((b) => b.quaternion.clone()), rp = h.root.position.clone();
    const t0 = trk[20].t, t1 = trk[trk.length - 1].t;
    const job = body.resolveBegin(t0, t1);
    assert.ok(job, `${n}: nothing to re-solve`);
    let made = 0, last = -Infinity, rep = 0, pos = 0, steps = 0, done = false;
    const poses = [];
    const write = (t, hh) => {
      const f = live.get(t);
      assert.ok(f && t >= t0 && t > last, 'poses in order, from t0');
      last = t; made++;
      hh.boneList.forEach((b, k) => { rep = Math.max(rep, b.quaternion.angleTo(f.q[k])); });
      pos = Math.max(pos, hh.bones.hips.position.distanceTo(f.hp), hh.root.position.distanceTo(f.rp));
      poses.push({ t, q: hh.boneList.map((b) => b.quaternion.clone()), hp: hh.bones.hips.position.clone(), rp: hh.root.position.clone(), rq: hh.root.quaternion.clone() });
    };
    while (!done) {
      const n0 = made;
      done = body.resolveStep(job, 3, write);
      steps++;
      assert.ok(made - n0 <= 3, 'at most `count` poses a step');
    }
    body.resolveEnd(job);
    assert.equal(made, trk.filter((e) => e.t >= t0 && e.t <= t1).length, `${n}: every frame of the clip`);
    assert.ok(rep * 180 / Math.PI < 0.01 && pos < 1e-4, `${n}: replay differs by ${(rep * 180 / Math.PI).toFixed(3)} deg, ${(pos * 100).toFixed(3)} cm`);
    // the live figure is put back as it was
    h.boneList.forEach((b, k) => assert.ok(same(b.quaternion, before[k]), 'live pose restored: ' + b.name));
    assert.ok(h.root.position.distanceTo(rp) < 1e-9);
    // as the replay shows it: the recorded joints, the arms as long as they were then (replayArms)
    let rg = 0;
    const bp = V(), bq = new THREE.Quaternion();
    for (const p of poses) {
      const e = trk.find((x) => x.t === p.t);
      h.boneList.forEach((b, k) => b.quaternion.copy(p.q[k])); h.bones.hips.position.copy(p.hp); h.root.position.copy(p.rp); h.root.quaternion.copy(p.rq);
      body.replayArms(p.t); h.update();            // (at the exact time of the pose: that entry's arms)
      bp.set(e.bp.x, e.bp.y, e.bp.z); bq.set(e.bq.x, e.bq.y, e.bq.z, e.bq.w);
      rg = Math.max(rg, Math.abs(h.worldPos('handR', V()).distanceTo(bp) - 0.075), Math.abs(h.worldPos('handL', V()).distanceTo(V().set(0, 0.105, 0).applyQuaternion(bq).add(bp)) - 0.075));
    }
    assert.ok(rg < 0.005, `${n}: gloves ${(rg * 100).toFixed(2)} cm off the handle in the replay`);
    A.restArms();
  }
});

test('turned round with the stick: the body faces the way you are turned, the feet step round (no spinning on the spot)', { skip }, async () => {
  const m = await load(), { body, h } = m;
  const { trk } = play(m, 'turn_round');      // (re-run to read the feet at each frame)
  body.reset();
  const bp = V(), bq = new THREE.Quaternion();
  let prev = null, spin = 0, worst = 0;
  for (const e of trk) {
    bp.set(e.bp.x, e.bp.y, e.bp.z); bq.set(e.bq.x, e.bq.y, e.bq.z, e.bq.w);
    body.update(e.dt, e.t, bp, bq, null, e.head, e.extra, e.off, e.turn);
    h.update();
    const f = V().set(0, 0, 1).applyQuaternion(h.bones.hips.getWorldQuaternion(new THREE.Quaternion()));
    let d = Math.atan2(f.x, f.z) - Math.PI / 2 - e.turn;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (e.t - trk[0].t > 2.3 && e.t - trk[0].t < 2.7) worst = Math.max(worst, Math.abs(d));          // (turned round and held)
    const F = body.feet.s;
    if (prev) for (const sd of ['L', 'R']) if (!F[sd].m && !prev[sd].m) spin = Math.max(spin, Math.abs(F[sd].yaw - prev[sd].yaw));
    prev = { L: { yaw: F.L.yaw, m: !!F.L.m }, R: { yaw: F.R.yaw, m: !!F.R.m } };
  }
  assert.ok(worst < 0.25, `hips face ${(worst * 57.3).toFixed(0)} deg off the way you are turned`);
  assert.ok(spin * 57.3 < 2, `a planted foot spins ${(spin * 57.3).toFixed(1)} deg in a frame`);
  assert.ok(body.feet.s.steps >= 8, `${body.feet.s.steps} steps to turn round and back`);
});

test('the same tracks give the same body, every time (deterministic)', { skip }, async () => {
  const m = await load();
  const a = play(m, 'pull').R.frames, b = play(m, 'pull').R.frames;
  for (let i = 0; i < a.length; i++) a[i].q.forEach((q, k) => assert.ok(same(q, b[i].q[k]), `frame ${i} bone ${k}`));
});

test('slow motion does not change your body: the same swing at time scale 0.7 and 0.85 is posed exactly as at full speed', { skip }, async () => {
  const m = await load();
  // (the game clock runs slower than the real one your movements are made on; the body is on the real clock)
  const slowed = (ts) => (trk) => trk.map((e) => ({ ...e, t: trk[0].t + (e.t - trk[0].t) * ts, dt: e.dt * ts, mt: e.t, mdt: e.dt }));
  for (const n of ['cover_drive', 'sweep']) {
    const ref = play(m, n, slowed(1)).R.frames;
    for (const ts of [0.85, 0.7]) {
      const a = play(m, n, slowed(ts)).R.frames;
      let worst = 0;
      for (let i = 0; i < a.length; i++) a[i].q.forEach((q, k) => { worst = Math.max(worst, q.angleTo(ref[i].q[k])); });
      assert.ok(worst < 1e-6, `${n} at x${ts}: ${(worst * 57.3).toFixed(4)} deg from the body at full speed`);
    }
  }
});

test('replay tape: record -> re-solve -> overwrite -> apply keeps your gloves on the recorded bat (120 Hz input, decimated tape, ring wrap, a long review)', { skip }, async () => {
  const m = await load(), { body, A, h } = m;
  const { Replay } = await import('../src/game/replay.js');
  const batMesh = new THREE.Object3D(); batMesh.visible = true;
  const g = { scene: new THREE.Scene(), input: { headPose: { p: V(), q: new THREE.Quaternion() }, xr: false },
    ballView: { mesh: new THREE.Object3D(), visible: false, setVisible(v) { this.visible = v; } },
    batMesh, batReplayVisible: true, stumps: { batting: { pieces: [] }, bowling: { pieces: [] } }, playerBody: body };
  const R = new Replay(g);
  h.replayVisible = true;                // (as the game has it while you bat: your figure is on the tape)
  // strokes one after another at 120 Hz (the tape records at most 90 a second), long enough to wrap the ring
  const names = ['waggle', 'cover_drive', 'sweep', 'advance_drive', 'pull', 'cut', 'hook', 'straight_drive', 'on_drive', 'wild_slog', 'forward_defence', 'back_foot_punch', 'cover_drive', 'sweep'];
  const trk = [];
  let t0 = 100, clip = null;
  for (const n of names) {
    const s = shotTrack(n, { hz: 120, t0 });
    if (n === names[names.length - 1]) clip = [s[0].t, s[s.length - 1].t];
    trk.push(...s); t0 = s[s.length - 1].t + 1 / 120;
  }
  body.reset();
  const bp = V(), bq = new THREE.Quaternion();
  const feed = (e) => {
    bp.set(e.bp.x, e.bp.y, e.bp.z); bq.set(e.bq.x, e.bq.y, e.bq.z, e.bq.w);
    body.update(e.dt, e.t, bp, bq, null, e.head, e.extra, e.off, e.turn || 0);
    batMesh.position.copy(bp); batMesh.quaternion.copy(bq);     // (posed, then recorded: as Game.frame does)
  };
  for (const e of trk) { feed(e); R.record(e.t); }
  assert.ok(R.count === R.times.length && trk[trk.length - 1].t - R.timeAt(0) < trk[trk.length - 1].t - trk[0].t, 'the ring wrapped');
  // the replay re-solves the last stroke and writes it over the tape, exact frame by exact frame
  const job = body.resolveBegin(clip[0] + 0.3, clip[1]);
  assert.ok(job, 'the clip is in the log');
  let written = 0;
  while (!body.resolveStep(job, 4, (t, hh) => { R.overwrite(R.humans.indexOf(h), t, hh, body.armsNow()); written++; }));
  body.resolveEnd(job);
  assert.ok(written > 100);
  const gloves = (from, to, mid) => {
    let worst = 0, n = 0;
    for (let i = 0; i < R.count; i++) {
      const t = R.timeAt(i) + (mid ? 0.5 * (R.timeAt(Math.min(R.count - 1, i + 1)) - R.timeAt(i)) : 0);
      if (t < from || t > to) continue;
      R.apply(t); h.update(); n++;
      const top = V().set(0, 0.105, 0).applyQuaternion(batMesh.quaternion).add(batMesh.position);
      worst = Math.max(worst, Math.abs(h.worldPos('handR', V()).distanceTo(batMesh.position) - 0.075), Math.abs(h.worldPos('handL', V()).distanceTo(top) - 0.075));
    }
    return { worst, n };
  };
  for (const [what, a, b] of [['re-solved stroke', clip[0] + 0.3, clip[1]], ['first frames on the tape', R.timeAt(0), R.timeAt(0) + 3], ['the stroke before', clip[0] - 4, clip[0]]]) {
    const ex = gloves(a, b, false), md = gloves(a, b, true);
    assert.ok(ex.n > 50, `${what}: ${ex.n} frames`);
    assert.ok(ex.worst < 0.005, `${what}: gloves ${(ex.worst * 100).toFixed(2)} cm off the recorded bat at the recorded frames`);
    assert.ok(md.worst < 0.03, `${what}: gloves ${(md.worst * 100).toFixed(2)} cm off between frames`);
  }
  // a long review (30 s more of you standing there, not recorded): the log has moved on, the tape has not
  const stand = shotTrack('waggle', { hz: 120, t0 }).slice(0, 120 * 6);
  for (let k = 0; k < 5; k++) for (const e of stand) feed({ ...e, t: e.t + k * 6 });
  assert.equal(body.resolveBegin(clip[0] + 0.3, clip[1]), null, 'the log no longer holds the clip');
  const late = gloves(clip[0] + 0.3, clip[1], false);
  assert.ok(late.worst < 0.005, `after a long review: gloves ${(late.worst * 100).toFixed(2)} cm off`);
  A.restArms(); h.replayVisible = undefined;
});
