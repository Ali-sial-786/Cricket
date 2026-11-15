// The shot read-out: the launch angle is the ball's as it left the bat, read
// with which way it went (a top edge that climbs over your shoulder is not a
// low drive), and a second touch of the bat re-reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattingSession, launchAngle, shotWhere, shotReadout } from '../src/game/batting.js';
import { BallState } from '../src/physics/ball.js';

test('launch angle: degrees above the horizontal, whichever way the ball goes', () => {
  assert.equal(Math.round(launchAngle({ x: 0, y: 0, z: -20 })), 0);
  assert.equal(Math.round(launchAngle({ x: 10, y: 10, z: 0 })), 45);
  assert.equal(Math.round(launchAngle({ x: 0, y: 4, z: 17 })), 13);       // behind, 13° up
  assert.equal(Math.round(launchAngle({ x: 0, y: -3, z: -10 })), -17);    // into the ground
  assert.ok(launchAngle({ x: 0.3, y: 25, z: 0.5 }) > 85);                 // skied
});

test('shot direction: the fielding position it went to (right-hander: off side +x, bowler -z)', () => {
  const at = (x, z) => shotWhere({ x, y: 1, z });
  assert.equal(at(0.5, -20), 'straight');
  assert.equal(at(6, -18), 'mid-off');
  assert.equal(at(-6, -18), 'mid-on');
  assert.equal(at(15, -12), 'cover');
  assert.equal(at(-15, -9), 'midwicket');
  assert.equal(at(20, 0), 'point');
  assert.equal(at(-20, 0), 'square leg');
  assert.equal(at(6, 15), 'third man');
  assert.equal(at(-6, 15), 'fine leg');
  assert.equal(at(0.3, 20), 'over the keeper');
  assert.equal(shotWhere({ x: 0.2, y: 20, z: 0.3 }), 'straight up');
});

test('read-out: a top edge over the shoulder reads its real launch and fine leg, not a low shot', () => {
  const r = shotReadout({ exit: 17.5, launch: launchAngle({ x: -4, y: 4, z: 16.5 }), dir: { x: -4, y: 4, z: 16.5 }, batSpeed: 30.5, quality: 0.01, carry: 18 });
  assert.match(r, /· 13° · fine leg ·/);
});

test('read-out: struck a second time, the read-out is of the ball as it finally left the bat', () => {
  const ball = new BallState();
  ball.active = true; ball.pos.set(-0.3, 1.6, -1.0); ball.vel.set(-4, 4, 16.5);
  const g = {
    world: { ball }, input: { right: { buttons: { squeeze: { pressed: false } } } },
    ui: { setHud() {}, prompt() {} }, say() {}, cheer() {}, crowdReact() {}, settings: {}, rng: () => 0.5,
  };
  const s = new BattingSession(g, { kind: 'nets' });
  s.state = 'live'; s.shotName = '';
  s.onEvent({ type: 'bat', batId: 'player', t: 5, quality: 0.05, isEdge: true, batSpeed: 30, face: 'front' });
  assert.equal(Math.round(s.hit.launch), 13);
  ball.vel.set(-0.5, 18, 2);                                    // the bat came round into it again
  s.onEvent({ type: 'bat', batId: 'player', t: 5.2, quality: 0.1, isEdge: true, batSpeed: 25, face: 'front' });
  assert.ok(s.hit.launch > 80, `launch ${s.hit.launch}`);
  assert.match(s.shotDetail(), /straight up/);
});
