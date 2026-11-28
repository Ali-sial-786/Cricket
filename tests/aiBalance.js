// You bowl at the AI batter, headless: the deliveries the game makes from
// your aim (bowlingInput.js playerDelivery, the aim marker on), the AI
// batter's own plan and swing as a bat in the physics world (aiBatter.js), the
// session's pad check and LBW judging (lbwFlow.js padHit, lbw.js: the umpire,
// and the batter's review of a wrong one), bowled off the stumps, and the
// field for a ball he hits (fielding.js: caught, a boundary, or fielded and
// the runs the AI batters would take, running.js planRuns). Used by
// aiBalance.test.js and to measure the batter's balance.
import { Vec3, makeRng } from '../src/physics/math.js';
import { PhysicsWorld } from '../src/physics/world.js';
import { predict } from '../src/physics/trajectory.js';
import { CONFIG } from '../src/config.js';
import { AIBatter } from '../src/game/aiBatter.js';
import { playerDelivery } from '../src/game/bowlingInput.js';
import { playerBowler } from '../src/game/bowlerTypes.js';
import { padHit } from '../src/game/lbwFlow.js';
import { trackLbw, umpireDecision, lawOut } from '../src/game/lbw.js';
import { aiWillReview } from '../src/game/edgeTrack.js';
import { Fielding } from '../src/game/fielding.js';
import { planRuns } from '../src/game/running.js';

const DT = 1 / 72;
const UMPIRE = { easy: 0.8, medium: 0.86, hard: 0.92 };      // (lbwFlow.js ACC)
// Where you aim (the marker: where it pitches): x across (+ off side), length m from the stumps.
export const AIMS = {
  goodOff: { fast: { x: 0.1, len: 6.5 }, spin: { x: 0.1, len: 4.6 }, label: 'good length, off stump' },
  fullMiddle: { fast: { x: 0.0, len: 3.4 }, spin: { x: 0.0, len: 2.8 }, label: 'full, middle' },
  yorker: { fast: { x: -0.06, len: 1.0 }, spin: { x: -0.06, len: 1.0 }, label: 'yorker, middle and leg' },
  backOff: { fast: { x: 0.35, len: 8.6 }, spin: { x: 0.35, len: 6.3 }, label: 'back of a length, outside off' },
};
// A sensible bowler's spread (aim 'mix'): 60% good length on or just outside off, 20% full and
// straight, 10% short, 10% yorkers, each spread over its band.
const _mix = { x: 0, len: 0, cls: '' };
export function mixAim(kind, rng) {
  const u = rng(), j = (a, b) => a + (b - a) * rng(), spin = kind === 'spin';
  if (u < 0.6) { _mix.x = j(0.05, 0.3); _mix.len = spin ? j(4.0, 5.5) : j(5.5, 7.5); _mix.cls = 'good'; }
  else if (u < 0.8) { _mix.x = j(-0.08, 0.08); _mix.len = spin ? j(2.4, 3.4) : j(2.8, 4.0); _mix.cls = 'full'; }
  else if (u < 0.9) { _mix.x = j(-0.1, 0.25); _mix.len = spin ? j(6.5, 7.5) : j(8.5, 10); _mix.cls = 'short'; }
  else { _mix.x = j(-0.1, 0.05); _mix.len = j(0.6, 1.4); _mix.cls = 'yorker'; }
  return _mix;
}
const CHOICES = { fast: ['stock', 'stock', 'outswinger', 'inswinger', 'offcutter', 'legcutter', 'slower'], spin: ['offbreak', 'offbreak', 'offbreak', 'armball', 'doosra'] };

