// The replay director (no three.js, so it can be tested in node): which balls
// get a replay, and how each one is cut: the angles, the tempo, the length.
//
// 1. What gets a replay (Settings -> Replays: highlights | every ball | off).
//    classify() reads what happened to the ball and names its story:
//      wicket    bowled, lbw, caught, run out, stumped;
//      boundary  four, six;
//      close     a run-out / stumping chance (the stumps broken or not), a
//                catch put down, an edge anywhere, any appeal, a play-and-miss
//                within 25 cm of the stumps or 10 cm of the edge, a bouncer
//                past the helmet, a lofted shot down by a fielder, a hard hit
//                stopped before the rope, a direct hit, a diving stop, a
//                misfield / overthrows (DIRECTOR's thresholds);
//                and the ball that ends an innings or the match, whatever it was;
//      routine   everything else (leaves well wide, dots, pushed singles): only
//                "every ball".
// 2. The takes. A replay is a sequence of whole takes, each ONE continuous
//    shot from a fixed spot (turning, yaw only in the headset: no roll, the
//    horizon level, your own head pitches), a quick dip to dark between them:
//      take 1, always: from the bowler's end, behind the arm: the last strides,
//               the release, the ball down the pitch, bat / pad / stumps and the
//               first of what follows; it turns no more than 25° off the pitch,
//               so a ball that leaves its reach ends the take (a beat after).
//      take 2, only where another angle shows what take 1 cannot, from the
//               broadcast positions (CANON): the line of the stumps in front of
//               the batter (bowled, lbw, an appeal); side-on at the popping
//               crease with a freeze as the stumps break (run-out, stumping);
//               three-quarter on, close, on the fielder (a catch, a drop, a
//               dive, a lofted shot down by him, a hard hit he stopped); the
//               rope (a four) or the crowd (a six); a fixed spot round the
//               ground (overthrows). Every later take passes takeOK (clear of
//               everybody, its subject in the middle and near, never looking up
//               into the sky, never ending on a sightscreen, the big screen or
//               the pavilion) or it is left out.
// 3. The tempo: take 1 from the last stride (0.35 s before the release) at
//    real speed, 0.6 s (real) of slow motion (0.3x) round the key moment, 0.3 s
//    after; a later take from about 1 s before its moment, a short slow beat on
//    it. About 4 s for a boundary, 5 s for a wicket, 3.5 s for a close call.
// 4. How often (replayTakes): the whole replay for a wicket, a six, a drop, a
//    run-out / stumping decision and the last ball; a four's second take for
//    the first four of an over only; other close calls take 1, one an over.
// Everything is laid out once, when the replay starts (~1-3 ms), from the tape.
import { keepClear, blocksSight, nearestOnBody, viewShares, CLEAR, SCREEN } from './replayFraming.js';
import { hypot2, hypot3 } from '../physics/math.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const CZ = -10.06, Z_BAT = 0, Z_BOWL = -20.12, POP = 1.22, SEATS = 84;   // (the stands' front wall, m from the middle)
// Where nobody sits, [centre, half width] in degrees round from behind the batter: the covered seats behind the
// sightscreens, the pavilion (replayFraming.js STAND).
const NO_CROWD = [[0, 10], [180, 10], [90, 12]], ONE = [null];

export const MODES = ['highlights', 'every', 'off'];
// Real seconds at most: a replay is a sequence of whole takes, each one continuous shot (DIRECTOR.takes); the
// whole: take 1 and one more; a routine ball ("every ball") take 1 only, short.
export const BUDGET = { wicket: 5.2, boundary: 4.4, close: 4.2, routine: 2.2 };
export const DIRECTOR = {
  du: 1 / 90,                  // s: the plan's samples (real time)
  slow: 0.3,                   // slow motion through the key moment
  cutOut: 0.03, cutIn: 0.05,   // s: a cut is a quick dip: down to dark and back in (one cut at most a replay)
  endOut: 0.04,                // s: the last moments fade down before you are put back
  inOut: 0.08,                 // s: the view comes in from dark as the replay starts, and as it puts you back
  takes: { first: 2.4, later: 2.6 },   // s: take 1 (the bowler's end) at most, each later take at most
  t1: { pre: 0.35, slowReal: 0.6, post: 0.3 },   // take 1: from the last stride; 0.6 s (real) of slow motion round the key moment; 0.3 s after
  t2: { lead: 1.0, slowReal: 0.6 },              // a later take: from 1 s before its moment, a short slow beat on it
  // how many takes a ball gets in highlights (replayTakes): a four's second take only for the first four of
  // an over; one close-call replay an over (take 1 only), a review aside
  freq: { foursFull: 1, closePerOver: 1 },
  fourChase: 15,                                 // m: a four's second take needs a fielder this near where it crosses
  arm: { back: 3.0, y: 2.5, side: 2.0, yawLim: 25 * D2R },  // m behind the bowler's stumps, m up, m to the bowling arm's side; it turns no more than this off the pitch
  line: { z: -7.0, y: 1.65, gap: 3.0 },  // on the stumps' line, z; eye height; joins once the ball is this far past it
  crease: { d: 8.5, y: 1.4 },  // m square of the popping crease, m up
  cone: 20 * D2R,              // the middle of the view the ball is kept inside
  lead: 0.18,                  // s (real): the turn leads the ball by this much
  share: 0.4,                  // of a turn too quick to make, the part made before the ball gets there
  rim: 60,                     // m from the middle: no camera further out (inside the rope, clear of the boards)
  // turn limits: headset gentle, monitor brisker
  xr: { wMax: 60 * D2R, wAcc: 150 * D2R },
  desk: { wMax: 110 * D2R, wAcc: 360 * D2R },
  // the monitor's lens per angle (vertical fov, degrees)
  fov: { arm: 27, line: 42, crease: 36, track: 40, wide: 48 },
  // what earns a replay in highlights beyond wickets and boundaries (classify)
  beatenBy: 0.25,              // m: played and missed, the ball this close to the stumps
  pastEdge: 0.10,              // m: …or this close to the bat's edge
  leftBy: 0.04,                // m: left alone, all but hitting them
  headNear: 0.30,              // m: a bouncer past the helmet
  runAttempt: 1.2,             // m: the batter home by no more than this as the throw came in (a run-out chance)
  safeNear: 5,                 // m: a lofted shot (over safeHigh m up) landing this close to a fielder
  safeHigh: 3,
  savedSpeed: 22, savedR: 52,  // m/s off the bat, m from the middle (less 8): a hard hit stopped in the deep
  // the checks every later take's camera passes, or there is no such take (takeOK)
  // (a figure at least figH of the picture's height, vfov high; the ball at least ballPx at pxPerRad, its own size)
  checks: { clear: 1.5, minY: 1.2, off: 20 * D2R, offArc: 45 * D2R, up: 40 * D2R, none: 0.1, sky: 0.15, boards: 0.35, figH: 0.08, crowd: 0.6, vfov: 90 * D2R, ballPx: 8, ballR: 0.036, pxPerRad: 20 / D2R },
};

// The broadcast positions a later take's camera comes from (DIRECTOR / takeOK): fixed ones round the
// ground, and the ones placed from the moment itself (CANON's descriptions).
export const CANON = {
  arm: 'behind the bowler\'s arm (take 1)', line: 'on the line of the stumps in front of the batter', square: 'side-on at the popping crease, either side',
  catch: 'three-quarter on from the fielder\'s front, 5-8 m, chest high', rope: 'inside the rope by where a four goes over', crowd: 'in front of the seats where a six comes down',
  keeperHigh: 'high behind the keeper', cover: 'cover, inside the rope', midwicket: 'mid-wicket, inside the rope', longOff: 'long-off, high', longOn: 'long-on, high',
  squareOffHigh: 'square on the off side, high', squareLegHigh: 'square on the leg side, high', screenSide: 'beside a sightscreen, inside the rope',
};
const ringAt = (name, az, r, y) => ({ name, x: Math.sin(az * D2R) * r, y, z: CZ + Math.cos(az * D2R) * r });
const FIXED = [{ name: 'keeperHigh', x: 0, y: 5, z: 18 }, ringAt('cover', 122, 52, 3), ringAt('midwicket', 238, 52, 3), ringAt('longOff', 150, 57, 6), ringAt('longOn', 210, 57, 6),
  ringAt('squareOffHigh', 90, 45, 4), ringAt('squareLegHigh', 270, 45, 4),
  // beside each sightscreen inside the rope, looking across the straight boundary in front of it
  { name: 'screenSide', x: 19, y: 4, z: CZ - 62 }, { name: 'screenSide', x: -19, y: 4, z: CZ - 62 }, { name: 'screenSide', x: 19, y: 4, z: CZ + 62 }, { name: 'screenSide', x: -19, y: 4, z: CZ + 62 }];

