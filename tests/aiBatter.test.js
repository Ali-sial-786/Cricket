import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, Vec3, Pose } from '../src/physics/math.js';
import { BatGeometry } from '../src/physics/bat.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { AIBatter, analyzeDelivery, chooseShot, REACH, canReach, padX } from '../src/game/aiBatter.js';
import { CONFIG } from '../src/config.js';

function face(settings, difficulty = 'hard', aggression = 0.4, seed = 3) {
  const rng = makeRng(seed * 7919 + 13); // decorrelate small sequential seeds
  const world = new PhysicsWorld(CONFIG, seed);
  const ai = new AIBatter();
  ai.setDifficulty(difficulty);
  ai.aggression = aggression;
  world.addBat('ai', ai, undefined, 1);
  const d = machineDelivery(settings, null);
  world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0 });
  ai.planDelivery(world.ball.clone(), world.time, rng);
  const events = [];
  let bounced = false;
  for (let t = 1 / 90; t < 3; t += 1 / 90) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) {
      events.push(e);
      if (e.type === 'bounce' && !bounced) { bounced = true; ai.adjust(world.ball.clone(), world.time); }
    }
  }
  return { shot: ai.plan.shot.type, bat: events.find((e) => e.type === 'bat'), wicket: events.find((e) => e.type === 'wicket' && e.end === 'batting'), world };
}

test('AI leaves wide balls outside off and does not touch them', () => {
  let leaves = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const r = face({ paceKmh: 135, length: 6.5, line: 0.6 }, 'hard', 0.3, seed);
    if (r.shot === 'leave') { leaves++; assert.equal(r.bat, undefined); }
  }
  assert.ok(leaves >= 8, `left ${leaves}/10`);
});

test('hard AI middles most straight good-length balls (defends or drives)', () => {
  let contacts = 0, bowled = 0, n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = face({ paceKmh: 125 + (seed % 4) * 7, length: 5.5 + (seed % 3), line: 0.0 + (seed % 2) * 0.08 }, 'hard', 0.4, seed);
    n++;
    if (r.bat) contacts++;
    if (r.wicket && !r.bat) bowled++;
    if (r.bat) assert.ok(r.bat.vel.z < 5, `ball should go forward-ish, vz=${r.bat.vel.z} (${r.shot})`);
  }
  assert.ok(contacts / n > 0.75, `contact rate ${contacts}/${n}`);
  assert.ok(bowled / n < 0.2, `bowled ${bowled}/${n}`);
});

test('easy AI is beaten more often than hard AI by seam movement', () => {
  const run = (diff) => {
    let miss = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const r = face({ paceKmh: 138, length: 6.5, line: 0.06, seam: seed % 2 ? 1 : -1 }, diff, 0.3, seed);
      if (!r.bat || r.bat.isEdge) miss++;
    }
    return miss;
  };
  const easy = run('easy'), hard = run('hard');
  assert.ok(easy > hard, `easy beaten ${easy} vs hard ${hard}`);
});

test('short ball on the body gets pulled/defended off the back foot; full ball driven when he goes for it, else blocked', () => {
  const skill = CONFIG.ai.medium;
  const st = (settings) => {
    const d = machineDelivery(settings);
    const w = new PhysicsWorld();
    w.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing });
    return analyzeDelivery(w.ball, 1);
  };
  const shortInfo = st({ paceKmh: 135, length: 10.5, line: -0.05 });
  const s1 = chooseShot(shortInfo, skill, 1.0, () => 0.3);
  assert.ok(['pull', 'backdef'].includes(s1.type), s1.type);
  const fullInfo = st({ paceKmh: 130, length: 3.0, line: 0.05 });
  // (full and straight: driven when he means to go for it, otherwise a push in the line of the stumps)
  assert.equal(chooseShot(fullInfo, skill, 0.5, () => 0.1).type, 'drive');
  assert.equal(chooseShot(fullInfo, skill, 0.5, () => 0.9).type, 'defend');
  // (full and wide of off stump: the cover drive either way)
  assert.equal(chooseShot(st({ paceKmh: 130, length: 3.0, line: 0.4 }), skill, 0.5, () => 0.9).type, 'drive');
});

test('a ball he cannot reach is left alone: no bat thrown at a very wide one (any length, any mood)', () => {
  const geom = new BatGeometry(CONFIG.bat), pose = new Pose();
  for (const line of [1.4, 1.8, -1.3]) for (const length of [1.5, 5, 9, 11.5]) for (let seed = 1; seed <= 6; seed++) {
    const r = face({ paceKmh: 125 + seed * 3, length, line }, ['easy', 'medium', 'hard'][seed % 3], 0.95, seed);
    assert.equal(r.shot, 'leave', `line ${line} length ${length} seed ${seed}: ${r.shot}`);
    assert.equal(r.bat, undefined);
  }
  // Within reach he may play, but the bat stays an arm and a bat from his body.
  for (let seed = 1; seed <= 12; seed++) {
    const rng = makeRng(seed * 31 + 7);
    const world = new PhysicsWorld(CONFIG, seed);
    const ai = new AIBatter(); ai.setDifficulty('easy'); ai.aggression = 1;
    world.addBat('ai', ai, undefined, 1);
    const d = machineDelivery({ paceKmh: 130, length: seed % 2 ? 9 : 3.5, line: 1.05 }, null);
    world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0 });
    const plan = ai.planDelivery(world.ball.clone(), world.time, rng);
    if (plan.shot.type === 'leave') continue;
    ai.poseAt(plan.Tc, pose);
    const sweet = new Vec3(0, geom.sweetY, 0).applyQuat(pose.q).add(pose.p);
    const body = ai.bodyAt(plan.Tc);
    assert.ok(plan.C.x <= REACH.off + 1e-9, `C.x ${plan.C.x}`);
    assert.ok(Math.abs(pose.p.x - body.x) < 1.0 && Math.abs(sweet.x - body.x) < 1.25, `hands ${pose.p.x - body.x} sweet ${sweet.x - body.x}`);
  }
});

test('reach: a block reaches less far than a drive; over his head he ducks', () => {
  assert.equal(canReach(1.0, 0.5, 'drive'), true);
  assert.equal(canReach(1.0, 0.5, 'defend'), false);
  assert.equal(canReach(-0.9, 0.5, 'flick'), true);
  assert.equal(canReach(-1.2, 0.5, 'flick'), false);
  assert.equal(canReach(0, REACH.high + 0.1, 'pull'), false);
  const r = face({ paceKmh: 145, length: 13.2, line: 0 }, 'hard', 0.95, 2);
  assert.equal(r.shot, 'leave');
  assert.equal(r.bat, undefined);
});

test('pads: by the ball he plays at, never off to leg of his stance', () => {
  assert.ok(Math.abs(padX({ C: { x: 0.3 } }) - 0.16) < 1e-9);
  assert.equal(padX({ C: { x: -0.7 } }), padX(null), 'a ball down leg goes past his legs');
});
