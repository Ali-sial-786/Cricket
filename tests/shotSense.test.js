// Shot reading for your own batting body (src/render/shotSense.js): the
// features of a swing -> soft shot weights, the hysteresis that keeps the
// leading shot from flickering, and what the reader makes of whole scripted
// strokes (tests/battingTracks.js): the right family, no flicker, no stroke
// read into lifting the bat, walking or waggling between balls. Pure JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShotSense, FAMILIES, SENSE, scoreShots, weighShots, captureTime } from '../src/render/shotSense.js';
import { SHOTS, shotTrack, buildTrack } from './battingTracks.js';

// The bat's +Y (up the handle) and +Z (its face) from its quaternion.
const axisOf = (q) => ({ x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) });
const faceOf = (q) => ({ x: 2 * (q.x * q.z + q.w * q.y), y: 2 * (q.y * q.z - q.w * q.x), z: 1 - 2 * (q.x * q.x + q.y * q.y) });
const ctxOf = (e) => ({ sweep: e.extra ? e.extra.sweep : null, hitT: null, live: e.extra ? e.extra.live : null, face: faceOf(e.bq) });

// Feed a track through a reader; per frame: the reader's output (copied).
function read(trk, S = new ShotSense()) {
  return trk.map((e) => { const o = S.update(e.t, e.dt, e.head.p, e.bp, axisOf(e.bq), e.off, ctxOf(e)); return { t: e.t - trk[0].t, ...o, weights: o.weights.slice() }; });
}
const leaderOf = (scores) => FAMILIES[scores.indexOf(Math.max(...scores))];
// The kinds of stroke: upright bat, across the line, down low.
const KIND = Object.fromEntries(FAMILIES.map((n) => [n, /sweep/.test(n) ? 'low' : /cut|pull|hook/.test(n) ? 'cross' : 'upright']));

const BASE = { cross: 0, power: 0, front: 0, dirX: 0, up: 0, fine: 0, handX: 0.25, handY: -0.5, low: 0, lowBat: 0, sense: 1, sweep: null };
const F = (o) => ({ ...BASE, ...o });

test('scores: each shot family from the features that make it', () => {
  const cases = [
    ['forward_defence', { front: 0.8 }],
    ['back_defence', { front: -0.8 }],
    ['straight_drive', { power: 1, front: 0.8 }],
    ['cover_drive', { power: 1, front: 0.8, dirX: 0.7 }],
    ['lofted_drive', { power: 1, front: 0.8, up: 0.9 }],
    ['flick', { power: 1, front: 0.5, dirX: -0.7 }],
    ['back_foot_punch', { power: 1, front: -0.8 }],
    ['square_cut', { cross: 1, handX: 0.5 }],
    ['late_cut', { cross: 1, handX: 0.5, fine: 0.8 }],
    ['pull', { cross: 1, handX: 0, handY: -0.4 }],
    ['hook', { cross: 1, handX: 0, handY: 0 }],
    ['sweep', { cross: 1, low: 1, lowBat: 1 }],
    ['slog_sweep', { cross: 1, low: 1, lowBat: 1, power: 1, up: 0.9 }],
    ['reverse_sweep', { cross: 1, low: 1, lowBat: 1, sense: -1 }],
  ];
  for (const [want, f] of cases) assert.equal(leaderOf(scoreShots(F(f))), want, want + ' from ' + JSON.stringify(f));
});

test('scores: the sweep button makes a low stroke a sweep (slog / reverse as held)', () => {
  const low = { cross: 0.3, low: 1, lowBat: 0.5 };
  assert.equal(leaderOf(scoreShots(F({ ...low, sweep: { k: 1, slog: false, reverse: false } }))), 'sweep');
  assert.equal(leaderOf(scoreShots(F({ ...low, sweep: { k: 1, slog: true, reverse: false } }))), 'slog_sweep');
  assert.equal(leaderOf(scoreShots(F({ ...low, sweep: { k: 1, slog: false, reverse: true } }))), 'reverse_sweep');
  // standing up, the button alone makes it a sweep too (your figure goes down: "he should bend down always")
  for (const [v, want] of [[{ slog: false, reverse: false }, 'sweep'], [{ slog: true, reverse: false }, 'slog_sweep'], [{ slog: false, reverse: true }, 'reverse_sweep']]) {
    const up = scoreShots(F({ power: 1, front: 0.8, sweep: { k: 1, ...v } }));
    assert.equal(leaderOf(up), want);
    for (const n of FAMILIES) if (!/sweep/.test(n)) assert.equal(up[FAMILIES.indexOf(n)], 0, `${n} with the button held`);
  }
  // half-way into the button the sweep already leads a standing drive
  assert.equal(leaderOf(scoreShots(F({ power: 1, front: 0.8, sweep: { k: 0.5, slog: false, reverse: false } }))), 'sweep');
});

