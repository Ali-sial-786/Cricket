// Recorded sound effects (assets/audio): the bat, the crowd, the stumps, the umpire's cues.
// Fetched and decoded once through the Sfx AudioContext, cached, each played at its class's
// reference loudness (mix.js normGain: the gains callers pass mean the same for every file) into
// a group, a 3-D voice (pos) or any node (out), with a few ms of fade on the end so a clip cut
// short never clicks. Nothing here throws: a missing file, no AudioContext or sound off just
// returns false, so callers can fall back to the synthesised effect:
//   samples.play('bat_sweet', { pos }) || sfx.batCrack(...)
//
//   const samples = new Samples(sfx);
//   samples.preload();                    // after sfx.init() (a user gesture); resolves to the count loaded
//   samples.play('roar_six', { gain: 0.8, crowd: true });
//   const bed = samples.loop('crowd_bed', { gain: 0.3, out, offset: 12, seamless: 1 });  bed.setGain(0.15, 0.4);  bed.stop();
import { normGain } from './mix.js';

const DIR = './assets/audio/';
const OGG = ['bat_sweet_1', 'bat_sweet_2', 'bat_sweet_3', 'bat_edge_1', 'bat_edge_2', 'bat_block_1', 'bat_block_2',
  'crowd_bed', 'applause_polite_1', 'applause_polite_2', 'applause_warm', 'cheer_four', 'roar_six', 'roar_wicket',
  'appeal', 'howzat'];
const WAV = ['stumps', 'bails', 'gloves', 'pad', 'catch', 'drs_stinger', 'chime', 'umpire_out', 'umpire_not_out',
  'coin', 'footstep_1', 'footstep_2', 'cam_whoosh'];
// A group name plays one of its variants at random.
// Crowd reactions (assets/audio/crowd).
const CROWD = ['crowd_aah_1', 'crowd_aah_2', 'crowd_aah_3', 'crowd_applause', 'crowd_applause_loud', 'crowd_applause_short',
  'crowd_aww', 'crowd_cheer', 'crowd_cheer_big', 'crowd_gasp_1', 'crowd_gasp_2', 'crowd_gasp_3', 'crowd_gasp_4',
  'crowd_gasp_voiced_1', 'crowd_gasp_voiced_2', 'crowd_groan', 'crowd_inhale', 'crowd_laugh_1', 'crowd_laugh_2',
  'crowd_ooh_1', 'crowd_ooh_2', 'crowd_ooh_3', 'crowd_ovation', 'crowd_whoa', 'crowd_whoa_cheer'];
const GROUPS = { bat_sweet: 3, bat_edge: 2, bat_block: 2, applause_polite: 2, footstep: 2,
  crowd_aah: 3, crowd_gasp: 4, crowd_gasp_voiced: 2, crowd_laugh: 2, crowd_ooh: 3 };

// _seamless's slices (samples): a copy of this many, or a crossfade of this many, is a few ms at most.
const SEAM_COPY = 1 << 17, SEAM_FADE = 4096;
const later = () => new Promise((r) => setTimeout(r, 0));
const SEAMLESS_AT_LOAD = [['crowd_bed', 1]];      // [sample, crossfade s] as audio/crowd.js loops it
function crossfade(a, b, len, n, i0, i1) {
  for (let i = i0; i < i1; i++) { const u = i / n; b[i] = a[i] * Math.sqrt(u) + a[len + i] * Math.sqrt(1 - u); }
}

export class Samples {
  constructor(sfx) {
    this.sfx = sfx;
    this.files = {};                   // name -> file
    for (const n of OGG) this.files[n] = `${n}.ogg`;
    for (const n of WAV) this.files[n] = `${n}.wav`;
    for (const n of CROWD) this.files[n] = `crowd/${n}.ogg`;
    this.buffers = new Map();          // name -> AudioBuffer
    this.pending = new Map();          // name -> Promise<AudioBuffer | null>
    this.failed = new Set();           // names whose file is missing or won't decode
    this.last = {};                    // group -> the variant played last (not twice running)
    this.seams = new Map();            // 'name~xf' -> Promise<AudioBuffer>: a loop's crossfaded copy (loop seamless)
  }