// The setting as it applies (old saves said 'bowler' for "on": highlights).
export function replayMode(s) {
  const v = s && s.replay;
  return v === 'off' ? 'off' : v === 'every' ? 'every' : 'highlights';
}
export function wants(mode, tier) { return mode === 'every' || (mode === 'highlights' && tier !== 'routine'); }

// ---------------------------------------------------------------- 1. the story
// f: what the session and the tape say about the ball:
//   res        the session's result ({ kind, runs, closeCall, margin, padded, backInTime, shyMissed, overthrows })
//   wicket     the dismissal that stands (null: none, or a no-ball / free hit)
//   boundary   4 / 6 (0: none; overthrows to the rope are not a four)
//   review     an appeal / DRS / the third umpire was asked
//   edge       the bat's contact was an edge; behind: the ball went behind the batter
//   nearMiss   m by which a ball that was not hit missed the stumps (null: not near)
//   dropped, dive, direct, overthrow   (the field's moments)
//   brk        the stumps were broken by a fielder (a run-out / stumping attempt)
// Returns { story, tier }.
export function classify(f) {
  const r = f.res || {}, k = r.kind, D = DIRECTOR;
  const STORY = { bowled: 'bowled', lbw: 'lbw', caught: 'caught', runout: 'runout', stumped: 'stumped' };
  if (f.wicket) return { story: STORY[k] || (f.wicket === 'run out' ? 'runout' : f.wicket), tier: 'wicket' };
  if (STORY[k]) return { story: STORY[k], tier: 'close' };                 // out, but a no-ball / free hit
  if (f.boundary === 6) return { story: 'six', tier: 'boundary' };
  if (f.boundary === 4 || (k === 'boundary' && !r.overthrows)) return { story: 'four', tier: 'boundary' };
  if (f.dropped) return { story: 'dropped', tier: 'close' };
  if (r.backInTime || r.shyMissed) return { story: 'stumped', tier: 'close' };
  // a run-out chance, the stumps broken or not: the throw came in with the batter home by a metre or so
  if ((f.review && !r.padded && f.brk) || (r.closeCall != null && r.closeCall <= D.runAttempt)) return { story: 'runout', tier: 'close' };
  if (f.direct && f.brk) return { story: 'direct', tier: 'close' };
  if (r.padded && f.review) return { story: 'lbw', tier: 'close' };
  if (f.edge) return { story: 'edge', tier: 'close' };                      // (anywhere: behind, into the ground, past gully)
  if (f.review) return { story: 'appeal', tier: 'close' };                  // (any appeal, given or not)
  // played and missed: by a few inches past the stumps, or past the bat's edge; a ball left alone with no
  // shot only if it all but hit them
  if (f.nearMiss != null && f.nearMiss <= (k === 'left' ? D.leftBy : D.beatenBy)) return { story: k === 'left' ? 'leave' : 'beaten', tier: 'close' };
  if (k === 'beaten' && f.batGap != null && f.batGap <= D.pastEdge) return { story: 'beaten', tier: 'close' };
  if (f.headGap != null && f.headGap <= D.headNear) return { story: 'bouncer', tier: 'close' };
  if (f.dive) return { story: 'dive', tier: 'close' };
  if (f.safe) return { story: 'safe', tier: 'close' };                      // (lofted, down safe by a fielder)
  if (f.saved) return { story: 'saved', tier: 'close' };                    // (hit hard, stopped before the rope)
  if (r.overthrows || f.overthrow) return { story: 'misfield', tier: 'close' };
  if (f.last) return { story: 'last', tier: 'close' };                      // (the winning single, the innings' last ball)
  return { story: 'routine', tier: 'routine' };
}

// By how much (m) a ball passing the batter's stumps missed them (null: it
// never came near, or did not pass). pass: the ball at the stumps' plane.
export function missBy(pass) {
  if (!pass) return null;
  const side = Math.abs(pass.x) - 0.1143 - 0.036, over = pass.y - 0.724 - 0.036;
  const m = Math.max(side, over);
  return m > 0 ? m : null;
}

// ---------------------------------------------------------------- 2. the plan
// opts:
//   story, tier   from classify
//   m             the moments (tape s): release, arrive (the ball reaches the batter), hit, pad,
//                 wicket (ball into the stumps), brk + brkEnd (stumps broken by a fielder, which end),
//                 caught, dropT, diveT, throwAt, cross (over the rope), dead
//   tape          { first, last, ball(t, out) -> drawn?, bodies(t) -> [{ a, b, c }] }
//   xr            headset (else the monitor)
// Returns the plan: { story, tier, n, du, len, T, X, Y, Z, W (yaw), P (pitch, monitor), S (shot), R (rate),
//   shots, segs, cuts (sample indices), start, end (tape s) } or null.
export function direct({ story, tier, m, tape, xr = true, check = true, maxTakes = 0 }) {
  const R = recipe(story, tier, m, tape);
  if (!R || !R.segs.length) return null;
  R.takes = R.takes.filter((tk, j, A) => tk.seg < (j + 1 < A.length ? A[j + 1].seg : R.segs.length));   // (a take with nothing in it is none)
  if (maxTakes > 0 && R.takes.length > maxTakes) { R.segs.length = R.takes[maxTakes].seg; R.takes.length = maxTakes; }   // (replayTakes: take 1 only)
  const lim = xr ? DIRECTOR.xr : DIRECTOR.desk;
  let p = layout(R, tape, lim, xr);
  // A later take whose camera does not pass the checks is left out (take 1 always plays): no take rather
  // than a weird one. (Laid out again without it: once more at most.)
  // (a take whose camera fails tries the next of its broadcast positions, then its second choice (alt):
  // laid out again each time, a few times at most)
  const tried = [];
  for (let round = 0; check && round < 4; round++) {
    let again = false;
    for (let j = 1; j < p.takes.length; j++) {
      const sh = p.shots[p.takes[j].shot], r = takeOK(p, j, tape);
      if (r.ok) continue;
      tried.push(`${sh.canon}: ${r.why}`);
      if (sh.cands && sh.cands.length > 1) { const c = sh.pos; sh.cands = sh.cands.filter((q) => hypot2(q.x - c.x, q.z - c.z) > 1.2); again = true; }
      else if (sh.alt) { const a = sh.alt; for (const k of Object.keys(sh)) if (k !== 'i0' && k !== 'i1') delete sh[k]; Object.assign(sh, a); again = true; }
    }
    if (!again) break;
    p = layout(R, tape, lim, xr);
  }
  const drop = [], why = [];
  for (let j = 1; check && j < p.takes.length; j++) { const r = takeOK(p, j, tape); if (!r.ok) { const sh = p.shots[p.takes[j].shot]; drop.push(j); why.push(`${p.takes[j].name} (${sh.canon} ${sh.pos.x.toFixed(0)},${sh.pos.z.toFixed(0)}): ${r.why}`); } }
  if (drop.length) {
    const keep = [], takes = [];
    for (let j = 0; j < R.takes.length; j++) {
      const a = R.takes[j].seg, b = j + 1 < R.takes.length ? R.takes[j + 1].seg : R.segs.length;
      if (drop.includes(j)) continue;
      takes.push({ ...R.takes[j], seg: keep.length });
      for (let q = a; q < b; q++) keep.push(R.segs[q]);
    }
    R.segs = keep; R.takes = takes;
    p = layout(R, tape, lim, xr);
  }
  p.leftOut = why; p.tried = tried;   // (the takes left out and why, the positions tried: for the harness and the tests)
  return p;
}

