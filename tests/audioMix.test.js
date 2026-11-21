// The sound's plain logic (no Web Audio here): the mix's levels and normalisation (mix.js and the
// measured levels.js cover every clip the game plays), the voice pool and budget (pool.js), the
// crowd's mood through a delivery, a six, a review and a close finish (crowdMood.js), where a
// reaction comes from (crowd.js), and how a bat contact sounds (director.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { MIX, REF, classOf, normGain, volGain, groupGains, distanceGain, airCutoff, travelDelay, clipCurve } from '../src/audio/mix.js';
import { LEVELS } from '../src/audio/levels.js';
import { VoicePool, VoiceBudget } from '../src/audio/pool.js';
import { CrowdMood } from '../src/audio/crowdMood.js';
import { Samples } from '../src/audio/samples.js';
import { stand, azimuthOf } from '../src/audio/crowd.js';
import { batKind } from '../src/audio/director.js';

const db = (g) => 20 * Math.log10(g);

test('every clip the bank plays exists and has a measured level', () => {
  for (const n of Samples.names()) {
    const f = n.startsWith('crowd_') && n !== 'crowd_bed' ? `crowd/${n}.ogg` : null;
    const ok = f ? existsSync(new URL(`../assets/audio/${f}`, import.meta.url))
      : existsSync(new URL(`../assets/audio/${n}.ogg`, import.meta.url)) || existsSync(new URL(`../assets/audio/${n}.wav`, import.meta.url));
    assert.ok(ok, `${n} on disk`);
    assert.ok(LEVELS[n], `${n} in levels.js (run tools/audio_levels.py)`);
  }
});

test('normalisation brings each clip to its class reference', () => {
  for (const [n, [m]] of Object.entries(LEVELS)) {
    const g = normGain(n), after = m + db(g);
    if (g > 0.3 && g < 3) assert.ok(Math.abs(after - REF[classOf(n)]) < 0.05, `${n}: ${after.toFixed(2)}`);
  }
  assert.equal(classOf('crowd_ooh_1'), 'crowd');
  assert.equal(classOf('crowd_bed'), 'bed');
  assert.equal(classOf('bat_sweet_2'), 'bat');
  assert.equal(classOf('gloves'), 'impact');
  assert.equal(classOf('drs_stinger'), 'ui');
  assert.equal(normGain('no_such_clip'), 1);
});

test('volume steppers: squared, sound off silences the master, groups keep their balance', () => {
  assert.equal(volGain(1), 1); assert.equal(volGain(0), 0);
  assert.ok(Math.abs(db(volGain(0.5)) + 12.04) < 0.01);
  assert.equal(volGain(NaN), 1); assert.equal(volGain(2), 1);
  const g = groupGains({});
  assert.equal(g.master, MIX.master);
  assert.equal(groupGains({ sound: false }).master, 0);
  assert.ok(g.voice > g.crowd, 'the commentary sits over the crowd');
  assert.ok(g.ui < g.fx, 'the menu is quieter than the game');
  const h = groupGains({ volCrowd: 0.5, volCommentary: 0 });
  assert.ok(Math.abs(h.crowd - g.crowd * 0.25) < 1e-9);
  assert.equal(h.voice, 0); assert.equal(h.fx, g.fx);
  assert.ok(MIX.duck.crowd < 1 && MIX.duck.crowd > 0.5, 'a duck, not a mute');
});

test('distance: near is full, the keeper at 20 m still heard, the air dulls far sounds, sound arrives late', () => {
  assert.equal(distanceGain(1), 1);
  const k = db(distanceGain(20));
  assert.ok(k > -14 && k < -8, `keeper ${k.toFixed(1)} dB`);
  assert.ok(db(distanceGain(65)) > -25, 'the boundary still audible');
  assert.ok(airCutoff(2) === 20000 && airCutoff(65) < 6000 && airCutoff(500) >= 2200);
  assert.equal(travelDelay(5), 0);
  assert.ok(Math.abs(travelDelay(65) - 0.19) < 0.01);
});

test('the soft clip is linear below its knee and never reaches full scale', () => {
  const c = clipCurve(1025);
  const at = (x) => c[Math.round((x + 1) / 2 * 1024)];
  assert.ok(Math.abs(at(0.5) - 0.5) < 0.002);
  assert.ok(Math.abs(at(-0.5) + 0.5) < 0.002);
  assert.ok(at(1) < 0.99 && at(1) > MIX.clip, `full scale -> ${at(1).toFixed(3)}`);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1], 'monotonic');
});

test('voice pool: free slots first, then the one ending soonest, never stealing from louder', () => {
  const p = new VoicePool(3, (i) => ({ id: i }));
  const a = p.acquire(0, 1, 1), b = p.acquire(0, 2, 1), c = p.acquire(0, 3, 2);
  assert.deepEqual([a.i, b.i, c.i], [0, 1, 2]);
  assert.equal(p.busy(0.5), 3);
  const d = p.acquire(0.5, 1, 1);
  assert.equal(d.i, 0, 'the one ending soonest');
  assert.equal(p.acquire(0.5, 1, 0), null, 'ambience does not take a slot from the game');
  assert.equal(p.acquire(1.6, 1, 0).i, 0, 'a slot whose sound is over is free');
  assert.equal(p.slots[0].node.id, 0);
  // Free slots: the one last used nearest the new sound (no long glide of its HRTF).
  const q = new VoicePool(3);
  q.acquire(0, 0.1, 1, { x: 0, y: 1, z: 0 }); q.acquire(0, 0.1, 1, { x: 0, y: 0, z: -10 }); q.acquire(0, 0.1, 1, { x: 30, y: 0, z: -40 });
  assert.equal(q.acquire(1, 0.1, 1, { x: 0.3, y: 0, z: -9 }).i, 1, 'the pitch slot for a bounce');
  assert.equal(q.acquire(1, 0.1, 1, { x: 0.2, y: 1, z: -0.5 }).i, 0, 'the batter slot for the bat');
});

