// How the figures move between and around balls: nobody is ever put anywhere
// (no teleports: fielders walk back at a body's pace and turn at a body's
// pace), fielders face the batter once back on their marks and get set when
// the ball is bowled, the umpire stands clear of your run-up and your line to
// the striker, the batters' figures are never lost or recycled in view, a dive
// lands on the turf (not held off it by the ground guard), and the AI bowler's
// delivery and the non-striker's bat have no joint that jumps in one frame.
// The figure tests need three.js (npm install); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeRng } from '../src/physics/math.js';
import { PITCH } from '../src/physics/pitch.js';
import { CONFIG } from '../src/config.js';
import { Fielding } from '../src/game/fielding.js';
import { Runs } from '../src/game/running.js';

const TAU = Math.PI * 2;
const ang = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

// ------------------------------------------------------------------ logic

test('between balls nobody is put anywhere: fielders walk back at a body\'s pace, turn at a body\'s pace, then face the batter', () => {
  const f = new Fielding({ rng: makeRng(7) });
  const F = f.fielders;
  f.reset();
  f.started = true;
  // after a ball: everyone somewhere else, facing anywhere, one of them out by the rope 55 m away
  F.forEach((p, i) => {
    if (p.bowler) return;
    p.pos.set(p.home.x + (i % 2 ? 6 : -9), 0, p.home.z + (i === 3 ? 55 : 4));
    p.state = 'set'; p.yaw = p.face = 2.5;
  });
  f.ballDead();
  f.newBall();
  const dt = 1 / 60, vmax = CONFIG.field.fielderSpeed;
  const prev = F.map((p) => ({ x: p.pos.x, z: p.pos.z, yaw: p.yaw }));
  let k = 0;
  for (; k < 60 * 40 && !f.settled(); k++) {
    f.update(dt, 100 + k * dt, null, null);
    F.forEach((p, i) => {
      if (p.bowler) return;
      const d = Math.hypot(p.pos.x - prev[i].x, p.pos.z - prev[i].z);
      assert.ok(d <= vmax * dt * 1.05 + 1e-6, `${p.name} moved ${d.toFixed(3)} m in one frame`);
      const turn = Math.abs(ang(prev[i].yaw, p.yaw)) / dt;
      assert.ok(turn <= 7.5 + 1e-6, `${p.name} turned at ${turn.toFixed(1)} rad/s`);
      prev[i] = { x: p.pos.x, z: p.pos.z, yaw: p.yaw };
    });
  }
  assert.ok(f.settled(), 'everyone back on his mark and still');
  for (const p of F) if (!p.bowler) assert.ok(Math.abs(ang(p.yaw, f.restFace(p))) < 0.12, `${p.name} faces ${p.yaw.toFixed(2)}, not the batter (${f.restFace(p).toFixed(2)})`);
});

test('still walking back as the ball is bowled, a fielder near his mark pulls up and gets set; one a long way off keeps coming', () => {
  const f = new Fielding({ rng: makeRng(3) });
  f.reset();
  const a = f.fielders[3], b = f.fielders[5];
  a.pos.set(a.home.x + 2, 0, a.home.z); a.state = 'return';
  b.pos.set(b.home.x + 12, 0, b.home.z); b.state = 'return';
  f.onRelease();
  assert.equal(a.state, 'set');
  assert.equal(b.state, 'return');
});

test('the dive for the crease: launched, sliding, then he gets up (or stays down while the third umpire looks)', () => {
  for (const stay of [false, true]) {
    const r = new Runs();
    r.begin(0, { x: -0.4, z: -1.1 }, { x: 1.35, z: -18.75 });
    r.call(); r.diveHeld = true;
    let t = 0, launched = null, up = null;
    for (; t < 12; t += 1 / 60) {
      r.stay = stay && t < 7;
      r.update(1 / 60);
      const st = r.state(true);
      if (st.dive && launched == null) launched = t;
      if (launched != null && !st.dive && up == null) up = t;
    }
    assert.ok(launched != null, 'he dived');
    assert.ok(up != null, 'he got up');
    if (stay) assert.ok(up > 7, `stayed down while held (${up.toFixed(2)})`);
    else assert.ok(up - launched < 3, `up ${(up - launched).toFixed(2)} s after the launch`);
  }
});

