// Performance control: measures every frame (render/quality.js FrameStats),
// runs the two quality governors (graphics, processor) in the headset, turns the levers each level
// names (the hooks in session.js, crowd.js, shadows.js, humanoid.js,
// ground.js, particles.js, visionCorrect.js) and keeps the per-headset
// level in localStorage. The game calls sample() once a frame from its
// animation loop (main.js -> Game.sampleFrame) with the CPU time of the
// update and of the draw submission. Nothing here allocates per frame.
//
// Console / harness: __game.perf.force('low') (or 'auto'), __game.perf.report()
// (texture / geometry memory estimates and the current numbers).
import { CONFIG } from '../config.js';
import { LEVELS, CPU_LEVELS, cpuLevelFor, SHARPNESS, nextSharpness, FrameStats, Governor, fixedLevel, deviceKey, startLevel } from './quality.js';
import { ShadowPool, Humanoid, ANIM_LOD } from './humanoid.js';
import { GROUND_QUALITY } from './ground.js';
import { PerfPanel } from './perfPanel.js';
import { loadJSON, saveJSON } from '../game/settings.js';

const KEY = 'creasevr.quality.v2';   // (v1 remembered levels of the old single ladder, which cut resolution for a slow CPU)
const REMEMBER_S = 20;          // a level held this long in the headset is remembered for it
// How often far, calm fielders get a new pose at each processor level's `anim` (the root, the
// ground guard and the shadow still move every frame; nothing inside 12 m is ever thinned).
const ANIM_LEVELS = [
  { near: 18, far: 40, midDiv: 2, farDiv: 3 },
  { near: 14, far: 32, midDiv: 2, farDiv: 4 },
  { near: 12, far: 25, midDiv: 3, farDiv: 4 },
];
const SHARP_S = 90;             // s of play before a session's outcome may tune the next one's sharpness

export class PerfControl {
  constructor(game) {
    this.game = game;
    this.stats = new FrameStats();
    const G = CONFIG.xr.governor || {};
    this.ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    this.device = deviceKey(this.ua, gpuName(game.renderer));
    const saved = loadJSON(KEY) || {};
    this.rec = saved[this.device] || {};            // { level, cpu, fb, fbFail, at }
    this.remembered = this.rec.level ?? null;
    const opt = { dropPct: G.dropPct, badS: G.badS, climbS: G.climbS, holdS: G.holdS };
    this.gov = new Governor({ ...opt, start: startLevel(this.rec.level, this.ua) });                                              // graphics
    this.cgov = new Governor({ ...opt, levels: CPU_LEVELS.length, start: startLevel(this.rec.cpu, this.ua, CPU_LEVELS.length) }); // processor
    this.applied = -1; this.cApplied = -1;
    this.setting = null;          // the settings value last read ('auto' | 'ultra' ...)
    this.sharp = null;            // the sharpness setting last read
    this.panel = null;
    this.panelT = 0;
    this.held = 0;                // s at the current levels (remembering)
    this.played = 0;              // s of play this session, and how long at each graphics level (the next session's sharpness)
    this.levelT = new Float64Array(LEVELS.length);
    this.cut = 0;                 // s left of the pause after a camera cut
    this.ex = 0; this.ey = 0; this.ez = 0;
    this.heapMB = 0;
    this.lastNow = null;
    this.visT = 0; this.vision = false; this.xm = null;
    this.lines = ['', '', '', '', ''];
    this.applyLevel(this.gov.level, this.cgov.level);
  }

  // The settings' choice: 'auto' or a level name.
  readSetting() {
    const st = this.game.settings, s = st.quality || 'auto', sh = st.sharpness || 'auto';
    if (sh !== this.sharp) { this.sharp = sh; this.applied = -1; }
    if (s === this.setting) return;
    this.setting = s;
    const f = fixedLevel(s);
    this.gov.setFixed(f);
    this.cgov.setFixed(f >= 0 ? cpuLevelFor(f) : -1);
    this.applied = -1;
    const xm = this.game.xrManager;
    if (xm) xm.autoRate = f >= 0;          // (a fixed level: the old rate step-down still guards it)
  }

  // Force a level from the console / a harness: 'auto' | 'ultra' | ... | 'minimum'.
  force(name) { this.game.settings.quality = name; this.readSetting(); this.applyLevel(this.gov.level, this.cgov.level); }

  get level() { return this.gov.level; }
  get spec() { return LEVELS[Math.max(0, this.applied)]; }
  get cspec() { return CPU_LEVELS[Math.max(0, this.cApplied)]; }
  // The eye buffers' scale for the next session: the setting's, or (auto) the one tuned for this headset.
  get sharpness() { return SHARPNESS[this.sharp] || nextSharpness(this.rec).fb; }