test('voice budget: caps one-shots, keeps room for the game, frees as sounds end', () => {
  const v = new VoiceBudget(24);
  let n = 0;
  for (let i = 0; i < 40; i++) if (v.admit(0, 1, 1)) n++;
  assert.equal(n, 24);
  assert.equal(v.admit(0, 1, 0), false, 'ambience dropped when full');
  assert.equal(v.admit(0, 1, 2), true, 'the bat always sounds');
  for (let i = 0; i < 20; i++) v.admit(0, 1, 2);
  assert.equal(v.count(0), 32, 'up to the hard cap');
  assert.equal(v.admit(2, 1, 1), true, 'room again once they end');
  assert.equal(v.count(2), 1);
});

const run = (m, secs, dt = 1 / 60) => { for (let t = 0; t < secs; t += dt) m.update(dt); return m.out; };

test('crowd mood: building through the run-up, the held breath at the release, back up after', () => {
  const m = new CrowdMood();
  const idle = run(m, 5).bed;
  m.cue('runup');
  const runup = run(m, 2.4).bed;
  assert.ok(runup > idle * 1.1, `builds ${idle.toFixed(2)} -> ${runup.toFixed(2)}`);
  assert.ok(m.out.hush > 0.4, 'no whistles as he runs in');
  m.cue('release');
  const held = run(m, 0.6).bed;
  assert.ok(held < idle * 0.7, `the held breath ${held.toFixed(2)}`);
  m.cue('hit');
  run(m, 2);
  m.cue('ball');
  const after = run(m, 4).bed;
  assert.ok(after > held * 1.5 && Math.abs(after - idle) < 0.25 * idle);
  assert.ok(m.out.hush < 0.2);
});

test('crowd mood: a six swells the roar fast and it dies away over seconds; a dot barely moves it', () => {
  const m = new CrowdMood();
  run(m, 3);
  const base = m.out.roar;
  m.react('six', 1);
  const peak = run(m, 0.5).roar;
  assert.ok(peak > 0.6, `roar ${peak.toFixed(2)}`);
  const later = run(m, 10).roar;
  assert.ok(later < 0.25 && later > base, `decays to ${later.toFixed(2)}`);
  const m2 = new CrowdMood();
  run(m2, 3); m2.react('dot', 1);
  assert.ok(run(m2, 0.5).roar < 0.12);
  assert.ok(m.excite > m2.excite, 'a six leaves the ground livelier');
  const m3 = new CrowdMood(); m3.react('wicketAgainst', 1);
  assert.ok(m3.excite < new CrowdMood().excite, 'your wicket deflates the home crowd');
});

test('crowd mood: a review hushes the ground; nets and menus are quieter', () => {
  const m = new CrowdMood();
  const idle = run(m, 4).bed;
  m.cue('review');
  assert.ok(run(m, 2).bed < idle * 0.7);
  m.cue('review_result');
  assert.ok(run(m, 3).bed > idle * 0.9);
  const n = new CrowdMood(); n.practice = true;
  assert.ok(run(n, 4).bed < idle * 0.6 && n.out.detail < 0.5);
});

test('crowd mood: tension rises in a close finish, not in a lost cause or a stroll', () => {
  const m = new CrowdMood();
  const close = m.situation({ target: 40, runs: 31, balls: 26, ballsLimit: 30 });     // 9 off 4
  const early = m.situation({ target: 40, runs: 5, balls: 3, ballsLimit: 30 });
  const lost = m.situation({ target: 40, runs: 10, balls: 27, ballsLimit: 30 });      // 30 off 3
  const stroll = m.situation({ target: 40, runs: 39, balls: 10, ballsLimit: 30 });    // 1 off 20
  assert.ok(close > 0.6, `close ${close.toFixed(2)}`);
  assert.ok(early < 0.1 && lost < 0.1 && stroll < 0.4, `${early} ${lost} ${stroll}`);
  assert.equal(m.situation({ runs: 10 }), 0, 'batting first: no chase');
  m.situation({ target: 40, runs: 31, balls: 26, ballsLimit: 30 });
  const calm = new CrowdMood();
  calm.cue('runup'); m.cue('runup');
  assert.ok(run(m, 2.4).bed > run(calm, 2.4).bed, 'the run-up builds more when it is tight');
});

test('reactions come from where the ball went; near the square, from all round', () => {
  assert.equal(azimuthOf({ x: 1, z: -8 }), null);
  assert.equal(azimuthOf(null), null);
  const a = azimuthOf({ x: 60, z: -10 });
  const p = stand(a, 58);
  assert.ok(p.x > 50 && Math.abs(p.z + 10) < 1, 'square leg side: from that stand');
  const s = stand(azimuthOf({ x: 0, z: -75 }), 58);
  assert.ok(s.z < -60, 'straight back over the bowler');
});

test('bat contacts by quality, speed and where on the bat', () => {
  assert.equal(batKind({ quality: 0.9, batSpeed: 20, face: 'front' }), 'sweet');
  assert.equal(batKind({ quality: 0.3, batSpeed: 20, face: 'front' }), 'mistimed');
  assert.equal(batKind({ quality: 0.4, batSpeed: 2, face: 'front' }), 'block');
  assert.equal(batKind({ quality: 0.9, batSpeed: 20, face: 'front', isEdge: true }), 'edge');
  assert.equal(batKind({ quality: 0.06, batSpeed: 20, face: 'toe' }), 'toe');
  assert.equal(batKind({ quality: 0.05, face: 'handle' }), 'handle');
});