  get ctx() {
    const s = this.sfx;
    return s && s.ctx && s.master && s.ctx.state !== 'closed' ? s.ctx : null;
  }

  /** Every name this bank knows (for the levels table and its test). */
  static names() { return [...OGG, ...WAV, ...CROWD]; }

  /** The names a group stands for (or the name itself). */
  variants(name) {
    const n = GROUPS[name];
    return n ? Array.from({ length: n }, (_, i) => `${name}_${i + 1}`) : [name];
  }

  /** A sample (or group) this bank knows and hasn't failed to load. */
  has(name) { return this.variants(name).some((v) => v in this.files && !this.failed.has(v)); }

  /** Decoded and ready to play right now. */
  ready(name) { return this.variants(name).some((v) => this.buffers.has(v)); }

  /** Fetch and decode the named samples / groups (all by default). Resolves to how many are ready. */
  preload(names = Object.keys(this.files)) {
    const list = [].concat(names || []).flatMap((n) => this.variants(n));
    // (the crowd bed's seamless copy is made as soon as it is decoded, not when the crowd first
    // comes in: its slices take a few hundred ms of timers, which was silence at the start)
    for (const [n, xf] of SEAMLESS_AT_LOAD) {
      const v = this.variants(n)[0], key = `${v}~${xf}`;
      if (list.includes(v) && !this.seams.has(key)) this.seams.set(key, this._load(v).then((buf) => (buf ? this._seamless(buf, xf) : null)));
    }
    return Promise.all(list.map((n) => this._load(n))).then((bufs) => bufs.filter(Boolean).length, () => 0);
  }

