// The batting shots from motion capture (assets/anim/shots.*, built by tools/build_shots.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('assets/anim/shots.json', root), 'utf8'));
const buf = fs.readFileSync(new URL('assets/anim/shots.bin', root));
const q = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
const TYPES = ['drive', 'defend', 'backdef', 'pull', 'cut', 'flick', 'sweep', 'slog', 'reverse'];

test('shot asset matches the 17-bone rig and is small', () => {
  const athlete = JSON.parse(fs.readFileSync(new URL('assets/models/athlete.json', root), 'utf8'));
  assert.deepEqual(meta.bones, athlete.bones);
  assert.equal(meta.stride, 17 * 4 + 3);
  assert.equal(q.length, meta.shots.reduce((s, c) => s + c.frames, 0) * meta.stride);
  assert.ok(buf.byteLength < 400 * 1024);
  assert.ok(meta.shots.length >= 2);
});

test('every kept shot has a type, ordered events and footwork', () => {
  for (const s of meta.shots) {
    assert.ok(TYPES.includes(s.type), s.name);
    assert.ok(['front', 'back', 'neutral'].includes(s.foot), s.name);
    const e = s.events;
    assert.ok(e.stance === 0 && e.stance < e.top && e.top < e.contact && e.contact < e.finish && e.finish <= s.dur + 1e-6, s.name);
    assert.ok(Math.abs(s.dur - (s.frames - 1) / s.fps) < 1e-3, s.name);
    for (const k of ['stance', 'contact']) for (const f of ['L', 'R']) assert.equal(s.feet[k][f].length, 2);
    // a right-hander's front (left) foot is the one toward the bowler (+X)
    assert.ok(s.feet.stance.L[0] > s.feet.stance.R[0], s.name);
    assert.ok(s.why.length > 0, s.name);
  }
  const types = meta.shots.map((s) => s.type);
  assert.ok(types.includes('drive') && types.includes('pull'));
});

test('cleaned frames: unit quaternions, continuous, feet on the floor and planted feet still', () => {
  for (const s of meta.shots) {
    for (let f = 0; f < s.frames; f++) {
      for (let k = 0; k < 17; k++) {
        const o = s.offset + f * meta.stride + k * 4;
        const n = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]) / meta.qScale;
        assert.ok(Math.abs(n - 1) < 2e-3, `${s.name} f${f} b${k}`);
        if (f > 0) {
          const p = o - meta.stride;
          const dot = (q[o] * q[p] + q[o + 1] * q[p + 1] + q[o + 2] * q[p + 2] + q[o + 3] * q[p + 3]) / meta.qScale ** 2;
          assert.ok(dot > 0.7, `${s.name} f${f} b${k} jumps (dot ${dot.toFixed(3)})`);
        }
      }
    }
    assert.ok(s.check.footLow > -0.01, `${s.name} foot through the floor`);
    assert.ok(s.check.plantedSlide < 0.01, `${s.name} planted foot slides ${s.check.plantedSlide}`);
    assert.equal(s.contact.L.length, s.frames);
    for (let f = 0; f < s.frames; f++) assert.ok(s.contact.L[f] === '1' || s.contact.R[f] === '1', `${s.name} f${f}: nobody standing`);
  }
});

test('rejected windows are listed with reasons', () => {
  assert.ok(meta.rejected.length > 0);
  for (const r of meta.rejected) assert.ok(r.why.length > 0 && typeof r.t === 'number');
});
