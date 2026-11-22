// The crowd: a bed that surrounds you and breathes with the game, reactions that swell from the
// side of the ground the ball went to, and the stands' own life between balls. The home crowd is
// on your side.
//
// The bed: the recorded murmur (one 40 s take, its loop seam crossfaded) played by four emitters
// round the bowl, each from a different point in the take and at a hair's different speed (so
// they never line up and the ground is wide, turning with your head), each wandering a dB or two;
// under it a layer of excited noise (the roar) that the mood swells. Its level, its roar and how
// bright it is come from CrowdMood (crowdMood.js): quiet between balls, building in the run-up,
// a held breath at the release, the roar after a boundary dying away over seconds, hushed for a
// review, tense in a close finish.
//
// Reactions (CC0 / public-domain cuts from the Courtside project): each is a few recorded layers
// placed round the ground: the first where the ball went (if it went somewhere), the others to
// either side or all round; the stereo roars wide.
//
// The stands (synthesised): rhythmic clapping chants and a drum from the fans' block that build
// and die away, whistles, single claps, a horn, shouts, a vendor's call, applause rippling round.
//
//   const crowd = new CrowdAudio(sfx, samples, rng);
//   crowd.update(dt, { active, present, practice, menu, situation })   every frame
//   crowd.cue(kind, ctx)                                               the game's match events
//   crowd.react(kind, strength, ballPos)                               see REACT below
import { CrowdMood } from './crowdMood.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
const MID_Z = -10;                    // the middle of the pitch
const BLOCK = 2.25;                   // the fans' block (azimuth round the middle: 0 = behind the batting end)
const BED_GAIN = 0.35;                // each of the four emitters, at the class reference (mix.js) (+3 dB: the bed between balls was -30..-34 dBFS, thin on Quest speakers)
const ROAR_GAIN = 0.22;               // the excited layer at roar 1
const EMITTERS = [0.6, 2.2, 3.75, 5.3];   // azimuths of the bed's emitters (round the bowl, not on the axes)

// Where a sound in the stands comes from: az round the middle, r out (the stands are 55-75 m).
const _st = { x: 0, y: 0, z: 0 };
export function stand(az, r = 58, y = 9, out = _st) {
  out.x = Math.sin(az) * r; out.y = y; out.z = MID_Z + Math.cos(az) * r;
  return out;
}
// The azimuth the ball went to (null near the square: everyone is watching the middle).
export function azimuthOf(p) {
  if (!p) return null;
  const dx = p.x, dz = p.z - MID_Z;
  return Math.hypot(dx, dz) < 24 ? null : Math.atan2(dx, dz);
}