  _load(name) {
    const c = this.ctx;
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name));
    if (!c || !(name in this.files) || this.failed.has(name)) return Promise.resolve(null);
    if (this.pending.has(name)) return this.pending.get(name);
    const p = Promise.resolve()
      .then(() => fetch(DIR + this.files[name]))
      .then((r) => { if (!r.ok) throw new Error(`${name} ${r.status}`); return r.arrayBuffer(); })
      .then((bytes) => c.decodeAudioData(bytes))
      .then((buf) => { this.buffers.set(name, buf); return buf; })
      .catch(() => { this.failed.add(name); return null; })
      .finally(() => this.pending.delete(name));
    this.pending.set(name, p);
    return p;
  }

  // One of the group's decoded variants (not the one just played when there's a choice).
  _pick(name) {
    const all = this.variants(name);
    let ok = all.filter((v) => this.buffers.has(v));
    if (ok.length < all.length) for (const v of all) this._load(v);   // warm the rest for next time
    if (ok.length > 1) ok = ok.filter((v) => v !== this.last[name]);
    const v = ok[Math.floor(Math.random() * ok.length)];
    if (v) this.last[name] = v;
    return v ? this.buffers.get(v) : null;
  }

  /**
   * Play a sample once. gain: linear (x the clip's normalisation); rate: playback rate; when: s
   * from now; out: a node to play into, else pos {x,y,z} (a 3-D voice; crowd: the stands'),
   * else the group `bus` (fx | crowd | voice | ui); lowpass: Hz (a duller take); prio: the voice
   * budget's (pool.js). Returns true when it started; false (and starts loading it) when it isn't
   * decoded yet, is unknown / missing, there's no sound, or no voice to spare.
   */
  play(name, { gain = 1, rate = 1, when = 0, out = null, pos = null, crowd = false, bus = 'fx', lowpass = 0, prio = 1 } = {}) {
    try {
      const c = this.ctx, s = this.sfx;
      if (!c || s.enabled === false) return false;
      const buf = this._pick(name);
      if (!buf) return false;
      const len = buf.duration / Math.max(0.05, rate);
      let dest = out;
      if (!dest && s.bus) {
        if (pos && s.at) { const a = s.at(pos, { crowd, dur: len + Math.max(0, when), prio }); dest = a.out; when += a.delay; }
        else dest = crowd ? s.bus.crowd : s.bus[bus] || s.bus.fx;
      }
      dest = dest || s.master;
      if (s.budget && !s.budget.admit(c.currentTime, Math.max(0, when) + len, prio)) return false;
      const src = c.createBufferSource();
      src.buffer = buf; src.playbackRate.value = rate;
      const g = c.createGain(), t = c.currentTime + Math.max(0, when), k = gain * normGain(this.last[name] || name);
      g.gain.setValueAtTime(k, t);
      g.gain.setValueAtTime(k, t + Math.max(0, len - 0.012));       // (a clip cut short: no click at its end)
      g.gain.linearRampToValueAtTime(0, t + len);
      if (lowpass) {
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.7;
        src.connect(f).connect(g);
      } else src.connect(g);
      g.connect(dest);
      src.start(t);
      return true;
    } catch { return false; }
  }

  // A loop that joins without a seam: the last `xf` s crossfaded (equal power) into the start.
  // Resolves to the new buffer. (In slices of a few ms, yielding between them: in one go it was
  // a 70 ms stall -- a loop run once runs mostly in the interpreter -- just as the crowd came in.)
  async _seamless(buf, xf) {
    const c = this.ctx, n = Math.floor(xf * buf.sampleRate);
    if (!c || n < 16 || buf.length < n * 4) return buf;
    const len = buf.length - n, out = c.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const a = buf.getChannelData(ch), b = out.getChannelData(ch);
      for (let i0 = 0; i0 < len; i0 += SEAM_COPY) { b.set(a.subarray(i0, Math.min(len, i0 + SEAM_COPY)), i0); await later(); }
      for (let i0 = 0; i0 < n; i0 += SEAM_FADE) { crossfade(a, b, len, n, i0, Math.min(n, i0 + SEAM_FADE)); await later(); }
    }
    return out;
  }

  /**
   * Loop a sample (the crowd bed) until stopped; it starts once decoded. Always returns a handle:
   * setGain(g, tau = 0.3) glides the level, stop(fade = 0.2) ends it; handle.ok is false when
   * there's no AudioContext or no such sample (the handle then does nothing). out: the node it
   * plays into (default the crowd group); offset: where in the clip it starts (s); rate;
   * seamless: crossfade the loop's seam over this many seconds (the crossfaded copy is kept).
   */
  loop(name, { gain = 1, out = null, offset = 0, rate = 1, seamless = 0 } = {}) {
    const c = this.ctx, v = this.variants(name)[0];
    const h = { ok: false, setGain() {}, stop() {} };
    if (!c || !(v in this.files) || this.failed.has(v)) return h;
    try {
      const k = normGain(v), s = this.sfx;
      const g = c.createGain(); g.gain.value = gain * k; g.connect(out || (s.bus ? s.bus.crowd : s.master));
      let src = null, stopped = false;
      this._load(v).then((buf) => {
        if (!buf || stopped) return;
        if (!seamless) return buf;
        const key = `${v}~${seamless}`;
        if (!this.seams.has(key)) this.seams.set(key, this._seamless(buf, seamless));
        return this.seams.get(key);
      }).then((buf) => {
        if (!buf || stopped) return;
        src = c.createBufferSource(); src.buffer = buf; src.loop = true; src.playbackRate.value = rate;
        src.connect(g); src.start(c.currentTime, offset % buf.duration);
      }).catch(() => {});
      h.ok = true;
      h.setGain = (to, tau = 0.3) => {
        try { g.gain.cancelScheduledValues(c.currentTime); g.gain.setTargetAtTime(to * k, c.currentTime, Math.max(0.005, tau)); } catch { /* closed */ }
      };
      h.stop = (fade = 0.2) => {
        if (stopped) return;
        stopped = true;
        try {
          g.gain.cancelScheduledValues(c.currentTime); g.gain.setTargetAtTime(0, c.currentTime, Math.max(0.005, fade / 4));
          if (src) src.stop(c.currentTime + fade + 0.05);
          setTimeout(() => { try { g.disconnect(); } catch { /* gone */ } }, (fade + 0.1) * 1000);
        } catch { /* closed */ }
      };
    } catch { /* no audio */ }
    return h;
  }
}
