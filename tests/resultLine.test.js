// The result line on the HUD panel is about THIS ball: cleared when a new ball
// starts, "Appeal…" / the on-field call / "Third umpire…" while it is being
// decided (never the last ball's "FOUR!" or "OUT — LBW"), the verdict after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattingSession } from '../src/game/batting.js';
import { LbwFlow } from '../src/game/lbwFlow.js';
import { ThirdUmpireFlow } from '../src/game/thirdUmpire.js';
import { BallState } from '../src/physics/ball.js';
import { Vec3 } from '../src/physics/math.js';

function fakeGame() {
  const hud = { title: 'Run Chase', big: 'FOUR!', bigColor: '#4dd2ff', last: '127 km/h · good', detail: 'Exit 109 km/h · 17°' };
  const toasts = [];
  const nop = () => {};
  const g = {
    hud, toasts, simTime: 10, clock: 10, realDt: 1 / 72, rigOffset: { x: 0, z: 0 },
    rng: () => 0.5, settings: { difficulty: 'medium', autoFeed: true, machine: { release: 'over' } },
    input: { xr: false, right: { connected: false, buttons: { a: {} } }, left: { buttons: { a: {} } }, headPose: { p: { x: 0, y: 1.6, z: 0 } } },
    world: { ball: { padded: false, active: false }, removeBall: nop, resetWickets: nop },
    stumps: { batting: { reset: nop }, bowling: { reset: nop } },
    ballView: { setVisible: nop, clearTrail: nop, visible: false },
    machine: { setRelease: nop, setCue: nop }, umpires: { signal: nop, setLook: nop },
    drs: { startLbw: nop, startThird: nop, placeBoard: nop, hide: nop, update: nop, takeCues: () => [], done: false },
    ui: {
      setHud: (p) => Object.assign(hud, p), showHud: nop, setBoard: nop,
      prompt: (text) => toasts.push(text),
    },
    sample: nop, say: nop, crowdReact: nop, hint: nop,
  };
  return g;
}

test('result line: a new ball clears the last one\'s result, delivery and shot lines', () => {
  const g = fakeGame();
  const s = new BattingSession(g, { kind: 'nets' });
  s.planned = { settings: {}, delivery: { releasePos: new Vec3(0, 2, -18) } };
  s.prepare(10);
  assert.equal(g.hud.big, '');
  assert.equal(g.hud.last, '');
  assert.equal(g.hud.detail, '');
  assert.equal(g.hud.title, 'Run Chase');               // (the score and title stay)
  // a new batter is named, nothing else
  s.newBatter = 'D. Okafor'; g.hud.big = 'CAUGHT — Cover!';
  s.planned = { settings: {}, delivery: { releasePos: new Vec3(0, 2, -18) } };
  s.prepare(20);
  assert.equal(g.hud.big, '');
  assert.equal(g.hud.detail, 'New batter in: D. Okafor');
});

test('result line: an LBW appeal shows "Appeal…", then the umpire\'s call, never the last ball\'s result', () => {
  for (const out of [true, false]) {
    const g = fakeGame();
    const flow = new LbwFlow(g, { player: 0, ai: 0 });
    const ball = new BallState();
    ball.pos.set(out ? -0.02 : 0.6, 0.3, -1.4); ball.vel.set(0, -1, 30); ball.active = true;
    flow.start({ impactState: ball, path: [], shotOffered: false, playerIsBatter: true });
    assert.equal(g.hud.big, 'Appeal…');
    assert.equal(g.hud.detail, '');
    for (let i = 0; i < 200 && flow.phase === 'appeal'; i++) flow.update(1 / 72);
    const call = flow.onFieldOut;
    assert.equal(g.hud.big, call ? 'Given OUT — LBW' : 'NOT OUT');
    assert.ok(g.toasts.includes(call ? 'OUT — LBW' : 'NOT OUT'));
    assert.ok(!/FOUR/.test(g.hud.big));
  }
});

test('result line: a third-umpire review shows "Third umpire…" until the verdict', () => {
  const g = fakeGame();
  const flow = new ThirdUmpireFlow(g);
  flow.start({ kind: 'run_out', end: 'batting', margin: 0.05, out: true });
  assert.equal(g.hud.big, 'Third umpire…');
  assert.equal(g.hud.detail, '');
});
