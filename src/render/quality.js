// Dynamic quality: the levels, how frames are landing (FrameStats) and the
// governor that picks a level from that. Pure JS (no three.js, no DOM), so the
// rules are unit-tested (tests/quality.test.js); render/perf.js wires the
// levers to the renderer, the XR session and the scene.
//
// Nobody here has timed the game on a Quest 3S, so instead of guessing one
// setting the game measures itself: in WebXR the frame callback comes once
// per display refresh it makes, so a frame that took too long shows up as a
// gap of two (or more) refresh periods. A missed refresh is reprojected by
// the compositor (smear / judder): that is the signal. The governor drops a
// level fast when refreshes are missed for about a second, climbs back
// slowly after a long clean spell, and backs off (twice as long each time)
// from a level that failed soon after it climbed to it, so it never
// oscillates. It holds still during loading, menus, camera cuts and for a
// moment after every change (its own window must refill first).

// Index 0 is the best. Ultra is the game as designed (every hook's default);
// each level below turns down what costs GPU time, cheapest visual loss first:
//   foveation   fixed foveation (XRProjectionLayer.fixedFoveation): the lens edges at lower resolution; free to change
//   viewport    dynamic viewport scale (XRView.requestViewportScale) where the browser has it: render a smaller
//               part of the eye buffer, upscaled by the compositor (the main continuous lever)
//   fbScale     framebuffer scale for the NEXT session (most runtimes fix it at session start: only the
//               initial guess, from the remembered level, uses it)
//   hz          highest display rate asked for (capped by CONFIG.xr.maxFrameRate)
//   crowd       share of spectators drawn (whole quarters, spread through the stands); crowdAnim: their motion
//   shadows     2 sun shadows of every limb + contact blobs · 1 the same · 0 contact blobs only
//   detail      players' procedural cloth folds and bump (the decals, faces and lighting stay)
//   lodNear     distance (m) inside which a player gets the full-detail mesh
//   turf        the turf's / pitch's blade-and-clay detail texture
//   particles   share of dust / spark particles spawned
//   visionSteps / visionRegion  caps on the vision correction's steps per frame and corrected area (when it is on)
export const LEVELS = [
  { name: 'Ultra',   hz: 90, foveation: 0.5,  viewport: 1.0,  fbScale: 1.0, crowd: 1.0,  crowdAnim: true,  shadows: 2, detail: true,  lodNear: 13, turf: true,  particles: 1.0,  visionSteps: 6, visionRegion: 1.0 },
  { name: 'High',    hz: 90, foveation: 0.7,  viewport: 0.92, fbScale: 1.0, crowd: 1.0,  crowdAnim: true,  shadows: 2, detail: true,  lodNear: 12, turf: true,  particles: 1.0,  visionSteps: 4, visionRegion: 1.0 },
  { name: 'Medium',  hz: 90, foveation: 0.85, viewport: 0.85, fbScale: 0.9, crowd: 0.75, crowdAnim: true,  shadows: 2, detail: false, lodNear: 11, turf: true,  particles: 0.75, visionSteps: 2, visionRegion: 0.9 },
  { name: 'Low',     hz: 72, foveation: 1.0,  viewport: 0.8,  fbScale: 0.85, crowd: 0.75, crowdAnim: false, shadows: 1, detail: false, lodNear: 10, turf: true,  particles: 0.5,  visionSteps: 1, visionRegion: 0.8 },
  { name: 'Minimum', hz: 72, foveation: 1.0,  viewport: 0.7,  fbScale: 0.8, crowd: 0.5,  crowdAnim: false, shadows: 0, detail: false, lodNear: 8,  turf: false, particles: 0.35, visionSteps: 1, visionRegion: 0.7 },
];
export const QUALITY_NAMES = ['auto', ...LEVELS.map((l) => l.name.toLowerCase())];   // the setting's values

// Settings value ('auto' | 'ultra' ...) -> fixed level index, or -1 for auto.
export function fixedLevel(setting) {
  const i = LEVELS.findIndex((l) => l.name.toLowerCase() === setting);
  return i;
}

