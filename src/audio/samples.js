// Recorded sound effects (assets/audio): the bat, the crowd, the stumps, the umpire's cues.
// Lazily fetched and decoded through the Sfx AudioContext, cached, played into sfx.master.
// Nothing here throws: a missing file, no AudioContext or sound off just returns false, so
// callers can fall back to the synthesised effect:  samples.play('bat_sweet') || sfx.batCrack(...)
//
//   const samples = new Samples(sfx);
//   samples.preload();                    // after sfx.init() (a user gesture); resolves to the count loaded
//   samples.play('roar_six', { gain: 0.8 });
//   const bed = samples.loop('crowd_bed', { gain: 0.3 });  bed.setGain(0.15, 0.4);  bed.stop();

const DIR = './assets/audio/';
const OGG = ['bat_sweet_1', 'bat_sweet_2', 'bat_sweet_3', 'bat_edge_1', 'bat_edge_2', 'bat_block_1', 'bat_block_2',
  'crowd_bed', 'applause_polite_1', 'applause_polite_2', 'applause_warm', 'cheer_four', 'roar_six', 'roar_wicket',
  'appeal', 'howzat'];
const WAV = ['stumps', 'bails', 'gloves', 'pad', 'catch', 'drs_stinger', 'chime', 'umpire_out', 'umpire_not_out',
  'coin', 'footstep_1', 'footstep_2', 'cam_whoosh'];
// A group name plays one of its variants at random.
const GROUPS = { bat_sweet: 3, bat_edge: 2, bat_block: 2, applause_polite: 2, footstep: 2 };

export class Samples {
  constructor(sfx) {
    this.sfx = sfx;
    this.files = {};                   // name -> file
    for (const n of OGG) this.files[n] = `${n}.ogg`;
    for (const n of WAV) this.files[n] = `${n}.wav`;
    this.buffers = new Map();          // name -> AudioBuffer
    this.pending = new Map();          // name -> Promise<AudioBuffer | null>
    this.failed = new Set();           // names whose file is missing or won't decode
    this.last = {};                    // group -> the variant played last (not twice running)
  }

  get ctx() {
    const s = this.sfx;
    return s && s.ctx && s.master && s.ctx.state !== 'closed' ? s.ctx : null;
  }

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
   * Play a sample once. gain: linear; rate: playback rate; when: seconds from now.
   * Returns true when it started; false (and starts loading it) when it isn't decoded yet,
   * is unknown / missing, or there's no sound.
   */
  play(name, { gain = 1, rate = 1, when = 0 } = {}) {
    try {
      const c = this.ctx;
      if (!c || this.sfx.enabled === false) return false;
      const buf = this._pick(name);
      if (!buf) return false;
      const src = c.createBufferSource();
      src.buffer = buf; src.playbackRate.value = rate;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(g).connect(this.sfx.master);
      src.start(c.currentTime + Math.max(0, when));
      return true;
    } catch { return false; }
  }

  /**
   * Loop a sample (the crowd bed) until stopped; it starts once decoded. Always returns a handle:
   * setGain(g, tau = 0.3) glides the level, stop(fade = 0.2) ends it; handle.ok is false when
   * there's no AudioContext or no such sample (the handle then does nothing).
   */
  loop(name, { gain = 1 } = {}) {
    const c = this.ctx, v = this.variants(name)[0];
    const h = { ok: false, setGain() {}, stop() {} };
    if (!c || !(v in this.files) || this.failed.has(v)) return h;
    try {
      const g = c.createGain(); g.gain.value = gain; g.connect(this.sfx.master);
      let src = null, stopped = false;
      this._load(v).then((buf) => {
        if (!buf || stopped) return;
        src = c.createBufferSource(); src.buffer = buf; src.loop = true;
        src.connect(g); src.start();
      }).catch(() => {});
      h.ok = true;
      h.setGain = (to, tau = 0.3) => {
        try { g.gain.cancelScheduledValues(c.currentTime); g.gain.setTargetAtTime(to, c.currentTime, Math.max(0.005, tau)); } catch { /* closed */ }
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