// Does take j of plan p pass the checks for a camera (DIRECTOR.checks)? { ok, why }. Its spot is one of the
// broadcast positions (CANON); clear of everybody by `clear` m over the whole take; not low (y >= minY); its
// subject (the ball, the catcher, the crease) within `off` of the middle of the view at its key moment and
// no more than `up` above it (never looking up from the grass into the sky), near enough to be seen; and
// its last picture, looked at level, not a sightscreen, the big screen, the pavilion or sky (and the boards
// a band at most). Plan time only.
export function takeOK(p, j, tape) {
  const tk = p.takes[j], C = DIRECTOR.checks;
  if (!tk) return { ok: false, why: 'no such take' };
  const sh = p.shots[tk.shot], i0 = tk.i, i1 = j + 1 < p.takes.length ? p.takes[j + 1].i - 1 : p.n - 1;
  if (!sh || !CANON[sh.canon]) return { ok: false, why: `not a broadcast position (${sh && sh.canon})` };
  const c = sh.pos;
  if (c.y < C.minY - 1e-6) return { ok: false, why: `low (${c.y.toFixed(1)} m)` };
  for (let i = i0; i <= i1; i += 9) for (const b of tape.bodies(p.T[i])) {
    const q = nearestOnBody(c, b);
    if (hypot3(c.x - q.x, c.y - q.y, c.z - q.z) < C.clear - 1e-6) return { ok: false, why: `within ${C.clear} m of a figure` };
  }
  // the key moment (the nearest sample of this take to it), and the last frame
  let ik = i0, best = Infinity;
  for (let i = i0; i <= i1; i++) { const d = Math.abs(p.T[i] - tk.key); if (d < best - 1e-9) { best = d; ik = i; } }
  for (const [i, when] of [[ik, 'at its moment'], [i1, 'at the end']]) {
    const r = subjectAt(p, sh, tape, i, i === i1 && i !== ik);
    if (!r.ok) return { ok: false, why: `${r.why} ${when}` };
  }
  // what the last picture is made of, looked at level: never a sightscreen, the big screen or the pavilion;
  // boards, rope and empty turf no more than half of the middle (the subject is in it: checked above)
  if (sh.kind !== 'track') return { ok: true, why: '' };
  const v = viewShares(c, p.W[i1], 0, { hfov: 40, vfov: 30, n: 16, nv: 12 });
  if (v.screen + v.bigscreen + v.pavilion > C.none) return { ok: false, why: 'ends on a sightscreen, the big screen or the pavilion' };
  if (sh.seats && v.sky > C.sky) return { ok: false, why: 'ends on sky' };
  if (v.boards > C.boards) return { ok: false, why: 'ends on the boards' };
  return { ok: true, why: '' };
}

// Take j's subject at sample i: within DIRECTOR.checks.off of the middle and big enough at headset density
// (a figure at least `figH` of the picture's height, the ball at least `ballPx`), never looked up at more than
// `up`; a six's crowd (its last picture, end = true): the people at least `crowd` of the middle.
function subjectAt(p, sh, tape, i, end) {
  const C = DIRECTOR.checks, c = sh.pos, o = { x: 0, y: 0, z: 0 }, t = p.T[i], yaw = p.W[i];
  const off = (x, z) => Math.abs(wrap(Math.atan2(x - c.x, z - c.z) - yaw));
  const figFar = C.figH > 0 ? 1.8 / (2 * Math.tan(C.figH * C.vfov / 2)) : Infinity, ballFar = C.ballR / Math.tan(C.ballPx / C.pxPerRad / 2);
  if (sh.stand && end) {
    // (a six's people: the middle of the picture is them, the head a little down as it rests)
    const v = viewShares(c, yaw, -0.08, { hfov: 40, vfov: 30, n: 16, nv: 12 });
    return v.stand >= C.crowd ? { ok: true } : { ok: false, why: `the people ${(v.stand * 100).toFixed(0)}% of the middle` };
  }
  let x, y, z, size;
  if (sh.kind === 'catch' || sh.pair != null) {
    const k = sh.kind === 'catch' ? sh.who : sh.pair;
    if (!(tape.figure && tape.figure(k, t, o))) return { ok: false, why: 'no figure' };
    x = o.x; y = 1.0; z = o.z; size = 'figure';
    // (a catch: his hands, the ball in them, count as him)
    if (sh.kind === 'catch' && tape.ball(t, o) && hypot2(o.x - x, o.z - z) < 2 && off(o.x, o.z) < off(x, z)) { x = o.x; z = o.z; }
  } else if (sh.kind === 'crease' || sh.kind === 'line') { x = sh.face.x; y = sh.face.y; z = sh.face.z; size = 'figure'; }
  else { if (!tape.ball(t, o)) return { ok: false, why: 'no ball' }; x = o.x; y = o.y; z = o.z; size = sh.arc || sh.seats ? 'arc' : 'ball'; }   // (a six: the ball and its trail dropping in, the people the subject)
  const h = hypot2(x - c.x, z - c.z), d = hypot3(x - c.x, y - c.y, z - c.z);
  if (sh.kind !== 'crease' && h > 1 && off(x, z) > (sh.arc ? C.offArc : C.off)) return { ok: false, why: `the subject ${(off(x, z) / D2R).toFixed(0)}° off the middle` };
  if (Math.atan2(y - c.y, Math.max(0.5, h)) > C.up) return { ok: false, why: 'looking up at it' };
  if (size === 'figure' && d > figFar) return { ok: false, why: `the figure ${d.toFixed(0)} m away (small)` };
  if (size === 'ball' && d > ballFar) return { ok: false, why: `the ball ${d.toFixed(0)} m away (under ${C.ballPx} px)` };
  if (size === 'arc' && d > (sh.far ?? 75)) return { ok: false, why: `the ball ${d.toFixed(0)} m away` };
  return { ok: true };
}

// Plan two replays of a made-up ball (a four and a six) once, so that the first real replay of a session
// does not pay for compiling the planner (~30 ms cold). Replay's constructor calls it on an idle tick.
export function prewarm() {
  for (const v of [[24, 3, -14], [-17, 17, -14]]) {
    const pts = [], dt = 1 / 90, p = [-0.2, 0.8, -1.2], vel = v.slice();
    for (let t = -2; t < 5.6; t += dt) {
      if (t < 0.6) { const k = Math.max(0, t) / 0.6; pts.push([0.4 - 0.6 * k, 2.1 - 1.3 * k, -18.9 + 17.7 * k]); continue; }
      vel[1] -= 9.81 * dt; for (let a = 0; a < 3; a++) p[a] += vel[a] * dt;
      if (p[1] < 0.036) { p[1] = 0.036; vel[1] = Math.abs(vel[1]) * 0.4; }
      if (hypot2(p[0], p[2] - CZ) > 70) vel[0] = vel[1] = vel[2] = 0;
      pts.push(p.slice());
    }
    const first = 98, at = (t) => clamp(Math.round((t - first) / dt), 0, pts.length - 1);
    const tape = { first, last: first + (pts.length - 1) * dt, ball: (t, o) => { const q = pts[at(t)]; o.x = q[0]; o.y = q[1]; o.z = q[2]; return true; }, bodies: () => [], figure: () => false };
    let cross = null; for (let i = 0; i < pts.length; i++) if (hypot2(pts[i][0], pts[i][2] - CZ) > 65) { cross = first + i * dt; break; }
    direct({ story: v[1] > 10 ? 'six' : 'four', tier: 'boundary', m: { release: 100, arrive: 100.6, hit: 100.6, cross, dead: (cross ?? 104) + 0.02 }, tape });
  }
}

// How many takes the ball just finished gets (0: no replay), Settings -> Replays and what this over has had
// already (`over`: { fours, close }, a fresh object each over; updated here). Highlights: a wicket, a six, a
// dropped catch, a run-out / stumping / direct-hit decision, the last ball: the whole replay; a four: the
// whole replay for the first DIRECTOR.freq.foursFull of the over, take 1 for the rest; any other close call
// (an appeal turned down, an edge, a beaten bat, a bouncer, a stop, a lofted shot down safe, a misfield):
// take 1, DIRECTOR.freq.closePerOver of them an over (a review always). Every ball: at least take 1.
export function replayTakes(mode, story, tier, review, over) {
  if (mode === 'off') return 0;
  const F = DIRECTOR.freq, every = mode === 'every';
  if (tier === 'routine') return every ? 1 : 0;
  if (tier === 'wicket' || story === 'six' || story === 'dropped' || story === 'runout' || story === 'stumped' || story === 'direct' || story === 'last') return 2;
  if (story === 'four') { over.fours = (over.fours || 0) + 1; return over.fours <= F.foursFull ? 2 : 1; }
  if (review) return 2;
  over.close = (over.close || 0) + 1;
  return over.close <= F.closePerOver || every ? 1 : 0;
}

// Real seconds a list of segments takes.
export function segsLength(segs) { let s = 0; for (const g of segs) s += g.rate > 0 ? (g.b - g.a) / g.rate : g.dur; return s; }

