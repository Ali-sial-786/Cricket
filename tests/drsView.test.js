// The DRS view's sequence (src/render/drsView.js) with a stand-in canvas:
// on-field call -> Snicko (frames stepped, slowest at the bat) -> Hot Spot ->
// (LBW) ball tracking -> decision; bat first skips tracking; skip() ends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// A 2D context that draws nothing (every call is accepted).
function fakeCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(o, k) {
      if (k in o) return o[k];
      if (k === 'measureText') return (t) => ({ width: String(t).length * 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      return () => {};
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx(), toDataURL: () => '' }) };

const THREE = await import('three');
const { DRSView } = await import('../src/render/drsView.js');
const { ContactLog, edgeEvidence } = await import('../src/game/edgeTrack.js');
const { CONFIG } = await import('../src/config.js');
const { reviewOutcome } = await import('../src/game/lbw.js');

const G = { bladeHalf: { x: 0.07, z: 0.025 }, toeY: -0.79, shoulderY: -0.18, handleTopY: 0.12, sweetY: -0.62, faceZ: 0.025, handleRadius: 0.017 };
function log({ edge = true, pad = null }) {
  const L = new ContactLog(CONFIG);
  L.launchT = 0;
  for (let i = -60; i <= 60; i++) {
    const t = 0.5 + i / 960;
    L.frames.push({ t, x: 0.1, y: 0.4, z: -1.2 + 30 * (t - 0.5), lx: 0.1, ly: -0.55, lz: -30 * (t - 0.5), d: Math.abs(30 * (t - 0.5)), ax: -1, px: 0, py: 0.9, pz: -1.2, qx: 0, qy: 1, qz: 0, qw: 0 });
  }
  if (edge) L.addBat({ t: 0.5, face: 'side', part: 'blade', local: { x: 0.1, y: -0.55, z: 0.02 }, speedIn: 30 }, G, null, { x: -1, y: 0, z: 0 });
  if (pad != null) L.addPad({ t: pad, pos: { x: 0, y: 0.4, z: -1.15 }, vin: { x: 0, y: 0, z: 30 }, at: { x: 0, z: -1.1, halfX: 0.2 } });
  return L;
}
const viewer = new THREE.Vector3(0, 1.6, -0.6);

function play(drs, dt = 1 / 60, max = 30) {
  const seen = [];
  let last = null;
  for (let t = 0; t < max && !drs.done; t += dt) {
    drs.update(dt);
    const tag = `${drs.phase}${drs._stage ? ':' + drs._stage : ''}`;
    if (tag !== last) { seen.push({ tag, t: +t.toFixed(2) }); last = tag; }
  }
  return seen;
}

test('caught: on-field call, Snicko stepped frame by frame, Hot Spot, decision', () => {
  const scene = new THREE.Scene(), drs = new DRSView(scene);
  const ev = edgeEvidence(log({ edge: true }), { review: 'caught' });
  drs.startCaught({ edge: ev, onFieldOut: false, outcome: { out: true, reviewKept: true, rows: ev.rows }, viewerPos: viewer });
  assert.deepEqual(drs._rows.map((r) => `${r.label}:${r.colour}`), ['ON-FIELD CALL:white', 'SNICKO:red', 'HOT SPOT:red']);
  assert.equal(drs.screen.visible, false);
  // the screen is beside the board, toward the middle of the pitch
  const b = drs.board.getWorldPosition(new THREE.Vector3()), s = drs.screen.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(s.x) < Math.abs(b.x), `screen x ${s.x} board x ${b.x}`);
  // how long each frame is held: longest on the ball at the bat
  const frameT = drs._events.filter((e) => e.type === 'frame').map((e) => e.t);
  const holds = frameT.slice(1).map((t, i) => t - frameT[i]);
  const k0 = ev.trace.frames.findIndex((f) => Math.abs(f - ev.trace.tc) < 1e-9);
  assert.equal(holds.indexOf(Math.max(...holds)), k0);
  const seq = play(drs).map((x) => x.tag);
  assert.deepEqual(seq.filter((x, i) => seq.indexOf(x) === i), ['intro', 'snicko:snicko', 'hotspot:hotspot', 'decision:hotspot', 'done:hotspot']);
  assert.deepEqual(drs.result, { kind: 'caught', out: true, umpiresCall: false, reviewKept: true });
  assert.ok(drs._outcome.sub.includes('DECISION OVERTURNED'));
  drs.hide();
  assert.equal(drs.screen.visible, false);
});

test('LBW: bat first ends after Hot Spot, NOT OUT, no tracking; no bat: tracking as before', () => {
  const plumb = { fullToss: false, pitching: 'in_line', impact: 'in_line', wickets: 'hitting', pitchPos: { x: 0, y: 0.036, z: -5 }, impactPos: { x: 0, y: 0.4, z: -1.15 }, stumpsPos: { x: 0, y: 0.3 }, projectionValid: true, path: [{ x: 0, y: 0.4, z: -1.15 }, { x: 0, y: 0.3, z: 0 }] };
  const scene = new THREE.Scene(), drs = new DRSView(scene);
  const ev = edgeEvidence(log({ edge: true, pad: 0.505 }), { review: 'lbw' });
  const outcome = reviewOutcome(plumb, { onFieldOut: true, batFirst: true, edgeRows: ev.rows, batText: 'INSIDE EDGE FIRST' });
  drs.startLbw({ track: plumb, onFieldOut: true, outcome, viewerPos: viewer, edge: ev });
  assert.deepEqual(drs._rows.map((r) => r.label), ['ON-FIELD CALL', 'SNICKO', 'HOT SPOT', 'BAT']);
  const seq = play(drs).map((x) => x.tag);
  assert.ok(!seq.some((x) => x.startsWith('tracking')), seq.join(' '));
  assert.equal(drs.result.out, false);
  // no edge stage: the old 10.6 s tracking sequence, the screen never up
  const drs2 = new DRSView(new THREE.Scene());
  drs2.startLbw({ track: plumb, onFieldOut: false, outcome: reviewOutcome(plumb, { onFieldOut: false }), viewerPos: viewer });
  const seq2 = play(drs2);
  assert.deepEqual(seq2.map((x) => x.tag), ['intro', 'tracking', 'pitching', 'impact', 'wickets', 'decision', 'done']);
  assert.ok(Math.abs(seq2[seq2.length - 1].t - 10.6) < 0.05);
  assert.equal(drs2.result.out, true);
  // with the edge checks but no bat first: tracking comes after Hot Spot
  const drs3 = new DRSView(new THREE.Scene());
  const ev3 = edgeEvidence(log({ edge: false, pad: 0.5 }), { review: 'lbw' });
  drs3.startLbw({ track: plumb, onFieldOut: false, outcome: reviewOutcome(plumb, { onFieldOut: false, edgeRows: ev3.rows }), viewerPos: viewer, edge: ev3 });
  const seq3 = play(drs3).map((x) => x.tag);
  assert.ok(seq3.indexOf('hotspot:hotspot') < seq3.indexOf('tracking'), seq3.join(' '));
  // skip: straight to the result, only the result cue
  const drs4 = new DRSView(new THREE.Scene());
  drs4.startCaught({ edge: edgeEvidence(log({ edge: true }), { review: 'caught' }), onFieldOut: true, viewerPos: viewer });
  drs4.takeCues();
  drs4.skip();
  assert.equal(drs4.done, true);
  assert.deepEqual(drs4.takeCues(), ['out']);
});