// The reactions: layers [clip | group, gain, delay s, place]. place: 'ball' (where the ball went;
// all round when it went nowhere), 'L' / 'R' (to either side of that), 'round' (anywhere), 'wide'
// (a stereo recording, not placed).
const REACT = {
  six: [['crowd_whoa_cheer', 0.8, 0, 'ball'], ['crowd_cheer_big', 0.7, 0.3, 'L'], ['roar_six', 0.5, 0.1, 'wide'], ['crowd_applause_loud', 0.45, 1.4, 'R']],
  four: [['crowd_cheer', 0.62, 0, 'ball'], ['crowd_applause', 0.42, 0.7, 'L'], ['cheer_four', 0.26, 0.2, 'wide']],
  boundaryAgainst: [['crowd_groan', 0.45, 0, 'ball'], ['crowd_applause_short', 0.35, 0.9, 'R']],
  wicketFor: [['crowd_cheer_big', 0.85, 0, 'round'], ['roar_wicket', 0.5, 0.05, 'wide'], ['crowd_ovation', 0.5, 1.2, 'L']],
  wicketAgainst: [['crowd_groan', 0.7, 0, 'round'], ['crowd_aww', 0.5, 0.5, 'R'], ['crowd_applause_short', 0.35, 2.2, 'L']],
  beaten: [['ooh|aah', 0.55, 0, 'round'], ['ooh|aah', 0.32, 0.06, 'L']],
  edge: [['crowd_gasp|crowd_ooh', 0.6, 0, 'round'], ['crowd_gasp', 0.32, 0.05, 'R']],
  close: [['crowd_gasp_voiced', 0.65, 0, 'round'], ['crowd_gasp', 0.32, 0.08, 'L']],
  dropped: [['crowd_aww', 0.75, 0, 'ball'], ['crowd_groan', 0.4, 0.4, 'L']],
  skied: [['crowd_inhale', 0.5, 0, 'round'], ['crowd_whoa', 0.55, 0.25, 'ball']],
  dot: [['crowd_applause_short', 0.22, 0, 'round', 0.35]],
  single: [['crowd_applause_short', 0.3, 0, 'round', 0.5]],
  milestone: [['crowd_ovation', 0.75, 0, 'round'], ['crowd_cheer', 0.45, 0.2, 'L'], ['applause_warm', 0.35, 0.5, 'wide']],
  appeal: [['crowd_inhale', 0.45, 0, 'round']],
  miss: [['crowd_laugh|crowd_ooh', 0.42, 0, 'round']],
  lastOver: [['crowd_applause', 0.35, 0, 'round'], ['crowd_cheer', 0.3, 0.4, 'L']],
  win: [['crowd_cheer_big', 0.9, 0, 'round'], ['crowd_ovation', 0.7, 0.6, 'L'], ['roar_six', 0.45, 0.2, 'wide'], ['crowd_applause_loud', 0.5, 1.5, 'R']],
  lose: [['crowd_aww', 0.6, 0, 'round'], ['applause_polite', 0.45, 1.2, 'wide']],
};
const CHANT_AFTER = { six: 2.2, wicketFor: 2.0, four: 2.5, win: 1.5, lastOver: 1.0 };

export class CrowdAudio {
  constructor(sfx, samples, rng = Math.random) {
    this.sfx = sfx; this.samples = samples; this.rng = rng;
    this.mood = new CrowdMood();
    this.nextChant = 18 + rng() * 15;
    this.nextWhistle = 6 + rng() * 8;
    this.nextClap = 1;
    this.nextHorn = 30 + rng() * 40;
    this.nextShout = 10 + rng() * 15;
    this.nextRipple = 25 + rng() * 25;
    this.nextVendor = 60 + rng() * 60;
    this.chant = null;
    this.lastReact = -9;
    this.t = 0;
    this.bed = null;                  // the four emitters (once there is a context)
    this.present = true;
    this.tick = 0;
  }

  get ctx() { const s = this.sfx; return s && s.ctx && s.bus && s.enabled !== false ? s.ctx : null; }
  get excitement() { return this.mood.excite; }

  // ---------------------------------------------------------------- the bed
  startBed() {
    const s = this.sfx, c = this.ctx;
    if (this.bed || !c) return;
    try {
      this.bed = EMITTERS.map((az, i) => {
        const v = s.chain(s.bus.crowd, 'equalpower', 0);
        const p = stand(az, 55, 8);
        s.constructor.place(v.p, p.x, p.y, p.z);
        v.lp.frequency.value = 3500;
        const loop = this.samples.loop('crowd_bed', { gain: 0, out: v.g, offset: i * 10.3 + this.rng() * 2, rate: [1, 0.992, 1.007, 0.996][i], seamless: 1.0 });
        return { v, loop, wander: 1, next: 0 };
      });
      // The roar: pink noise shaped like a stadium's voice (a broad hump round 1 kHz), two
      // takes of it (different places in the noise) shared by the emitters in pairs.
      this.roar = [0, 1].map((k) => {
        const n = c.createBufferSource(); n.buffer = s.pinkBuf; n.loop = true;
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 0.55;
        const hs = c.createBiquadFilter(); hs.type = 'peaking'; hs.frequency.value = 2600; hs.Q.value = 0.8; hs.gain.value = 4;
        const g = c.createGain(); g.gain.value = 0;
        n.connect(bp).connect(hs).connect(g);
        g.connect(this.bed[k].v.g); g.connect(this.bed[k + 2].v.g);
        n.start(c.currentTime, k * 1.7 + this.rng());
        return g;
      });
    } catch (e) { console.warn('crowd bed', e); this.bed = null; }
  }