function recipe(story, tier, m, tape) {
  const first = tape.first, last = tape.last, rel = m.release;
  if (rel == null || rel < first) return null;
  const S = DIRECTOR.slow, TK = DIRECTOR.takes;
  const arr = m.arrive ?? (m.hit ?? m.pad ?? rel + 0.6);
  const hit = m.hit ?? null, dead = Math.min(m.dead ?? last, last);
  const shots = [], segs = [], takes = [];
  let k0 = -1;
  const shot = (s) => { shots.push(s); return shots.length - 1; };
  const seg = (a, b, rate, k) => { a = Math.max(first, a); b = Math.min(last, b); if (b > a + 1e-3) segs.push({ a, b, rate, shot: k }); };
  const hold = (t, dur, k) => segs.push({ a: t, b: t, rate: 0, dur, shot: k });
  // (a take's own length: its segments from index i0 on)
  const lenFrom = (i0) => segsLength(segs.slice(i0));
  const fit = (i0, B, cuts) => { for (const c of cuts) { if (lenFrom(i0) <= B + 1e-6) return; c(); } };
  const armPos = armSpot(tape, rel);
  const arm = () => shot({ kind: 'arm', canon: 'arm', pos: { ...armPos }, face: { x: 0, y: 0.9, z: Z_BAT - POP }, follow: arr, yawLim: DIRECTOR.arm.yawLim });
  const line = () => shot({ kind: 'line', canon: 'line', pos: { x: 0, y: DIRECTOR.line.y, z: DIRECTOR.line.z }, face: { x: 0, y: 0.6, z: Z_BAT - 0.6 }, follow: arr });
  // the line camera joins once the ball is past it (it is never whipped past your head)
  // (crossing that point on its way down: before the release the tape may hold the ball anywhere)
  const lineFrom = () => { let was = false; return clamp(firstWhen(tape, rel, arr, (p) => { const past = p.z > DIRECTOR.line.z + DIRECTOR.line.gap; if (!past) was = true; return past && was; }) ?? arr - 0.22, rel + 0.15, arr - 0.1); };
  // …and leaves before a ball hit back down the pitch gets near it
  const lineUntil = (t1) => { const L = DIRECTOR.line, t = hit != null ? firstWhen(tape, hit, t1, (p) => hypot3(p.x, p.y - L.y, p.z - L.z) < L.gap) : null; return t != null ? Math.max(hit + 0.04, t - 0.03) : t1; };
  const begin = (name, key) => { takes.push({ seg: segs.length, name, key }); return segs.length; };

  // ---- take 1, always: from the bowler's end, one continuous shot (no cut in it). The last strides and the
  // release at real speed, slowed through the key moment, then what follows for as long as the ball stays in
  // the camera's gentle reach (it turns at most DIRECTOR.arm.yawLim either way): a shot behind square or a
  // straight hit over the camera ends the take on the batter's follow-through instead of whipping round.
  const T1 = DIRECTOR.t1, half = T1.slowReal * S / 2;
  const takeOne = (key, post = T1.post) => {
    k0 = arm();
    const i0 = begin("REPLAY · BOWLER'S END", key), B = tier === 'routine' ? BUDGET.routine : TK.first, routine = tier === 'routine';
    const s0 = key - half, s1 = key + half;
    const gone = hit != null ? leavesArm(tape, armPos, hit, s1 + post) : null;
    let end = Math.min(last, dead + 0.6, s1 + post, gone != null ? Math.max(s1 + 0.1, gone + 0.3) : Infinity);
    end = Math.max(end, Math.min(last, s1 + 0.1));
    let pre = T1.pre;
    // (never more than 1.1 s of build-up before the slow moment, whatever the marks say)
    const a0 = () => Math.max(rel - pre, s0 - 1.1);
    const build = () => { segs.length = i0; if (routine) seg(a0(), end, 1, k0); else { seg(a0(), s0, 1, k0); seg(s0, s1, S, k0); seg(s1, end, 1, k0); } };
    build();
    fit(i0, B, [() => { end = Math.max(s1 + 0.1, end - (lenFrom(i0) - B)); build(); }, () => { pre = 0.15; build(); }]);
    return end;
  };
  // a later take on shot k: from `from` (tape s) to its moment at real speed, a short slow beat on it, real speed to `endT`
  const takeTwo = (k, name, key, from, endT, B = TK.later) => {
    const i1 = begin(name, key), h = DIRECTOR.t2.slowReal * S / 2;
    let a = from;
    const build = () => { segs.length = i1; seg(a, key - h, 1, k); seg(Math.max(a, key - h), Math.min(endT, key + h), S, k); seg(key + h, endT, 1, k); };
    build();
    fit(i1, B, [() => { a = Math.min(key - 0.3, a + (lenFrom(i1) - B)); build(); }]);
    return i1;
  };

  if (story === 'routine' || story === 'beaten' || story === 'leave' || story === 'bouncer' || story === 'last') {
    // the bowler's end only (a beaten bat: the ball past the edge, into the keeper's gloves)
    takeOne(hit ?? arr, tier === 'routine' ? 0.8 : clamp((m.held ?? dead) - arr - half + 0.2, T1.post, 0.8));
    return { story, tier, shots, segs, takes, key: arr };
  }
  if (story === 'bowled' || story === 'lbw' || story === 'edge' || story === 'appeal') {
    // Take 1 from the bowler's end; then (a wicket, an lbw shout, an appeal) the line of the stumps in front of
    // the batter for the ball's arrival: the stumps, the pad, where it was going. An edge that was not held:
    // the bowler's end shows it (into the slips / the keeper), nothing more.
    const key = story === 'bowled' ? (m.wicket ?? arr) : story === 'lbw' ? (m.pad ?? arr) : arr;
    takeOne(key, story === 'bowled' ? 0.6 : story === 'edge' ? clamp((m.held ?? m.caught ?? dead) - key - half + 0.2, T1.post, 0.9) : 0.4);
    if (story === 'edge') return { story, tier, shots, segs, takes, key };
    const k1 = line(), tB = lineFrom();
    let after = key + 0.5;
    // (a ball knocked back off the stumps or the pad does not come at your head: it ends first)
    const L = DIRECTOR.line, back = firstWhen(tape, key, after, (p) => hypot3(p.x, p.y - L.y, p.z - L.z) < L.gap);
    if (back != null) after = Math.max(key + 0.15, back - 0.03);
    takeTwo(k1, 'FROM THE FRONT', key, tB, after);
    return { story, tier, shots, segs, takes, key };
  }
  if (story === 'four' || story === 'six') {
    // Take 1 from the bowler's end: bat on ball, the ball away as far as it stays in view. Take 2 only with a
    // subject in it (takeOK): a four chased by a fielder (within DIRECTOR.fourChase m of where it crosses):
    // 8-12 m from him, three-quarter on, the ball running into the picture beside him; a four nobody chases
    // has no take 2 (take 1 told it). A six: 10-15 m in front of the rows where it comes down, 2.5 m up, the
    // people filling the picture and going up (fired again for the replay as it crosses), the ball and its
    // trail dropping in; if no spot does that, the whole arc from high at long-on / long-off; else none.
    // Where a six lands: the play's own `m.land`, else where the recorded ball stops falling, else its last place.
    if (hit == null) { takeOne(arr); return { story, tier, shots, segs, takes, key: arr }; }
    const six = story === 'six', cross = m.cross ?? dead;
    const land = six ? Math.min(last, m.land ?? landingAfter(tape, cross, last)) : cross;
    const key = six ? land : cross;
    takeOne(hit);
    const subj = ballAt(tape, key), re = hypot2(subj.x, subj.z - CZ) || 1;
    if (!six) {
      const fielder = nearestFigure(tape, key, subj, DIRECTOR.fourChase);
      if (!fielder) return { story, tier, shots, segs, takes, key: hit, focus: key };
      const k2 = shot({ kind: 'track', canon: 'rope', rope: true, fov: DIRECTOR.fov.track, subj, fielder, pair: fielder.k, dists: [8, 10, 12], heights: [1.8], endDist: [5, 18], rimMax: 60 });
      takeTwo(k2, 'THE CHASE', key, Math.max(hit + 0.1, key - DIRECTOR.t2.lead), Math.min(last, key + 0.3));
      return { story, tier, shots, segs, takes, key: hit, focus: key };
    }
    const screened = Math.abs(subj.x) < 18 && Math.abs(subj.z - CZ) > 50;
    // (the people it lands among: straight behind either end there are only a sightscreen and covered seats,
    // nor in front of the pavilion: the people nearest it, either side of those arcs; the spot picks)
    const sas = [Math.atan2(subj.x, subj.z - CZ)];
    for (const [c0, hw] of NO_CROWD) {
      const d = wrap(sas[0] - c0 * D2R), h = (hw + 8) * D2R;
      if (Math.abs(d) < h) { sas[0] = c0 * D2R + (d < 0 ? -1 : 1) * h; if (c0 !== 90) sas.push(c0 * D2R - (d < 0 ? -1 : 1) * h); }
    }
    const sr = Math.max(re, SEATS) + 4;
    const stands = sas.map((sa) => ({ t: key + 0.1, x: Math.sin(sa) * sr, y: Math.max(subj.y, 2) + 3, z: CZ + Math.cos(sa) * sr }));
    const arc = { kind: 'track', canon: 'fixed', arc: true, cands: FIXED.filter((c) => /^long|keeperHigh|screenSide/.test(c.name)), stand: { ...stands[0], t: key - 0.7 }, stands: stands.map((a) => ({ ...a, t: key - 0.7 })), lookMax: 50, far: 75, fov: DIRECTOR.fov.wide, subj, dists: [0], heights: [0], endDist: [15, 50] };
    const behind = Math.abs(subj.x) < SCREEN.half + 2.5 && Math.abs(subj.z - CZ) > SCREEN.dist - 2;
    const k2 = shot(behind ? arc : { kind: 'track', canon: 'crowd', rope: true, seats: true, stand: stands[0], stands, fov: DIRECTOR.fov.track, subj, dists: [10, 12.5, 15], heights: [2.5], endDist: [10, 15], rimMax: Math.max(63.5, Math.min(re + (screened ? 5 : 2), 82)), kMax: screened ? 18 : 8, alt: arc });
    takeTwo(k2, behind ? 'THE ARC' : 'IN THE CROWD', key, Math.max(hit + 0.1, key - DIRECTOR.t2.lead), Math.min(last, key + 0.9));
    return { story, tier, shots, segs, takes, key: hit, focus: key };
  }
  if (story === 'caught' || story === 'dropped' || story === 'dive' || story === 'safe' || story === 'saved') {
    // Take 1 from the bowler's end: the shot, and a catch at the keeper or the slips (straight away from the
    // camera, it stays in view). Take 2: the fielder, three-quarter on from his front, 5-8 m away at chest
    // height, in place before the ball gets there, the view on him; a short slow beat as the hands close.
    if (hit == null) { takeOne(arr); return { story, tier, shots, segs, takes, key: arr }; }
    const ct = story === 'caught' ? (m.caught ?? m.held ?? dead) : story === 'dropped' ? (m.dropT ?? dead) : story === 'dive' ? (m.diveT ?? dead) : story === 'safe' ? (m.safeT ?? dead) : (m.savedT ?? dead);
    const quick = ct - hit < 1.3;
    takeOne(hit, quick ? Math.min(1.2, ct - hit - half + 0.3) : T1.post);
    const cs = catchShot(tape, ct, quick ? hit - 0.12 : Math.max(hit + 0.1, ct - DIRECTOR.t2.lead), story === 'safe' ? 6 : 4);
    if (!cs) return { story, tier, shots, segs, takes, key: hit, focus: ct };
    const kc = shot(cs);
    takeTwo(kc, story === 'caught' ? 'THE CATCH' : story === 'dropped' ? 'THE DROP' : story === 'dive' || story === 'saved' ? 'THE STOP' : 'ANOTHER ANGLE', ct,
      quick ? hit - 0.12 : Math.max(hit + 0.1, ct - DIRECTOR.t2.lead), Math.min(last, ct + 0.5));
    return { story, tier, shots, segs, takes, key: ct, focus: ct };
  }
  if (story === 'runout' || story === 'stumped' || story === 'direct') {
    // Take 1 from the bowler's end (the shot, the batters setting off; a stumping: the batter beaten down the
    // pitch); take 2 side-on at the popping crease where the throw came in: the bat / the foot and the line,
    // a short slow beat either side of the stumps breaking and a freeze as they do.
    const kb = m.brk ?? m.throwAt;
    takeOne(hit ?? arr, kb != null && story === 'stumped' ? clamp(kb - arr - half + 0.3, T1.post, 1.2) : 0.5);
    if (kb == null) return { story, tier, shots, segs, takes, key: hit ?? arr };
    const end = m.brkEnd || 'batting';
    const sz = end === 'batting' ? Z_BAT : Z_BOWL, dir = end === 'batting' ? 1 : -1, cz = sz - dir * POP;
    const kc = shot(creaseShot(tape, cz, sz, kb));
    const i1 = begin('SIDE-ON', kb), h = DIRECTOR.t2.slowReal * S / 2;
    seg(Math.max(hit ?? arr, kb - 0.7), kb - h, 1, kc); seg(kb - h, kb, S, kc); hold(kb, 0.3, kc); seg(kb, kb + h, S, kc); seg(kb + h, kb + 0.35, 1, kc);
    return { story, tier, shots, segs, takes, key: kb };
  }
  if (story === 'misfield') {
    // Take 1 from the bowler's end; take 2 the fumble / the overthrows from the best of the broadcast
    // positions (only if the ball is near and in the middle there: takeOK).
    if (hit == null) { takeOne(arr); return { story, tier, shots, segs, takes, key: arr }; }
    takeOne(hit);
    const b = Math.min(last, dead + 0.3), a = Math.max(hit + 0.3, b - 2.2);
    const k2 = shot({ kind: 'track', canon: 'fixed', fov: DIRECTOR.fov.wide, subj: ballAt(tape, b), cands: FIXED, heights: [0], endDist: [10, 45], dists: [0] });
    begin('ANOTHER ANGLE', b);
    seg(a, b, 1, k2);
    return { story, tier, shots, segs, takes, key: hit };
  }
  return recipe('routine', tier, m, tape);
}