// n balls at `aim` ('goodOff' ...) by 'fast' (the fast bowler) or 'spin' (the off-spinner).
// Returns counts: bowled, lbw, caught, r0..r6 (runs off a ball he hit; r0 = dot), beaten (played
// and missed, not out: off the pad too), left, appeals (pad hits: you appeal every one), plumb (of
// them, out by the Law: the rest are the close ones and the not-outs), edges,
// byShot: { shot: { n, out, pad, edge, miss, runs } }, byEx: { misplay kind: {...} },
// byCls: { length band (the mix's good / full / short / yorker, or the aim): {...} }.
// auto: bowled as the game's auto run-up bowls them (bowling.js autoBowl): the stock ball at the
// machine's pace (130 km/h, within the bowler's range), released exactly at the aim; otherwise a
// pace across his range, a few degrees off the aim, and one of his deliveries at random.
export function bowlAt({ aim = 'fullMiddle', kind = 'fast', difficulty = 'medium', n = 200, seed = 1, aggression = 0.35, auto = false } = {}) {
  const rng = makeRng(seed * 9973 + 7);
  const world = new PhysicsWorld(CONFIG, seed);
  const ai = new AIBatter();
  world.addBat('ai', ai, undefined, 1);
  const bowler = playerBowler(kind === 'spin' ? 'offspin' : 'fast');
  const MIX = aim === 'mix';
  let A = MIX ? null : AIMS[aim][kind];
  const B = CONFIG.bowling;
  const c = { bowled: 0, lbw: 0, caught: 0, r0: 0, r1: 0, r2: 0, r3: 0, r4: 0, r6: 0, dot: 0, beaten: 0, left: 0, appeals: 0, plumb: 0, edges: 0, byShot: {}, byEx: {}, byCls: {} };
  const ball = { res: '', edge: false };
  let t = 0;
  for (let i = 0; i < n; i++) {
    world.resetWickets(); world.removeBall(); ai.reset();
    // Your release: the aim (a few degrees off it either way), a pace across the bowler's range, one of his deliveries.
    const rel = new Vec3(0.5, 2.05, -18.95);
    if (MIX) A = mixAim(kind, rng);
    const aimPt = { x: A.x, z: -A.len };
    const effort = auto ? Math.pow((Math.min(Math.max(130, bowler.pace[0]), bowler.pace[1]) - bowler.pace[0]) / Math.max(1, bowler.pace[1] - bowler.pace[0]), 1 / 0.85)
      : kind === 'spin' ? 0.35 + 0.4 * rng() : 0.55 + 0.4 * rng();
    const speed = (B.effortHandSpeed[0] + (B.effortHandSpeed[1] - B.effortHandSpeed[0]) * effort) * 2.6 / B.paceMultiplier;
    const el = (B.neutralElevationDeg + (auto ? 0 : rng.gauss() * 4)) * Math.PI / 180;
    const az = Math.atan2(aimPt.x - rel.x, aimPt.z - rel.z) + (auto ? 0 : rng.gauss() * 4 * Math.PI / 180);
    const vel = new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).scale(speed);
    const dir = new Vec3(Math.sin(az), 0, Math.cos(az));
    const choice = auto ? bowler.deliveryList[0].key : CHOICES[kind][Math.floor(rng() * CHOICES[kind].length)];
    const d = playerDelivery({ releasePos: rel, handVel: vel, handAngVel: dir.clone().scale(kind === 'spin' && !auto ? 30 : 0), palmDir: dir, swingChoice: 0, bowler, choice, paceScale: 1, aim: aimPt, assist: true, rng });
    t += 4;
    world.time = t;
    world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0.5 });
    ai.setProfile(difficulty, null);
    ai.aggression = aggression;
    const plan = ai.planDelivery(world.ball.clone(), t, rng, { charge: (CONFIG.ai.charge[difficulty] ?? 0.4) });
    playBall(world, ai, plan, t, rng, difficulty, ball);
    let res = ball.res;
    if (res === 'r') res = field(world, rng, aggression, t, difficulty, kind === 'spin');        // he hit it: the field
    if (res === 'padNotOut' || res === 'lbw') { c.appeals++; if (ball.plumb) c.plumb++; }
    if (res === 'r0') c.dot++;
    if (res !== 'padNotOut') c[res]++;
    else c.beaten++;
    if (ball.edge) c.edges++;
    const key = plan.shot.type + (plan.shot.charge ? '+charge' : plan.shot.push ? '+push' : '');
    const S = c.byShot[key] || (c.byShot[key] = { n: 0, out: 0, pad: 0, edge: 0, miss: 0, runs: 0 });
    S.n++;
    const runs = res[0] === 'r' ? +res.slice(1) : 0;
    S.runs += runs;
    const ck = MIX ? A.cls : aim;
    const K = c.byCls[ck] || (c.byCls[ck] = { n: 0, bowled: 0, lbw: 0, caught: 0, shout: 0, runs: 0, b4: 0, dot: 0 });
    K.n++; K.runs += runs; if (res === 'bowled' || res === 'lbw' || res === 'caught') K[res]++; if (res === 'lbw' || res === 'padNotOut') K.shout++;
    if (res === 'r4' || res === 'r6') K.b4++; if (res === 'r0' || res === 'beaten' || res === 'left' || res === 'padNotOut') K.dot++;
    const xk = (plan.ex && plan.ex.kind) || '-';
    const X = c.byEx[xk] || (c.byEx[xk] = { n: 0, bowled: 0, lbw: 0, caught: 0, shout: 0, runs: 0 });
    X.n++; X.runs += runs; if (res === 'bowled' || res === 'lbw' || res === 'caught') X[res]++; if (res === 'lbw' || res === 'padNotOut') X.shout++;
    if (res === 'bowled' || res === 'lbw' || res === 'caught') S.out++;
    if (res === 'lbw' || res === 'padNotOut') S.pad++;
    if (ball.edge) S.edge++;
    if (res === 'beaten' || res === 'bowled' || res === 'padNotOut') S.miss++;
  }
  return c;
}

