// The sound engine (Web Audio). The mix (mix.js): crowd, effects, commentary and UI groups into a
// master with headroom, a limiter and a soft clip, the crowd group ducked under the commentators.
// 3-D sound: pooled panner chains (gain -> air lowpass -> panner: HRTF for the effects near you,
// equal-power for the stands), the listener following your head every frame (listen()). And the
// synthesised sounds: the impacts layered under the recordings (bat, pitch, gloves, pads,
// stumps, boards), footsteps on turf and on the pitch, the bowler's grunt, the bowling machine,
// formant voices for the stands, the UI ticks and the presentation stings. Created on the first
// user gesture (or handed an OfflineAudioContext for a render); with no AudioContext, the sound
// off or a context that won't start, every call is a quiet no-op.
import { MIX, groupGains, airCutoff, travelDelay, clipCurve, SPACE } from './mix.js';
import { VoicePool, VoiceBudget } from './pool.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
// One of the listener's params (Sfx.listen's cache), set only if it would change; the last value kept after it is set.
function setIf(P, i, x) { if (P.v[i] !== x) { P.p[i].value = x; P.v[i] = x; } }
// Vowel formants (F1, F2, F3 Hz) for the voices of the ground.
const VOWEL = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2200, 2950], o: [570, 840, 2410], u: [320, 870, 2240], uh: [640, 1190, 2390] };

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noiseBuf = null; this.pinkBuf = null;
    this.bus = null;                 // { crowd, fx, voice, ui } once started
    this.levels = groupGains({});
    this.ear = { x: 0, y: 1.6, z: 0 };   // the listener, world metres (for distances)
    this.anchor = { machine: null };     // where the bowling machine is (its countdown beeps)
  }

  init(ctx = null) {
    if (this.ctx) { if (this.enabled && this.realtime && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!ctx && !AC) return;
      const c = this.ctx = ctx || new AC({ latencyHint: 'interactive' });
      this.realtime = !ctx;
      const L = this.levels;
      // master -> limiter -> soft clip -> out: nothing reaches full scale however much piles up.
      const clip = c.createWaveShaper(); clip.curve = clipCurve(); clip.connect(c.destination);
      const lim = this.limiter = c.createDynamicsCompressor();
      const P = MIX.limiter;
      lim.threshold.value = P.threshold; lim.knee.value = P.knee; lim.ratio.value = P.ratio; lim.attack.value = P.attack; lim.release.value = P.release;
      lim.connect(clip);
      this.master = c.createGain(); this.master.gain.value = this.enabled ? L.master : 0; this.master.connect(lim);
      if (!this.enabled && this.realtime) c.suspend().catch(() => {});      // (sound off: the clock waits)
      const mk = (g, to) => { const n = c.createGain(); n.gain.value = g; n.connect(to); return n; };
      this.duck = mk(1, this.master);
      this.bus = { crowd: mk(L.crowd, this.duck), fx: mk(L.fx, this.master), voice: mk(L.voice, this.master), ui: mk(L.ui, this.master) };
      // 2 s of white noise and 4 s of pink, shared by every noisy sound.
      const sr = c.sampleRate;
      this.noiseBuf = c.createBuffer(1, sr * 2, sr);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.pinkBuf = c.createBuffer(1, sr * 4, sr);
      const p = this.pinkBuf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;                              // (Kellet's economy pink filter)
      for (let i = 0; i < p.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        p[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      }
      this.budget = new VoiceBudget(MIX.maxVoices);
      this.near = new VoicePool(8, () => this.chain(this.bus.fx, MIX.hrtf ? 'HRTF' : 'equalpower', SPACE.rolloff));
      this.far = new VoicePool(10, () => this.chain(this.bus.crowd, 'equalpower', 0));
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null; this.bus = null;
    }
  }

  get ok() { return this.enabled && !!this.ctx && !!this.bus && this.ctx.state !== 'closed'; }
  get now() { return this.ctx ? this.ctx.currentTime : 0; }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.master) return;
    this.master.gain.value = on ? this.levels.master : 0;
    // (off: stop the clock too, the graph costs nothing; on: pick it up again)
    if (this.realtime) { try { if (on) this.ctx.resume().catch(() => {}); else this.ctx.suspend().catch(() => {}); } catch { /* closed */ } }
  }

  /** The volume steppers (settings.volMaster, volCrowd, volEffects, volCommentary). */
  setLevels(settings) {
    this.levels = groupGains({ ...settings, sound: this.enabled && settings.sound !== false });
    if (!this.bus) return;
    const t = this.ctx.currentTime, L = this.levels;
    this.master.gain.setTargetAtTime(L.master, t, 0.05);
    for (const k of ['crowd', 'fx', 'voice', 'ui']) this.bus[k].gain.setTargetAtTime(L[k], t, 0.05);
  }

  /** The crowd under the commentators: 1 = not ducked. */
  setDuck(x) {
    if (!this.duck || x === this._duckTo) return;        // (only on a change: no automation piling up every frame)
    const g = this.duck.gain, up = x > (this._duckTo ?? 1), t = this.ctx.currentTime;
    this._duckTo = x;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(x, t, up ? MIX.duck.release / 3 : MIX.duck.attack / 3);
  }

  // A panner chain into `bus`: gain -> lowpass (the air) -> panner.
  chain(bus, model, rolloff) {
    const c = this.ctx, g = c.createGain(), lp = c.createBiquadFilter(), p = c.createPanner();
    lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.5;
    p.panningModel = model; p.distanceModel = 'inverse'; p.refDistance = SPACE.ref; p.rolloffFactor = rolloff; p.maxDistance = 10000;
    g.connect(lp).connect(p).connect(bus);
    return { g, lp, p };
  }

  static place(p, x, y, z) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
  }

  /** Where your head is: position {x,y,z} and orientation quaternion {x,y,z,w} (world). */
  listen(pos, q) {
    if (!this.ctx) return;
    this.ear.x = pos.x; this.ear.y = pos.y; this.ear.z = pos.z;
    const L = this.ctx.listener, { x, y, z, w } = q;
    const fx = -2 * (x * z + w * y), fy = -2 * (y * z - w * x), fz = -(1 - 2 * (x * x + y * y));
    const ux = 2 * (x * y - w * z), uy = 1 - 2 * (x * x + z * z), uz = 2 * (y * z + w * x);
    try {
      if (L.positionX) {
        // (every frame: the params fetched once, and only a value that has changed is sent -- each
        // read of a param and each write of its value is a call into the browser)
        const P = this._lp || (this._lp = { p: [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ], v: new Float64Array(9).fill(NaN) });
        setIf(P, 0, pos.x); setIf(P, 1, pos.y); setIf(P, 2, pos.z); setIf(P, 3, fx); setIf(P, 4, fy); setIf(P, 5, fz); setIf(P, 6, ux); setIf(P, 7, uy); setIf(P, 8, uz);
      } else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fx, fy, fz, ux, uy, uz); }
    } catch { /* a non-finite pose: keep the last */ }
  }

  dist(pos) { const e = this.ear; return Math.hypot(pos.x - e.x, pos.y - e.y, pos.z - e.z); }

  /**
   * Where a sound at `pos` goes in: { out, delay } (delay: the time sound takes to get to you).
   * crowd: the stands' equal-power voices (no distance law), else the effects' 3-D voices. No pos
   * (or every voice busy with something louder): straight into the group, in the middle.
   */
  at(pos, { crowd = false, dur = 0.6, prio = 1 } = {}) {
    const bus = this.bus;
    if (!bus) return { out: null, delay: 0 };
    const flat = { out: crowd ? bus.crowd : bus.fx, delay: 0 };
    if (!pos) return flat;
    let v;
    // The game's own impacts (bat, stumps, gloves, pads) get a panner of their own, made at their
    // place: a pooled HRTF panner glides ~50 ms from its last direction, smearing a crack. (It goes
    // when its sounds end; the voice budget caps how many there are.) The rest share the pools.
    if (!crowd && prio >= 2) v = this.chain(bus.fx, MIX.hrtf ? 'HRTF' : 'equalpower', SPACE.rolloff);
    else {
      const s = (crowd ? this.far : this.near).acquire(this.ctx.currentTime, dur, prio, pos);
      if (!s) return flat;
      v = s.node;
    }
    const d = this.dist(pos);
    Sfx.place(v.p, pos.x, pos.y, pos.z);
    v.lp.frequency.value = crowd ? 20000 : airCutoff(d);
    return { out: v.g, delay: crowd ? 0 : travelDelay(d) };
  }

  // ------------------------------------------------------------ primitives
  // Each: when (s from now), out (a node; else pos -> at(); else the effects group), prio.
  _dest(o, dur) {
    if (o.out) return o.out;
    if (o.pos) { const a = this.at(o.pos, { dur, prio: o.prio ?? 1, crowd: o.crowd }); o.when = (o.when || 0) + a.delay; return a.out; }
    return o.crowd ? this.bus.crowd : this.bus[o.bus || 'fx'];
  }

  noise(dur, o = {}) {
    if (!this.ok) return;
    const { type = 'bandpass', freq = 1000, q = 1, gain = 0.5, attack = 0.002, decay = dur, sweep = 0, pink = false, prio = 1 } = o;
    const c = this.ctx, out = this._dest(o, attack + decay), t = c.currentTime + (o.when || 0);
    if (!this.budget.admit(c.currentTime, (o.when || 0) + attack + decay, prio)) return;
    const src = c.createBufferSource();
    src.buffer = pink ? this.pinkBuf : this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweep) { f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), t + attack + decay); }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);      // (an exponential ramp cannot reach 0)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  tone(freq, dur, o = {}) {
    if (!this.ok) return;
    const { type = 'sine', gain = 0.3, attack = 0.002, slide = 0, detune = 0, prio = 1 } = o;
    const c = this.ctx, out = this._dest(o, attack + dur), t = c.currentTime + (o.when || 0);
    if (!this.budget.admit(c.currentTime, (o.when || 0) + attack + dur, prio)) return;
    const osc = c.createOscillator();
    osc.type = type; osc.detune.value = detune;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + attack + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + attack + dur + 0.05);
  }

  /**
   * A voice: a glottal buzz (sawtooth, a little vibrato) and breath through three formant
   * filters gliding from vowel to vowel. f0: pitch (Hz), glide: the pitch at the end (x f0),
   * vowels: ['a', 'i'] etc., dur s. The shouts and the grunt.
   */
  voice({ f0 = 140, glide = 0.9, vowels = ['a'], dur = 0.4, gain = 0.2, breath = 0.25, attack = 0.03, when = 0, out = null, pos = null, crowd = false, prio = 1 } = {}) {
    if (!this.ok) return;
    const o = { out, pos, crowd, prio, when };
    const dest = this._dest(o, dur + attack);
    const c = this.ctx, t = c.currentTime + o.when, end = t + attack + dur;
    if (!this.budget.admit(c.currentTime, o.when + attack + dur, prio)) return;
    const osc = c.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * rnd(0.97, 1.03), t);
    osc.frequency.linearRampToValueAtTime(f0 * 1.06, t + dur * 0.25);           // (the shout's rise and fall)
    osc.frequency.exponentialRampToValueAtTime(f0 * glide, end);
    const br = c.createBufferSource(); br.buffer = this.noiseBuf;
    const bg = c.createGain(); bg.gain.value = breath;
    const env = c.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    env.gain.setTargetAtTime(gain * 0.7, t + attack, dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    br.connect(bg);
    const v0 = VOWEL[vowels[0]] || VOWEL.a, v1 = VOWEL[vowels[vowels.length - 1]] || v0;
    for (let k = 0; k < 3; k++) {
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = [6, 10, 14][k];
      f.frequency.setValueAtTime(v0[k], t);
      if (vowels.length > 1) f.frequency.linearRampToValueAtTime(v1[k], t + attack + dur * 0.7);
      const fg = c.createGain(); fg.gain.value = [1, 0.55, 0.3][k];
      osc.connect(f); bg.connect(f); f.connect(fg).connect(env);
    }
    env.connect(dest);
    osc.start(t); br.start(t, Math.random()); osc.stop(end + 0.05); br.stop(end + 0.05);
  }

  // ------------------------------------------------------------ impacts
  // kind: sweet | mistimed | edge | toe | block | handle. Layered under the recorded bat.
  batLayer(kind, quality, speed, pos) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.35, prio: 2 }), o = { out: a.out, when: a.delay, prio: 2 }, L = 0.9 * clamp(0.35 + speed / 55, 0.35, 1);
    if (kind === 'sweet') {
      this.tone(rnd(86, 100), 0.08, { ...o, gain: 0.5 * L * (0.5 + 0.5 * quality), slide: 0.55 });          // the thump you feel
      this.noise(0.012, { ...o, type: 'highpass', freq: 3600, q: 0.7, gain: 0.45 * L });                     // the bright transient
      this.tone(rnd(760, 860), 0.05 + 0.1 * quality, { ...o, type: 'triangle', gain: 0.1 * L * quality, slide: 0.97, prio: 1 });   // the blade rings
    } else if (kind === 'mistimed') {
      this.noise(0.07, { ...o, type: 'lowpass', freq: 420, q: 0.8, gain: 0.45 * L });
      this.tone(rnd(140, 165), 0.06, { ...o, gain: 0.22 * L, slide: 0.7 });
    } else if (kind === 'edge') {
      this.noise(0.006, { ...o, type: 'highpass', freq: 5200, q: 0.7, gain: 0.3 * L });
      this.tone(rnd(2700, 3100), 0.02, { ...o, type: 'triangle', gain: 0.07 * L });
    } else if (kind === 'toe') {
      this.noise(0.06, { ...o, type: 'lowpass', freq: 650, q: 1, gain: 0.45 * L });
      this.tone(rnd(240, 280), 0.05, { ...o, type: 'triangle', gain: 0.22 * L, slide: 0.75 });
    } else if (kind === 'block') {
      this.tone(rnd(400, 460), 0.045, { ...o, type: 'triangle', gain: 0.14 * L, slide: 0.9 });
      this.noise(0.04, { ...o, type: 'lowpass', freq: 900, q: 0.7, gain: 0.25 * L });
    } else {                                                           // the handle: a dead clack
      this.tone(rnd(170, 200), 0.05, { ...o, gain: 0.2 * L });
      this.noise(0.03, { ...o, freq: 1200, q: 1, gain: 0.2 * L });
    }
  }

  // The legacy call (no recording loaded): a bat crack from the synthesis alone.
  batCrack(quality, speed, edge = false, pos = null) {
    const kind = edge ? 'edge' : quality > 0.6 ? 'sweet' : quality < 0.15 ? 'toe' : 'mistimed';
    this.batLayer(kind, quality, speed, pos);
    if (kind === 'sweet') this.noise(0.04 + quality * 0.04, { pos, freq: 1500 + quality * 2300, q: 1.4, gain: 0.5 * Math.min(1, 0.35 + speed / 60), prio: 2 });
  }

  // The ball landing: the pitch is hard and dry (a thud with a crack; skid: hurrying on low),
  // the outfield soft (a muffled thump in the grass).
  bounce(speed, surface = 'pitch', pos = null, skid = 0) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.3 }), o = { out: a.out, when: a.delay }, g = Math.min(0.6, 0.05 + speed / 70);
    if (surface === 'pitch') {
      this.tone(rnd(120, 150), 0.06, { ...o, gain: g * 0.7, slide: 0.6 });
      this.noise(0.045, { ...o, type: 'lowpass', freq: 900 + speed * 20, q: 0.8, gain: g * 0.8 });
      this.noise(0.01, { ...o, freq: 2400, q: 1, gain: g * 0.3 });
      if (skid > 0.1) this.noise(0.09, { ...o, freq: 1500, q: 0.7, gain: g * 0.22 * skid, attack: 0.008, sweep: 0.6, prio: 0 });
    } else {
      this.tone(rnd(78, 95), 0.07, { ...o, gain: g * 0.5, slide: 0.7 });
      this.noise(0.06, { ...o, type: 'lowpass', freq: 380, q: 0.7, gain: g * 0.7 });
      this.noise(0.05, { ...o, type: 'highpass', freq: 3500, q: 0.5, gain: g * 0.07, attack: 0.005, prio: 0 });
    }
  }

  // The stump struck: a hard knock, the stumps rattling, the bails clattering off.
  stumps(pos = null, speed = 20, bails = true) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.9, prio: 2 }), o = { out: a.out, when: a.delay, prio: 2 }, g = clamp(0.5 + speed / 60, 0.5, 1);
    this.tone(rnd(380, 430), 0.12, { ...o, type: 'triangle', gain: 0.32 * g, slide: 0.85 });
    this.noise(0.03, { ...o, freq: 1800, q: 1.2, gain: 0.4 * g });
    for (let i = 0; i < 3; i++) this.tone(rnd(600, 1500), 0.08, { ...o, type: 'triangle', gain: 0.1 * g, when: o.when + 0.02 + i * rnd(0.02, 0.05), slide: 0.8, prio: 1 });
    if (bails) this.bails(null, a.out, o.when);
  }

  bails(pos = null, out = null, when = 0) {
    if (!this.ok) return;
    if (!out) { const a = this.at(pos, { dur: 0.6 }); out = a.out; when += a.delay; }
    for (let i = 0; i < 4; i++) this.tone(rnd(2200, 4200), 0.025, { out, type: 'sine', gain: 0.07, when: when + 0.05 + i * rnd(0.04, 0.12) });
    this.noise(0.012, { out, type: 'highpass', freq: 3000, gain: 0.1, when: when + 0.3 });          // one lands on the pitch
  }

  // Leather: the keeper's gloves (or a fielder's hands) closing on the ball.
  gloves(pos = null, speed = 25) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.2, prio: 2 }), o = { out: a.out, when: a.delay, prio: 2 }, g = clamp(0.35 + speed / 40, 0.35, 1);
    this.noise(0.018, { ...o, freq: 1400, q: 1.1, gain: 0.45 * g });
    this.tone(rnd(160, 190), 0.05, { ...o, gain: 0.3 * g, slide: 0.6 });
    this.noise(0.006, { ...o, type: 'highpass', freq: 4000, gain: 0.22 * g });
  }

  // The ball into the batter: part = pad | body | helmet.
  pad(pos = null, speed = 25, part = 'pad') {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.25, prio: 2 }), o = { out: a.out, when: a.delay, prio: 2 }, g = clamp(0.3 + speed / 45, 0.3, 1);
    if (part === 'helmet') {
      this.tone(rnd(1100, 1200), 0.07, { ...o, type: 'triangle', gain: 0.22 * g, slide: 0.95 });
      this.tone(rnd(1750, 1850), 0.05, { ...o, gain: 0.1 * g });
      this.noise(0.02, { ...o, freq: 2500, q: 1.5, gain: 0.28 * g });
    } else {
      const body = part === 'body';
      this.noise(0.08, { ...o, type: 'lowpass', freq: body ? 420 : 700, q: 0.7, gain: 0.5 * g });
      this.tone(rnd(body ? 85 : 110, body ? 95 : 125), 0.07, { ...o, gain: 0.3 * g, slide: 0.7 });
      if (!body) this.noise(0.01, { ...o, freq: 2600, q: 2, gain: 0.08 * g });    // the cane in the pad
    }
  }

  // The boundary boards: a hollow knock and a rattle.
  boards(pos = null, speed = 10) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.4, prio: 1 }), o = { out: a.out, when: a.delay }, g = 1.5 * clamp(0.3 + speed / 30, 0.3, 1);
    this.tone(rnd(65, 80), 0.16, { ...o, gain: 0.5 * g, slide: 0.8 });
    this.noise(0.14, { ...o, freq: 450, q: 2.5, gain: 0.45 * g });
    this.noise(0.05, { ...o, freq: 1800, q: 3, gain: 0.14 * g, when: o.when + 0.02 });
    this.tone(rnd(200, 230), 0.1, { ...o, type: 'triangle', gain: 0.1 * g });
  }

  // A foot on the ground: turf (soft, a brush of grass) or the pitch (firm, gritty). weight 0..2.
  footstep(pos = null, surface = 'turf', weight = 1) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.12, prio: 0 }), o = { out: a.out, when: a.delay, prio: 0 }, w = clamp(weight, 0.1, 2);
    if (surface === 'pitch') {
      this.noise(0.03, { ...o, freq: rnd(950, 1250), q: 0.9, gain: 0.45 * w });
      this.tone(rnd(85, 100), 0.035, { ...o, gain: 0.32 * w, slide: 0.7 });
    } else {
      this.noise(0.06, { ...o, type: 'lowpass', freq: rnd(230, 300), q: 0.7, gain: 0.6 * w });
      if (w > 0.8) this.noise(0.035, { ...o, type: 'highpass', freq: 3000, gain: 0.07 * w, attack: 0.005 });   // the grass
    }
    if (w > 1.2) this.tone(rnd(60, 70), 0.06, { ...o, gain: 0.3 * w, slide: 0.7, prio: 1 });           // the front foot landing
  }

  // A body on the turf (a dive).
  dive(pos = null) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.3 }), o = { out: a.out, when: a.delay };
    this.noise(0.13, { ...o, type: 'lowpass', freq: 260, q: 0.7, gain: 0.45 });
    this.tone(rnd(55, 65), 0.1, { ...o, gain: 0.25, slide: 0.7 });
    this.noise(0.18, { ...o, type: 'highpass', freq: 2500, gain: 0.05, attack: 0.02, prio: 0 });
  }

  // The bat tapped on the crease while you wait.
  batTap(pos = null, speed = 1) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.08, prio: 0 }), o = { out: a.out, when: a.delay, prio: 0 }, g = clamp(0.3 + speed / 3, 0.3, 1);
    this.noise(0.015, { ...o, freq: 1200, q: 1.2, gain: 0.36 * g });
    this.tone(rnd(560, 640), 0.02, { ...o, type: 'triangle', gain: 0.12 * g });
  }

  // The bowler's effort at the release: a short voiced "uh!" with a breath.
  grunt(pos = null, effort = 1) {
    this.voice({ pos, f0: rnd(100, 128), glide: 0.75, vowels: ['uh'], dur: rnd(0.12, 0.2), gain: 0.6 * clamp(effort, 0.3, 1.2), breath: 0.6, attack: 0.012, prio: 1 });
  }

  // The arm coming over (and your own when you bowl): air past your ear.
  whoosh(speed = 20, pos = null) {
    this.noise(0.12, { pos, freq: 700, q: 0.8, gain: Math.min(0.35, speed / 80), attack: 0.04, sweep: 2.2, prio: 0 });
  }

  // The bowling machine: wheels humming while it is set, a thunk as it fires.
  machineThunk(pos = null) {
    if (!this.ok) return;
    const a = this.at(pos, { dur: 0.3, prio: 2 }), o = { out: a.out, when: a.delay, prio: 2 };
    this.tone(rnd(64, 72), 0.1, { ...o, gain: 0.5, slide: 0.55 });
    this.noise(0.04, { ...o, type: 'lowpass', freq: 1200, q: 0.8, gain: 0.35 });
    this.noise(0.07, { ...o, type: 'highpass', freq: 2200, gain: 0.08, attack: 0.003, prio: 1 });
  }

  /** A looped hum at a place: returns { set(pos, level), stop() } (level 0..1). */
  hum(kind = 'machine') {
    const h = { set() {}, stop() {} };
    if (!this.bus) return h;
    try {
      const c = this.ctx, v = this.chain(this.bus.fx, 'equalpower', SPACE.rolloff), srcs = [];
      v.g.gain.value = 0;
      if (kind === 'machine') {
        for (const f of [46, 49.5]) {
          const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
          const g = c.createGain(); g.gain.value = 0.05;
          o.connect(lp).connect(g).connect(v.g); srcs.push(o);
        }
      }
      // (both kinds: a band of air - the wheels, or a ball rolling through grass)
      const n = c.createBufferSource(); n.buffer = this.pinkBuf; n.loop = true;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = kind === 'machine' ? 700 : 500; bp.Q.value = 0.8;
      const ng = c.createGain(); ng.gain.value = kind === 'machine' ? 0.08 : 0.5;
      n.connect(bp).connect(ng).connect(v.g); srcs.push(n);
      for (const s of srcs) s.start(c.currentTime, s === n ? Math.random() * 3 : undefined);
      let gone = false, lv = 0, fq = bp.frequency.value, px = NaN, py = NaN, pz = NaN;
      h.set = (pos, level, freq = 0) => {
        if (gone) return;
        level = clamp(level, 0, 1);
        // (called every frame: the panner moved, and the clock read, only for a real change -- each is a call into the browser)
        if (pos && (pos.x !== px || pos.y !== py || pos.z !== pz)) { px = pos.x; py = pos.y; pz = pos.z; Sfx.place(v.p, px, py, pz); }
        const lvl = Math.abs(level - lv) > 0.004, frq = freq && Math.abs(freq - fq) > fq * 0.02;
        if (!lvl && !frq) return;
        const t = c.currentTime;
        if (lvl) { lv = level; v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(level, t, 0.06); }
        if (frq) { fq = freq; bp.frequency.cancelScheduledValues(t); bp.frequency.setTargetAtTime(freq, t, 0.06); }
      };
      h.stop = () => {
        if (gone) return; gone = true;
        try { v.g.gain.setTargetAtTime(0, c.currentTime, 0.05); for (const s of srcs) s.stop(c.currentTime + 0.4); } catch { /* closed */ }
        setTimeout(() => { try { v.p.disconnect(); } catch { /* gone */ } }, 600);
      };
    } catch { /* no audio */ }
    return h;
  }

  beep(stage) {
    const f = stage >= 3 ? 1320 : 880;
    this.tone(f, stage >= 3 ? 0.12 : 0.07, { type: 'square', gain: 0.06, pos: this.anchor.machine, prio: 2 });
  }

  catchThud(pos = null) { this.gloves(pos, 18); }

  // ------------------------------------------------------------ presentation
  // The menu: a soft tick as the pointer moves onto a button, a click when you press it.
  ui(kind = 'click') {
    if (kind === 'hover') { this.tone(rnd(2350, 2450), 0.012, { bus: 'ui', gain: 0.06, prio: 0 }); return; }
    this.tone(1480, 0.022, { bus: 'ui', gain: 0.35, prio: 1 });
    this.noise(0.006, { bus: 'ui', freq: 3200, q: 1.5, gain: 0.2, prio: 1 });
    this.tone(740, 0.03, { bus: 'ui', gain: 0.1, when: 0.004, prio: 1 });
  }

  // An FM bell (the stings' melody): carrier at freq, modulator at 3.5x, its index dying away.
  bell(freq, when, dur, gain, out) {
    const c = this.ctx, t = c.currentTime + when;
    if (!this.budget.admit(c.currentTime, when + dur, 2)) return;
    const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain();
    car.frequency.value = freq; mod.frequency.value = freq * 3.5;
    mg.gain.setValueAtTime(freq * 2.2, t); mg.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    mod.connect(mg).connect(car.frequency); car.connect(g).connect(out);
    car.start(t); mod.start(t); car.stop(t + dur + 0.05); mod.stop(t + dur + 0.05);
  }

  // A warm pad chord (two detuned saws a note, lowpassed) swelling in and out.
  pad3(notes, when, dur, gain, out) {
    const c = this.ctx, t = c.currentTime + when;
    if (!this.budget.admit(c.currentTime, when + dur, 2)) return;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1600, t + dur * 0.4); lp.frequency.linearRampToValueAtTime(700, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + Math.min(0.5, dur * 0.3)); g.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.12);
    lp.connect(g).connect(out);
    for (const m of notes) for (const dt of [-7, 7]) {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = dt;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }
  }

  /**
   * The game's own short idents, original to Crease VR: 'menu' (the title: a rising call and a
   * warm chord, a willow tock on the downbeat), 'win', 'lose', 'innings'.
   */
  sting(kind = 'menu') {
    if (!this.ok) return;
    const out = this.bus.ui;
    const S = {
      menu: { mel: [62, 66, 69, 74], step: 0.14, pad: [50, 57, 62, 66], dur: 2.6, tock: true },
      win: { mel: [67, 71, 74, 79, 83], step: 0.1, pad: [55, 62, 67, 71], dur: 2.4, tock: true, sparkle: true },
      lose: { mel: [69, 65, 62], step: 0.26, pad: [50, 57, 62, 65], dur: 2.6 },
      innings: { mel: [62, 69, 74], step: 0.16, pad: [50, 57, 62, 69], dur: 2.0 },
    }[kind];
    if (!S) return;
    S.mel.forEach((m, i) => {
      const last = i === S.mel.length - 1;
      this.bell(mtof(m), i * S.step, last ? 1.6 : 0.7, last ? 0.32 : 0.24, out);
    });
    this.pad3(S.pad, 0.02, S.dur, 0.08, out);
    if (S.tock) { this.tone(820, 0.06, { out, type: 'triangle', gain: 0.25, slide: 0.95, prio: 2 }); this.tone(92, 0.07, { out, gain: 0.3, slide: 0.6, prio: 2 }); }
    if (S.sparkle) for (let i = 0; i < 5; i++) this.tone(mtof(91 + [0, 4, 7, 12, 16][i]), 0.25, { out, gain: 0.03, when: 0.45 + i * 0.06, prio: 1 });
  }

  // The review's heartbeat (lub-dub), into the UI group.
  heartbeat(strength = 1) {
    const g = 0.3 * clamp(strength, 0.3, 1.2);
    this.tone(54, 0.09, { bus: 'ui', gain: g, slide: 0.8, prio: 1 });
    this.tone(48, 0.11, { bus: 'ui', gain: g * 0.7, slide: 0.8, when: 0.19, prio: 1 });
  }

  // Legacy (the game's director drives the crowd now): kept so old call sites stay harmless.
  setCrowdLevel() {}
  startCrowd() {}
  cheer(intensity = 1) { this.noise(1.8 + intensity, { crowd: true, freq: 1100, q: 0.6, gain: 0.08 + 0.15 * intensity, attack: 0.25, decay: 1.6 + intensity, pink: true }); }
  groan() { this.noise(1.0, { crowd: true, type: 'lowpass', freq: 500, q: 0.7, gain: 0.12, attack: 0.15, decay: 0.9, pink: true }); }
}