// Take 1's spot: DIRECTOR.arm.back m behind the bowler's stumps, to the side the ball was let go from (the
// bowling arm's: the bowler runs in beside it and the umpire stands on the other side), arm.y m up.
function armSpot(tape, rel) {
  const o = { x: 0, y: 0, z: 0 }; tape.ball(rel, o);
  const A = DIRECTOR.arm;
  return { x: (o.x < -0.05 ? -1 : 1) * A.side, y: A.y, z: Z_BOWL - A.back };
}

// The first moment after t0 (up to t1) the ball is out of the bowler's-end camera's gentle reach: more than
// its turn limit off straight down the pitch, within 8 m of it (a straight hit back over it) or more than 35°
// above it. null: it stays in view.
function leavesArm(tape, A, t0, t1) {
  const lim = DIRECTOR.arm.yawLim + DIRECTOR.cone, b0 = Math.atan2(-A.x, Z_BAT - POP - A.z);
  let back = false;
  return firstWhen(tape, t0 + 0.05, t1, (p) => {
    const dx = p.x - A.x, dz = p.z - A.z, h = hypot2(dx, dz);
    if (p.z < -1) back = true;                       // (coming back down the pitch)
    return Math.abs(wrap(Math.atan2(dx, dz) - b0)) > lim || (back && h < 8) || Math.atan2(p.y - A.y, Math.max(0.5, h)) > 35 * D2R;
  });
}

// Side-on at the popping crease cz (stumps at sz) for the moment kb: the side
// with nobody in the way of the line and the stumps.
function creaseShot(tape, cz, sz, kb) {
  const C = DIRECTOR.crease, at = { x: 0, y: 0.5, z: (cz + sz) / 2 };
  const times = [kb - 0.6, kb - 0.25, kb, kb + 0.3];
  const bodies = [];
  for (const t of times) for (const b of tape.bodies(t)) bodies.push(b);
  // (on the side the throw comes from, it comes in toward the middle of the view rather than across it)
  const from = ballAt(tape, kb - 0.5), path = [];
  for (let t = kb - 1.0; t <= kb + 0.4; t += 0.05) { const o = { x: 0, y: 0, z: 0 }; if (tape.ball(t, o)) path.push(o); }
  let best = null;
  for (const d of [C.d, C.d + 2.5, C.d + 5]) for (const side of [1, -1]) {
    const pos = { x: side * d, y: C.y, z: cz };
    let bad = 0;
    for (const b of bodies) {
      const q = nearestOnBody(pos, b);
      if (hypot3(pos.x - q.x, pos.y - q.y, pos.z - q.z) < CLEAR + 0.2) bad += 3;
      if (Math.abs(b.b.x) > 1.2 && blocksSight(pos, at, b)) bad += 1;     // (the batters at the crease are what you are watching)
    }
    bad += (d - C.d) * 0.08 + (side < 0 ? 0.01 : 0) + (Math.abs(from.x) > 1 && Math.sign(from.x) !== side ? 0.6 : 0);
    for (const o of path) if (hypot3(o.x - pos.x, o.y - pos.y, o.z - pos.z) < 4) { bad += 5; break; }   // (never a throw past your head)
    if (!best || bad < best.bad) best = { bad, pos };
  }
  return { kind: 'crease', canon: 'square', fov: DIRECTOR.fov.crease, pos: best.pos, face: at, fixed: true };
}

// The figure standing nearest p (on the ground) at tape time t, within `r` m: { k, x, z } or null.
function nearestFigure(tape, t, p, r) {
  let best = null, bd = r;
  for (const b of tape.bodies(t)) { const d = hypot2(b.b.x - p.x, b.b.z - p.z); if (d < bd) { bd = d; best = { k: b.k, x: b.b.x, z: b.b.z }; } }
  return best;
}