// ------------------------------------------------------------------ figures

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
  await humanoid.loadAthlete(root + 'assets/models/');
  await clips.loadClips(root + 'assets/anim/');
  const actors = await import('../src/render/actors.js');
  const crew = await import('../src/render/crew.js');
  const umpires = await import('../src/render/umpires.js');
  return (M = { humanoid, clips, actors, crew, umpires, scene: new THREE.Scene() });
}
// Largest joint rotation between two snapshots (rad).
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
let lastBone = '';
const jointJump = (h, prev) => h.boneList.reduce((m, b, i) => { const d = b.quaternion.angleTo(prev[i]); if (d > m) { lastBone = BONES.find((n) => h.bones[n] === b) || String(i); return d; } return m; }, 0);
const snap = (h) => h.boneList.map((b) => b.quaternion.clone());

test('AI bowler: no joint jumps in one frame through a whole delivery, every run-up kind', { skip }, async () => {
  const { actors, scene } = await load();
  const A = new actors.BowlerActor(scene, { team: 'away', seed: 5, headgear: 'bare' });
  // (every kind, both sides of the wicket, and the stride at four different phases as he arrives)
  for (const [kind, x] of [['long', 0.42], ['medium', 0.42], ['short', 0.42], ['long', -0.42], ['short', -0.42]]) for (const ph of [0, 1.6, 3.2, 4.8]) {
    let t = 100;
    A.phase = ph; A.idleOff = 3;
    A.startRunup(t, new THREE.Vector3(x, kind === 'short' ? 1.98 : 2.2, -18.75), kind);
    const tr = A.run.tr, dt = 1 / 60;
    let prev = snap(A.h), worst = 0, at = 0, bone = '';
    while (t < tr + 1.2) {
      t += dt; A.update(dt, t);
      const j = jointJump(A.h, prev);
      if (t - tr > -1.5 && j > worst) { worst = j; at = t - tr; bone = lastBone; }
      prev = snap(A.h);
    }
    // (a bowling arm turns at up to ~30 rad/s; a pop is far more than that in one frame)
    assert.ok(worst / dt < 36, `${kind} ${x > 0 ? 'over' : 'round'} (stride phase ${ph}): ${bone} turned at ${(worst / dt).toFixed(0)} rad/s at u=${at.toFixed(2)}`);
  }
});

test('the non-striker\'s bat: leaning on it, walking, standing and leaning again without the hand or bat jumping', { skip }, async () => {
  const { actors, scene } = await load();
  const a = new actors.BatterActor(scene, { team: 'home', seed: 23 });
  a.place(-1.35, -19, 1.07);
  a.phase = 0; a.idleOff = 11;
  const dt = 1 / 60, look = new THREE.Vector3(0.5, 1.3, -30);
  let t = 0, prev = null, prevBat = null, worst = 0, worstBat = 0, when = '';
  const plan = [['lean', 1.2], ['walk', 1.2], ['stand', 0.6], ['lean', 1.0], ['walk', 0.8], ['lean', 1.0]];
  for (const [what, T] of plan) {
    for (let k = 0; k < T * 60; k++) {
      t += dt;
      if (what === 'lean') { a.speed = 0; a.updateLeaning(dt, t, look); }
      else { a.speed = what === 'walk' ? 1.4 : 0; a.pos.z += a.speed * dt; a.updateMoving(dt, t, null); }
      const s = snap(a.h);
      if (prev) {
        const j = jointJump(a.h, prev);
        if (j > worst) { worst = j; when = what + ' ' + lastBone + ' @' + t.toFixed(2); }
        worstBat = Math.max(worstBat, a.bat.position.distanceTo(prevBat) - a.speed * dt);
      }
      prev = s; prevBat = a.bat.position.clone();
    }
  }
  assert.ok(worst / dt < 28, `a joint turned at ${(worst / dt).toFixed(0)} rad/s (${when})`);
  // (it swings over between his hand and the turf in about a quarter of a second: up to ~4 m/s, never a jump)
  assert.ok(worstBat < 0.08, `the bat jumped ${worstBat.toFixed(3)} m in a frame`);
});