  applyBed(dt) {
    const c = this.ctx;
    if (!this.bed || !c) return;
    const o = this.mood.out, on = this.present ? 1 : 0;
    for (const e of this.bed) {
      e.next -= dt;
      if (e.next <= 0) { e.wander = 0.8 + this.rng() * 0.4; e.next = 2 + this.rng() * 3; }
    }
    // (10 times a second is plenty for levels gliding with 0.2-1.2 s time constants)
    this.tick -= dt;
    if (this.tick > 0) return;
    this.tick = 0.1;
    const t = c.currentTime, cut = 1800 + 4800 * o.bright, roar = ROAR_GAIN * o.roar * on;
    // (only what changed: the params' automation must not pile up)
    const near = (a, b) => Math.abs(a - b) <= Math.max(1e-4, Math.abs(b) * 0.01);
    for (const e of this.bed) {
      const g = BED_GAIN * o.bed * e.wander * on;
      if (!near(g, e.g ?? -1)) { e.g = g; e.loop.setGain(g, 0.08); }
      if (!near(cut, e.cut ?? -1)) { e.cut = cut; e.v.lp.frequency.cancelScheduledValues(t); e.v.lp.frequency.setTargetAtTime(cut, t, 0.3); }
    }
    if (!near(roar, this.roarG ?? -1)) {
      this.roarG = roar;
      for (const g of this.roar) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(roar, t, 0.15); }
    }
  }

  // ---------------------------------------------------------------- reactions
  cue(kind, ctx = {}) {
    this.mood.cue(kind);
    if (kind === 'over' && ctx && ctx.balls != null && ctx.balls <= 6 && this.mood.tension > 0.3) this.react('lastOver', 0.8);
    if (kind === 'result') this.react(ctx && ctx.winner === 0 ? 'win' : ctx && ctx.tie ? 'four' : 'lose', 1);
  }

  _layer(name, gain, when, place, az, strength) {
    const S = this.samples, r = this.rng;
    if (name.includes('|')) { const alts = name.split('|'); name = alts[Math.floor(r() * alts.length)]; }
    if (!name.startsWith('crowd_') && !S.has(name)) name = `crowd_${name}`;
    const g = gain * clamp(strength, 0.3, 1.3), rate = 0.97 + r() * 0.06;
    if (place === 'wide') return S.play(name, { gain: g, when, rate, crowd: true, prio: 1 });
    let a;
    if (place === 'round' || az == null) a = r() * TAU;
    else a = az + (place === 'L' ? 1.2 : place === 'R' ? -1.2 : 0) + (r() - 0.5) * 0.3;
    return S.play(name, { gain: g, when, rate, pos: stand(a), crowd: true, prio: place === 'ball' || place === 'round' ? 2 : 1 });
  }

  react(kind, strength = 1, ballPos = null) {
    const now = this.t, L = REACT[kind];
    if (!L) return;
    if (kind === 'skied' && now - this.lastReact < 0.8) return;
    this.mood.react(kind, strength);
    if (this.present && this.ctx) {
      const az = azimuthOf(ballPos), sparse = this.mood.practice;      // (the nets: a few hundred in, no chants)
      for (const [name, gain, when, place, chance] of L) if (chance == null || this.rng() < chance) this._layer(name, sparse ? gain * 0.2 : gain, when, place, az, strength);
      const ch = !sparse && CHANT_AFTER[kind];
      if (ch && (kind !== 'four' || this.rng() < 0.5)) this.startChant(ch + 2 + this.rng() * 3, kind);
    }
    this.lastReact = now;
  }

  /** A recorded applause clip (applause_polite, applause_warm) from round the ground. */
  applause(name, gain = 0.6) {
    return this._layer(name, gain * 0.7, 0, 'round', null, 1) && this._layer(name, gain * 0.45, 0.12, 'round', null, 1);
  }

  // ---------------------------------------------------------------- the stands
  update(dt, { active = true, present = true, practice = false, menu = false, situation = null } = {}) {
    this.t += dt;
    this.present = present;
    const M = this.mood;
    M.practice = practice; M.menu = menu;
    if (situation) M.situation(situation);
    M.update(dt);
    const c = this.ctx;
    if (!c) return;
    if (!this.bed) this.startBed();
    this.applyBed(dt);
    if (!active || !present) return;
    const o = M.out, rate = o.detail, quiet = o.hush > 0.4;
    if (this.chant) this.tickChant(dt);
    // A chant now and then (more often when it's lively).
    this.nextChant -= dt * rate;
    if (this.nextChant <= 0 && !this.chant && !quiet) this.startChant(4 + this.rng() * 5, this.rng() < 0.3 ? 'drums' : '');
    if (quiet) return;                         // (the ball is on its way: nobody whistles)
    this.nextWhistle -= dt * rate;
    if (this.nextWhistle <= 0) { this.whistle(); this.nextWhistle = 5 + this.rng() * 12; }
    this.nextClap -= dt * rate;
    if (this.nextClap <= 0) { this.clap(0.05 + 0.05 * this.rng()); this.nextClap = 0.4 + this.rng() * 2.5; }
    this.nextHorn -= dt * rate;
    if (this.nextHorn <= 0) { this.horn(); this.nextHorn = 35 + this.rng() * 50; }
    this.nextShout -= dt * rate;
    if (this.nextShout <= 0) { this.shout(); this.nextShout = 9 + this.rng() * 20; }
    this.nextRipple -= dt * rate;
    if (this.nextRipple <= 0) { this.ripple(); this.nextRipple = 25 + this.rng() * 30; }
    this.nextVendor -= dt;
    if (this.nextVendor <= 0) { this.vendor(); this.nextVendor = 70 + this.rng() * 80; }
  }

  // Patterns: 1 = clap, 0 / space = rest; one step = `beat` seconds. Drums on 'D', a drum alone on 'd'.
  startChant(secs = 5, why = '') {
    const patterns = [
      { p: '1 1 111 1 1 111 ', beat: 0.2 },            // the classic "clap clap clap-clap-clap"
      { p: '1010101010101010', beat: 0.27 },           // steady clapping
      { p: 'D 1 D 1 DD1 D 1 ', beat: 0.22 },           // drum and claps
      { p: '111 111 111 1111', beat: 0.17 },
    ];
    const drums = { p: 'd d dd d d dd   ', beat: 0.21 };
    const pick = why === 'drums' ? drums : why === 'six' || why === 'wicketFor' || why === 'win' ? patterns[2] : patterns[Math.floor(this.rng() * patterns.length)];
    // The whole chant comes from the fans' block (one voice of the stands' for its length).
    const out = this.sfx.at(stand(BLOCK + (this.rng() - 0.5) * 0.4, 62, 11), { crowd: true, dur: secs + 1, prio: 0 }).out;
    this.chant = { ...pick, step: 0, acc: 0, left: secs, gain: 0.5 + this.mood.excite * 0.5, out };
    this.nextChant = 25 + this.rng() * 30;
  }

  tickChant(dt) {
    const ch = this.chant;
    ch.acc += dt;
    ch.left -= dt;
    while (ch.acc >= ch.beat) {
      ch.acc -= ch.beat;
      const sym = ch.p[ch.step % ch.p.length];
      // (it catches on over the first bars and dies away at the end)
      const fade = clamp(ch.left / 1.5, 0, 1) * clamp((ch.step + 1) / 10, 0.15, 1);
      if (sym === '1') this.crowdClap(ch.gain * fade, ch.out);
      else if (sym === 'D') { this.drum(0.5 * ch.gain * fade, ch.out); this.crowdClap(0.6 * ch.gain * fade, ch.out); }
      else if (sym === 'd') this.drum(0.6 * ch.gain * fade, ch.out);
      ch.step++;
    }
    if (ch.left <= 0) this.chant = null;
  }

  // Thousands clapping together: a few noise bursts, slightly spread in time.
  crowdClap(g, out) {
    const s = this.sfx;
    for (let i = 0; i < 3; i++) {
      s.noise(0.05 + this.rng() * 0.03, { out, freq: 1300 + this.rng() * 900, q: 0.9, gain: g * 0.25, when: this.rng() * 0.035, prio: 0 });
    }
    s.noise(0.09, { out, type: 'lowpass', freq: 900, q: 0.5, gain: g * 0.12, when: 0.01, prio: 0 });
  }

  clap(g) { this.sfx.noise(0.03, { pos: stand(this.rng() * TAU, 50 + this.rng() * 15), crowd: true, freq: 1800 + this.rng() * 1500, q: 1.6, gain: g, prio: 0 }); }

  drum(g, out) {
    const s = this.sfx;
    s.tone(66, 0.32, { out, gain: g * 0.9, attack: 0.004, slide: 0.6, prio: 0 });
    s.noise(0.06, { out, type: 'lowpass', freq: 380, q: 0.6, gain: g * 0.4, prio: 0 });
  }

  // A two-finger whistle from the stands (sometimes the rising "wheee-oo").
  whistle() {
    const s = this.sfx, f = 2300 + this.rng() * 900, g = 0.035 + this.rng() * 0.025;
    const out = s.at(stand(this.rng() * TAU), { crowd: true, dur: 1.1, prio: 0 }).out;
    if (this.rng() < 0.5) {
      s.tone(f, 0.45, { out, gain: g, attack: 0.03, slide: 1.16, prio: 0 });
      s.tone(f * 1.1, 0.5, { out, gain: g * 0.8, attack: 0.03, when: 0.5, slide: 0.74, prio: 0 });
    } else {
      s.tone(f, 0.25, { out, gain: g, attack: 0.02, prio: 0 });
      s.tone(f, 0.25, { out, gain: g, attack: 0.02, when: 0.32, prio: 0 });
    }
  }

  // A fan's horn (two reeds a third apart): two short blasts and a long one, from the block.
  horn() {
    const s = this.sfx, c = this.ctx;
    if (!c) return;
    const out = s.at(stand(BLOCK + (this.rng() - 0.5), 64, 11), { crowd: true, dur: 1.6, prio: 0 }).out;
    const f = 310 + this.rng() * 90, g = 0.05 + this.rng() * 0.03;
    [[0, 0.16], [0.24, 0.16], [0.48, 0.55]].forEach(([w, d]) => {
      s.tone(f, d, { out, type: 'sawtooth', gain: g, attack: 0.02, when: w, prio: 0 });
      s.tone(f * 1.26, d, { out, type: 'sawtooth', gain: g * 0.6, attack: 0.02, when: w, prio: 0 });
    });
  }

  // A shout of encouragement from somewhere (a voice, far off: "hey!", "oi!", "c'mon!").
  shout() {
    const r = this.rng, calls = [['e', 'i'], ['o', 'i'], ['a', 'i'], ['uh', 'o'], ['e', 'o']];
    const female = r() < 0.3;
    this.sfx.voice({ pos: stand(r() * TAU, 40 + r() * 20, 6), crowd: true, f0: female ? 230 + r() * 50 : 130 + r() * 60, glide: 0.8 + r() * 0.15,
      vowels: calls[Math.floor(r() * calls.length)], dur: 0.25 + r() * 0.3, gain: 0.15 + r() * 0.1, breath: 0.3, prio: 0 });
  }

  // A vendor calling his wares: a two-note sing-song, faint, a long way round the ground.
  vendor() {
    const r = this.rng, pos = stand(r() * TAU, 50, 7), f = 150 + r() * 30;
    const out = this.sfx.at(pos, { crowd: true, dur: 1.4, prio: 0 }).out;
    this.sfx.voice({ out, f0: f, glide: 0.98, vowels: ['o', 'a'], dur: 0.35, gain: 0.11, breath: 0.2, prio: 0 });
    this.sfx.voice({ out, f0: f * 0.84, glide: 0.9, vowels: ['e', 'i'], dur: 0.5, gain: 0.11, breath: 0.2, when: 0.45, prio: 0 });
  }

  // Applause rippling round a stand (someone's nice bit of fielding, a return to the dressing room).
  ripple() { this._layer('crowd_applause_short', 0.2, 0, 'round', null, 1); }
}
