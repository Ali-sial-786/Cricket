// Nobody goes through the turf: the AI bowler's whole delivery (every run-up
// kind, over and round the wicket, the tallest and shortest release), fielders'
// dives and pick-ups, the keeper's crouch and the clip locomotion, posed on the
// real rig (assets/models/athlete.*, assets/anim/clips.*) and checked by
// skinning the mesh on the CPU: no vertex below the ground, and feet that
// stand still are on it. Needs three.js (npm install); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch { THREE = null; }
const skip = THREE ? false : 'three.js is not installed (npm install)';

// Just enough browser for the render modules: a 2D canvas that draws nothing,
// and fetch() of the repo's own asset files.
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
  return (M = { humanoid, clips, actors, scene: new THREE.Scene() });
}

// Lowest skinned vertex of a figure (world y), and which bone carries it.
const _v = new (THREE ? THREE.Vector3 : Object)();
function lowestVertex(h) {
  h.root.updateMatrixWorld(true);
  const geo = h.mesh.geometry, P = geo.attributes.position;
  let low = Infinity;
  for (let i = 0; i < P.count; i += 2) {
    h.mesh.getVertexPosition(i, _v);
    _v.applyMatrix4(h.mesh.matrixWorld);
    if (_v.y < low) low = _v.y;
  }
  return low;
}

test('AI bowler: no part of the body below the turf through a whole delivery, every run-up kind', { skip }, async () => {
  const { actors, scene } = await load();
  const A = new actors.BowlerActor(scene, { team: 'away', seed: 5, headgear: 'bare' });
  const cases = [
    ['long', 0.42, 2.2], ['medium', 0.42, 2.2], ['short', 0.42, 1.98],
    ['long', -0.42, 2.2], ['medium', -0.42, 2.2], ['short', -0.42, 1.98],
    ['long', 0.42, 1.85], ['long', 0.42, 2.35],          // near the scale clamps (0.92 .. 1.12), up on the toes
  ];
  for (const [kind, x, y] of cases) {
    let t = 100, worst = Infinity, at = 0, releaseErr = null;
    const rp = new THREE.Vector3(x, y, -18.75);
    A.startRunup(t, rp, kind);
    const tr = A.run.tr, dt = 1 / 72;
    while (t < tr + 5) {
      t += dt;
      const rel = A.update(dt, t);
      if (rel) releaseErr = A.handPos(new THREE.Vector3()).distanceTo(rp);
      if (Math.round((t - tr) * 72) % 3 === 0) {          // every third frame (CPU skinning is slow)
        const low = lowestVertex(A.h);
        if (low < worst) { worst = low; at = t - tr; }
      }
    }
    assert.ok(worst > -0.006, `${kind} ${x > 0 ? 'over' : 'round'} y=${y}: ${(worst * 100).toFixed(1)} cm below the turf at u=${at.toFixed(2)}`);
    assert.ok(releaseErr != null && releaseErr < 0.02, `${kind} y=${y}: the ball left ${releaseErr} m from the release point`);
  }
});

test('AI bowler: the bound and follow-through stay out of the stumps', { skip }, async () => {
  const { actors, scene } = await load();
  const A = new actors.BowlerActor(scene, { team: 'away', seed: 5, headgear: 'bare' });
  for (const [kind, x] of [['long', 0.42], ['medium', 0.42], ['short', 0.42], ['long', -0.42], ['short', -0.42]]) {
    let t = 100, near = Infinity;
    A.startRunup(t, new THREE.Vector3(x, 2.2, -18.75), kind);
    const tr = A.run.tr, p = new THREE.Vector3();
    while (t < tr + 1.2) {
      t += 1 / 72; A.update(1 / 72, t); A.h.update();
      for (const b of ['ankleL', 'ankleR', 'kneeL', 'kneeR']) {
        A.h.worldPos(b, p);
        if (Math.abs(p.z + 20.12) < 0.2) near = Math.min(near, Math.abs(p.x));
      }
    }
    assert.ok(near > 0.2, `${kind} ${x}: a leg ${near.toFixed(3)} m from the middle stump`);
  }
});

test('feet stand on the turf: standing, crouching, running, diving, picking up', { skip }, async () => {
  const { actors, scene } = await load();
  const F = new actors.FielderActor(scene, { team: 'away', seed: 3 });
  const K = new actors.FielderActor(scene, { team: 'away', seed: 4, keeper: true, pads: true, gloves: true });
  const base = { x: 5, z: 5, face: 0, speed: 0, state: 'set', action: null };
  const run = (A, s, T, ctx = {}) => {
    let low = Infinity, high = -Infinity;
    for (let t = 0; t < T; t += 1 / 60) {
      A.update(1 / 60, { ...base, ...s(t) }, { t, ball: null, delivering: true, ...ctx });
      const y = lowestVertex(A.h);
      low = Math.min(low, y); high = Math.max(high, y);
    }
    return { low, high };
  };
  // standing at his mark, down into the set as the bowler runs in
  let r = run(F, () => ({}), 2);
  assert.ok(r.low > -0.006 && r.high < 0.012, `fielder standing: lowest point ${r.low}..${r.high}`);
  // the keeper's crouch: on the turf (up on his toes), not in it, not hovering
  r = run(K, () => ({ crouch: true }), 2);
  assert.ok(r.low > -0.006 && r.high < 0.02, `keeper crouched: ${r.low}..${r.high}`);
  // running at every speed (walk / jog / sprint blends)
  for (const v of [0.6, 1.5, 3, 5, 7.5]) {
    r = run(F, () => ({ speed: v, state: 'chase' }), 1.5);
    assert.ok(r.low > -0.006, `running at ${v} m/s: ${r.low}`);
  }
  // a diving catch both ways, and a pick-up
  for (const side of [1, -1]) {
    const act = { type: 'catch', t0: 0, success: true, dive: true, side, dir: { x: side, z: 0 }, lunge: 1.2, target: new THREE.Vector3(5 + side * 1.6, 0.4, 5) };
    r = run(F, () => ({ action: act, state: 'chase' }), 1.1);
    assert.ok(r.low > -0.006, `dive ${side}: ${r.low}`);
  }
  const pick = { type: 'pickup', t0: 0, dur: 0.6, ball: new THREE.Vector3(5, 0.04, 5.5) };
  r = run(F, () => ({ action: pick }), 0.6);
  assert.ok(r.low > -0.006 && r.low < 0.03, `pick-up: ${r.low}`);
});

test('Humanoid.lowest agrees with the skinned mesh and the guard never leaves anything under', { skip }, async () => {
  const { humanoid, clips } = await load();
  const h = new humanoid.Humanoid({ team: 'home', seed: 1, pads: true });
  for (const [name, n] of [['idle', 20], ['sprint', 20], ['throw', 30]]) {
    for (let i = 0; i < n; i++) {
      h.reset(); h.root.position.set(0, 0, 0);
      clips.applyClip(h, name, i / 30);
      h.bones.hips.position.y -= 0.2;                     // pushed into the ground on purpose
      h.groundGuard(0);
      const v = lowestVertex(h);
      assert.ok(v > -0.004, `${name} frame ${i}: ${v}`);
    }
  }
});