test('a dive for the crease lands: the body on the turf, never held off it by the ground guard, and up again', { skip }, async () => {
  const { actors, scene } = await load();
  const a = new actors.BatterActor(scene, { team: 'home', seed: 3 });
  const trunk = ['hips', 'spine', 'chest'].map((n) => a.h.boneList.indexOf(a.h.bones[n]));
  const r = new Runs();
  r.begin(0, { x: -0.4, z: -1.1 }, { x: 1.35, z: -18.75 });
  r.call();
  const dt = 1 / 60;
  let t = 0, launched = null, up = null, maxLift = 0, minTrunk = Infinity;
  const step = () => {
    r.update(dt); t += dt;
    const st = r.state(true);
    a.pos.set(st.x, 0, st.z); a.speed = st.speed; a.turnToward(st.heading, dt, 9);
    if (st.dive) a.updateDive(dt, t, st.dive); else a.updateMoving(dt, t, null, false);
    return st;
  };
  while (r.remaining * 17.68 > 5.2 && t < 10) step();
  r.diveHeld = true;
  for (let k = 0; k < 60 * 4; k++) {
    const st = step();
    if (st.dive) {
      if (launched == null) launched = t;
      maxLift = Math.max(maxLift, a.h.guardLift || 0);
      minTrunk = Math.min(minTrunk, a.h.lowest(trunk));
    } else if (launched != null && up == null) up = t;
  }
  assert.ok(launched != null, 'he dived');
  assert.ok(maxLift < 0.01, `the ground guard held him ${maxLift.toFixed(3)} m off the turf`);
  assert.ok(minTrunk < 0.06, `his trunk never got lower than ${minTrunk.toFixed(3)} m`);
  assert.ok(up != null && up - launched < 3, 'he got up');
});

test('a fielder\'s diving stop lies on the turf: no part through it, so nothing lifts the body off', { skip }, async () => {
  const { actors, scene } = await load();
  const F = new actors.FielderActor(scene, { team: 'away', seed: 9 });
  for (const side of [1, -1]) {
    let maxLift = 0;
    F.cut();
    const act = { type: 'catch', t0: 0, success: true, dive: true, side, dir: { x: side, z: 0 }, lunge: 1.4, target: new THREE.Vector3(5 + side * 1.4, 0.4, 5) };
    for (let t = -0.3; t < 1.2; t += 1 / 60) {
      F.update(1 / 60, { x: 5, z: 5, face: 0.3, speed: 0, state: 'set', action: t >= 0 ? act : null }, { t, ball: null, delivering: false });
      maxLift = Math.max(maxLift, F.h.guardLift || 0);
    }
    assert.ok(maxLift < 0.02, `dive ${side}: the body was lifted ${maxLift.toFixed(3)} m off the turf`);
  }
});

test('the batters\' four figures are never lost: a new batter is never one still walking off in view', { skip }, async () => {
  const { actors, crew, scene } = await load();
  const game = { batterView: { actor: new actors.BatterActor(scene, { seed: 11 }) }, nonStrikerView: { actor: new actors.BatterActor(scene, { seed: 23 }) } };
  const C = new crew.BatterCrew(game, scene);
  const [A, B] = [game.batterView.actor, game.nonStrikerView.actor], [S1, S2] = C.spares;
  assert.equal(new Set(C.pool).size, 4);
  // two wickets later: the spares are at the crease, A has walked off and gone, B is still walking off
  game.batterView.actor = S1; game.nonStrikerView.actor = S2;
  A.visible = false; A.task = null;
  B.visible = true; B.h.setFade(1); C.leaving.push(B);
  assert.equal(new Set(C.pool).size, 4, 'all four figures still in the pool');
  assert.equal(C.free(), A, 'the free figure (not the one walking off) comes in next');
});

test('stepWalk: he goes where he faces (no sliding sideways or backwards), never through anyone, and stops on the spot', { skip }, async () => {
  const { actors, crew, scene } = await load();
  const a = new actors.BatterActor(scene, { seed: 31 });
  a.place(0, 0, Math.PI);                              // facing away from where he is going
  a.task = crew.walkTask({ x: 0, z: 12 }, 0);
  const obs = [{ x: 0.1, z: 6, r: 0.9 }];
  let worstSlip = 0;
  for (let k = 0; k < 60 * 20 && !a.task.done; k++) {
    const x0 = a.pos.x, z0 = a.pos.z;
    crew.stepWalk(a, 1 / 60, obs);
    const dx = a.pos.x - x0, dz = a.pos.z - z0, d = Math.hypot(dx, dz);
    if (d > 1e-4 && !a.task.there) worstSlip = Math.max(worstSlip, Math.abs(ang(a.heading, Math.atan2(dx, dz))));
    assert.ok(Math.hypot(a.pos.x - obs[0].x, a.pos.z - obs[0].z) > obs[0].r - 1e-6, 'walked into someone');
  }
  assert.ok(a.task.done, 'got there');
  assert.ok(Math.hypot(a.pos.x, a.pos.z - 12) < 0.15, 'on the spot');
  assert.ok(worstSlip < 0.05, `moved ${worstSlip.toFixed(2)} rad off the way he faces`);
});

