// A seeded passage of play through the fielding logic, digested frame by
// frame: every fielder's position, velocity, facing, speed, state and action,
// the ball in a fielder's hands, the drawn states, the outcomes and the
// throw tally. Used by fieldingTrace.test.js to hold the logic to exactly
// the numbers it gave before it was made allocation-free (fielding.js is
// deterministic: any change to it that changes a result shows up here).
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { predict } from '../src/physics/trajectory.js';
import { Fielding, PLAYER_CLEAR, steerAmong } from '../src/game/fielding.js';
import { Runs } from '../src/game/running.js';

// FNV-1a over the bits of every number (and the characters of every string).
class Digest {
  constructor() { this.h = 0x811c9dc5; this.buf = new Float64Array(1); this.u = new Uint32Array(this.buf.buffer); }
  word(w) { this.h = Math.imul(this.h ^ (w & 0xffff), 16777619) >>> 0; this.h = Math.imul(this.h ^ (w >>> 16), 16777619) >>> 0; }
  num(x) { if (x == null) { this.word(0x7ff9dead); return; } this.buf[0] = x; this.word(this.u[0]); this.word(this.u[1]); }
  str(s) { if (s == null) { this.word(0x7ff9beef); return; } for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i)); this.word(0xfeed); }
  hex() { return this.h.toString(16).padStart(8, '0'); }
}

function digestField(D, L) {
  for (const f of L.fielders) {
    D.num(f.pos.x); D.num(f.pos.z); D.num(f.vel.x); D.num(f.vel.z); D.num(f.yaw); D.num(f.face); D.num(f.speed);
    D.str(f.state); D.str(f.action ? f.action.type : null);
    D.num(f.target ? f.target.x : null); D.num(f.target ? f.target.z : null);
  }
  const o = L.ballOverride;
  if (o) { D.num(o.pos.x); D.num(o.pos.y); D.num(o.pos.z); D.num(o.holder); } else D.num(null);
  for (const s of L.states()) {
    D.num(s.x); D.num(s.z); D.num(s.face); D.num(s.speed); D.num(s.hidden ? 1 : 0); D.str(s.state);
    D.num(s.crouch ? 1 : 0); D.num(s.await ? 1 : 0); D.num(s.armsUp ? 1 : 0); D.num(s.huddle);
    D.str(s.action ? s.action.type : null); D.str(s.leap ? s.leap.how : null);
  }
}

const DT = 1 / 72;
const STRIKER = { x: -0.4, z: -1.1 }, NON = { x: -1.35, z: -18.75 };

