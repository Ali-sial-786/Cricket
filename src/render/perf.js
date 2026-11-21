// Performance control: measures every frame (render/quality.js FrameStats),
// runs the quality governor in the headset, turns the levers each level
// names (the hooks in session.js, crowd.js, shadows.js, humanoid.js,
// ground.js, particles.js, visionCorrect.js) and keeps the per-headset
// level in localStorage. The game calls sample() once a frame from its
// animation loop (main.js -> Game.sampleFrame) with the CPU time of the
// update and of the draw submission. Nothing here allocates per frame.
//
// Console / harness: __game.perf.force('low') (or 'auto'), __game.perf.report()
// (texture / geometry memory estimates and the current numbers).
import { CONFIG } from '../config.js';
import { LEVELS, FrameStats, Governor, fixedLevel, deviceKey, startLevel } from './quality.js';
import { ShadowPool, Humanoid } from './humanoid.js';
import { GROUND_QUALITY } from './ground.js';
import { PerfPanel } from './perfPanel.js';
import { loadJSON, saveJSON } from '../game/settings.js';

const KEY = 'creasevr.quality.v1';
const REMEMBER_S = 20;          // a level held this long in the headset is remembered for it

export class PerfControl {
  constructor(game) {
    this.game = game;
    this.stats = new FrameStats();
    const G = CONFIG.xr.governor || {};
    this.ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    this.device = deviceKey(this.ua, gpuName(game.renderer));
    const saved = loadJSON(KEY) || {};
    this.remembered = saved[this.device] ? saved[this.device].level : null;
    this.gov = new Governor({ start: startLevel(this.remembered, this.ua), dropPct: G.dropPct, badS: G.badS, climbS: G.climbS, holdS: G.holdS });
    this.applied = -1;
    this.setting = null;          // the settings value last read ('auto' | 'ultra' ...)
    this.panel = null;
    this.panelT = 0;
    this.held = 0;                // s at the current level (remembering)
    this.cut = 0;                 // s left of the pause after a camera cut
    this.ex = 0; this.ey = 0; this.ez = 0;
    this.heapMB = 0;
    this.lastNow = null;
    this.visT = 0; this.vision = false; this.xm = null;
    this.lines = ['', '', '', '', ''];
    this.applyLevel(this.gov.level);
  }

  // The settings' choice: 'auto' or a level name.
  readSetting() {
    const s = this.game.settings.quality || 'auto';
    if (s === this.setting) return;
    this.setting = s;
    const f = fixedLevel(s);
    this.gov.setFixed(f);
    this.applied = -1;
    const xm = this.game.xrManager;
    if (xm) xm.autoRate = f >= 0;          // (a fixed level: the old rate step-down still guards it)
  }

  // Force a level from the console / a harness: 'auto' | 'ultra' | ... | 'minimum'.
  force(name) { this.game.settings.quality = name; this.readSetting(); this.applyLevel(this.gov.level); }

