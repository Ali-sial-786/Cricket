// The replay director (no three.js, so it can be tested in node): which balls
// get a replay, and how each one is cut: the angles, the tempo, the length.
//
// 1. What gets a replay (Settings -> Replays: highlights | every ball | off).
//    classify() reads what happened to the ball and names its story:
//      wicket    bowled, lbw, caught, run out, stumped;
//      boundary  four, six;
//      close     a run-out / stumping decision that went the batter's way, a
//                catch put down, an edge past the stumps, a played-and-missed
//                that just missed them, an lbw shout, a direct hit, a diving
//                stop, a misfield / overthrows;
//      routine   everything else (leaves, dots, singles): only "every ball".
// 2. The angles. A small number of fixed cameras, each turning (yaw only in
//    the headset: no roll, the horizon level, your own head pitches) to keep
//    the ball near the middle of the view; a cut between them goes through
//    the view fading (out 0.1 s, in 0.2 s), never a move through the air:
//      arm      high behind the bowler's arm: the run-up and the release;
//      line     on the line of the stumps, 7 m in front of the batter, at
//               eye height: the ball's line, bat or pad on ball, the stumps;
//      crease   side-on at the popping crease where the stumps were broken:
//               the bat / the foot and the line (a freeze as they break);
//      track    a spot picked from the ball's recorded flight so that it stays
//               near the middle of the view the whole way at a bounded turn
//               rate, ending on the subject: the rope, the landing in the
//               stands and the crowd, the fielder taking the catch.
// 3. The tempo: real speed for the build-up, slow motion (0.3x) through the
//    key moment, then cut. Budgets: wicket 6 s, boundary / close call 5 s, a
//    routine ball ("every ball") 2.5 s.
// Everything is laid out once, when the replay starts (~1-3 ms), from the tape.
import { keepClear, blocksSight, nearestOnBody, viewShares, CLEAR } from './replayFraming.js';
import { hypot2, hypot3 } from '../physics/math.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const CZ = -10.06, Z_BAT = 0, Z_BOWL = -20.12, POP = 1.22, BOARD_REACH = 68.2;

export const MODES = ['highlights', 'every', 'off'];
export const BUDGET = { wicket: 6, boundary: 5, close: 5, routine: 2.5 };
export const DIRECTOR = {
  du: 1 / 90,                  // s: the plan's samples (real time)
  slow: 0.3,                   // slow motion through the key moment
  cutOut: 0.03, cutIn: 0.05,   // s: a cut is a quick dip: down to dark and back in (one cut at most a replay)
  endOut: 0.04,                // s: the last moments fade down before you are put back
  inOut: 0.08,                 // s: the view comes in from dark as the replay starts, and as it puts you back
  arm: { back: 6.5, y: 3.0 },  // m behind the bowler's stumps, m up
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
  fov: { arm: 30, line: 42, crease: 36, track: 40, wide: 48 },
};

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
  const r = f.res || {}, k = r.kind;
  const STORY = { bowled: 'bowled', lbw: 'lbw', caught: 'caught', runout: 'runout', stumped: 'stumped' };
  if (f.wicket) return { story: STORY[k] || (f.wicket === 'run out' ? 'runout' : f.wicket), tier: 'wicket' };
  if (STORY[k]) return { story: STORY[k], tier: 'close' };                 // out, but a no-ball / free hit
  if (f.boundary === 6) return { story: 'six', tier: 'boundary' };
  if (f.boundary === 4 || (k === 'boundary' && !r.overthrows)) return { story: 'four', tier: 'boundary' };
  if (f.dropped) return { story: 'dropped', tier: 'close' };
  if (r.backInTime || r.shyMissed) return { story: 'stumped', tier: 'close' };
  if ((f.review && !r.padded && f.brk) || (r.closeCall != null && r.closeCall < 0.9 && f.brk)) return { story: 'runout', tier: 'close' };
  if (f.direct && f.brk) return { story: 'direct', tier: 'close' };
  if (r.padded && f.review) return { story: 'lbw', tier: 'close' };
  if (f.edge && f.behind) return { story: 'edge', tier: 'close' };
  // (played and missed by 12 cm or less; a ball left alone with no shot only if it all but hit them)
  if (f.nearMiss != null && f.nearMiss <= (k === 'left' ? 0.04 : 0.12)) return { story: k === 'left' ? 'leave' : 'beaten', tier: 'close' };
  if (f.dive) return { story: 'dive', tier: 'close' };
  if (r.overthrows || f.overthrow) return { story: 'misfield', tier: 'close' };
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
export function direct({ story, tier, m, tape, xr = true }) {
  const R = recipe(story, tier, m, tape);
  if (!R || !R.segs.length) return null;
  return layout(R, tape, xr ? DIRECTOR.xr : DIRECTOR.desk, xr);
}