// The catch camera: 5-8 m from the catcher (the figure nearest the ball when it
// is caught), 1.3 m up, three-quarter on (25-55° off the line the ball comes in
// on, from his front), clear of everybody over the shot, the ball never within
// 2.5 m of it, nobody between it and him, not on the pitch. null: no catcher.
function catchShot(tape, ct, from, r = 4) {
  const B = ballAt(tape, ct), near = nearestFigure(tape, ct, B, r);
  if (!near && r > 4) return null;                                                       // (a fielder's moment with no fielder)
  const who = near || { k: -1, x: B.x, z: B.z };   // (nobody there: on the ball)
  const P = { x: who.x, y: 1.1, z: who.z }, q = ballAt(tape, Math.max(from, ct - 0.35));
  let wx = q.x - P.x, wz = q.z - P.z, wl = hypot2(wx, wz);
  if (wl < 0.5) { wx = -P.x; wz = Z_BAT - POP - P.z; wl = hypot2(wx, wz) || 1; }      // (straight down onto him: his front is the batter)
  wx /= wl; wz /= wl;
  const path = [], bodies = [];
  for (let t = Math.max(from, ct - 1.6); t <= ct + 0.4; t += 0.04) { const o = { x: 0, y: 0, z: 0 }; if (tape.ball(t, o)) path.push(o); }
  for (const t of [Math.max(from, ct - 1.6), ct - 0.8, ct, ct + 0.6]) for (const b of tape.bodies(t)) bodies.push(b);
  const atCt = tape.bodies(ct);
  let best = null, n = 0;
  for (const d of [6.5, 5.5, 7.5]) for (const a of [40, -40, 52, -52, 28, -28]) {
    const c = Math.cos(a * D2R), sn = Math.sin(a * D2R), dx = wx * c - wz * sn, dz = wx * sn + wz * c;
    const pos = { x: P.x + dx * d, y: 1.3, z: P.z + dz * d };
    if (hypot2(pos.x, pos.z - CZ) > DIRECTOR.rim + 2.5) continue;
    let bad = (n++) * 0.01;
    if (Math.abs(pos.x) < 1.8 && pos.z > -21 && pos.z < 1.9) bad += 4;               // (not on the pitch)
    for (const o of path) { const e = hypot3(o.x - pos.x, o.y - pos.y, o.z - pos.z); if (e < 2.5) { bad += 5 + (2.5 - e); break; } }
    for (const b of bodies) { const g = nearestOnBody(pos, b); if (hypot3(pos.x - g.x, pos.y - g.y, pos.z - g.z) < DIRECTOR.checks.clear + 0.05) { bad += 3; break; } }
    for (const b of atCt) if (b.k !== who.k && blocksSight(pos, P, b)) bad += 1;
    if (!best || bad < best.bad) best = { bad, pos };
  }
  if (!best) return null;
  return { kind: 'catch', canon: 'catch', fov: DIRECTOR.fov.line, pos: best.pos, who: who.k, face: P };
}

// The first tape time in [t0, t1] at which the ball (drawn) satisfies pred.
function firstWhen(tape, t0, t1, pred) {
  const o = { x: 0, y: 0, z: 0 };
  for (let t = t0; t <= t1; t += 1 / 120) if (tape.ball(t, o) && pred(o)) return t;
  return null;
}
function ballAt(tape, t) { const o = { x: 0, y: 0, z: 0 }; tape.ball(t, o); return o; }

// A six: where it comes down in the stands (it stops falling, or stops), from the moment it crossed the rope.
function landingAfter(tape, cross, last) {
  const o = { x: 0, y: 0, z: 0 }, p = { x: 0, y: 0, z: 0 };
  let py = null, vy = null;
  for (let t = cross; t <= Math.min(last, cross + 2.2); t += 1 / 60) {
    if (!tape.ball(t, o)) return t;
    if (py != null) {
      const v = (o.y - py) * 60;
      if (vy != null && vy < -1 && v > vy * 0.5) return t;                     // (a bounce, or caught by the stand)
      if (hypot3(o.x - p.x, o.y - p.y, o.z - p.z) * 60 < 1.0) return t;   // (stopped)
      vy = v;
    }
    py = o.y; p.x = o.x; p.y = o.y; p.z = o.z;
  }
  return Math.min(last, cross + 1.0);
}

// ---------------------------------------------------------------- the track spot
// Pick a fixed spot to follow the ball from over `samples` ([{ u, x, y, z, vis }],
// real time u): the ball near the middle of the view at a bounded turn rate,
// never close to the camera or high over it, the subject at the end at a good
// distance, nobody too close or in the way of the subject.
export function chooseSpot(samples, sh, bodies, lim) {
  const E = sh.subj, cands = [];
  if (sh.cands) for (const c of sh.cands) cands.push({ x: c.x, y: c.y, z: c.z, name: c.name });   // (the broadcast positions)
  else if (sh.along) {
    // 6-8 m inside the rope, 4-8 m along it either side of where the ball crosses, 2 m up: looking out
    // across the rope at the ball running into it (the field and the stand behind, not a board close-up).
    const th = Math.atan2(E.x, E.z - CZ);
    // (in front of a sightscreen or the pavilion, whose dark face or roof is all there is behind the ball from
    // inside: just inside the boards a few metres along, outside the ball's path, looking back in at it coming
    // to the rope, the field behind it)
    for (const [rr, ds] of [[58.5, sh.dists], [57, sh.dists], [67.3, [3, 4.5, 6]]]) for (const s0 of ds) for (const sg of [-1, 1]) {
      const a = th + sg * s0 / rr;
      for (const y of sh.heights) cands.push({ x: Math.sin(a) * rr, y, z: CZ + Math.cos(a) * rr });
    }
  } else if (sh.rope) {
    // (a four in front of a sightscreen or the pavilion: from inside, its face or its roof is all there is
    // behind the ball; also just inside the boards 5-8 m along, outside the ball's path, looking back in)
    if (sh.outside) {
      const th = Math.atan2(E.x, E.z - CZ), rr = Math.abs(E.x) < 18 ? 69.3 : 67.5;
      for (const s0 of [5, 6.5, 8]) for (const sg of [-1, 1]) { const a = th + sg * s0 / rr; cands.push({ x: Math.sin(a) * rr, y: 2.0, z: CZ + Math.cos(a) * rr, out: true }); }
    }
    // Inside the rope, `dists` m from the subject (further if it came down deep in the stand), on bearings
    // up to 80° either side of straight in from it.
    // (a four's chase: round the fielder, `dists` m from him)
    const O = sh.pair != null && sh.fielder ? sh.fielder : E;
    const re = hypot2(O.x, O.z - CZ) || 1, ix = -O.x / re, iz = -(O.z - CZ) / re, rim = sh.rimMax ?? DIRECTOR.rim + 2.5, kMax = sh.kMax ?? 8;
    for (const d0 of sh.dists) for (let k = -kMax; k <= kMax; k++) {
      const c = Math.cos(k * 10 * D2R), sn = Math.sin(k * 10 * D2R), ux = ix * c - iz * sn, uz = ix * sn + iz * c;
      let d = d0;
      while (d < d0 + 20 && hypot2(O.x + ux * d, O.z + uz * d - CZ) > rim) d += 1;     // (no nearer the boards than the shot allows)
      for (const y of sh.heights) cands.push({ x: O.x + ux * d, y, z: O.z + uz * d });
    }
  }
  const endBodies = bodies.filter((b) => b.t === bodies.end);
  let nearest = null, nd = Infinity;
  for (const b of endBodies) { const d = hypot2(b.b.x - E.x, b.b.z - E.z); if (d < nd) { nd = d; nearest = b; } }
  let best = null;
  for (const c of cands) {
    const rc = hypot2(c.x, c.z - CZ);
    if (!c.out && (rc > (sh.rope ? (sh.rimMax ?? DIRECTOR.rim + 2.5) + 1e-6 : DIRECTOR.rim) || rc < (sh.rimMin ?? 0))) continue;
    if (Math.abs(c.x) < 2.2 && c.z > -23 && c.z < 2.5 && !sh.near) continue;     // (not on the pitch, in the way of play)
    if (Math.abs(c.x) < SCREEN.half + 2.5 && Math.abs(c.z - CZ) > SCREEN.dist - 1.5) continue;   // (not in a sightscreen, nor behind one among its braces)
    const cc = crowdCost(c, bodies, endBodies, nearest, E);
    for (const A of sh.stands || ONE) {
      if (A) sh.stand = A;
      const cost = spotCost(c, samples, sh, lim) + cc;
      if (!best || cost < best.cost) best = { cost, c, A };
    }
  }
  if (best && best.A) sh.stand = best.A;
  if (!best) best = { c: sh.cands && sh.cands.length ? { ...sh.cands[0] } : { x: E.x * 0.7, y: sh.heights[0], z: CZ + (E.z - CZ) * 0.7 } };
  if (best.c.name) sh.canon = best.c.name;
  keepClear(best.c, bodies);
  return { x: best.c.x, y: best.c.y, z: best.c.z };
}

