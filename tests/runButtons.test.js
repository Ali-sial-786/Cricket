// The running buttons (src/game/batting.js runControls): in the headset Y
// turns back and the off-hand trigger, held, dives; on a monitor the keys are
// unchanged (G back, V dive). And the session reads them that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattingSession, runControls } from '../src/game/batting.js';

const btn = () => ({ pressed: false, down: false });
const ctl = (hand) => ({ hand, connected: true, buttons: { trigger: btn(), squeeze: btn(), a: btn(), b: btn(), stick: btn() }, stick: { x: 0, y: 0 }, pulse() { this.pulsed = true; } });

test('headset: Y turns back, the off-hand trigger dives; monitor: G (left trigger) back, V (Y) dive', () => {
  const L = ctl('left'), R = ctl('right');
  const xr = runControls({ xr: true, left: L, right: R }, L);
  assert.equal(xr.back, L.buttons.b);
  assert.equal(xr.dive, L.buttons.trigger);
  assert.equal(xr.diveHand, L);
  // a left-handed bat: the off hand is the right one
  assert.equal(runControls({ xr: true, left: L, right: R }, R).dive, R.buttons.trigger);
  const desk = runControls({ xr: false, left: L, right: R }, L);
  assert.equal(desk.back, L.buttons.trigger, 'G');
  assert.equal(desk.dive, L.buttons.b, 'V');
});

// Just enough of a game for the running branch of handleInput.
function running(xr) {
  const L = ctl('left'), R = ctl('right'), calls = { back: 0 };
  const runs = { running: true, closed: false, completed: 0, diveHeld: false, diveStarted: false };
  const g = {
    realDt: 1 / 72, input: { xr, left: L, right: R, desktop: {} }, runs, rigOffset: { x: 0, z: 0 },
    world: { ball: { padded: false } }, replay: { skipHand: () => L },
    setRigOffset() {}, say() {}, sample() {}, hint() {}, ui: { prompt() {} }, playerBat: {},
  };
  const s = Object.create(BattingSession.prototype);
  Object.assign(s, { game: g, state: 'live', hit: { t: 0 }, byes: null, advance: 0, crease: { x: 0, z: 0 }, sweepK: 0, lbw: { active: false } });
  s.readLowSweep = () => false;
  s.field = { result: () => null, callRun: () => true, turnBack: () => { calls.back++; return true; }, throwEnd: () => null };
  return { s, L, runs, calls, input: g.input };
}

test('batting, running in the headset: holding the left trigger is the dive, Y turns back', () => {
  const { s, L, runs, calls, input } = running(true);
  L.buttons.trigger.pressed = true; L.buttons.trigger.down = true;
  s.handleInput(input);
  assert.equal(runs.diveHeld, true, 'trigger held: dive');
  assert.equal(calls.back, 0, 'the trigger no longer turns back');
  L.buttons.trigger.pressed = false; L.buttons.trigger.down = false;
  L.buttons.b.pressed = true; L.buttons.b.down = true;
  s.handleInput(input);
  assert.equal(calls.back, 1, 'Y: back');
  assert.equal(runs.diveHeld, false, 'Y is not a dive any more');
});

test('batting, running on a monitor: G still turns back, V still dives', () => {
  const { s, L, runs, calls, input } = running(false);
  L.buttons.trigger.pressed = true; L.buttons.trigger.down = true;       // G
  s.handleInput(input);
  assert.equal(calls.back, 1);
  assert.equal(runs.diveHeld, false);
  L.buttons.trigger.pressed = false; L.buttons.trigger.down = false;
  L.buttons.b.pressed = true;                                            // V
  s.handleInput(input);
  assert.equal(runs.diveHeld, true);
});
