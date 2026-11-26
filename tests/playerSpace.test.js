// The player's space (review 7, N2): one rule for every figure -- no walking, running, sliding or
// celebrating figure's path comes within EYE_CLEAR of your eye (game/playerSpace.js). Sampled here for
// the lane bend every straight walk and run is drawn with, every ceremony's staged walks and the
// result's for each outcome, the result's gathering when you lost a chase (N1: never an empty scene),
// and the wicket huddle, with you at the striker's and at the bowler's end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// (the cards and the coin draw on canvases: a stand-in document)
const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {}, width: 10 })), set: (o, k, v) => { o[k] = v; return true; } });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
const { EYE_CLEAR, FIELD_CLEAR, FAST_CLEAR, bendAround } = await import('../src/game/playerSpace.js');
const { resultPaths, resultStaging, winnersFocus, gatherAt, HUDDLE_AT, HUDDLE_RING } = await import('../src/game/ceremony.js');
const { HUDDLE_YOU, HUDDLE_AWAY, clearHuddle } = await import('../src/game/fieldController.js');
const { Fielding } = await import('../src/game/fielding.js');
const { makeRng } = await import('../src/physics/math.js');
const { PITCH } = await import('../src/physics/pitch.js');

const CZ = PITCH.centerZ;
// you, on the ground: at the striker's crease (batting), or just past the bowling crease (you have bowled)
const STRIKER = { x: -0.35, z: -1.0 }, BOWLER = { x: 0.4, z: PITCH.bowlingStumpsZ + 2.0 };
const PLACES = [['striker', STRIKER, -1], ['bowler', BOWLER, 1]];      // (and which way down the pitch is)
const segDist = (w, e) => {
  const dx = w.x1 - w.x0, dz = w.z1 - w.z0, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((e.x - w.x0) * dx + (e.z - w.z0) * dz) / L2));
  return Math.hypot(w.x0 + dx * t - e.x, w.z0 + dz * t - e.z);
};

test('a straight walk or run drawn bent round you never comes within the clearance, whichever line it takes', () => {
  const out = { x: 0, z: 0 }, e = { x: 0.3, z: -1.2 };
  let worst = Infinity;
  for (let a = 0; a < Math.PI * 2; a += 0.13) {
    const ux = Math.sin(a), uz = Math.cos(a);
    for (let off = -2.5; off <= 2.5; off += 0.05) {
      for (let s = -9; s <= 9; s += 0.02) {
        const x = e.x - uz * off + ux * s, z = e.z + ux * off + uz * s;
        bendAround(x, z, ux, uz, e, FIELD_CLEAR, out, 1);
        worst = Math.min(worst, Math.hypot(out.x - e.x, out.z - e.z));
      }
    }
  }
  assert.ok(worst >= FIELD_CLEAR - 1e-9, `came within ${worst.toFixed(3)} m`);
  // and far off the line it is left alone
  bendAround(5, 7, 0, 1, e, FIELD_CLEAR, out); assert.deepEqual(out, { x: 5, z: 7 });
});

test('the result, every outcome: something is staged, and no staged walk comes within the clearance of you', () => {
  const outcomes = [['you batted, won', 'home', false, false], ['you batted, lost', 'away', true, false], ['you bowled, won', 'home', true, true],
    ['you bowled, lost', 'away', false, true], ['tied, batting', 'tie', false, false], ['tied, bowling', 'tie', false, true]];
  for (const [name, winner, fieldingWon, isBowling] of outcomes) {
    const how = resultStaging(winner, fieldingWon, isBowling);
    assert.ok(['line', 'meet', 'walkPast', 'huddle'].includes(how), `${name}: ${how}`);
    for (const [where, e0, down] of PLACES) {
      for (const turn of [0, 0.6, -0.6, Math.PI]) {
        const fx = Math.sin(turn), fz = down * Math.cos(turn);
        // (they won batting: you are cut to beside the middle, where the batters meet)
        const e = how === 'meet' ? { x: -3.4, z: CZ + 0.6 } : e0;
        const P = resultPaths(how, e, fx, fz);
        const walks = [...P.line, ...(P.partner ? [P.partner] : []), ...(P.meet || []), ...(P.walkPast || [])];
        if (how !== 'huddle') assert.ok(walks.length >= 2, `${name} at the ${where}'s end: nothing staged`);
        for (const w of walks) {
          const d = segDist(w, e);
          assert.ok(d >= FIELD_CLEAR, `${name} at the ${where}'s end, facing ${turn}: a walk comes ${d.toFixed(2)} m from you`);
          assert.ok(Math.hypot(w.x1 - e.x, w.z1 - e.z) < 16, `${name}: a walk ends out of the scene`);
        }
      }
    }
  }
});