test('when you bowl, the bowler\'s-end umpire stands behind the stumps: clear of your run-up and of your line to the striker', { skip }, async () => {
  const { umpires, scene } = await load();
  const U = new umpires.UmpireView(scene);
  {
    U.place(true);
    const m = U.main.mark, runX = 0.75;                              // your run-up line (game.js BOWL_HEAD.x)
    assert.ok(m.z < PITCH.bowlingStumpsZ - 1, 'behind the stumps');
    assert.ok(Math.abs(m.x - runX) > 1.8, `${Math.abs(m.x - runX).toFixed(2)} m from your run-up line`);
    // from the top of a long run-up, more than 8 degrees off your line to the striker's stumps
    const ex = runX, ez = -19.6 - 11, tx = 0 - ex, tz = 0 - ez, ux = m.x - ex, uz = m.z - ez;
    const off = Math.acos((tx * ux + tz * uz) / (Math.hypot(tx, tz) * Math.hypot(ux, uz)));
    assert.ok(off > 8 * Math.PI / 180, `${(off * 180 / Math.PI).toFixed(1)} degrees off your line to the striker`);
  }
});

test('the keeper comes up to the ball: a ball arriving at the chest is not taken from a squat, and he stands up after the take', { skip }, async () => {
  const { actors, scene } = await load();
  const K = new actors.FielderActor(scene, { team: 'away', seed: 4, keeper: true, pads: true, gloves: true });
  const hipsAt = (y) => {
    K.cut(); K.kCrouch = null;
    let out = {};
    for (let t = -1.0; t < 1.2; t += 1 / 60) {
      const took = t >= 0;
      const s = { x: 0, z: 1.2, face: Math.PI, speed: 0, state: took ? 'set' : 'gather', action: took ? { type: 'keep', t0: 0, target: { x: 0, y, z: 1.2 }, hold: true, how: 'take', side: 1 } : null,
        leap: { t: 0, how: 'take', x: 0, y, side: 1, done: took } };
      K.update(1 / 60, s, { t, ball: null, delivering: !took });
      K.h.update();
      const hy = K.h.worldPos('hips', new THREE.Vector3()).y;
      if (Math.abs(t + 0.6) < 0.01) out.early = hy;
      if (Math.abs(t) < 0.01) out.at = hy;
      if (Math.abs(t - 1.15) < 0.01) out.after = hy;
    }
    return out;
  };
  const low = hipsAt(0.25), high = hipsAt(1.15);
  assert.ok(Math.abs(low.early - high.early) < 0.03, 'the same crouch while the ball is on its way');
  assert.ok(high.at > low.at + 0.12, `up to a chest-high ball: hips ${high.at.toFixed(2)} vs ${low.at.toFixed(2)} m for a low one`);
  assert.ok(low.after > low.at + 0.15, `stands up after the take: ${low.at.toFixed(2)} -> ${low.after.toFixed(2)} m`);
});

test('the non-striker walks back to his crease, stops and leans on his bat: the arm and bat swing over, never jump', { skip }, async () => {
  const { scene } = await load();
  const { NonStrikerView } = await import('../src/render/people.js');
  const ns = new NonStrikerView(scene);
  ns.show(true); ns.reset();
  const a = ns.actor; a.phase = 0; a.idleOff = 9;
  const watch = new THREE.Vector3(0.6, 1.5, -31);
  const held = new THREE.Vector3(0.1, 0.9, 0.9);                     // (the ball in the keeper's gloves: he looks at it walking and leaning)
  const dt = 1 / 60;
  for (const [dx, dz] of [[2.5, 3], [-1.2, -0.8], [0.6, 1.5]]) {
    a.place(ns.home.x + dx, ns.home.z + dz, 0); a.cut();            // (put there unseen, as a session start does)
    let prev = null, prevBat = null, worst = 0, worstBat = 0, when = '', whenBat = '', leant = false;
    for (let t = 0; t < 8; t += dt) {
      ns.update(dt, t, { backingUp: false, ball: held, watch });
      if (prev) {
        const j = jointJump(a.h, prev);
        if (j > worst) { worst = j; when = `${a.poseKey} ${lastBone} @${t.toFixed(2)}`; }
        const bj = a.bat.position.distanceTo(prevBat) - a.speed * dt;
        if (bj > worstBat) { worstBat = bj; whenBat = `${a.poseKey} @${t.toFixed(2)}`; }
      }
      if (a.poseKey === 'lean') leant = true;
      prev = snap(a.h); prevBat = a.bat.position.clone();
    }
    assert.ok(leant, 'he got back to his crease and leant on the bat');
    assert.ok(worst / dt < 28, `from ${dx},${dz}: a joint turned at ${(worst / dt).toFixed(0)} rad/s (${when})`);
    assert.ok(worstBat < 0.08, `from ${dx},${dz}: the bat jumped ${worstBat.toFixed(3)} m in a frame (${whenBat})`);
  }
});
