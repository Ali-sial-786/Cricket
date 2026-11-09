// Forward prediction of a ball's flight using the exact same integrator as the
// world (no bats). Used by the bowling-machine solver, the AI batter, fielders
// and the nets "projected carry" readout. Pure JS.

import { BallState, aeroParams, integrateFlight } from './ball.js';
import { groundDistance } from './pitch.js';
import { Wicket } from './wicket.js';
import { CONFIG } from '../config.js';
import { Vec3 } from './math.js';

const _wBat = new Wicket('batting', 0);
const _pa = new Vec3();

// Simulate from `state` (BallState, not mutated).
// opts: { cfg, P, maxTime, sampleEvery (s), stop: (ball, t) => bool,
//         rng (null = deterministic, no random seam), wicket: bool }
export function predict(state, opts = {}) {
  const cfg = opts.cfg || CONFIG;
  const P = opts.P || aeroParams(cfg);
  const h = opts.h || 1 / cfg.physics.substepHz;
  const maxTime = opts.maxTime ?? 6;
  const sampleEvery = opts.sampleEvery ?? 1 / 60;
  const ball = state.clone();
  ball.active = true;
  const samples = [];
  const bounces = [];
  let t = 0, nextSample = 0;
  let wicketHit = null;
  let boundary = null;
  let end = 'timeout';
  const push = () => samples.push({
    t, x: ball.pos.x, y: ball.pos.y, z: ball.pos.z,
    vx: ball.vel.x, vy: ball.vel.y, vz: ball.vel.z,
    bounces: ball.bounces, bouncesSinceBat: ball.bouncesSinceBat,
  });
  push();
  while (t < maxTime) {
    _pa.copy(ball.pos);
    integrateFlight(ball, h, P, opts.rng || null, (info, pos) => {
      bounces.push({ t: t + h, pos: pos.clone(), ...info });
    });
    t += h;
    if (opts.wicket && !wicketHit) {
      const s = _wBat.sweep(_pa, ball.pos, P.r);
      if (s >= 0) {
        wicketHit = { t: t - h + s * h, pos: _pa.clone().lerp(ball.pos, s) };
        if (opts.stopAtWicket) { end = 'wicket'; push(); break; }
      }
    }
    if (!boundary && groundDistance(ball.pos.x, ball.pos.z) > cfg.field.boundaryRadius) {
      boundary = { t, onFull: ball.bouncesSinceBat === 0 && ball.batted, bounces: ball.bounces, pos: ball.pos.clone() };
    }
    if (t >= nextSample) { push(); nextSample += sampleEvery; }
    if (ball.stopped) { end = 'stopped'; push(); break; }
    if (opts.stop && opts.stop(ball, t)) { end = 'stop'; push(); break; }
  }
  return { samples, bounces, wicketHit, boundary, end, final: ball };
}

// Time/position at which the ball centre first crosses z = zPlane (moving +z
// or -z). Returns null if it never does.
export function crossingAtZ(pred, zPlane) {
  const s = pred.samples;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if ((a.z - zPlane) * (b.z - zPlane) <= 0 && a.z !== b.z) {
      const f = (zPlane - a.z) / (b.z - a.z);
      return {
        t: a.t + (b.t - a.t) * f,
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: zPlane,
        vx: a.vx + (b.vx - a.vx) * f,
        vy: a.vy + (b.vy - a.vy) * f,
        vz: a.vz + (b.vz - a.vz) * f,
        bounces: b.bounces,
      };
    }
  }
  return null;
}

// Simulate until the first ground contact; returns { t, pos, vel } or null.
export function firstBounce(state, cfg = CONFIG, P = aeroParams(cfg), maxTime = 3) {
  const ball = state.clone();
  ball.active = true;
  ball.bounces = 0;
  const h = 1 / cfg.physics.substepHz;
  let t = 0;
  let hit = null;
  while (t < maxTime && !hit) {
    integrateFlight(ball, h, P, null, (info, pos) => {
      hit = { t: t + h, pos: pos.clone(), info };
    });
    t += h;
  }
  return hit;
}
