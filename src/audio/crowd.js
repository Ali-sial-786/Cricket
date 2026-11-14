// The crowd: recorded reactions (oohs, gasps, groans, whoas, cheers,
// ovations, laughs — CC0 / public-domain cuts from the Courtside project) on
// top of the recorded murmur, plus a synthesised terrace: rhythmic clapping
// chants, a drum, whistles and scattered single claps. The home crowd is on
// your side.
//
//   const crowd = new CrowdAudio(sfx, samples, rng);
//   crowd.update(dt, { excitement })      every frame (ambient life)
//   crowd.react('four' | 'six' | 'beaten' | 'edge' | 'close' | 'dropped' |
//               'wicketFor' | 'wicketAgainst' | 'skied' | 'dot' | 'milestone' |
//               'boundaryAgainst' | 'appeal' | 'miss')

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class CrowdAudio {
  constructor(sfx, samples, rng = Math.random) {
    this.sfx = sfx; this.samples = samples; this.rng = rng;
    this.nextChant = 18 + rng() * 15;
    this.nextWhistle = 6 + rng() * 8;
    this.nextClap = 1;
    this.chant = null;
    this.excitement = 0.3;          // 0..1, rises with boundaries / wickets, decays
    this.lastReact = -9;
    this.t = 0;
  }

  get ctx() { const s = this.sfx; return s && s.ctx && s.enabled !== false ? s.ctx : null; }

  // ---------------------------------------------------------------- reactions
  react(kind, strength = 1) {
    const S = this.samples, now = this.t;
    const play = (name, gain = 0.8, when = 0, rate = 1) => S.play(name, { gain: gain * clamp(strength, 0.3, 1.3), when, rate: rate * (0.97 + this.rng() * 0.06) });
    switch (kind) {
      case 'six':
        play('crowd_whoa_cheer', 0.9); play('crowd_cheer_big', 0.85, 0.35); play('crowd_applause_loud', 0.6, 1.4);
        this.bump(0.6); this.startChant(2.2, 'six');
        break;
      case 'four':
        play('crowd_cheer', 0.8); play('crowd_applause', 0.55, 0.8);
        this.bump(0.4); if (this.rng() < 0.5) this.startChant(2.5, 'four');
        break;
      case 'boundaryAgainst':
        play('crowd_groan', 0.5); play('crowd_applause_short', 0.4, 0.9);
        break;
      case 'wicketFor':                 // the home side took a wicket
        play('crowd_cheer_big', 0.95); play('crowd_ovation', 0.6, 1.2);
        this.bump(0.7); this.startChant(2.0, 'wicket');
        break;
      case 'wicketAgainst':             // you are out
        play('crowd_groan', 0.85); play('crowd_aww', 0.6, 0.5); play('crowd_applause_short', 0.4, 2.2);
        this.excitement *= 0.5;
        break;
      case 'beaten':                    // play and miss / beaten outside off
        play(this.rng() < 0.6 ? 'crowd_ooh' : 'crowd_aah', 0.7);
        this.bump(0.12);
        break;
      case 'edge':
        play(this.rng() < 0.5 ? 'crowd_gasp' : 'crowd_ooh', 0.75);
        this.bump(0.15);
        break;
      case 'close':                     // close run-out, catch just short, umpire's call…
        play('crowd_gasp_voiced', 0.8);
        this.bump(0.2);
        break;
      case 'dropped':
        play('crowd_aww', 0.85); play('crowd_groan', 0.4, 0.4);
        break;
      case 'skied':                     // up in the air: the crowd rises with it
        if (now - this.lastReact > 0.8) play('crowd_inhale', 0.55), play('crowd_whoa', 0.6, 0.25);
        break;
      case 'dot':
        if (this.rng() < 0.35) play('crowd_applause_short', 0.35);
        break;
      case 'milestone':
        play('crowd_ovation', 0.9); play('crowd_cheer', 0.5, 0.2);
        this.bump(0.5);
        break;
      case 'appeal':
        play('crowd_inhale', 0.5);
        break;
      case 'miss':                      // a wild swing at nothing
        if (this.rng() < 0.3) play('crowd_laugh', 0.45); else play('crowd_ooh', 0.5);
        break;
      default:
    }
    this.lastReact = now;
  }

  bump(x) { this.excitement = clamp(this.excitement + x, 0, 1); }

  // ---------------------------------------------------------------- terrace
  update(dt) {
    this.t += dt;
    const c = this.ctx;
    this.excitement = Math.max(0.25, this.excitement - dt * 0.012);
    if (!c) return;
    // A rhythmic clapping chant every so often (more often when it's lively).
    this.nextChant -= dt * (0.6 + this.excitement);
    if (this.nextChant <= 0 && !this.chant) { this.startChant(4 + this.rng() * 4); }
    if (this.chant) this.tickChant(dt);
    // Whistles from somewhere in the stands.
    this.nextWhistle -= dt;
    if (this.nextWhistle <= 0) { this.whistle(); this.nextWhistle = 5 + this.rng() * 12 * (1.2 - this.excitement); }
    // Scattered single claps and shouts of encouragement between balls.
    this.nextClap -= dt;
    if (this.nextClap <= 0) { this.clap(0.05 + 0.05 * this.rng(), this.rng() * 0.1); this.nextClap = 0.4 + this.rng() * 2.5; }
  }

  // Patterns: 1 = clap, 0 = rest; one step = `beat` seconds. Drums on 'D'.
  startChant(secs = 5, why = '') {
    const patterns = [
      { p: '1 1 111 1 1 111 ', beat: 0.2 },            // the classic "clap clap clap-clap-clap"
      { p: '1010101010101010', beat: 0.27 },           // steady clapping
      { p: 'D 1 D 1 DD1 D 1 ', beat: 0.22 },           // drum and claps
      { p: '111 111 111 1111', beat: 0.17 },
    ];
    const pick = why === 'six' || why === 'wicket' ? patterns[2] : patterns[Math.floor(this.rng() * patterns.length)];
    this.chant = { ...pick, step: 0, acc: 0, left: secs, gain: 0.5 + this.excitement * 0.5 };
    this.nextChant = 25 + this.rng() * 30;
  }

  tickChant(dt) {
    const ch = this.chant;
    ch.acc += dt;
    ch.left -= dt;
    while (ch.acc >= ch.beat) {
      ch.acc -= ch.beat;
      const sym = ch.p[ch.step % ch.p.length];
      const fade = clamp(ch.left / 1.2, 0, 1) * clamp((ch.step + 1) / 6, 0, 1);
      if (sym === '1') this.crowdClap(ch.gain * fade);
      else if (sym === 'D') { this.drum(0.5 * ch.gain * fade); this.crowdClap(0.6 * ch.gain * fade); }
      ch.step++;
    }
    if (ch.left <= 0) this.chant = null;
  }

  // Thousands clapping together: a few noise bursts, slightly spread in time.
  crowdClap(g) {
    const s = this.sfx;
    for (let i = 0; i < 4; i++) {
      s.noise(0.05 + this.rng() * 0.03, { freq: 1300 + this.rng() * 900, q: 0.9, gain: g * 0.09, attack: 0.002, when: this.rng() * 0.03 });
    }
    s.noise(0.09, { type: 'lowpass', freq: 900, q: 0.5, gain: g * 0.05, when: 0.01 });
  }

  clap(g, when) { this.sfx.noise(0.03, { freq: 1800 + this.rng() * 1500, q: 1.6, gain: g, when }); }

  drum(g) {
    const s = this.sfx;
    s.tone(66, 0.32, { type: 'sine', gain: g * 0.55, attack: 0.004, slide: 0.6 });
    s.noise(0.06, { type: 'lowpass', freq: 380, q: 0.6, gain: g * 0.25 });
  }

  // A two-finger whistle from the stands (sometimes the rising "wheee-oo").
  whistle() {
    const s = this.sfx, f = 2300 + this.rng() * 900, g = 0.025 + this.rng() * 0.02;
    if (this.rng() < 0.5) {
      s.tone(f, 0.45, { type: 'sine', gain: g, attack: 0.03, slide: 1.16 });
      s.tone(f * 1.1, 0.5, { type: 'sine', gain: g * 0.8, attack: 0.03, when: 0.5, slide: 0.74 });
    } else {
      s.tone(f, 0.25, { type: 'sine', gain: g, attack: 0.02 });
      s.tone(f, 0.25, { type: 'sine', gain: g, attack: 0.02, when: 0.32 });
    }
  }
}