test('scores are 0..1 and change smoothly with the features (no step anywhere)', () => {
  let prev = null;
  for (let i = 0; i <= 200; i++) {
    const k = i / 200;
    const s = scoreShots(F({ cross: k, power: 1 - k, front: 1 - 2 * k, dirX: 2 * k - 1, handX: 0.5 * k, low: k * k, lowBat: k }));
    for (const v of s) assert.ok(v >= 0 && v <= 1 + 1e-9, 'score in range');
    if (prev) for (let j = 0; j < s.length; j++) assert.ok(Math.abs(s[j] - prev[j]) < 0.08, `${FAMILIES[j]} jumps at ${k}`);
    prev = s;
  }
});

test('weights: normalised, sharpened toward the best; the leader is favoured (hysteresis)', () => {
  const sc = new Array(FAMILIES.length).fill(0);
  const a = FAMILIES.indexOf('straight_drive'), b = FAMILIES.indexOf('cover_drive');
  sc[a] = 0.5; sc[b] = 0.55;
  const w = new Array(FAMILIES.length);
  // no leader yet: the better score leads
  assert.equal(weighShots(sc, -1, w), b);
  assert.ok(Math.abs(w.reduce((x, y) => x + y, 0) - 1) < 1e-9);
  assert.ok(w[b] > w[a]);
  // the leader keeps it against a slightly better score...
  assert.equal(weighShots(sc, a, w), a);
  // ...but not against one better by more than the hysteresis
  sc[b] = 0.5 * SENSE.stay * 1.05;
  assert.equal(weighShots(sc, a, w), b);
  // nothing scores: no leader, no weights
  assert.equal(weighShots(new Array(FAMILIES.length).fill(0), a, w), -1);
  assert.ok(w.every((x) => x === 0));
});

test('capture time follows the phase: stance -> top of the backlift -> contact -> finish', () => {
  const ev = { top: 0.6, contact: 0.9, finish: 1.4 };
  assert.equal(captureTime(0, ev), 0);
  assert.equal(captureTime(1, ev), 0.6);
  assert.equal(captureTime(2, ev), 0.9);
  assert.equal(captureTime(3, ev), 1.4);
  assert.equal(captureTime(5, ev), 1.4);
  let prev = -1;
  for (let p = 0; p <= 3; p += 0.01) { const u = captureTime(p, ev); assert.ok(u >= prev - 1e-12); prev = u; }
});

test('every scripted stroke is read as its shot, without flicker', () => {
  for (const [name, s] of Object.entries(SHOTS)) {
    const out = read(shotTrack(name));
    const maxE = Math.max(...out.map((o) => o.engage));
    if (!s.want.length) { assert.ok(maxE < 0.05, `${name}: no stroke, engaged ${maxE.toFixed(2)}`); continue; }
    assert.ok(maxE > 0.9, `${name}: the stroke engages the body (${maxE.toFixed(2)})`);
    // the shot shown: the intended family in the end; on the way in (while the swing builds up speed and
    // shape) it may sharpen, a block becoming a drive, a cut a hook, but never to another kind of stroke,
    // and once the body is mostly in the stroke it does not change at all
    const shown = [];
    let settled = null;
    for (const o of out) {
      if (o.engage > 0.15 && o.leader && o.leader !== shown[shown.length - 1]) shown.push(o.leader);
      if (o.engage > 0.7 && o.leader) { if (settled && settled !== o.leader) assert.fail(`${name}: changes from ${settled} to ${o.leader} in the stroke`); settled = o.leader; }
    }
    assert.ok(s.want.includes(shown[shown.length - 1]), `${name}: read as ${shown.join(' -> ')}`);
    assert.ok(shown.length <= 3 && shown.every((n) => KIND[n] === KIND[shown[shown.length - 1]]), `${name}: flickers ${shown.join(' -> ')}`);
    // engagement is smooth, and so is the phase while the stroke is shown (before that it is free to start over)
    for (let i = 1; i < out.length; i++) {
      assert.ok(Math.abs(out[i].engage - out[i - 1].engage) < 0.12, `${name}: engagement jumps at ${out[i].t.toFixed(2)}`);
      if (out[i].engage > 0.05 && out[i - 1].engage > 0.05) assert.ok(Math.abs(out[i].phase - out[i - 1].phase) < 0.2, `${name}: phase jumps at ${out[i].t.toFixed(2)}`);
    }
    // and it lets go afterwards (back in the stance)
    assert.ok(out[out.length - 1].engage < 0.05, `${name}: still engaged at the end`);
  }
});