// A field at its marks, the ball dead; your space kept the way fieldController.keepClear keeps it.
function field(you, seed = 7, bowlerFields = true) {
  const f = new Fielding({ rng: makeRng(seed), bowlerFields });
  f.reset(); f.started = true; f.ballDead();
  f.keepOut = { x: you.x, z: you.z, r: FIELD_CLEAR, path: FAST_CLEAR };
  return f;
}
// The nearest a fielder comes to you, walking or standing (worst) and moving fast -- over 3 m/s: a jog
// in to a huddle, a sprint (fast) -- frame by frame.
function nearest(f, you, secs = 16) {
  const dt = 1 / 60; let worst = Infinity, fast = Infinity;
  const prev = f.fielders.map((p) => ({ x: p.pos.x, z: p.pos.z }));
  for (let k = 0; k < secs / dt; k++) {
    f.update(dt, 100 + k * dt, null, null);
    f.fielders.forEach((p, i) => {
      const v = Math.hypot(p.pos.x - prev[i].x, p.pos.z - prev[i].z) / dt; prev[i].x = p.pos.x; prev[i].z = p.pos.z;
      if (k < 30 || p.bowler) return;          // (the marks they start from are the field's, not this test's)
      const d = Math.hypot(p.pos.x - you.x, p.pos.z - you.z);
      worst = Math.min(worst, d);
      if (v > 3) fast = Math.min(fast, d);
    });
  }
  nearest.fast = fast;
  return worst;
}

test('the wicket huddle: round the bowler with you at the striker\'s end, round you when you took it -- nobody within the clearance', () => {
  // you batting, out: they gather to the AI bowler a few steps up the pitch from his follow-through
  let f = field(STRIKER, 7, false);
  assert.ok(f.celebrateWicket(100, { x: 1.0, z: -15.5 }, -1, undefined, 11.5) >= 3);
  clearHuddle(f, STRIKER, HUDDLE_AWAY);          // (as FieldController.huddle does)
  let d = nearest(f, STRIKER);
  assert.ok(d >= FIELD_CLEAR - 0.02, `a fielder came ${d.toFixed(2)} m from you at the striker's end`);
  assert.ok(nearest.fast >= FAST_CLEAR - 0.05, `a fielder ran past ${nearest.fast.toFixed(2)} m from you at the striker's end`);
  // you bowled it: they come round you, at the edge of your space
  f = field(BOWLER, 11, false);
  assert.ok(f.celebrateWicket(100, BOWLER, -1, HUDDLE_YOU, 11.5) >= 3);
  clearHuddle(f, BOWLER, HUDDLE_YOU);
  d = nearest(f, BOWLER);
  assert.ok(d >= FAST_CLEAR - 0.02, `the huddle round you came ${d.toFixed(2)} m from you: its jumps are fast`);
  assert.ok(nearest.fast >= FAST_CLEAR - 0.05, `a fielder ran in ${nearest.fast.toFixed(2)} m from you at the bowler's end`);
});

test('you lose a chase on a dot ball: the side still gathers -- where the bowler was -- and you are cut to beside them, clear of everyone', () => {
  for (const bw of [{ pos: { x: 0.9, z: PITCH.bowlingStumpsZ + 3 } }, null]) {
    const f = field(STRIKER, 5, false);
    const focus = winnersFocus(f, bw, { x: 0, z: 0 });
    assert.ok(focus, 'a place to gather, always');
    // the view: 5.5 m beside them (ceremony.js winnersSpot)
    const side = focus.x <= 0 ? -1 : 1, you = { x: focus.x + side * 5.5, z: focus.z + 1.2 };
    f.keepOut = { x: you.x, z: you.z, r: FIELD_CLEAR, path: FAST_CLEAR };
    const n = gatherAt(f, focus, 100, you);
    assert.ok(n >= 5, `${n} men gather`);
    const d = nearest(f, you, 6);
    assert.ok(d >= FIELD_CLEAR - 0.02, `a fielder came ${d.toFixed(2)} m from you`);
    assert.ok(nearest.fast >= FAST_CLEAR - 0.05, `a fielder jogged in ${nearest.fast.toFixed(2)} m from you`);
    const near = f.fielders.filter((p) => !p.bowler && Math.hypot(p.pos.x - focus.x, p.pos.z - focus.z) < 3).length;
    assert.ok(near >= 3, `${near} round the bowler's spot after 6 s`);
  }
});

test('the other ceremonies: the side gathered before an innings stands clear of you (the walks out and past are drawn bent round you: the first test)', () => {
  assert.ok(HUDDLE_AT - HUDDLE_RING >= FIELD_CLEAR, 'the take-the-field huddle ring');
  assert.ok(HUDDLE_YOU > FAST_CLEAR && FAST_CLEAR > FIELD_CLEAR && FIELD_CLEAR > EYE_CLEAR, 'a huddle round you forms outside the fast clearance, outside the field\'s, outside the eye\'s');
});