// The session's pad box for the AI batter at t (bowling.js checkLive: AIBatter.padAt).
const _pad = { x: 0, z: 0, halfX: 0.2, front: 0.24, back: 0.24 }, _box = { halfX: 0.2, front: 0.24, back: 0.24 };

// One delivery to the bat or the pads or past, into out: res 'bowled' | 'lbw' | 'padNotOut' | 'beaten' | 'left' | 'r' (hit); edge.
function playBall(world, ai, plan, t0, rng, difficulty, out) {
  out.res = playOut(world, ai, plan, t0, rng, difficulty, out);
}
function playOut(world, ai, plan, t0, rng, difficulty, out) {
  const b = world.ball, path = [];
  let bounced = false, hit = null, padded = false;
  out.edge = false; out.plumb = false; out.exit = 0; out.q = 0; out.vy = 0; out.dir = 0;
  for (let t = t0 + DT; t < t0 + 3; t += DT) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) {
      if (e.type === 'bounce' && !e.batted && !bounced) { bounced = true; ai.adjust(world.ball.clone(), world.time); }
      if (e.type === 'bat' && e.batId === 'ai' && !hit) { hit = e; out.edge = !!e.isEdge; out.exit = e.speedOut; out.q = e.quality; out.vy = world.ball.vel.y; out.dir = Math.atan2(world.ball.vel.x, -world.ball.vel.z); }
      if (e.type === 'wicket' && e.end === 'batting' && !e.thrown && (!hit || e.t - hit.t < 0.6)) return 'bowled';
    }
    if (hit) return 'r';
    if (b.active && !b.batted) path.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    if (!padded && plan.shot.type !== 'pull' && plan.shot.type !== 'cut') {
      const pad = ai.padAt(t, _pad);
      _box.halfX = pad.halfX; _box.front = pad.front; _box.back = pad.back;
      if (padHit(b, pad.x, pad.z, _box, path.length > 1 ? path[path.length - 2] : null)) {
        padded = true;
        const shotOffered = plan.shot.type !== 'leave';
        let track = null;
        try { track = trackLbw({ impactState: b.clone(), cfg: CONFIG }); } catch { track = null; }
        // (you appeal whenever it hits him: the umpire decides; a wrong one he may review)
        const given = umpireDecision(track, { shotOffered, rng, accuracy: UMPIRE[difficulty] });
        const truth = lawOut(track, { shotOffered });
        out.plumb = truth;
        if (given && !truth && aiWillReview({ kind: 'lbw', aiBatting: true, onFieldOut: true, truthOut: false, left: 1, rng })) return 'padNotOut';
        return given ? 'lbw' : 'padNotOut';
      }
    }
    if (b.pos.z > 2.4 || !b.active) break;
  }
  return plan.shot.type === 'leave' ? 'left' : 'beaten';
}

// A ball he hit, to the field: 'caught' | 'r0'..'r6'.
function field(world, rng, aggression, t0, difficulty, spinner) {
  const b = world.ball;
  const skill = CONFIG.ai[difficulty] || CONFIG.ai.medium;    // (the field's hands and arms by the difficulty, as fieldController.js)
  const L = new Fielding({ rng, catchSkill: skill.catchSkill, throwSkill: 0.85 + (skill.catchSkill - 0.55) / (0.88 - 0.55) * 0.3, spinner });
  L.autoRuns = false;
  const pred = predict(b, { maxTime: 8, h: 1 / 240 });
  L.onHit(b, t0, pred);
  const est = L.estimateReturn();
  const bold = 0.25 + 0.5 * aggression;
  const runs = L.boundaryAhead() || est === 0 ? 0 : est === Infinity ? 3 : planRuns(est, bold, rng);
  for (let t = t0 + DT; t < t0 + 14; t += DT) {
    world.advanceTo(t);
    for (const e of world.drainEvents()) if (e.type === 'boundary') L.onBoundary(e);
    L.update(DT, t, b.active ? b : null, world);
    if (L.outcome) {
      if (L.outcome.kind === 'caught') return 'caught';
      if (L.outcome.kind === 'boundary') return L.outcome.runs === 6 ? 'r6' : 'r4';
    }
    // (fielded: the runs they called that they can still finish before his throw is in -- the rest they turn back from)
    if (L.fielded) return `r${Math.min(3, runs, L.throw ? planRuns(L.throw.tArrive - t0, bold, rng) : runs)}`;
  }
  return `r${Math.min(3, runs)}`;
}