// Real seconds a list of segments takes.
export function segsLength(segs) { let s = 0; for (const g of segs) s += g.rate > 0 ? (g.b - g.a) / g.rate : g.dur; return s; }

function recipe(story, tier, m, tape) {
  const first = tape.first, last = tape.last, rel = m.release;
  if (rel == null || rel < first) return null;
  const B = BUDGET[tier] || 5, S = DIRECTOR.slow;
  const arr = m.arrive ?? (m.hit ?? m.pad ?? rel + 0.6);
  const hit = m.hit ?? null, dead = Math.min(m.dead ?? last, last);
  const shots = [], segs = [];
  const shot = (s) => { shots.push(s); return shots.length - 1; };
  const seg = (a, b, rate, k) => { a = Math.max(first, a); b = Math.min(last, b); if (b > a + 1e-3) segs.push({ a, b, rate, shot: k }); };
  const hold = (t, dur, k) => segs.push({ a: t, b: t, rate: 0, dur, shot: k });
  const fit = (cuts) => { for (const c of cuts) { if (segsLength(segs) <= B + 1e-6) return; c(); } };
  const arm = () => shot({ kind: 'arm', pos: { x: 0, y: DIRECTOR.arm.y, z: Z_BOWL - DIRECTOR.arm.back }, face: { x: 0, y: 0.9, z: Z_BAT - POP }, follow: arr });
  const line = () => shot({ kind: 'line', pos: { x: 0, y: DIRECTOR.line.y, z: DIRECTOR.line.z }, face: { x: 0, y: 0.6, z: Z_BAT - 0.6 }, follow: arr });
  // the line camera joins once the ball is past it (it is never whipped past your head)
  // (crossing that point on its way down: before the release the tape may hold the ball anywhere)
  const lineFrom = () => { let was = false; return clamp(firstWhen(tape, rel, arr, (p) => { const past = p.z > DIRECTOR.line.z + DIRECTOR.line.gap; if (!past) was = true; return past && was; }) ?? arr - 0.22, rel + 0.15, arr - 0.1); };
  // …and leaves before a ball hit back down the pitch gets near it
  const lineUntil = (t1) => { const L = DIRECTOR.line, t = hit != null ? firstWhen(tape, hit, t1, (p) => hypot3(p.x, p.y - L.y, p.z - L.z) < L.gap) : null; return t != null ? Math.max(hit + 0.04, t - 0.03) : t1; };

  if (story === 'routine') {
    // One angle from behind the arm, following the ball once it is played; no slow motion.
    const end = Math.min(dead + 0.3, arr + 1.4, rel + 1.9), a = Math.max(rel - 0.6, end - B);
    seg(a, end, 1, arm());
    return { story, tier, shots, segs };
  }
  if (story === 'bowled' || story === 'lbw' || story === 'beaten' || story === 'leave' || story === 'edge') {
    // Behind the arm for the run-up and the release; cut to the line of the
    // stumps for the ball's arrival in slow motion (the stumps breaking, the
    // pad, the edge); real speed for what follows (bails, the keeper's take).
    const k0 = arm(), k1 = line(), tB = lineFrom();
    const key = story === 'bowled' ? (m.wicket ?? arr) : story === 'lbw' ? (m.pad ?? arr) : arr;
    const slowEnd = key + (story === 'edge' ? 0.3 : 0.35);
    let after = story === 'edge' ? Math.min((m.caught ?? m.held ?? dead) + 0.5, slowEnd + 1.6) : slowEnd + 0.8;
    // (a ball knocked back off the stumps or the pad does not come at your head: it ends first)
    const L = DIRECTOR.line, back = firstWhen(tape, key, after, (p) => hypot3(p.x, p.y - L.y, p.z - L.z) < L.gap);
    if (back != null) after = Math.max(key + 0.15, back - 0.03);
    let pre = 0.9;
    const build = (rate) => { segs.length = 0; seg(rel - pre, tB, 1, k0); seg(tB, Math.min(slowEnd, after), rate, k1); seg(slowEnd, after, 1, k1); };
    build(S);
    fit([() => { pre = 0.4; build(S); }, () => build(0.45), () => { segs[segs.length - 1].b = Math.min(segs[segs.length - 1].b, slowEnd + 0.4); }]);
    return { story, tier, shots, segs, key };
  }
  if (story === 'four' || story === 'six') {
    // Two angles, one cut: the line camera for bat on ball (slowed) and the
    // ball leaving; then the end of its journey, framed so that the turf, the
    // rope and the people are the picture and the boards only a band behind:
    //   a four, with a fielder chasing (within 12 m of where it crosses): from
    //   11-16 m inside the rope at 1.8 m, ball and fielder in the picture
    //   together; with nobody near: a crane, 4 m up, 9-14 m in, looking down
    //   onto the ball and the rope (on a monitor; in the headset you look down
    //   to it). Slowed over its last 0.5 s, the replay ends 0.12 s after the
    //   ball crosses the rope (never on a ball stopped against the boards);
    //   a six: a crane 5 m up, 16-28 m in front of where it comes down (the
    //   recorded `land` if the tape has it, else where it stops falling, else
    //   its last recorded place: it may stop at the rope or fly on into the
    //   seats), the arc coming down into the stand, then the view settles on
    //   the crowd going up there.
    if (hit == null) return recipe('routine', tier, m, tape);
    const six = story === 'six', cross = m.cross ?? dead;
    const land = six ? Math.min(last, m.land ?? landingAfter(tape, cross, last)) : cross;
    const key = six ? land : cross;
    const endT = Math.min(last, key + (six ? 0.9 : 0.12));
    const k1 = line(), tB = lineFrom(), outT = lineUntil(hit + 0.5);
    const subj = ballAt(tape, key), re = hypot2(subj.x, subj.z - CZ) || 1;
    const fielder = six ? null : nearestFigure(tape, key, subj, 12);
    // (the crowd it lands among: straight behind either end there is only a sightscreen and covered seats,
    // so the view settles on the people nearest it, just outside that wedge)
    let sa = Math.atan2(subj.x, subj.z - CZ);
    for (const axis of [0, Math.PI]) { const d = wrap(sa - axis); if (Math.abs(d) < 18 * D2R) sa = axis + (d < 0 ? -18 : 18) * D2R; }
    const sr = Math.max(re, BOARD_REACH) + 6;
    const stand = six ? { t: key + 0.1, x: Math.sin(sa) * sr, y: Math.max(subj.y, 1) + 4, z: CZ + Math.cos(sa) * sr } : null;
    const k2 = shot(six
      ? { kind: 'track', rope: true, stand, fov: DIRECTOR.fov.wide, subj, dists: [18, 22, 26], heights: [5.0], endDist: [16, 28], rimMax: 52, kMax: 5 }
      : fielder
        ? { kind: 'track', rope: true, fov: DIRECTOR.fov.track, subj, fielder, pair: fielder.k, dists: [12, 14, 16], heights: [1.8], endDist: [11, 17], rimMax: 55.5 }
        : { kind: 'track', rope: true, fov: DIRECTOR.fov.track, subj, dists: [9, 11.5, 14], heights: [4.0], endDist: [9, 15], rimMax: 56 });
    // (a ball driven back down the pitch leaves the line camera at once: the shot from behind the arm instead)
    const viaArm = (Math.min(hit + 0.2, outT) - tB) / S + Math.max(0, outT - hit - 0.2) < 0.7, k0 = viaArm ? arm() : -1;
    let slow = S, from = Math.max(viaArm ? hit + 0.35 : outT, key - (six ? 1.8 : 1.6)), overRate = S, slowFrom = 0.5;
    const slowTo = six ? 0.3 : 0.12;
    const build = () => {
      segs.length = 0;
      if (viaArm) seg(rel - 0.7, hit + 0.35, 1, k0);
      else { seg(tB, Math.min(hit + 0.2, outT), slow, k1); seg(hit + 0.2, outT, 1, k1); }
      seg(from, key - slowFrom, 1, k2); seg(Math.max(from, key - slowFrom), Math.min(endT, key + slowTo), overRate, k2); seg(key + slowTo, endT, 1, k2);
    };
    build();
    // (over budget: less slow motion; then the rope camera picks the ball up later, never with under 1.2 s to go)
    fit([() => { slow = 0.45; build(); }, () => { overRate = 0.4; build(); }, () => { slowFrom = 0.4; build(); },
      () => { const over = segsLength(segs) - B; from = Math.min(key - 0.9, from + over); build(); }]);
    return { story, tier, shots, segs, key: hit, focus: key };
  }
  if (story === 'caught' || story === 'dropped') {
    // The catch (or the drop) from 5-8 m in front of the catcher, three-quarter
    // on, at chest height, the camera in place before the ball gets there and
    // the view on him (it turns with him as he runs in); slow motion through
    // the hands closing, then a beat on him at real speed. Before it, the shot:
    // the line camera (bat on ball, slowed), or for the keeper and the slips
    // (too quick for that) the delivery from behind the arm.
    if (hit == null) return recipe('routine', tier, m, tape);
    const ct = story === 'caught' ? (m.caught ?? m.held ?? dead) : (m.dropT ?? dead);
    const tB = lineFrom(), lt = lineUntil(hit + 0.2), quick = ct - hit < 1.3;
    const cs = catchShot(tape, ct, quick ? hit - 0.12 : lt);
    if (!cs) return recipe('routine', tier, m, tape);
    const kc = shot(cs), endT = Math.min(last, ct + 1.0);
    if (quick) {
      const k0 = arm();
      let pre = 0.8, rate = S;
      const build = () => { segs.length = 0; seg(rel - pre, hit - 0.12, 1, k0); seg(hit - 0.12, ct - 0.35, 0.6, kc); seg(Math.max(hit - 0.12, ct - 0.35), ct + 0.3, rate, kc); seg(ct + 0.3, endT, 1, kc); };
      build();
      fit([() => { pre = 0.4; build(); }, () => { rate = 0.45; build(); }]);
      return { story, tier, shots, segs, key: ct, focus: ct };
    }
    const k1 = line();
    let from = Math.max(lt, ct - 1.6), rate = S, lineRate = S;
    const build = () => {
      segs.length = 0;
      seg(tB, lt, lineRate, k1);
      seg(from, ct - 0.45, 1, kc); seg(Math.max(from, ct - 0.45), ct + 0.3, rate, kc); seg(ct + 0.3, endT, 1, kc);
    };
    build();
    fit([() => { rate = 0.4; build(); }, () => { lineRate = 0.5; build(); },
      () => { const over = segsLength(segs) - B; from = Math.min(ct - 0.9, from + over); build(); }]);
    return { story, tier, shots, segs, key: ct, focus: ct };
  }
  if (story === 'runout' || story === 'stumped' || story === 'direct') {
    const kb = m.brk ?? m.throwAt;
    if (kb == null) return recipe(hit != null ? 'misfield' : 'beaten', tier, m, tape);
    const end = m.brkEnd || (story === 'stumped' ? 'batting' : 'batting');
    const sz = end === 'batting' ? Z_BAT : Z_BOWL, dir = end === 'batting' ? 1 : -1, cz = sz - dir * POP;
    const kc = shot(creaseShot(tape, cz, sz, kb));
    const freeze = 0.45;
    let leadIn = 0.9;
    const crease = (from) => { seg(from, kb - 0.25, 1, kc); seg(kb - 0.25, kb, 0.25, kc); hold(kb, freeze, kc); seg(kb, kb + 0.25, 0.25, kc); seg(kb + 0.25, kb + 0.7, 1, kc); };
    const creaseLen = () => leadIn - 0.25 + 1 + freeze + 1 + 0.45;
    if (story === 'stumped' && kb - arr < 2.0) {
      // The delivery from behind the arm (the batter down the pitch, beaten), then side-on for the stumps.
      const k0 = arm(); let pre = 0.6;
      const from = Math.max(arr, kb - leadIn);
      const build = () => { segs.length = 0; seg(rel - pre, from, 1, k0); crease(from); };
      build(); fit([() => { pre = 0.2; build(); }]);
      return { story, tier, shots, segs, key: kb };
    }
    // The throw tracked as it comes in (as much as the budget leaves), then the crease.
    const room = B - creaseLen();
    const a0 = Math.max(hit ?? arr, kb - leadIn - Math.max(0, room));
    if (kb - leadIn - a0 > 0.6) {
      const k2 = shot({ kind: 'track', fov: DIRECTOR.fov.wide, subj: ballAt(tape, kb - leadIn), dists: [11, 15, 20], heights: [3.2], endDist: [8, 21] });
      seg(a0, kb - leadIn, 1, k2);
      crease(kb - leadIn);
    } else crease(Math.max(first, kb - leadIn - Math.max(0, room)));
    return { story, tier, shots, segs, key: kb };
  }
  if (story === 'dive' || story === 'misfield') {
    if (hit == null) return recipe('routine', tier, m, tape);
    const k0 = arm();
    const dive = story === 'dive', dt = m.diveT ?? dead;
    const endT = dive ? Math.min(last, dt + 0.9) : Math.min(last, dead + 0.4);
    const k2 = shot({ kind: 'track', fov: DIRECTOR.fov.wide, subj: ballAt(tape, dive ? dt : endT),
      dists: dive ? [10, 14, 18] : [26, 34], heights: dive ? [2.4] : [6], endDist: dive ? [8, 18] : [18, 42] });
    let pre = 0.6, from = hit + 0.1;
    const build = () => {
      segs.length = 0; seg(rel - pre, hit + 0.1, 1, k0);
      if (dive && dt - 0.3 > from) { seg(from, dt - 0.3, 1, k2); seg(dt - 0.3, dt + 0.35, 0.4, k2); seg(dt + 0.35, endT, 1, k2); } else seg(from, endT, 1, k2);
    };
    build();
    fit([() => { pre = 0.25; build(); }, () => { const over = segsLength(segs) - B; from = Math.min((dive ? dt - 0.5 : endT - 2.5), from + over); build(); }]);
    return { story, tier, shots, segs, key: dive ? dt : hit };
  }
  return recipe('routine', tier, m, tape);
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
  return { kind: 'crease', fov: DIRECTOR.fov.crease, pos: best.pos, face: at, fixed: true };
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
function catchShot(tape, ct, from) {
  const B = ballAt(tape, ct), who = nearestFigure(tape, ct, B, 4) || { k: -1, x: B.x, z: B.z };   // (nobody there: on the ball)
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
    for (const b of bodies) { const g = nearestOnBody(pos, b); if (hypot3(pos.x - g.x, pos.y - g.y, pos.z - g.z) < CLEAR + (b.k === who.k ? 0.5 : 0.3)) { bad += 3; break; } }
    for (const b of atCt) if (b.k !== who.k && blocksSight(pos, P, b)) bad += 1;
    if (!best || bad < best.bad) best = { bad, pos };
  }
  if (!best) return null;
  return { kind: 'catch', fov: DIRECTOR.fov.line, pos: best.pos, who: who.k, face: P };
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
  if (sh.rope) {
    // Inside the rope, `dists` m from the subject (further if it came down deep in the stand), on bearings
    // up to 80° either side of straight in from it.
    const re = hypot2(E.x, E.z - CZ) || 1, ix = -E.x / re, iz = -(E.z - CZ) / re, rim = sh.rimMax ?? DIRECTOR.rim + 2.5, kMax = sh.kMax ?? 8;
    for (const d0 of sh.dists) for (let k = -kMax; k <= kMax; k++) {
      const c = Math.cos(k * 10 * D2R), sn = Math.sin(k * 10 * D2R), ux = ix * c - iz * sn, uz = ix * sn + iz * c;
      let d = d0;
      while (d < d0 + 20 && hypot2(E.x + ux * d, E.z + uz * d - CZ) > rim) d += 1;     // (no nearer the boards than the shot allows)
      for (const y of sh.heights) cands.push({ x: E.x + ux * d, y, z: E.z + uz * d });
    }
  } else for (const d of sh.dists) for (let k = 0; k < 24; k++) {
    const a = k / 24 * 2 * Math.PI;
    for (const y of sh.heights) cands.push({ x: E.x + Math.sin(a) * d, y, z: E.z + Math.cos(a) * d });
  }
  // (and wider round the middle of the flight)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const s of samples) if (s.vis) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z); }
  if (!sh.rope && (x0 < x1 || z0 < z1)) {
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, half = hypot2(x1 - x0, z1 - z0) / 2;
    for (const d of [half + 10, half * 1.4 + 14]) for (let k = 0; k < 16; k++) {
      const a = k / 16 * 2 * Math.PI;
      cands.push({ x: mx + Math.sin(a) * d, y: sh.heights[0], z: mz + Math.cos(a) * d });
    }
  }
  const endBodies = bodies.filter((b) => b.t === bodies.end);
  let nearest = null, nd = Infinity;
  for (const b of endBodies) { const d = hypot2(b.b.x - E.x, b.b.z - E.z); if (d < nd) { nd = d; nearest = b; } }
  let best = null;
  for (const c of cands) {
    if (hypot2(c.x, c.z - CZ) > (sh.rope ? (sh.rimMax ?? DIRECTOR.rim + 2.5) + 1e-6 : DIRECTOR.rim)) continue;
    if (Math.abs(c.x) < 2.2 && c.z > -23 && c.z < 2.5 && !sh.near) continue;     // (not on the pitch, in the way of play)
    const cost = spotCost(c, samples, sh, lim) + crowdCost(c, bodies, endBodies, nearest, E);
    if (!best || cost < best.cost) best = { cost, c };
  }
  if (!best) best = { c: { x: E.x * 0.7, y: sh.heights[0], z: CZ + (E.z - CZ) * 0.7 } };
  keepClear(best.c, bodies);
  return best.c;
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
  cost += Math.max(0, 4 - minD) * 3 + Math.max(0, maxEl - (sh.rope ? 50 : 38) * D2R) / D2R * 0.12;
  if (sh.rope) {
    cost += (dE - sh.endDist[0]) * 0.3;                    // (by the rope: as close to where it ends as the turn allows)
    // looking out at the stand across the rope (40° or less off straight out), not along the boards (a board
    // close-up receding across the view)
    const re = hypot2(sh.subj.x, sh.subj.z - CZ) || 1, cosOut = ((sh.subj.x - c.x) * sh.subj.x + (sh.subj.z - c.z) * (sh.subj.z - CZ)) / (re * Math.max(1e-3, dE));
    const ang = Math.acos(clamp(cosOut, -1, 1)) / D2R;
    if (ang > 40) cost += (ang - 40) * 0.12;
    // what the last picture shows, looking at where it ends (a crane looks down onto it): boards or a
    // sightscreen filling it cost a lot (a coarse 10 x 8 look, at plan time)
    // (looked at level, as a headset viewer sees it until he looks down; and the whole view for a sightscreen at its side)
    const A = sh.stand || sh.subj, ay = Math.atan2(A.x - c.x, A.z - c.z), sv = viewShares(c, ay, 0, { hfov: 40, vfov: 30, n: 10, nv: 8 });
    const sw = viewShares(c, ay, 0, { hfov: 100, vfov: 90, n: 12, nv: 8 });
    cost += (sv.boards + sv.screen) * 25 + sw.screen * 30;
    // the fielder chasing it in the picture with the ball
    const F = sh.fielder;
    if (F) { const off = Math.abs(wrap(Math.atan2(F.x - c.x, F.z - c.z) - Math.atan2(sh.subj.x - c.x, sh.subj.z - c.z))); if (off < 25 * D2R && hypot2(F.x - c.x, F.z - c.z) > 2.5) cost -= 0.8; }
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
  let si = 0, u0 = 0;
  for (let i = 0; i < n; i++) {
    const u = Math.min(len, i * du);
    while (si < segs.length - 1 && u > u0 + segLen(segs[si]) + 1e-9) { u0 += segLen(segs[si]); si++; }
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
        if (tape.figure && tape.figure(sh.pair, T[i], o2)) { hx = (hx + o2.x) * 0.5; hz = (hz + o2.z) * 0.5; }
      }
      else if (sh.stand && T[i] >= sh.stand.t) { const u = clamp((T[i] - sh.stand.t) / 0.5, 0, 1); hx += (sh.stand.x - hx) * u; hy += (sh.stand.y - hy) * u; hz += (sh.stand.z - hz) * u; }   // (a six: on to the stand going up)
      else if (follow && tape.ball(T[i], o)) { hx = o.x; hy = o.y; hz = o.z; seen = true; }
      else if (follow && !seen && sh.kind === 'track') { const j = firstVisible(tape, T, i, sh.i1, o); if (j) { hx = o.x; hy = o.y; hz = o.z; } }
      bx[i] = hx; by[i] = hy; bz[i] = hz;
      X[i] = sh.pos.x; Y[i] = sh.pos.y; Z[i] = sh.pos.z;
    }
    track(sh, bx, by, bz, X, Y, Z, W, P, lead, lim, du, xr);
  }
  const cuts = [];
  for (let i = 1; i < n; i++) if (S[i] !== S[i - 1]) cuts.push(i);
  return { story: R.story, tier: R.tier, n, du, len, T, X, Y, Z, W, P, S, R: RT, shots: R.shots, segs, cuts, start: segs[0].a, end: segs[segs.length - 1].b, key: R.key ?? null, focus: R.focus ?? null };
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
  for (let j = 0; j < m; j++) {
    const i = i0 + j, k = Math.min(i1, i + lead);
    const dx = bx[k] - X[i], dz = bz[k] - Z[i];
    let a = hypot2(dx, dz) > 1.5 || prev == null ? Math.atan2(dx, dz) : prev;
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