  // Would the game's own work fit the period of `hz` with room to spare?
  fits(hz, share = 0.7) { return this.stats.work < share * 1000 / hz; }

  // Once a frame, after the draw. now: the frame's time (ms); upd / rend: CPU ms of game.frame and of render().
  sample(now, upd, rend) {
    const g = this.game, xm = g.xrManager, inXR = !!(g.input && g.input.xr);
    this.readSetting();
    this.stats.setTarget(inXR && xm && xm.frameRate ? xm.frameRate : 0);
    // (real seconds between frames: the game's dt is clamped for the simulation, and a governor
    // that counts clamped time would take minutes to decide anything on a struggling device)
    const dt = this.lastNow == null ? 0 : Math.min(0.5, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.stats.frame(now, upd, rend);
    // A camera cut (a replay's, a recenter, a teleport) or a hitch right after it is not the level's fault.
    const e = g.eye && g.eye.p;
    if (e) {
      const dx = e.x - this.ex, dy = e.y - this.ey, dz = e.z - this.ez;
      if (dx * dx + dy * dy + dz * dz > 2.25) this.cut = 0.75;
      this.ex = e.x; this.ey = e.y; this.ez = e.z;
    }
    if (this.cut > 0) this.cut -= dt;
    const visible = !xm || !xm.session || !xm.session.visibilityState || xm.session.visibilityState === 'visible';
    // Hard pauses (loading, out of the headset, the headset's own menu, a cut) stop even the benchmark;
    // our menus only stop the governors proper (the benchmark runs on the safety screen).
    // (out of the headset they sit still: a monitor's frame rate says nothing about the headset)
    const hard = !g.ready || !inXR || !visible || this.cut > 0;
    const paused = hard || !!(g.ui && g.ui.menuOpen);
    let lv = this.gov.level, cv = this.cgov.level;
    if (!hard || this.gov.fixed >= 0) {
      // Who is late? The processor ladder when the game's own work nearly fills the period, the
      // graphics ladder when it leaves most of it, both in between. Neither climbs while frames are late;
      // a climb to a faster rate (or to more animation) waits until the work would fit it.
      const S = this.stats, late = S.latePct, b = S.bound, full = S.spanMs >= 900;
      const rate = Math.min(LEVELS[lv].hz, CPU_LEVELS[cv].hz);
      const gUp = lv > 0 ? LEVELS[lv - 1] : null, cUp = cv > 0 ? CPU_LEVELS[cv - 1] : null;
      const gOK = !gUp || gUp.hz <= rate || this.fits(gUp.hz);
      const cOK = !cUp || (cUp.hz > rate ? this.fits(cUp.hz) : this.fits(rate, 0.6));
      const g0 = lv, c0 = cv;
      lv = this.gov.update(dt, late, paused, full, b !== 'cpu', gOK);
      cv = this.cgov.update(dt, late, paused, full, b !== 'gpu', cOK);
      // (one change at a time: whichever moved, the other waits and watches what it did)
      if (lv !== g0) { this.cgov.clean = 0; this.cgov.hold = Math.max(this.cgov.hold, this.cgov.holdS); }
      if (cv !== c0) { this.gov.clean = 0; this.gov.hold = Math.max(this.gov.hold, this.gov.holdS); }
    } else { this.gov.clean = 0; this.gov.bad = 0; this.cgov.clean = 0; this.cgov.bad = 0; }
    // Re-send every lever when the session manager appears (main.js sets it after loading: the next
    // session's framebuffer scale) and when the vision pass turns on or off (it wants full viewports).
    this.visT -= dt;
    if (this.visT <= 0) {
      this.visT = 1;
      const v = typeof g.visionActive === 'function' && g.visionActive();
      if (v !== this.vision) { this.vision = v; this.applied = -1; }
    }
    if (xm !== this.xm) { this.xm = xm; this.applied = -1; }
    if (lv !== this.applied || cv !== this.cApplied) this.applyLevel(lv, cv);
    // Remember levels that have held in the headset (auto only).
    if (inXR && this.gov.fixed < 0 && !paused) {
      this.held += dt; this.played += dt; this.levelT[lv] += dt;
      if (this.held >= REMEMBER_S && (this.rec.level !== lv || this.rec.cpu !== cv)) this.remember(lv, cv);
    }
    if (g.settings.debugFrames) this.updatePanel(dt);
    else if (this.panel && this.panel.mesh.visible) this.panel.mesh.visible = false;
  }

  remember(lv, cv, extra = null) {
    this.remembered = lv;
    Object.assign(this.rec, { level: lv, cpu: cv, at: Date.now() }, extra);
    const saved = loadJSON(KEY) || {};
    saved[this.device] = this.rec;
    saveJSON(KEY, saved);
  }

  onXRStart() {
    this.stats.reset(); this.lastNow = null;
    this.held = 0; this.played = 0; this.levelT.fill(0);
    this.readSetting();
    const xm = this.game.xrManager;
    if (xm) xm.autoRate = this.gov.fixed >= 0;
    // First time in this headset: a quick benchmark on the safety screen (the stadium in view).
    if (this.remembered == null && this.gov.fixed < 0) { const s = (CONFIG.xr.governor || {}).benchmarkS || 8; this.gov.benchmark(s); this.cgov.benchmark(s); }
    else { this.gov.hold = this.gov.holdS; this.cgov.hold = this.cgov.holdS; }
    this.applied = -1;              // (re-send every lever to the new session)
  }

  onXREnd() {
    if (this.gov.fixed < 0 && this.held >= 5) this.remember(this.gov.level, this.cgov.level);
    // The next session's sharpness (auto): from the graphics level this session spent most of its time at.
    if (this.gov.fixed < 0 && this.sharp === 'auto' && this.played >= SHARP_S) {
      let acc = 0, typical = 0;
      for (let i = 0; i < this.levelT.length; i++) { acc += this.levelT[i]; if (acc >= this.played / 2) { typical = i; break; } }
      this.remember(this.rec.level ?? this.gov.level, this.rec.cpu ?? this.cgov.level, nextSharpness(this.rec, typical));
      this.applied = -1;
    }
    this.held = 0; this.played = 0;
  }

  // Every lever of a graphics level and a processor level. Hooks default to the top (the game as designed).
  applyLevel(i, c = this.cgov.level) {
    const L = LEVELS[i], C = CPU_LEVELS[c], g = this.game, xm = g.xrManager;
    if (i !== this.applied || c !== this.cApplied) this.held = 0;
    this.applied = i; this.cApplied = c;
    const vision = typeof g.visionActive === 'function' && g.visionActive();
    if (xm) {
      xm.setFoveation(L.foveation);
      xm.setViewportScale(vision ? 1 : L.viewport);            // (the vision pass reads the full eye viewports)
      xm.setMaxRate(Math.min(L.hz, C.hz));
      xm.setFramebufferScale(this.sharpness);                  // (the next session's)
    }
    const crowd = g.env && g.env.crowd;
    if (crowd && crowd.userData.setQuality) crowd.userData.setQuality(L.crowd, L.crowdAnim);
    ShadowPool.setDetail(Math.min(L.shadows, C.shadows));
    Humanoid.lodNear = L.lodNear;
    const h = Humanoid.all[0];
    if (h && h.material.userData.uniforms.uDetail) h.material.userData.uniforms.uDetail.value = L.detail ? 1 : 0;   // (shared by every figure)
    GROUND_QUALITY.uDetOn.value = L.turf ? 1 : 0;
    if (g.particles) g.particles.keep = Math.min(L.particles, C.particles);
    if (g.vision && g.vision.setCap) g.vision.setCap(L.visionSteps, L.visionRegion);
    Object.assign(ANIM_LOD, ANIM_LEVELS[C.anim] || ANIM_LEVELS[0]);   // (far, calm fielders posed less often: render/humanoid.js)
  }

  updatePanel(dt) {
    const g = this.game;
    if (!this.panel) this.panel = new PerfPanel(g.scene);
    const P = this.panel;
    P.mesh.visible = true;
    if (g.eye) P.place(g.eye, dt);
    this.panelT -= dt;
    if (this.panelT > 0) return;
    this.panelT = 0.5;
    const s = this.stats, xm = g.xrManager, L = this.spec, i = g.renderer.info;
    if (typeof performance !== 'undefined' && performance.memory) this.heapMB = performance.memory.usedJSHeapSize / 1048576;
    const hz = xm && xm.frameRate ? `${xm.frameRate} Hz` : 'monitor';
    const C = this.cspec, fb = xm && xm.fbActive ? xm.fbActive : this.sharpness;
    const lines = this.lines;
    lines[0] = `${s.fps.toFixed(0)} fps · ${hz} · late ${s.latePct.toFixed(1)}% · missed ${s.missedPct.toFixed(1)}%`;
    lines[1] = `${L.name}${this.gov.fixed >= 0 ? ' (fixed)' : ' (auto)'}${this.gov.bench > 0 ? ' benchmarking' : ''} · CPU level ${this.cApplied} · res ${(fb * (xm && xm.vpActive ? L.viewport : 1)).toFixed(2)} · fov ${L.foveation.toFixed(2)}`;
    lines[2] = `CPU ${s.updMs.toFixed(1)} update + ${s.rendMs.toFixed(1)} draw of ${s.period.toFixed(1)} ms${s.bound ? ' · late: ' + s.bound : ''} · anim ${C.anim}`;
    lines[3] = `${i.render.calls} calls · ${(i.render.triangles / 1000).toFixed(0)}k tris · ${i.programs ? i.programs.length : 0} prog · ${i.memory.textures} tex`;
    const vel = g.input && g.input.xr ? (g.input.right.hasXRVel ? 'XR' : 'pose') : 'desktop';     // (was on the Settings page)
    lines[4] = `heap ${this.heapMB.toFixed(0)} MB · long frames ${g.frameLog ? g.frameLog.count : 0} · velocity ${vel} · v${g.version}`;
    P.draw(lines, s.latePct >= 3);
  }

  // A one-off report (allocates: debugging only): the numbers now and memory estimates.
  report() {
    const g = this.game, r = g.renderer, i = r.info, s = this.stats;
    const mem = sceneMemory(g.scene, [g.drs && g.drs.group]);
    return {
      level: this.spec.name, cpuLevel: this.cApplied, fixed: this.gov.fixed >= 0, changes: this.gov.changes, cpuChanges: this.cgov.changes, device: this.device, remembered: this.remembered, rec: this.rec, sharpness: this.sharpness,
      fps: +s.fps.toFixed(1), latePct: +s.latePct.toFixed(2), missedPct: +s.missedPct.toFixed(2), updMs: +s.updMs.toFixed(2), rendMs: +s.rendMs.toFixed(2), bound: s.bound,
      calls: i.render.calls, triangles: i.render.triangles, programs: i.programs ? i.programs.length : 0, textures: i.memory.textures, geometries: i.memory.geometries,
      heapMB: typeof performance !== 'undefined' && performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      ...mem,
    };
  }
}

// The GPU's name, where the browser tells (the remembered level is per headset).
function gpuName(r) {
  try {
    const gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch { return ''; }
}

// Texture and geometry memory, estimated from what the scene (and `extra` groups) use:
// a texture w x h x 4 bytes (x 4/3 with mipmaps), a geometry its attribute and index arrays.
export function sceneMemory(scene, extra = []) {
  const tex = new Map(), geo = new Set();         // texture -> where it was first seen
  const visit = (o) => {
    if (o.geometry) geo.add(o.geometry);
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      const at = (k) => `${o.name || o.type}.${k}`;
      for (const k in m) { const v = m[k]; if (v && v.isTexture && !tex.has(v)) tex.set(v, at(k)); }
      const u = m.uniforms || (m.userData && m.userData.uniforms);
      if (u) for (const k in u) { const v = u[k] && u[k].value; if (v && v.isTexture && !tex.has(v)) tex.set(v, at(k)); }
    }
  };
  scene.traverse(visit);
  for (const g of extra) if (g) g.traverse(visit);
  let texBytes = 0; const big = [];
  for (const [t, where] of tex) {
    const im = t.image || {}, w = im.width || (im.data && im.width) || 0, h = im.height || 0;
    const bpp = t.type === 1015 ? 16 : t.type === 1016 ? 8 : 4;         // (float / half float data textures)
    const mip = t.generateMipmaps !== false && t.minFilter !== 1006 && t.minFilter !== 1003 ? 4 / 3 : 1;
    const b = w * h * bpp * mip;
    texBytes += b;
    big.push([t.name || where, w, h, Math.round(b / 1024)]);
  }
  let geoBytes = 0;
  for (const g of geo) {
    const seen = new Set();
    for (const k in g.attributes) { const a = g.attributes[k], arr = a.isInterleavedBufferAttribute ? a.data.array : a.array; if (!seen.has(arr)) { seen.add(arr); geoBytes += arr.byteLength; } }
    if (g.index) geoBytes += g.index.array.byteLength;
  }
  big.sort((a, b) => b[3] - a[3]);
  return { textureMB: +(texBytes / 1048576).toFixed(1), textureCount: tex.size, geometryMB: +(geoBytes / 1048576).toFixed(1), geometryCount: geo.size, biggestTextures: big.slice(0, 12) };
}
