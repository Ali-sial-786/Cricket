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