// How frames are landing, over a rolling window (default 1 s). One call a
// frame; nothing is allocated after the constructor.
//   frame(nowMs, updMs, rendMs): this frame's callback time and the CPU ms
//   spent in the game's update and in submitting the draw.
// A refresh is "missed" when the gap since the frame before is more than
// 1.5 periods of the target rate (round(gap / period) - 1 refreshes went by
// without a new frame). Without a target (a monitor: the rate is the
// screen's) the period is learnt from the shortest recent gaps.
export class FrameStats {
  constructor({ windowMs = 1000, cap = 256 } = {}) {
    this.windowMs = windowMs; this.cap = cap;
    this.t = new Float64Array(cap); this.miss = new Uint8Array(cap); this.upd = new Float32Array(cap); this.rend = new Float32Array(cap);
    this.head = 0; this.n = 0;
    this.sumMiss = 0; this.sumLate = 0; this.sumUpd = 0; this.sumRend = 0;
    this.lastAt = null; this.lastGap = 0;
    this.period = 1000 / 72; this.targetHz = 0;
    this.totalFrames = 0; this.totalMissed = 0;
    this.learnt = 1000 / 60;
  }

  setTarget(hz) { this.targetHz = hz || 0; if (hz) this.period = 1000 / hz; }
  reset() { this.head = 0; this.n = 0; this.sumMiss = this.sumLate = this.sumUpd = this.sumRend = 0; this.lastAt = null; }

  frame(now, updMs = 0, rendMs = 0) {
    const gap = this.lastAt == null ? 0 : now - this.lastAt;
    this.lastAt = now; this.lastGap = gap;
    if (!this.targetHz && gap > 0) {
      // (no target: follow the shortest gaps, slowly upward so a slow spell is not taken for the rate)
      this.learnt = gap < this.learnt ? this.learnt * 0.8 + gap * 0.2 : this.learnt * 0.999 + gap * 0.001;
      this.period = this.learnt;
    }
    let missed = 0;
    if (gap > this.period * 1.5) missed = Math.min(255, Math.round(gap / this.period) - 1);
    // drop what has left the window (and the oldest when full)
    while (this.n > 0) {
      const i = (this.head - this.n + this.cap) % this.cap;
      if (this.n < this.cap && now - this.t[i] <= this.windowMs) break;
      this.sumMiss -= this.miss[i]; this.sumLate -= this.miss[i] > 0 ? 1 : 0; this.sumUpd -= this.upd[i]; this.sumRend -= this.rend[i];
      this.n--;
    }
    const j = this.head;
    this.t[j] = now; this.miss[j] = missed; this.upd[j] = updMs; this.rend[j] = rendMs;
    this.sumMiss += missed; this.sumLate += missed > 0 ? 1 : 0; this.sumUpd += updMs; this.sumRend += rendMs;
    this.head = (j + 1) % this.cap; this.n++;
    this.totalFrames++; this.totalMissed += missed;
    return missed;
  }

  // Over the window: refreshes missed as a share of all refreshes (%): what you see.
  get missedPct() { const n = this.n + this.sumMiss; return n > 0 ? (this.sumMiss / n) * 100 : 0; }
  // Frames that came late as a share of frames (%): what the governor reads. One long hitch
  // (a GC, a first-time upload) is one late frame however many refreshes it covered, so it
  // cannot by itself cost a level; a GPU that cannot keep up makes most frames late.
  get latePct() { return this.n > 0 ? (this.sumLate / this.n) * 100 : 0; }
  get fps() {
    if (this.n > 1) return (this.n - 1) * 1000 / Math.max(1, this.spanMs);
    return this.lastGap > 0 ? 1000 / this.lastGap : 0;          // (under one frame a window: the last gap)
  }
  get updMs() { return this.n ? this.sumUpd / this.n : 0; }
  get rendMs() { return this.n ? this.sumRend / this.n : 0; }
  // Seconds of frames in the window (the governor waits for a full one).
  get spanMs() { return this.n > 1 ? this.t[(this.head - 1 + this.cap) % this.cap] - this.t[(this.head - this.n + this.cap) % this.cap] : 0; }
  // Where the time goes when refreshes are missed: 'cpu' when the game's own
  // work nearly fills the period (the GPU cannot be the only cause), 'gpu'
  // when it leaves plenty (the GPU or the compositor did not finish), else ''.
  get bound() {
    if (this.latePct < 1) return '';
    return this.updMs + this.rendMs > this.period * 0.8 ? 'cpu' : 'gpu';
  }
}

