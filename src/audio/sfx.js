// Synthesised sound effects (WebAudio, no samples):
// bat crack (varies with contact quality), bounce, stumps, beeps, crowd bed,
// cheers/groans, catch thud. Lazily created on the first user gesture.
import { CONFIG } from '../config.js';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.crowdGain = null;
    this.noiseBuf = null;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = CONFIG.audio.master;
      this.master.connect(this.ctx.destination);
      // 2 s of white noise, reused by every noisy sound.
      const n = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.startCrowd();
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null;
    }
  }

  get ok() { return this.enabled && this.ctx && this.ctx.state !== 'closed'; }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? CONFIG.audio.master : 0;
  }

  noise(dur, { type = 'bandpass', freq = 1000, q = 1, gain = 0.5, attack = 0.002, decay = dur, when = 0 } = {}) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime + when;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + attack + decay + 0.05);
  }

  tone(freq, dur, { type = 'sine', gain = 0.3, attack = 0.002, when = 0, slide = 0 } = {}) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  // quality 0..1 (1 = sweet spot), speed m/s of the impact, edge flag.
  batCrack(quality, speed, edge = false) {
    const loud = Math.min(1, 0.35 + speed / 60);
    if (edge) {
      this.noise(0.035, { freq: 3800, q: 2.5, gain: 0.35 * loud });
      this.tone(2100 + Math.random() * 300, 0.03, { type: 'triangle', gain: 0.12 * loud });
      return;
    }
    // Sweet spot: sharp crack + woody resonance; poor contact: dull thunk.
    const bright = 1500 + quality * 2300;
    this.noise(0.03 + quality * 0.05, { freq: bright, q: 1.4, gain: (0.45 + 0.45 * quality) * loud });
    this.noise(0.08, { type: 'lowpass', freq: 600 + quality * 400, q: 0.7, gain: 0.25 * loud });
    this.tone(520 + quality * 380, 0.05 + quality * 0.12, { type: 'triangle', gain: (0.08 + 0.2 * quality) * loud, slide: 0.92 });
  }

  bounce(speed, surface = 'pitch') {
    const g = Math.min(0.5, 0.06 + speed / 90);
    this.noise(0.05, { type: 'lowpass', freq: surface === 'pitch' ? 700 : 380, q: 0.8, gain: g });
    this.tone(surface === 'pitch' ? 180 : 120, 0.05, { gain: g * 0.4, slide: 0.7 });
  }

  stumps() {
    for (let i = 0; i < 4; i++) {
      this.tone(700 + Math.random() * 900, 0.07, { type: 'triangle', gain: 0.18, when: i * 0.025 + Math.random() * 0.02, slide: 0.8 });
      this.noise(0.04, { freq: 2200, q: 2, gain: 0.25, when: i * 0.03 });
    }
  }

  beep(stage) {
    const f = stage >= 3 ? 1320 : 880;
    this.tone(f, stage >= 3 ? 0.12 : 0.07, { type: 'square', gain: 0.07 });
  }

  catchThud() { this.noise(0.06, { type: 'lowpass', freq: 500, gain: 0.35 }); }
  ui() { this.tone(1200, 0.025, { type: 'sine', gain: 0.05 }); }
  whoosh(speed = 20) { this.noise(0.12, { freq: 900, q: 0.8, gain: Math.min(0.2, speed / 150), attack: 0.03 }); }

  // Crowd: looping filtered noise bed.
  startCrowd() {
    if (!this.ctx || this.crowdGain) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    this.crowdGain = c.createGain();
    this.crowdGain.gain.value = CONFIG.audio.crowd * 0.35;
    // Slow murmur modulation.
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoGain = c.createGain();
    lfoGain.gain.value = CONFIG.audio.crowd * 0.08;
    lfo.connect(lfoGain).connect(this.crowdGain.gain);
    src.connect(bp).connect(lp).connect(this.crowdGain).connect(this.master);
    src.start();
    lfo.start();
  }

  setCrowdLevel(level) {
    if (!this.crowdGain) return;
    this.crowdGain.gain.setTargetAtTime(CONFIG.audio.crowd * level, this.ctx.currentTime, 0.4);
  }

  // Cheer swell (0..1) that decays back to the bed.
  cheer(intensity = 1) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this.noise(1.8 + intensity, { freq: 1100, q: 0.6, gain: 0.12 + 0.25 * intensity, attack: 0.25, decay: 1.6 + intensity });
    this.noise(1.2, { freq: 2600, q: 1.2, gain: 0.05 + 0.1 * intensity, attack: 0.15, when: 0.1 });
    if (this.crowdGain) {
      this.crowdGain.gain.cancelScheduledValues(t);
      this.crowdGain.gain.setTargetAtTime(CONFIG.audio.crowd * (1 + 2 * intensity), t, 0.2);
      this.crowdGain.gain.setTargetAtTime(CONFIG.audio.crowd * 0.35, t + 1.5, 0.8);
    }
  }

  groan() {
    this.noise(1.0, { type: 'lowpass', freq: 500, q: 0.7, gain: 0.18, attack: 0.15, decay: 0.9 });
  }
}
