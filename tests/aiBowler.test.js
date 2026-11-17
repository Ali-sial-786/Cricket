import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../src/physics/math.js';
import { AIBowler, BOWLER_TYPES } from '../src/game/aiBowler.js';
import { Innings } from '../src/game/scoring.js';
import { machineDelivery } from '../src/physics/bowlingMachine.js';
import { CONFIG } from '../src/config.js';

test('five overs use five different bowler types, each within its pace band', () => {
  const b = new AIBowler('hard', makeRng(4));
  const inn = new Innings({ balls: 30, wickets: 5 });
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const s = b.next(inn);
    seen.add(s.bowlerType);
    const [lo, hi] = BOWLER_TYPES[s.bowlerType].pace;
    assert.ok(s.paceKmh >= lo * 0.75 && s.paceKmh <= hi * 1.16, `${s.bowlerType} ${s.name} ${s.paceKmh}`);
    assert.ok(machineDelivery(s).solverError < 0.05, `${s.name} solves`);
    inn.record({ runs: 0 });
  }
  assert.equal(seen.size, 5);
});

test('easier difficulties bowl slower', () => {
  const avg = (d) => { const b = new AIBowler(d, makeRng(9)); const inn = new Innings({ balls: 6 }); let s = 0; for (let i = 0; i < 200; i++) s += b.next(inn).paceKmh; return s / 200; };
  assert.ok(avg('easy') < avg('medium') && avg('medium') < avg('hard'));
  assert.equal(CONFIG.difficulty.easy.timeScale, 0.7);
});

test('one bouncer an over at most (ICC T20I 41.6), and it comes at the head, not over it', async () => {
  const { predict, crossingAtZ } = await import('../src/physics/trajectory.js');
  const { BallState } = await import('../src/physics/ball.js');
  const b = new AIBowler('hard', makeRng(11));
  const inn = new Innings({ balls: 600, wickets: 10 });
  let bouncers = 0, over = 0, inOver = 0, high = 0;
  for (let i = 0; i < 600; i++) {
    const o = Math.floor(inn.legal / 6);
    if (o !== over) { over = o; inOver = 0; }
    const s = b.next(inn);
    if (s.name === 'bouncer') {
      bouncers++; inOver++;
      assert.ok(inOver <= CONFIG.match.bouncersPerOver, `over ${o}: ${inOver} bouncers`);
      const d = machineDelivery(s), ball = new BallState();
      ball.active = true; ball.pos.copy(d.releasePos); ball.vel.copy(d.vel); ball.spin.copy(d.spin);
      const c = crossingAtZ(predict(ball, { maxTime: 3, h: 1 / 240 }), -1.22);
      if (c && c.y > CONFIG.match.batterHeight) high++;
    }
    inn.record({ runs: 0 });
  }
  assert.ok(bouncers > 10, `${bouncers} bouncers`);
  assert.ok(high / bouncers < 0.35, `${high}/${bouncers} over head height`);
});
