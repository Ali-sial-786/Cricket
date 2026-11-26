// Two-figure ceremony poses (src/render/ceremonyPoses.js): a handshake's two hands
// meet at one point, a glove punch's two fists touch, an embrace puts each one's
// hand on the other's far shoulder -- on the real rig, over each figure's idle.
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
  const actors = await import('../src/render/actors.js');
  const P = await import('../src/render/ceremonyPoses.js');
  return (M = { actors, P, scene: new THREE.Scene() });
}
// Two men face to face, `gap` m apart, standing (their idle posed).
async function pair(gap) {
  const { actors, scene } = await load();
  const A = new actors.FielderActor(scene, { team: 'away', seed: 3 }), B = new actors.FielderActor(scene, { team: 'home', seed: 9 });
  for (const [a, z, face] of [[A, 0, 0], [B, gap, Math.PI]]) { a.h.reset(); a.place(0, z, face); a.idle(5); a.apply(); a.h.update(); }
  return [A, B];
}
const P0 = () => new THREE.Vector3(), P1 = () => new THREE.Vector3();

test('a handshake: the two right hands meet, between the two men, below the chest', { skip }, async () => {
  const { P } = await load();
  const [A, B] = await pair(0.85);
  P.handshake(A, B, 1, 0);
  A.h.update(); B.h.update();
  const a = A.h.worldPos('handR', P0()), b = B.h.worldPos('handR', P1());
  assert.ok(a.distanceTo(b) < 0.15, `hands ${a.distanceTo(b).toFixed(2)} m apart`);
  assert.ok(Math.abs((a.z + b.z) / 2 - 0.425) < 0.12, 'between them');
  assert.ok(a.y > 0.8 && a.y < A.h.worldPos('chest', P1()).y, `at ${a.y.toFixed(2)} m: below the chest`);
});

test('a batter shakes with his left (his bat in his right): left meets right', { skip }, async () => {
  const { P } = await load();
  const [A, B] = await pair(0.95);
  P.handshake(A, B, 1, 0, 'L', 'R');
  A.h.update(); B.h.update();
  const d = A.h.worldPos('handL', P0()).distanceTo(B.h.worldPos('handR', P1()));
  assert.ok(d < 0.15, `hands ${d.toFixed(2)} m apart`);
});

test('a glove punch: the fists touch at chest height; weight 0 leaves the arms alone', { skip }, async () => {
  const { P } = await load();
  const [A, B] = await pair(1.0);
  const before = A.h.worldPos('handL', P0()).clone();
  P.glovePunch(A, B, 0, 0.5, 'L');
  assert.ok(A.h.worldPos('handL', P1()).distanceTo(before) < 1e-6);
  P.glovePunch(A, B, 1, 0.5, 'L');
  A.h.update(); B.h.update();
  const a = A.h.worldPos('handL', P0()), b = B.h.worldPos('handL', P1());
  assert.ok(a.distanceTo(b) < 0.15, `fists ${a.distanceTo(b).toFixed(2)} m apart`);
});

test("an embrace: each one's left hand over the other's right shoulder, from behind it", { skip }, async () => {
  const { P } = await load();
  const [A, B] = await pair(0.54);
  P.embrace(A, B, 1);
  A.h.update(); B.h.update();
  const ha = A.h.worldPos('handL', P0()), sb = B.h.worldPos('shoulderR', P1());
  assert.ok(ha.distanceTo(sb) < 0.22, `A's hand ${ha.distanceTo(sb).toFixed(2)} m from B's shoulder`);
  assert.ok(ha.z > sb.z - 0.02, 'round behind it (B faces -z: his back is +z)');
});