test('no stroke is read into lifting the bat, walking down the pitch with it, or waggling between balls', () => {
  // a quick pick-up to the top of the backlift and a hold, then back down slowly
  const lift = buildTrack([{ t: 0 }, { t: 0.5 }, { t: 0.7, hand: [0.05, 1.25, -0.78], toe: [0.3, 0.7, 0.65] }, { t: 1.5, hand: [0.05, 1.25, -0.78], toe: [0.3, 0.7, 0.65] }, { t: 3 }, { t: 3.5 }]);
  // walking 1.5 m down the pitch with the bat held still against the body
  const walk = buildTrack([{ t: 0 }, { t: 0.5 }, { t: 2.0, head: [-0.25, 1.58, -2.55], hand: [0.02, 0.85, -2.48] }, { t: 2.6, head: [-0.25, 1.58, -2.55], hand: [0.02, 0.85, -2.48] }]);
  for (const [name, trk] of [['lift', lift], ['walk', walk], ['waggle', shotTrack('waggle')]]) {
    const maxE = Math.max(...read(trk).map((o) => o.engage));
    assert.ok(maxE < 0.05, `${name}: read as a stroke (engage ${maxE.toFixed(2)})`);
  }
  // the same slow block counts when a ball is on its way, not between balls
  const block = SHOTS.forward_defence.keys;
  const live = Math.max(...read(buildTrack(block, { extra: { live: true } })).map((o) => o.engage));
  const idle = Math.max(...read(buildTrack(block, { extra: { live: false } })).map((o) => o.engage));
  assert.ok(live > 0.8 && idle < 0.05, `block: live ${live.toFixed(2)}, between balls ${idle.toFixed(2)}`);
});

test('reader state is plain data: saved mid-stroke and loaded, it carries on exactly the same', () => {
  const trk = shotTrack('cover_drive'), a = new ShotSense(), ref = read(trk, a);
  const b = new ShotSense(), cut = 80;
  read(trk.slice(0, cut), b);
  const c = new ShotSense();
  c.load(JSON.parse(JSON.stringify(b.save())));
  const rest = read(trk.slice(cut), c);
  for (let i = 0; i < rest.length; i++) {
    const r = ref[cut + i], o = rest[i];
    assert.equal(o.state, r.state);
    assert.equal(o.leader, r.leader);
    assert.ok(Math.abs(o.engage - r.engage) < 1e-12 && Math.abs(o.phase - r.phase) < 1e-12);
  }
});

test('a held drive keeps its finish until the player lowers the bat', () => {
  const keys = SHOTS.straight_drive.keys.map(k => ({ ...k, t: k.t >= 2.2 ? k.t + 1.5 : k.t }));
  for (const hz of [30, 72, 120]) {
    const out = read(buildTrack(keys, { hz }));
    const held = out.filter(o => o.t >= 1.8 && o.t <= 3.7);
    assert.ok(held.every(o => o.state === 'follow' && o.engage > 0.9), `drive released during the hold at ${hz} Hz`);
    assert.ok(out.some(o => o.t > 3.7 && o.t < 4.2 && o.state === 'recover'), `no release as the hands came down at ${hz} Hz`);
    assert.ok(out.at(-1).engage < 0.05);
  }
});

test('lowering a drive directly into a wide guard releases the stroke', () => {
  const guard = { t: 1.9, head: [-0.25, 1.52, -1.15], hand: [0.02, 0.8, -1.39], toe: [0.1, -0.95, 0.28], face: [0, 0, -1] };
  const out = read(buildTrack([...SHOTS.straight_drive.keys.slice(0, 7), guard, { ...guard, t: 4 }], { noise: 0 }));
  assert.ok(out.some(o => o.state === 'follow' && o.engage > 0.9));
  assert.equal(out.at(-1).state, 'ready');
});

test('a direct return to the player’s own angled guard ends a drive', () => {
  for (const angle of [35, 45, 55, 75]) {
    const tilt = angle * Math.PI / 180;
    const guard = { head: [-0.25, 1.52, -1.15], hand: [0.02, 0.8, -1.39], toe: [0, -Math.cos(tilt), Math.sin(tilt)], face: [0, 0, -1] };
    const keys = [{ t: 0, ...guard }, { t: 0.6, ...guard }, ...SHOTS.straight_drive.keys.slice(2, 7),
      { t: 1.9, ...guard }, { t: 5, ...guard }];
    const out = read(buildTrack(keys));
    assert.ok(out.some(o => o.state === 'follow' && o.engage > 0.90), `played the drive from a ${angle} degree guard`);
    assert.equal(out.at(-1).state, 'ready', `returned to a ${angle} degree guard`);
  }
});
