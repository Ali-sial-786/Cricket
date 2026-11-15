// Your figure's feet (src/render/footwork.js): planted feet never slide, they
// step (one at a time, lifted and put down) when your head goes further than
// a body reaches, small moves never shuffle them, walking down the pitch is
// real steps, a sweep puts the back knee down behind, and no foot is ever in
// the stumps. Pure JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Footwork, FEET } from '../src/render/footwork.js';

const DT = 1 / 72;
// Drive the planner along a head path: head(t) -> { hx, hz, crouch?, kneel?, ... }. Returns per-frame feet.
function drive(path, T, extra = {}, fw = new Footwork()) {
  const out = [];
  for (let i = 0; i * DT <= T + 1e-9; i++) {
    const t = i * DT, p = path(t);
    const o = fw.update(DT, { quiet: 0, engage: 0, pat: null, kneel: 0, maxStride: 1, stumpsZ: 0, ...extra, ...p });
    out.push({ t, L: { ...o.L }, R: { ...o.R }, steps: o.steps });
  }
  return out;
}
const smooth = (a, b, k) => a + (b - a) * (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

// A planted foot (down and not stepping in two frames running) does not move along the turf.
function assertNoSlide(out, what) {
  for (let i = 1; i < out.length; i++) for (const sd of ['L', 'R']) {
    const a = out[i - 1][sd], b = out[i][sd];
    if (!a.moving && !b.moving) assert.ok(Math.hypot(b.x - a.x, b.z - a.z) < 1e-9, `${what}: ${sd} slides at ${out[i].t.toFixed(2)}`);
    if (b.moving) assert.ok(b.y >= 0 && b.y <= FEET.lift + FEET.liftMore + 1e-9, `${what}: ${sd} lifted ${b.y}`);
  }
}

test('standing still and swaying a little: the feet stay put (no shuffling)', () => {
  const out = drive((t) => ({ hx: -0.25 + 0.04 * Math.sin(t * 3), hz: -1.05 + 0.05 * Math.sin(t * 2.1), crouch: 0.03 + 0.03 * Math.sin(t * 1.3) }), 6);
  const steps = out[out.length - 1].steps;
  assert.ok(steps <= 0, `stepped ${steps} times`);
  assertNoSlide(out, 'sway');
  // a side-on stance: back foot behind the head, front foot ahead of it, astride the line of the head
  const { L, R } = out[out.length - 1];
  assert.ok(L.z < -1.05 && R.z > -1.05, 'front foot toward the bowler, back foot behind');
  assert.ok(R.z - L.z > FEET.minApart && R.z - L.z < 0.7, 'a stance width apart');
});

test('a stride forward: the front foot steps out, the back foot stays; the feet step, never slide', () => {
  // (a stride: forward and down, at a lunge's pace; quicker and upright is walking, and the back foot comes too)
  const out = drive((t) => ({ hx: -0.25, hz: smooth(-1.05, -1.42, (t - 0.5) / 0.7), crouch: smooth(0.02, 0.12, (t - 0.5) / 0.7) }), 2);
  assertNoSlide(out, 'stride');
  const a = out[0], b = out[out.length - 1];
  assert.ok(b.L.z < a.L.z - 0.2, `front foot strides (${a.L.z.toFixed(2)} -> ${b.L.z.toFixed(2)})`);
  assert.ok(Math.abs(b.R.z - a.R.z) < 1e-9, 'back foot stays planted');
});

test('walking 1.5 m down the pitch: real steps, never crossed, never further apart than a stride', () => {
  const out = drive((t) => ({ hx: -0.25, hz: smooth(-1.05, -2.6, (t - 0.4) / 1.2) }), 2.6);
  assertNoSlide(out, 'walk');
  const b = out[out.length - 1];
  assert.ok(b.steps >= 4, `${b.steps} steps`);
  assert.ok(b.L.z < -2.4 && b.R.z < -2.0, 'both feet came along');
  for (const o of out) {
    assert.ok(o.L.z < o.R.z, `crossed at ${o.t.toFixed(2)}`);
    assert.ok(Math.hypot(o.L.x - o.R.x, o.L.z - o.R.z) <= FEET.maxStride + 0.03, `over-stride at ${o.t.toFixed(2)}`);   // (a landing spot is held to the other foot's, which may itself be stepping)
  }
});

test('back and across: the back foot goes back first, the front follows; no foot in the stumps', () => {
  const out = drive((t) => ({ hx: smooth(-0.25, -0.05, (t - 0.4) / 0.4), hz: smooth(-1.05, -0.35, (t - 0.4) / 0.5) }), 2.5);
  assertNoSlide(out, 'back');
  const firstR = out.findIndex((o) => o.R.moving), firstL = out.findIndex((o) => o.L.moving);
  assert.ok(firstR >= 0 && (firstL < 0 || firstR <= firstL), 'the back foot moves first');
  for (const o of out) for (const f of [o.L, o.R]) {
    const inX = Math.abs(f.x) < FEET.stumpX, inZ = Math.abs(f.z) < FEET.stumpZ;
    assert.ok(!(inX && inZ), `a foot in the stumps at ${o.t.toFixed(2)} (${f.x.toFixed(2)}, ${f.z.toFixed(2)})`);
  }
});

test('right down for a sweep: the back foot trails behind for the knee, the front foot ahead', () => {
  const out = drive((t) => ({ hx: -0.24, hz: smooth(-1.05, -1.5, (t - 0.3) / 0.4), crouch: smooth(0.02, 0.45, (t - 0.3) / 0.4), kneel: smooth(0, 1, (t - 0.45) / 0.3) }), 1.8);
  assertNoSlide(out, 'sweep');
  const { L, R } = out[out.length - 1];
  assert.ok(R.z - (-1.5) > 0.3, `back foot trails behind the head (${R.z.toFixed(2)})`);
  assert.ok(L.z < -1.5 + 0.05, `front foot ahead (${L.z.toFixed(2)})`);
});

test('a stroke: the feet do what the capture\'s do, once, from where they were', () => {
  const pat = { Lx: 0.05, Lz: -0.3, Rx: 0, Rz: 0, yawL: 0.3, yawR: 0 };
  const fw = new Footwork();
  drive(() => ({ hx: -0.25, hz: -1.05 }), 1, {}, fw);
  const before = { ...fw.s.L };
  const out = drive((t) => ({ hx: -0.25, hz: smooth(-1.05, -1.3, t / 0.3), engage: smooth(0, 1, t / 0.2), pat }), 1.5, {}, fw);
  assertNoSlide(out, 'stroke');
  const after = out[out.length - 1].L;
  assert.ok(after.z < before.z - 0.15, `front foot strode with the shot (${before.z.toFixed(2)} -> ${after.z.toFixed(2)})`);
  assert.ok(after.yaw > before.yaw + 0.1, 'and turned out');
});

test('the hips opening in a stroke turn the back foot round (pivot), in place', () => {
  const fw = new Footwork();
  drive(() => ({ hx: -0.25, hz: -1.05 }), 1, {}, fw);
  const R0 = { ...fw.s.R };
  const out = drive((t) => ({ hx: -0.25, hz: -1.05, engage: 1, turn: smooth(0, 2, t / 0.3) }), 1, {}, fw);
  const R1 = out[out.length - 1].R;
  assert.ok(R1.yaw > R0.yaw + 1, `back foot pivots (${R0.yaw.toFixed(2)} -> ${R1.yaw.toFixed(2)})`);
  assert.ok(R1.yaw <= FEET.yawMaxR + 1e-9);
  assert.ok(Math.hypot(R1.x - R0.x, R1.z - R0.z) < 1e-9, 'on the spot');
});

test('turned round on the spot with the stick: the feet step round one after the other, never slide or spin', () => {
  const turn = (t) => smooth(0, Math.PI, (t - 0.3) / 1.6);
  const out = drive((t) => ({ hx: -0.25, hz: -1.05, heading: turn(t) }), 2.6);
  assertNoSlide(out, 'turn');
  let spin = 0, last = null, alt = 0;
  for (let i = 1; i < out.length; i++) for (const sd of ['L', 'R']) {
    const a = out[i - 1][sd], b = out[i][sd];
    if (!a.moving && !b.moving) spin = Math.max(spin, Math.abs(b.yaw - a.yaw));
    if (b.moving && !a.moving) { if (last && last !== sd) alt++; last = sd; }
  }
  assert.ok(spin < 0.035, `a planted foot spins ${(spin * 57.3).toFixed(1)} deg in a frame`);
  assert.ok(alt >= 3, 'the feet take turns');
  // turned round: the stance faces the other way (back foot toward the bowler now), the feet pointing round with it
  const { L, R } = out[out.length - 1];
  assert.ok(R.z < L.z, 'back foot now on the bowler\'s side');
  assert.ok(Math.abs(Math.cos(L.yaw - Math.PI)) > 0.8 && Math.abs(Math.cos(R.yaw - Math.PI)) > 0.8, 'feet turned round');
});

test('the rig put back (a jump in the turn): the feet go round with it at once', () => {
  const fw = new Footwork();
  drive(() => ({ hx: -0.25, hz: -1.05, heading: 0 }), 0.6, {}, fw);
  const o = fw.update(DT, { hx: -0.25, hz: -1.05, heading: Math.PI / 2, quiet: 0, engage: 0, kneel: 0, stumpsZ: 0 });
  assert.ok(!o.L.moving && !o.R.moving, 'no steps');
  // (the back foot was F.back behind the head and a little to the leg side: a quarter turn puts it on the off side of the head)
  const dx = o.R.x - -0.25, dz = o.R.z - -1.05;
  assert.ok(Math.abs(dx - FEET.back) < 0.03 && Math.abs(dz) < 0.15, `carried round about the head (${dx.toFixed(2)}, ${dz.toFixed(2)})`);
  assert.ok(Math.abs(o.R.yaw - (Math.PI / 2 - 0.04)) < 0.05, 'and turned with it');
});

test('moved far in one go (the rig was moved): the feet are put there, not walked', () => {
  const fw = new Footwork();
  drive(() => ({ hx: -0.25, hz: -1.05 }), 0.5, {}, fw);
  const o = fw.update(DT, { hx: -0.25, hz: -20, quiet: 0, engage: 0, kneel: 0, stumpsZ: 0 });
  assert.ok(Math.abs(o.L.z - (-20 - FEET.front)) < 1e-9 && Math.abs(o.R.z - (-20 + FEET.back)) < 1e-9);
  assert.ok(!o.L.moving && !o.R.moving);
});

test('planner state is plain data: saved and loaded mid-step it carries on the same', () => {
  const path = (t) => ({ hx: -0.25, hz: smooth(-1.05, -2.2, (t - 0.2) / 1.0) });
  const a = drive(path, 1.6);
  const fw = new Footwork();
  const first = drive(path, 0.7, {}, fw);
  const fw2 = new Footwork();
  fw2.load(JSON.parse(JSON.stringify(fw.save())));
  const rest = [];
  for (let i = first.length; i * DT <= 1.6 + 1e-9; i++) { const o = fw2.update(DT, { quiet: 0, engage: 0, pat: null, kneel: 0, maxStride: 1, stumpsZ: 0, ...path(i * DT) }); rest.push(o); }
  for (let i = 0; i < rest.length; i++) {
    const r = a[first.length + i], o = rest[i];
    assert.ok(Math.abs(o.L.z - r.L.z) < 1e-12 && Math.abs(o.R.z - r.R.z) < 1e-12 && Math.abs(o.L.y - r.L.y) < 1e-12);
  }
});