// One innings' worth of balls (n) from seed: hit in every direction at every
// pace, the batters running, the ball dead, the huddle, the walk back, the
// next ball. keeper: also unhit balls to (and past) the keeper. Returns
// { digest, frames, outcomes } (outcomes: a line per ball, for reading).
export function playPassage({ seed = 1, balls = 12, bowlerFields = true, spinner = false, keeper = true, greedy = 0 } = {}) {
  const rng = makeRng(seed);
  const world = new PhysicsWorld(undefined, seed + 100);
  const L = new Fielding({ rng: makeRng(seed + 7), catchSkill: 0.7, throwSkill: 1, spinner, bowlerFields });
  const runs = new Runs();
  L.runs = runs; L.autoRuns = false;
  const D = new Digest();
  const outcomes = [];
  let t = 0, frames = 0;
  const step = (n, ballLive) => {
    for (let k = 0; k < n; k++) {
      t += DT; frames++;
      world.advanceTo(t);
      for (const e of world.drainEvents()) if (e.type === 'boundary' && ballLive) L.onBoundary(e);
      // (the player's head, the umpires and the batters: what the controller sets every frame)
      L.keepOut = { x: STRIKER.x + Math.sin(t * 0.7) * 0.05, z: STRIKER.z, r: PLAYER_CLEAR, path: 2.1 };
      L.obstacles = [{ x: 0.9, z: -22.3, r: 0.9 }, { x: -21, z: -0.8, r: 0.9 }, { x: NON.x, z: NON.z, r: 0.95 }, { x: 2.2, z: -24, r: 1.5, soft: true }];
      L.lobTarget = { x: 0.5, y: 1.3, z: -21, roll: false };
      runs.update(DT);
      L.update(DT, t, world.ball.active ? world.ball : null, world);
      L.events.splice(0);
      digestField(D, L);
    }
  };
  for (let b = 0; b < balls; b++) {
    L.newBall();
    world.removeBall();
    world.resetWickets();
    step(40, false);
    L.walkIn();
    step(70, false);
    L.onRelease();
    const unhit = keeper && b % 4 === 3;
    if (unhit) {
      // a delivery to (or past) the keeper
      const x = (rng() - 0.5) * 2.2, y = 0.4 + rng() * 2.2;
      world.launch({ pos: new Vec3(x * 0.3, 1.0, -6), vel: new Vec3(x * 0.1, (y - 1.0) * 0.8, 30) });
      world.ball.bounces = 1;
      for (let k = 0; k < 120; k++) {
        t += DT; frames++;
        world.advanceTo(t);
        world.drainEvents();
        const ball = world.ball;
        if (ball.active && !L.keeperHold && !L.keeperMissed) { L.keeperTrack(ball, t); const got = L.keeperTry(ball, t); if (got === 'take') world.removeBall(); }
        L.update(DT, t, null, world);
        digestField(D, L);
      }
      outcomes.push(`k ${L.keeperHold ? 'held' : L.keeperMissed ? 'missed' : '-'}`);
      L.ballDead();
      step(300, false);
      continue;
    }
    // the hit: any direction, ground or air, soft to very hard
    const ang = (rng() - 0.5) * Math.PI * 2;
    const speed = 8 + rng() * 32, elev = -0.15 + rng() * 0.75;
    const from = new Vec3(-0.2, 0.8, -1.6);
    const vel = new Vec3(Math.sin(ang) * Math.cos(elev), Math.sin(elev), -Math.cos(ang) * Math.cos(elev)).scale(speed);
    world.launch({ pos: from, vel });
    world.ball.batted = true; world.ball.bouncesSinceBat = 0;
    L.onHit(world.ball, t, predict(world.ball, { maxTime: 10 }));
    runs.begin(t, STRIKER, NON);
    const est = L.estimateReturn();
    let want = est === 0 || L.boundaryAhead() ? 0 : est === Infinity ? 2 : Math.max(0, Math.floor((est - 2.5) / 3.2) + 1) + greedy;
    let done = false, deadAt = null;
    for (let k = 0; k < 72 * 14 && deadAt == null; k++) {
      if (!done && want > 0 && !runs.running && runs.call()) want--;
      step(1, true);
      if (done) continue;
      if (L.outcome) { done = true; runs.close({ boundary: L.outcome.kind === 'boundary' }); }
      else if (L.throwArrived) {
        done = true;
        const short = runs.running ? runs.shortBy() : -1;
        if (runs.running && short > 0) { L.outcome = { kind: 'runout', short }; runs.close({ stop: true, short }); }
        else { L.outcome = { kind: 'runs', runs: runs.makeGround() }; runs.close(); }
      }
      if (done) deadAt = k;
    }
    outcomes.push(`${b} ${L.outcome ? JSON.stringify(L.outcome) : 'none'} ${L.message}`);
    D.str(JSON.stringify(L.outcome)); D.str(L.message);
    step(30, false);
    L.ballDead();
    if (L.outcome && (L.outcome.kind === 'caught' || L.outcome.kind === 'runout')) {
      const held = L.ballOverride && L.ballOverride.holder != null ? L.ballOverride.holder : -1;
      L.celebrateWicket(t, held >= 0 ? L.fielders[held].pos : { x: 1, z: -12.5 }, held, undefined, 11);
    } else if (L.outcome && L.outcome.kind === 'boundary') L.reactBoundary(t);
    step(72 * 7, false);
    if (b % 3 === 2) { L.hurry = 2.5; step(200, false); }
  }
  D.str(JSON.stringify(L.tally));
  D.num(L.throwLog.length);
  for (const e of L.throwLog) D.str(JSON.stringify(e));
  // steerAmong on its own, among seeded circles (some on the move, some null)
  const S = makeRng(seed + 31), out = { x: 0, z: 0 };
  for (let i = 0; i < 400; i++) {
    const obs = [];
    for (let j = 0; j < 1 + (i % 7); j++) obs.push(S() < 0.1 ? null : { x: (S() - 0.5) * 8, z: S() * 8, r: 0.5 + S(), keepRight: S() < 0.4 });
    const u = steerAmong((S() - 0.5) * 2, S() * 0.5, (S() - 0.5) * 6, 4 + S() * 6, obs, out);
    D.num(u.x); D.num(u.z);
  }
  return { digest: D.hex(), frames, outcomes };
}