// How well a spot follows the ball (the turn it needs, simulated at the turn limits).
function spotCost(c, S, sh, lim) {
  let yaw = null, w = 0, miss = 0, n = 0, minD = Infinity, maxEl = 0, turn = 0, prevB = null, bx = 0, bz = 0;
  const lead = Math.max(1, Math.round(DIRECTOR.lead / Math.max(1e-3, (S[1] ? S[1].u - S[0].u : 1 / 15))));
  for (let i = 0; i < S.length; i++) {
    const s = S[i], f = S[Math.min(S.length - 1, i + lead)];
    if (s.vis) { bx = s.x; bz = s.z; }
    const dx = (f.vis ? f.x : bx) - c.x, dz = (f.vis ? f.z : bz) - c.z;
    let b = Math.atan2(dx, dz);
    if (prevB != null) { b = prevB + wrap(b - prevB); turn += Math.abs(b - prevB); }
    prevB = b;
    if (yaw == null) yaw = b;
    const du = i ? s.u - S[i - 1].u : 0;
    if (du > 0) {
      const e = b - yaw, ws = Math.sign(e) * Math.min(lim.wMax, 4 * Math.abs(e));
      w += clamp(ws - w, -lim.wAcc * du, lim.wAcc * du); yaw += w * du;
    }
    if (!s.vis) continue;
    const ex = s.x - c.x, ey = s.y - c.y, ez = s.z - c.z, h = hypot2(ex, ez);
    const off = Math.abs(wrap(Math.atan2(ex, ez) - yaw));
    n++; if (off > DIRECTOR.cone) miss++;
    minD = Math.min(minD, hypot2(h, ey));
    maxEl = Math.max(maxEl, Math.atan2(ey, Math.max(0.5, h)));
  }
  const dE = hypot2(sh.subj.x - c.x, sh.subj.z - c.z);
  let cost = (n ? miss / n : 0) * 20;
  cost += Math.max(0, sh.endDist[0] - dE) * 0.4 + Math.max(0, dE - sh.endDist[1]) * 0.25;
  cost += Math.max(0, 4 - minD) * 3 + Math.max(0, maxEl - (sh.seats ? 32 : sh.rope ? 50 : 38) * D2R) / D2R * (sh.seats ? 0.6 : 0.12);
  if (sh.rope) {
    cost += (dE - sh.endDist[0]) * 0.3;                    // (by the rope: as close to where it ends as the turn allows)
    // looking out at the stand across the rope (40° or less off straight out), not along the boards (a board
    // close-up receding across the view)
    const re = hypot2(sh.subj.x, sh.subj.z - CZ) || 1, cosOut = ((sh.subj.x - c.x) * sh.subj.x + (sh.subj.z - c.z) * (sh.subj.z - CZ)) / (re * Math.max(1e-3, dE));
    const ang = Math.acos(clamp(cosOut, -1, 1)) / D2R;
    if (ang > 40 && !sh.along && !sh.seats && !c.out) cost += (ang - 40) * 0.12;
    // what the last picture shows, looked at level toward its subject (as a headset viewer sees it), a coarse
    // look at plan time: no sightscreen, big screen, pavilion, covered seats or sky in the middle of it, the
    // boards a band at most, no sightscreen wall at its side; a six: the people at least half of it
    // (toward where the view ends: the stand, or the ball as last seen)
    const A = sh.stand ? standLook(c, sh) : lastVis(S) || sh.subj, ay = Math.atan2(A.x - c.x, A.z - c.z), sv = viewShares(c, ay, 0, { hfov: 40, vfov: 30, n: 10, nv: 8 });
    const sw = viewShares(c, ay, 0, { hfov: 100, vfov: 90, n: 12, nv: 8 });
    cost += (sv.screen + sv.bigscreen + sv.pavilion + sv.covers) * 40 + sv.sky * 10 + sv.boards * 25 + sw.screen * 30 + (sv.screen + sv.bigscreen + sv.pavilion > DIRECTOR.checks.none ? 20 : 0);   // (over the limit: as good as out)
    if (sh.seats) cost += Math.max(0, 0.5 - sv.stand) * 20;
    // the fielder chasing it in the picture with the ball
    const F = sh.fielder;
    if (F) { const off = Math.abs(wrap(Math.atan2(F.x - c.x, F.z - c.z) - Math.atan2(sh.subj.x - c.x, sh.subj.z - c.z))); if (off < 25 * D2R && hypot2(F.x - c.x, F.z - c.z) > 2.5) cost -= 0.8; }
  }
  if (sh.cands) {
    // (a broadcast position: not ending on a sightscreen, the big screen, the pavilion or sky)
    const A = sh.stand ? standLook(c, sh) : sh.subj, v = viewShares(c, Math.atan2(A.x - c.x, A.z - c.z), 0, { hfov: 40, vfov: 30, n: 10, nv: 8 });
    cost += (v.screen + v.bigscreen + v.pavilion + v.covers) * 40 + v.sky * 10 + v.boards * 10 + (dE > (sh.far ?? 55) ? 50 : 0);
  }
  cost += turn / Math.PI * 0.6;
  // (by the rope: never ending on a sightscreen, the dark wedges straight behind either end)
  if (sh.rope) {
    const ux = (sh.subj.x - c.x) / Math.max(1e-3, dE), uz = (sh.subj.z - c.z) / Math.max(1e-3, dE), ox = c.x, oz = c.z - CZ;
    const bq = ox * ux + oz * uz, k = -bq + Math.sqrt(Math.max(0, bq * bq - (ox * ox + oz * oz - 70 * 70)));
    const deg = ((Math.atan2(ox + ux * k, oz + uz * k) / D2R) + 360) % 360;
    if (Math.min(deg, 360 - deg) < 14 || Math.abs(deg - 180) < 14) cost += 2.5;
  }
  // (a six: from inside the ground looking out, so the stands and the crowd are behind the landing)
  if (sh.wide) { const out = (sh.subj.x * (sh.subj.x - c.x) + (sh.subj.z - CZ) * (sh.subj.z - c.z)) / Math.max(1, hypot2(sh.subj.x, sh.subj.z - CZ) * dE); cost += (1 - out) * 1.5; }
  return cost;
}
function lastVis(S) { for (let i = S.length - 1; i >= 0; i--) if (S[i].vis) return S[i]; return null; }
// A six's last look from spot c: on to the stand point, but no more than 28° round from where the ball
// comes down, so the ball is still in the picture as it drops (behind a sightscreen the people are beside it).
function standLook(c, sh) {
  const A = sh.stand, E = sh.subj, bL = Math.atan2(E.x - c.x, E.z - c.z), d = hypot2(A.x - c.x, A.z - c.z);
  const lm = (sh.lookMax ?? 28) * D2R, b = bL + clamp(wrap(Math.atan2(A.x - c.x, A.z - c.z) - bL), -lm, lm);
  return { t: A.t, x: c.x + Math.sin(b) * d, y: A.y, z: c.z + Math.cos(b) * d };
}
function crowdCost(c, bodies, endBodies, nearest, E) {
  let cost = 0;
  for (const b of bodies) { const q = nearestOnBody(c, b); if (hypot3(c.x - q.x, c.y - q.y, c.z - q.z) < CLEAR + 0.4) { cost += 3; break; } }
  for (const b of endBodies) if (b !== nearest && blocksSight(c, E, b)) cost += 1.2;
  return cost;
}

