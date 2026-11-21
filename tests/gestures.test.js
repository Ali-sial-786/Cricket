// Body language (src/render/gestures.js): which crowd events make the fielding
// side react and how, each man in his own way and at his own moment; what a
// man does with his hands between balls; and, on the real rig, that the hands
// go where the gesture puts them and no joint jumps as a reaction comes and goes.
// The figure tests need three.js (npm install); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch { THREE = null; }
const skip = THREE ? false : 'three.js is not installed (npm install)';
const G = THREE ? await import('../src/render/gestures.js') : null;

test('crowd events become the fielding side\'s mood; a stronger one replaces a weaker, never the other way', { skip }, () => {
  G.clearMood();
  assert.equal(G.moodAt(10), null);
  G.noteCrowd('dot', 10);
  assert.equal(G.moodAt(10.1), null, 'a dot ball: nothing');
  G.noteCrowd('beaten', 10);
  assert.equal(G.moodAt(10.2).mood, 'ooh');
  G.noteCrowd('wicketAgainst', 10.4);
  assert.equal(G.moodAt(10.5).mood, 'celebrate');
  G.noteCrowd('close', 11);
  assert.equal(G.moodAt(11.2).mood, 'celebrate', 'a "close" does not cut the celebration short');
  assert.equal(G.moodAt(10.4 + G.MOOD_DUR.celebrate + 0.01), null, 'and it is over in its time');
  for (const k of ['wicketFor', 'wicketAgainst']) assert.equal(G.moodFor(k), 'celebrate');
  for (const k of ['four', 'six', 'boundaryAgainst', 'dropped']) assert.equal(G.moodFor(k), 'dejected');
  assert.equal(G.moodFor('appeal'), 'appeal');
  G.clearMood();
});

test('each man reacts his own way and at his own moment; only the men round the bat appeal', { skip }, () => {
  const kinds = new Set(), delays = new Set();
  for (let s = 100; s < 170; s += 7) {
    const r = G.reactionFor('celebrate', s, 3, 10);
    assert.deepEqual(r, G.reactionFor('celebrate', s, 3, 10), 'repeatable');
    kinds.add(r.kind); delays.add(r.delay.toFixed(3));
    assert.ok(r.delay >= 0 && r.delay < 0.8 && r.amt > 0.7 && r.amt <= 1);
  }
  assert.ok(kinds.size >= 2 && delays.size >= 5, 'the field never reacts as one');
  assert.equal(G.reactionFor('appeal', 107, 1, 60).kind, null, 'nobody appeals from the boundary');
  assert.equal(G.reactionFor('appeal', 107, 1, 8).kind, 'appeal');
  assert.equal(G.reactionFor('celebrate', 107, 1, 60).kind, 'clap', 'a man in the deep claps');
});

test('between balls: mostly standing, now and then hands on hips, a clap, hands behind, wiping the hands', { skip }, () => {
  const n = {};
  for (let slot = 0; slot < 400; slot++) { const k = G.idleGesture(121, slot) || 'none'; n[k] = (n[k] || 0) + 1; }
  for (const k of ['none', 'hips', 'clap', 'behind', 'wipe']) assert.ok(n[k] > 20, `${k}: ${n[k]}`);
  assert.ok(n.none > 120, 'mostly just standing');
  for (let slot = 0; slot < 50; slot++) assert.ok(['clap', 'wipe', null].includes(G.idleGesture(9, slot, true)), 'the keeper only claps / wipes his gloves');
  assert.equal(G.envelope(0, 3), 0); assert.equal(G.envelope(3, 3), 0); assert.equal(G.envelope(1.5, 3), 1);
});

// ---------------------------------------------------------------- the rig
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
  return (M = { actors, scene: new THREE.Scene() });
}

test('gestures put the hands where they say (on the hips, on the head, together for a clap) and blend in by weight', { skip }, async () => {
  const { actors, scene } = await load();
  const A = new actors.FielderActor(scene, { team: 'away', seed: 3 });
  const h = A.h, fwd = new THREE.Vector3(0, 0, 1), S = G.gestureStore(), p = new THREE.Vector3(), q = new THREE.Vector3();
  const pose = (kind, w) => { h.reset(); A.place(0, 0, 0); A.idle(5); A.apply(); G.poseArms(h, fwd, kind, w, 0, S); h.update(); };
  pose('hips', 1);
  for (const sd of ['L', 'R']) assert.ok(h.worldPos('hand' + sd, p).distanceTo(h.worldPos('hip' + sd, q)) < 0.25, `${sd} hand on the hip`);
  pose('head', 1);
  for (const sd of ['L', 'R']) assert.ok(h.worldPos('hand' + sd, p).y > h.worldPos('head', q).y, `${sd} hand on top of the head`);
  pose('clap', 1);
  assert.ok(h.worldPos('handL', p).distanceTo(h.worldPos('handR', q)) < 0.3, 'hands together in front');
  pose('arms', 1);
  assert.ok(h.worldPos('handR', p).y > h.worldPos('head', q).y + 0.2, 'arms up');
  // weight 0 leaves the pose alone
  pose(null, 1); h.worldPos('handR', p);
  pose('arms', 0); assert.ok(h.worldPos('handR', q).distanceTo(p) < 1e-6);
});

test('a fielder reacting to a wicket, then a boundary, then idling: no joint jumps in a frame', { skip }, async () => {
  const { actors, scene } = await load();
  const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
  G.clearMood();
  for (const seed of [100, 107, 114, 121]) {
    const A = new actors.FielderActor(scene, { team: 'away', seed });
    let t = 200, prev = null, worst = 0, at = 0, bone = '';
    const dt = 1 / 72;
    for (let k = 0; k < 72 * 30; k++) {
      t += dt;
      if (k === 72) G.noteCrowd('wicketAgainst', t);
      if (k === 72 * 6) G.noteCrowd('four', t);
      if (k === 72 * 10) G.noteCrowd('beaten', t);
      A.update(dt, { x: 10, z: -30, face: 0, speed: 0, state: 'set', action: null }, { t, ball: null, delivering: false });
      const cur = BONES.map((b) => A.h.bones[b].quaternion.clone());
      if (prev) cur.forEach((c, i) => { const d = c.angleTo(prev[i]); if (d > worst) { worst = d; at = k / 72; bone = BONES[i]; } });
      prev = cur;
    }
    assert.ok(worst < 0.3, `seed ${seed}: ${bone} turned ${worst.toFixed(2)} rad in one frame at ${at.toFixed(2)} s`);
  }
  G.clearMood();
});