// The governor. update(dt, latePct, paused, windowFull) once a frame
// (dt in seconds, latePct: FrameStats.latePct); returns the level to use (an
// index into LEVELS). It drops when frames have been late (>= dropPct of the
// last second's) for badS on end: within about a second of trouble starting.
export class Governor {
  constructor({ levels = LEVELS.length, start = 0, top = 0, dropPct = 8, bigDropPct = 40, cleanPct = 1,
    badS = 0.5, climbS = 10, holdS = 2, probationS = 15, maxClimbS = 160 } = {}) {
    Object.assign(this, { levels, top, dropPct, bigDropPct, cleanPct, badS, climbS, holdS, probationS, maxClimbS });
    this.bad = 0;                   // s the late share has been over dropPct
    this.level = Math.max(top, Math.min(levels - 1, start));
    this.fixed = -1;                // >= 0: a level chosen in the settings
    this.hold = holdS;              // s before the next decision
    this.clean = 0;                 // s of clean frames at this level
    this.fails = new Uint8Array(levels);   // failed climbs to each level (the wait to climb there doubles each time)
    this.sinceClimb = Infinity;     // s since the last climb (a drop inside probation counts as its failure)
    this.bench = 0;                 // s of benchmark left: quick decisions, menus allowed
    this.changes = 0;
    this.lastReason = '';
  }

  setFixed(i) {
    this.fixed = i;
    if (i >= 0) this.level = i;
    else this.hold = this.holdS;
  }

  // The first seconds in the headset: drop on half a second of misses, climb after 2 s clean.
  benchmark(seconds) { this.bench = seconds; this.hold = Math.min(this.hold, 0.5); }

  climbNeed(level) { return Math.min(this.maxClimbS, this.climbS * Math.pow(2, this.fails[level])); }

  set(level, reason) {
    level = Math.max(this.top, Math.min(this.levels - 1, level));
    if (level === this.level) return;
    if (level < this.level) this.sinceClimb = 0;
    this.level = level; this.changes++; this.lastReason = reason;
    this.hold = this.bench > 0 ? 1.0 : this.holdS; this.clean = 0; this.bad = 0;
  }

  update(dt, latePct, paused = false, windowFull = true) {
    if (this.fixed >= 0) return (this.level = this.fixed);
    const bench = this.bench > 0;
    if (bench) this.bench -= dt;
    this.sinceClimb += dt;
    if (paused && !bench) { this.clean = 0; this.bad = 0; return this.level; }
    if (this.hold > 0) { this.hold -= dt; this.clean = 0; this.bad = 0; return this.level; }
    if (!windowFull) return this.level;
    if (latePct >= this.dropPct) {
      this.bad += dt; this.clean = 0;
      if (this.bad < (bench ? this.badS / 2 : this.badS)) return this.level;
      // a climb that failed soon after: wait twice as long before trying that level again
      if (this.sinceClimb < this.probationS && this.fails[this.level] < 8) this.fails[this.level]++;
      this.set(this.level + (latePct >= this.bigDropPct ? 2 : 1), `late ${latePct.toFixed(0)}%`);
      return this.level;
    }
    this.bad = 0;
    if (latePct <= this.cleanPct) this.clean += dt; else this.clean = 0;
    if (this.level > this.top && this.clean >= (bench ? 2 : this.climbNeed(this.level - 1))) this.set(this.level - 1, 'clean');
    return this.level;
  }
}

// A short stable key for "this headset / this GPU" (the remembered level is per device).
export function deviceKey(ua = '', gpu = '') {
  const m = /(Quest[^;)]*|Pico[^;)]*|Vive[^;)]*|Android [0-9.]+; [^;)]+)/.exec(ua);
  const s = `${m ? m[1].trim() : /Windows|Mac OS X|Linux|CrOS/.exec(ua)?.[0] || 'device'}|${gpu}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(m ? m[1] : 'pc').replace(/[^A-Za-z0-9]+/g, '').slice(0, 16)}-${(h >>> 0).toString(36)}`;
}

// The level to start at: the one remembered for this device, else a guess
// (a standalone headset one below the top; a PC the top).
export function startLevel(remembered, ua = '') {
  if (remembered != null && remembered >= 0 && remembered < LEVELS.length) return remembered;
  return /Quest|Pico|OculusBrowser|Android/.test(ua) ? 1 : 0;
}
