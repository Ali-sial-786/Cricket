// The AI striker's body through real deliveries (as the game drives it:
// PhysicsWorld + AIBatter + BatterView): from the stance into the captured
// shot and back, no joint turns over in a frame, nothing sinks, the feet do
// not skate. Needs three.js (npm install); skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch { THREE = null; }
const skip = THREE ? false : 'three.js is not installed (npm install)';

async function load() {
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {} })), set: (o, k, v) => { o[k] = v; return true; } });
  globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  globalThis.fetch = async (url) => {
    const buf = fs.readFileSync(new URL(url));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const root = new URL('../', import.meta.url).href;
  const humanoid = await import('../src/render/humanoid.js'), clips = await import('../src/render/clips.js'), shots = await import('../src/render/shots.js');
  await humanoid.loadAthlete(root + 'assets/models/'); await clips.loadClips(root + 'assets/anim/'); await shots.loadShots(root + 'assets/anim/');
  return {
    makeRng: (await import('../src/physics/math.js')).makeRng, PhysicsWorld: (await import('../src/physics/world.js')).PhysicsWorld,
    machineDelivery: (await import('../src/physics/bowlingMachine.js')).machineDelivery, AIBatter: (await import('../src/game/aiBatter.js')).AIBatter,
    CONFIG: (await import('../src/config.js')).CONFIG, BatterView: (await import('../src/render/people.js')).BatterView,
  };
}

const BODY = ['hips', 'spine', 'chest', 'neck', 'head', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];

test('AI striker: drives, pulls, flicks and blocks without a joint flipping, sinking or skating', { skip }, async () => {
  const M = await load(), scene = new THREE.Scene();
  const seen = new Set();
  // [pace km/h, length m, line m, aggression, seed]
  for (const [pace, len, line, aggr, seed] of [[135, 6.5, 0, 0.4, 2], [128, 6, -0.2, 0.6, 1], [140, 9.5, 0, 0.7, 4], [140, 11, -0.1, 0.8, 1], [125, 4.5, -0.25, 0.7, 2], [135, 6.5, 0, 0.4, 3], [110, 3, 0, 0.8, 3]]) {
    const rng = M.makeRng(seed * 7919 + 13), world = new M.PhysicsWorld(M.CONFIG, seed), ai = new M.AIBatter();
    ai.setDifficulty('hard'); ai.aggression = aggr;
    world.addBat('ai', ai, undefined, 1);
    const d = M.machineDelivery({ paceKmh: pace, length: len, line }, null);
    world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0 });
    ai.planDelivery(world.ball.clone(), world.time, rng);
    const view = new M.BatterView(scene, ai); view.show(true);
    const h = view.actor.h, ix = BODY.map((n) => h.boneList.indexOf(h.bones[n])), ankleY = h.ankleHeight * h.root.scale.x;
    for (let t = -1; t < 0; t += 1 / 72) view.update(t, 1 / 72, null);
    const type = ai.plan.shot.type, key = `${type} ${pace}/${len}/${line}/${seed}`;
    seen.add(type);
    let prev = null, bounced = false;
    for (let t = 1 / 72; t < 2.6; t += 1 / 72) {
      world.advanceTo(t);
      for (const e of world.drainEvents()) if (e.type === 'bounce' && !bounced) { bounced = true; ai.adjust(world.ball.clone(), world.time); }
      view.update(t, 1 / 72, null);
      h.update();
      const f = { q: h.boneList.map((b) => b.quaternion.clone()), aL: h.worldPos('ankleL', new THREE.Vector3()), aR: h.worldPos('ankleR', new THREE.Vector3()) };
      if (prev) {
        for (const k of ix) { const a = f.q[k].angleTo(prev.q[k]) * 180 / Math.PI; assert.ok(a < 50, `${key}: ${h.boneList[k].name} turns ${a.toFixed(0)} deg in a frame at ${t.toFixed(2)}`); }
        for (const sd of ['L', 'R']) {
          const a = f['a' + sd], b = prev['a' + sd];
          if (a.y < ankleY + 0.012 && b.y < ankleY + 0.012) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 0.045, `${key}: ${sd} foot skates at ${t.toFixed(2)}`);
        }
      }
      assert.ok((h.guardLift || 0) < 0.03, `${key}: the ground guard lifts him ${((h.guardLift || 0) * 100).toFixed(1)} cm`);
      prev = f;
    }
    scene.remove(h.root);
  }
  assert.ok(seen.size >= 4, 'several kinds of stroke: ' + [...seen].join(', '));
});