// ---------------------------------------------------------------- layout
function layout(R, tape, lim, xr) {
  const du = DIRECTOR.du, segs = R.segs, len = segsLength(segs);
  const n = Math.max(2, Math.ceil(len / du) + 1);
  const T = new Float64Array(n), X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), W = new Float32Array(n), P = new Float32Array(n);
  const S = new Int8Array(n), RT = new Float32Array(n);
  // tape time and shot per sample
  // (and the takes: where each starts (sample), its name for the strap, its key moment (tape s))
  const RK = R.takes || [{ seg: 0, name: 'REPLAY', key: segs[0].a }], takes = [];
  let si = 0, u0 = 0;
  for (let i = 0; i < n; i++) {
    const u = Math.min(len, i * du);
    while (si < segs.length - 1 && u > u0 + segLen(segs[si]) + 1e-9) { u0 += segLen(segs[si]); si++; }
    while (takes.length < RK.length && RK[takes.length].seg <= si) { const tk = RK[takes.length]; takes.push({ i, name: tk.name, key: tk.key, shot: segs[tk.seg].shot }); }
    const g = segs[si];
    T[i] = g.rate > 0 ? Math.min(g.b, g.a + (u - u0) * g.rate) : g.a;
    S[i] = g.shot; RT[i] = g.rate;
  }
  // where each shot stands (a track spot is picked from the ball over its samples)
  const o = { x: 0, y: 0, z: 0 }, o2 = { x: 0, y: 0, z: 0 };
  for (let k = 0; k < R.shots.length; k++) {
    const sh = R.shots[k];
    let i0 = -1, i1 = -1;
    for (let i = 0; i < n; i++) if (S[i] === k) { if (i0 < 0) i0 = i; i1 = i; }
    sh.i0 = i0; sh.i1 = i1;
    if (i0 < 0) continue;
    if (sh.kind === 'track') {
      const samples = [];
      for (let i = i0; i <= i1; i += 6) { const vis = tape.ball(T[i], o); samples.push({ u: i * du, x: o.x, y: o.y, z: o.z, vis }); }
      const bodies = [];
      const tEnd = T[i1];
      for (let j = 0; j <= 4; j++) { const t = T[i0] + (tEnd - T[i0]) * j / 4; for (const b of tape.bodies(t)) { b.t = t; bodies.push(b); } }
      bodies.end = tEnd;
      sh.pos = chooseSpot(samples, sh, bodies, lim);
      if (sh.stand) sh.look = standLook(sh.pos, sh);
    } else {
      const bodies = [];
      for (let j = 0; j <= 3; j++) for (const b of tape.bodies(T[i0] + (T[i1] - T[i0]) * j / 3)) bodies.push(b);
      sh.pos = keepClear({ ...sh.pos }, bodies);
    }
  }
  // which way each sample faces: the target's bearing (leading the ball), then a bounded turn
  const lead = Math.round(DIRECTOR.lead / du);
  const bx = new Float64Array(n), by = new Float64Array(n), bz = new Float64Array(n);
  for (let k = 0; k < R.shots.length; k++) {
    const sh = R.shots[k];
    if (sh.i0 < 0) continue;
    // the target: before the ball is played (arm / line) the batter's end; then the ball (held where last seen)
    let hx = sh.face ? sh.face.x : sh.subj.x, hy = sh.face ? sh.face.y : sh.subj.y, hz = sh.face ? sh.face.z : sh.subj.z, seen = false;
    for (let i = sh.i0; i <= sh.i1; i++) {
      const follow = !sh.fixed && (sh.follow == null || T[i] >= sh.follow);
      if (sh.kind === 'catch') { if (tape.figure && tape.figure(sh.who, T[i], o)) { hx = o.x; hy = 1.1; hz = o.z; } }   // (on the catcher, as he moves)
      else if (sh.pair != null && follow && tape.ball(T[i], o)) {
        // (the ball and the fielder chasing it in the picture together: the view on the point between them)
        hx = o.x; hy = o.y; hz = o.z; seen = true;
        if (tape.figure && tape.figure(sh.pair, T[i], o2)) { hx += (o2.x - hx) * 0.65; hz += (o2.z - hz) * 0.65; }   // (nearer him: he is the subject)
      }
      else if (sh.stand && T[i] >= sh.stand.t) { const u = clamp((T[i] - sh.stand.t) / 0.5, 0, 1); hx += (sh.look.x - hx) * u; hy += (sh.look.y - hy) * u; hz += (sh.look.z - hz) * u; }   // (a six: on to the stand going up)
      else if (follow && tape.ball(T[i], o)) { hx = o.x; hy = o.y; hz = o.z; seen = true; }
      else if (follow && !seen && sh.kind === 'track') { const j = firstVisible(tape, T, i, sh.i1, o); if (j) { hx = o.x; hy = o.y; hz = o.z; } }
      bx[i] = hx; by[i] = hy; bz[i] = hz;
      X[i] = sh.pos.x; Y[i] = sh.pos.y; Z[i] = sh.pos.z;
    }
    track(sh, bx, by, bz, X, Y, Z, W, P, lead, lim, du, xr);
  }
  const cuts = [];
  for (let i = 1; i < n; i++) if (S[i] !== S[i - 1]) cuts.push(i);
  let start = Infinity, end = -Infinity;
  for (const g of segs) { start = Math.min(start, g.a); end = Math.max(end, g.b); }
  return { story: R.story, tier: R.tier, n, du, len, T, X, Y, Z, W, P, S, R: RT, shots: R.shots, segs, cuts, takes, start, end, key: R.key ?? null, focus: R.focus ?? null };
}
function segLen(g) { return g.rate > 0 ? (g.b - g.a) / g.rate : g.dur; }
function firstVisible(tape, T, i, i1, o) { for (let j = i; j <= i1; j += 3) if (tape.ball(T[j], o)) return true; return false; }

// One shot's turn: toward where the target will be `lead` samples later, a turn
// too quick to make spread round the moment (part before, from where the
// shot starts), eased with its rate and acceleration bounded. The monitor also
// tilts to the target (eased).
function track(sh, bx, by, bz, X, Y, Z, W, P, lead, lim, du, xr) {
  const i0 = sh.i0, i1 = sh.i1, m = i1 - i0 + 1;
  const b = new Float64Array(m);
  let prev = null;
  // (the bowler's-end camera turns no more than yawLim off the way it faces: it never whips round)
  const base = sh.yawLim && sh.face ? Math.atan2(sh.face.x - X[i0], sh.face.z - Z[i0]) : 0;
  for (let j = 0; j < m; j++) {
    const i = i0 + j, k = Math.min(i1, i + lead);
    const dx = bx[k] - X[i], dz = bz[k] - Z[i];
    let a = hypot2(dx, dz) > 1.5 || prev == null ? Math.atan2(dx, dz) : prev;
    if (sh.yawLim) a = base + clamp(wrap(a - base), -sh.yawLim, sh.yawLim);
    if (prev != null) a = prev + wrap(a - prev);
    b[j] = prev = a;
  }
  const r = 0.9 * lim.wMax * du, f = new Float64Array(m), g = new Float64Array(m);
  f[0] = b[0]; for (let j = 1; j < m; j++) f[j] = f[j - 1] + clamp(b[j] - f[j - 1], -r, r);
  g[m - 1] = b[m - 1]; for (let j = m - 2; j >= 0; j--) g[j] = g[j + 1] + clamp(b[j] - g[j + 1], -r, r);
  // (the share of the early turn comes in over the first 0.4 s: a shot opens on its subject)
  let yaw = f[0], w = 0, pitch = null;
  for (let j = 0; j < m; j++) {
    const i = i0 + j, sh2 = DIRECTOR.share * Math.min(1, j * du / 0.4), e = (1 - sh2) * f[j] + sh2 * g[j] - yaw;
    const ws = Math.sign(e) * Math.min(lim.wMax, 4 * Math.abs(e), Math.sqrt(1.6 * lim.wAcc * Math.abs(e)));
    if (j) { w += clamp(ws - w, -lim.wAcc * du, lim.wAcc * du); yaw += w * du; }
    W[i] = yaw;
    if (!xr) {
      const el = Math.atan2(by[i] - Y[i], Math.max(3, hypot2(bx[i] - X[i], bz[i] - Z[i])));
      pitch = pitch == null ? el : pitch + (el - pitch) * Math.min(1, du * 5);
      P[i] = clamp(pitch, -50 * D2R, 50 * D2R);
    }
  }
}

// The plan at real time u: { t (tape), x, y, z, yaw, pitch, shot, rate } into out
// (no blending across a cut).
export function planAt(p, u, out) {
  const f = clamp(u / p.du, 0, p.n - 1), i = Math.min(p.n - 2, Math.floor(f));
  let k = f - i;
  if (p.S[i] !== p.S[i + 1]) k = k < 1 ? 0 : 1;
  const j = k >= 1 ? i + 1 : i;
  out.t = p.S[i] === p.S[i + 1] ? at(p.T, i, k) : p.T[j];
  out.x = at(p.X, i, k); out.y = at(p.Y, i, k); out.z = at(p.Z, i, k); out.yaw = at(p.W, i, k); out.pitch = at(p.P, i, k);
  out.shot = p.S[j]; out.rate = p.R[j];
  return out;
}
const at = (a, i, k) => a[i] + (a[i + 1] - a[i]) * k;     // (a module function: nothing made per frame)
