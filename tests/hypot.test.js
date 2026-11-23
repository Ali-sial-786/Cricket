// hypot2 / hypot3 (the allocation-free stand-ins for Math.hypot in the
// per-frame loops) give exactly what Math.hypot gives, bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hypot2, hypot3, makeRng } from '../src/physics/math.js';

const EDGE = [0, -0, 1, -1, 3, -4, 1e-310, 1e-300, 1e300, 1.7e308, Infinity, -Infinity, NaN, 0.1, 2 / 3];

test('hypot2 is Math.hypot of two numbers, bit for bit', () => {
  for (const a of EDGE) for (const b of EDGE) assert.ok(Object.is(hypot2(a, b), Math.hypot(a, b)), `${a}, ${b}`);
  const r = makeRng(17);
  for (let i = 0; i < 200000; i++) {
    const s = Math.pow(10, (r() - 0.5) * 12), a = (r() - 0.5) * s, b = (r() - 0.5) * s * (r() < 0.5 ? 1 : r() * 1e-4);
    if (hypot2(a, b) !== Math.hypot(a, b)) assert.fail(`${a}, ${b}: ${hypot2(a, b)} vs ${Math.hypot(a, b)}`);
  }
});

test('hypot3 is Math.hypot of three numbers, bit for bit', () => {
  for (const a of EDGE) for (const b of EDGE) for (const c of EDGE) assert.ok(Object.is(hypot3(a, b, c), Math.hypot(a, b, c)), `${a}, ${b}, ${c}`);
  const r = makeRng(23);
  for (let i = 0; i < 200000; i++) {
    const s = Math.pow(10, (r() - 0.5) * 12), a = (r() - 0.5) * s, b = (r() - 0.5) * s * r(), c = (r() - 0.5) * s * (r() < 0.5 ? 1 : r() * 1e-4);
    if (hypot3(a, b, c) !== Math.hypot(a, b, c)) assert.fail(`${a}, ${b}, ${c}: ${hypot3(a, b, c)} vs ${Math.hypot(a, b, c)}`);
  }
});

test('distGT / distGE / distLT answer exactly as the hypot comparisons do, on the line and off it', async () => {
  const { distGT, distGE, distLT } = await import('../src/physics/math.js');
  const r = makeRng(29);
  const check = (dx, dz, R) => {
    const h = Math.hypot(dx, dz);
    if (distGT(dx, dz, R) !== (h > R) || distGE(dx, dz, R) !== (h >= R) || distLT(dx, dz, R) !== (h < R)) assert.fail(`${dx}, ${dz}, ${R}`);
  };
  for (const a of EDGE) for (const b of EDGE) for (const R of [0, 1e-6, 0.4, 1, 4, 1e300, Infinity, NaN]) check(a, b, R);
  for (let i = 0; i < 200000; i++) {
    const dx = (r() - 0.5) * 20, dz = (r() - 0.5) * 20, h = Math.hypot(dx, dz);
    // on the line exactly, a hair either side, and anywhere
    check(dx, dz, h); check(dx, dz, h * (1 + 2 ** -52)); check(dx, dz, h * (1 - 2 ** -53)); check(dx, dz, h * (1 + 1e-10)); check(dx, dz, r() * 15);
  }
});