  get level() { return this.gov.level; }
  get spec() { return LEVELS[Math.max(0, this.applied)]; }

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
    // our menus only stop the governor proper (the benchmark runs on the safety screen).
    // (out of the headset the governor sits still: a monitor's frame rate says nothing about the headset)
    const hard = !g.ready || !inXR || !visible || this.cut > 0;
    const paused = hard || !!(g.ui && g.ui.menuOpen);
    let lv = this.gov.level;
    if (!hard || this.gov.fixed >= 0) lv = this.gov.update(dt, this.stats.latePct, paused, this.stats.spanMs >= 900);
    else { this.gov.clean = 0; this.gov.bad = 0; }
    // Re-send every lever when the session manager appears (main.js sets it after loading: the next
    // session's framebuffer scale) and when the vision pass turns on or off (it wants full viewports).
    this.visT -= dt;
    if (this.visT <= 0) {
      this.visT = 1;
      const v = typeof g.visionActive === 'function' && g.visionActive();
      if (v !== this.vision) { this.vision = v; this.applied = -1; }
    }
    if (xm !== this.xm) { this.xm = xm; this.applied = -1; }
    if (lv !== this.applied) this.applyLevel(lv);
    // Remember a level that has held in the headset (auto only).
    if (inXR && this.gov.fixed < 0 && !paused) {
      this.held += dt;
      if (this.held >= REMEMBER_S && this.remembered !== lv) this.remember(lv);
    }
    if (g.settings.debugFrames) this.updatePanel(dt);
    else if (this.panel && this.panel.mesh.visible) this.panel.mesh.visible = false;
  }

  remember(lv) {
    this.remembered = lv;
    const saved = loadJSON(KEY) || {};
    saved[this.device] = { level: lv, at: Date.now() };
    saveJSON(KEY, saved);
  }

  onXRStart() {
    this.stats.reset(); this.lastNow = null;
    this.held = 0;
    this.readSetting();
    const xm = this.game.xrManager;
    if (xm) xm.autoRate = this.gov.fixed >= 0;
    // First time in this headset: a quick benchmark on the safety screen (the stadium in view).
    if (this.remembered == null && this.gov.fixed < 0) this.gov.benchmark((CONFIG.xr.governor || {}).benchmarkS || 8);
    else this.gov.hold = this.gov.holdS;
    this.applied = -1;              // (re-send every lever to the new session)
  }

  onXREnd() {
    if (this.gov.fixed < 0 && this.held >= 5) this.remember(this.gov.level);
    this.held = 0;
  }

  // Every lever of a level. Hooks default to Ultra (the game as designed).
  applyLevel(i) {
    const L = LEVELS[i], g = this.game, xm = g.xrManager;
    this.applied = i; this.held = 0;
    const vision = typeof g.visionActive === 'function' && g.visionActive();
    if (xm) {
      xm.setFoveation(L.foveation);
      xm.setViewportScale(vision ? 1 : L.viewport);            // (the vision pass reads the full eye viewports)
      xm.setMaxRate(L.hz);
      xm.setFramebufferScale(xm.vpSupported && CONFIG.xr.dynamicViewport ? CONFIG.xr.framebufferScale : Math.min(CONFIG.xr.framebufferScale, L.fbScale));
    }
    const crowd = g.env && g.env.crowd;
    if (crowd && crowd.userData.setQuality) crowd.userData.setQuality(L.crowd, L.crowdAnim);
    ShadowPool.setDetail(L.shadows);
    Humanoid.lodNear = L.lodNear;
    const h = Humanoid.all[0];
    if (h && h.material.userData.uniforms.uDetail) h.material.userData.uniforms.uDetail.value = L.detail ? 1 : 0;   // (shared by every figure)
    GROUND_QUALITY.uDetOn.value = L.turf ? 1 : 0;
    if (g.particles) g.particles.keep = L.particles;
    if (g.vision && g.vision.setCap) g.vision.setCap(L.visionSteps, L.visionRegion);
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
    const vp = xm && xm.vpActive ? L.viewport.toFixed(2) : 'n/a';
    const lines = this.lines;
    lines[0] = `${s.fps.toFixed(0)} fps · ${hz} · late ${s.latePct.toFixed(1)}% · missed ${s.missedPct.toFixed(1)}%`;
    lines[1] = `${L.name}${this.gov.fixed >= 0 ? ' (fixed)' : ' (auto)'}${this.gov.bench > 0 ? ' benchmarking' : ''} · fov ${L.foveation.toFixed(2)} · vp ${vp}`;
    lines[2] = `CPU ${s.updMs.toFixed(1)} update + ${s.rendMs.toFixed(1)} draw ms${s.bound ? ' · ' + s.bound + '-bound' : ''}`;
    lines[3] = `${i.render.calls} calls · ${(i.render.triangles / 1000).toFixed(0)}k tris · ${i.programs ? i.programs.length : 0} prog · ${i.memory.textures} tex`;
    lines[4] = `heap ${this.heapMB.toFixed(0)} MB · long frames ${g.frameLog ? g.frameLog.count : 0}`;
    P.draw(lines, s.latePct >= 3);
  }

  // A one-off report (allocates: debugging only): the numbers now and memory estimates.
  report() {
    const g = this.game, r = g.renderer, i = r.info, s = this.stats;
    const mem = sceneMemory(g.scene, [g.drs && g.drs.group]);
    return {
      level: this.spec.name, fixed: this.gov.fixed >= 0, changes: this.gov.changes, device: this.device, remembered: this.remembered,
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
