// The retargeted animation clips (assets/anim, built by tools/build_clips.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('assets/anim/clips.json', root), 'utf8'));
const buf = fs.readFileSync(new URL('assets/anim/clips.bin', root));
const q = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
const clip = (n) => meta.clips.find((c) => c.name === n);

test('clip asset matches the 17-bone rig and is compact', () => {
  const athlete = JSON.parse(fs.readFileSync(new URL('assets/models/athlete.json', root), 'utf8'));
  assert.deepEqual(meta.bones, athlete.bones);
  assert.equal(meta.stride, 17 * 4 + 3);
  const frames = meta.clips.reduce((s, c) => s + c.frames, 0);
  assert.equal(q.length, frames * meta.stride);
  assert.ok(buf.byteLength < 600 * 1024);
});

test('every clip the renderer uses is present, with sane timing', () => {
  for (const n of ['idle', 'idle_fold_arms', 'walk', 'jog', 'sprint', 'set', 'throw', 'cheer', 'sad']) {
    const c = clip(n);
    assert.ok(c, n);
    assert.ok(c.dur > 0.3 && c.dur < 4, n);
    assert.ok(Math.abs(c.frames - (c.loop ? 0 : 1) - c.dur * c.fps) < 0.01, n);
  }
  const t = clip('throw');
  assert.equal(t.events.hand, 'R');
  assert.ok(t.events.release > 0.2 && t.events.release < 0.6);
});

test('quaternions are unit length and frames are continuous', () => {
  for (const c of meta.clips) {
    for (let f = 0; f < c.frames; f++) {
      for (let k = 0; k < 17; k++) {
        const o = c.offset + f * meta.stride + k * 4;
        const n = Math.hypot(q[o], q[o + 1], q[o + 2], q[o + 3]) / meta.qScale;
        assert.ok(Math.abs(n - 1) < 2e-3, `${c.name} f${f} b${k}`);
        if (f > 0) {
          const p = o - meta.stride;
          const dot = (q[o] * q[p] + q[o + 1] * q[p + 1] + q[o + 2] * q[p + 2] + q[o + 3] * q[p + 3]) / meta.qScale ** 2;
          assert.ok(dot > 0.75, `${c.name} f${f} b${k} jumps (dot ${dot.toFixed(3)})`);
        }
      }
    }
  }
});

test('locomotion clips get faster and cover more ground per cycle', () => {
  const w = clip('walk'), j = clip('jog'), s = clip('sprint');
  assert.ok(w.speed < j.speed && j.speed < s.speed);
  assert.ok(w.stride < j.stride && j.stride < s.stride);
  for (const c of [w, j, s]) {
    assert.ok(c.loop);
    assert.ok(c.phase0 >= 0 && c.phase0 < 1);
    assert.ok(Math.abs(c.stride - c.speed * c.dur) < 1e-3);
  }
  // On a 0.79 m leg: a walk under 1.3 m/s, a sprint of 7-9 m/s.
  assert.ok(w.speed * 0.786 < 1.3 && s.speed * 0.786 > 7 && s.speed * 0.786 < 9);
});
