// Nobody goes through your head (review 5 bug B, review 7 N2: the one rule, game/playerSpace.js):
// your runner's lane bends round it, never within EYE_CLEAR, and he pulls up as far off; the man who
// then becomes you walks round
// you (well wide) to behind you and fades there -- the fade by distance is only
// a last resort, so the dithered figure is hardly ever drawn in front of you.
// The figure tests need three.js (npm install); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
  const people = await import('../src/render/people.js');
  const crew = await import('../src/render/crew.js');
  return (M = { people, crew, scene: new THREE.Scene() });
}
const head = { x: -0.4, z: -1.05 };
const dist = (a) => Math.hypot(a.pos.x - head.x, a.pos.z - head.z);

test('your runner coming home along his lane passes round your head, never within EYE_CLEAR, and pulls up as far off', { skip }, async () => {
  const { people, crew, scene } = await load();
  const bv = new people.BatterView(scene, { poseAt() {}, plan: null, advanceAt: () => 0 });
  bv.runnerOnly = true; bv.show(true); bv.avoid = head; bv.avoidFwd = { x: 0, z: -1 };
  let t = 10, near = Infinity, faded = 0, stoppedAt = null;
  for (let k = 0; k < 72 * 4; k++) {
    t += 1 / 72;
    const z = Math.min(-0.85, -19 + 6.5 * (k / 72)), speed = z > -0.86 ? Math.max(0, 6.5 - (k / 72 - 2.8) * 8) : 6.5;
    bv.running = { x: -0.85, z, speed, heading: 0, moving: speed > 0.1 };
    bv.update(t, 1 / 72, null);
    near = Math.min(near, dist(bv.actor));
    if ((bv.actor.h.fade ?? 1) < 0.99 && k > 40) faded++;
    if (speed < 0.1) stoppedAt = dist(bv.actor);
  }
  assert.ok(near >= crew.EYE_CLEAR - 0.01, `came within ${near.toFixed(2)} m of your head`);
  assert.equal(faded, 0, 'never faded on the way in');
  assert.ok(stoppedAt >= crew.EYE_CLEAR - 0.02, `pulled up ${stoppedAt.toFixed(2)} m from you`);
});

test('the man becoming you walks round you to behind you, wide, and fades there; the last-resort fade is short', { skip }, async () => {
  const { people, crew, scene } = await load();
  assert.ok(crew.FADE_FAR - crew.FADE_NEAR <= 0.4 && crew.FADE_FAR < crew.EYE_CLEAR, 'the distance fade is short and inside the clearance');
  const bv = new people.BatterView(scene, { poseAt() {}, plan: null, advanceAt: () => 0 });
  bv.runnerOnly = true; bv.show(true); bv.avoid = head; bv.avoidFwd = { x: 0, z: -1 };
  const a = bv.actor;
  a.place(head.x + 0.3, head.z - 1.6, Math.PI);           // pulled up in front of you, a little to the off side
  a.h.setFade(1);
  a.task = crew.walkTask(head, null, { kind: 'merge', speed: 3.6, tol: 0.25 });
  bv.crew = { obstacles: () => [{ x: head.x, z: head.z, r: crew.EYE_CLEAR }] };
  let t = 20, near = Infinity, seenFadingInFront = 0, gone = null;
  for (let k = 0; k < 72 * 8 && bv.shown; k++) {
    t += 1 / 72;
    bv.update(t, 1 / 72, null);
    near = Math.min(near, dist(a));
    const inFront = (a.pos.z - head.z) < -0.2;
    if (inFront && (a.h.fade ?? 1) < 0.99) seenFadingInFront++;
    if (!bv.shown) gone = k / 72;
  }
  assert.ok(gone != null && gone < 6, `gone after ${gone} s`);
  assert.ok(near > crew.EYE_CLEAR - 0.1, `came within ${near.toFixed(2)} m`);
  assert.equal(seenFadingInFront, 0, 'he only fades behind you');
});
