// WebXR session management: VR (immersive-vr, local-floor) and MR
// (immersive-ar passthrough), the frame rate, fixed foveation and dynamic
// viewport scaling, the levers the quality governor (render/quality.js,
// render/perf.js) turns:
//   foveation   XRProjectionLayer / XRWebGLLayer .fixedFoveation (three: xr.setFoveation): any frame, free.
//   viewport    XRView.requestViewportScale: the part of each eye's buffer drawn this frame, which the
//               compositor scales up. three r180 never calls it, so we ask on each view just before three
//               reads its viewport (the binding's getViewSubImage / the layer's getViewport, wrapped).
//               Where the browser does not have it, the request is skipped and the lever does nothing.
//   framebuffer the eye buffers' size: fixed when the session starts (three: setFramebufferScaleFactor
//               before setSession), so it is only the starting guess (from the level remembered for
//               this headset, when there is no viewport scaling to do the job during play).
//   rate        session.updateTargetFrameRate: the highest supported rate at or under the level's.
import { toLocal, bestSpot } from './playArea.js';
import { CONFIG } from '../config.js';

export class XRSessionManager {
  constructor(renderer, { onStart, onEnd, onStatus, onReset, onVisibility } = {}) {
    this.renderer = renderer;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onStatus = onStatus || (() => {});
    this.onReset = onReset;
    this.onVisibility = onVisibility;
    this.session = null;
    this.mode = null;
    this.frameRate = null;
    this.rates = [];
    this.slowSeconds = 0;
    this.maxRate = CONFIG.xr.maxFrameRate;     // the quality level's cap (setMaxRate)
    this.fbScale = CONFIG.xr.framebufferScale; // for the next session (setFramebufferScale)
    this.foveation = CONFIG.xr.foveation;
    this.vpScale = 1;                          // requested viewport scale (setViewportScale)
    this.vpSupported = typeof XRView !== 'undefined' && 'requestViewportScale' in XRView.prototype;
    this.vpActive = false;                     // the request is wired into this session's views
    this.autoRate = true;                      // checkPerformance may step the rate down (off while the governor runs)
    // three has finished its own teardown when it fires 'sessionend'.
    renderer.xr.addEventListener('sessionend', () => this._ended());
  }

  async supported() {
    const out = { vr: false, ar: false };
    if (!navigator.xr) return out;
    try { out.vr = await navigator.xr.isSessionSupported('immersive-vr'); } catch { /* no */ }
    try { out.ar = await navigator.xr.isSessionSupported('immersive-ar'); } catch { /* no */ }
    return out;
  }

  async start(kind) {
    if (this.session) return;
    const mode = kind === 'ar' ? 'immersive-ar' : 'immersive-vr';
    const init = {
      requiredFeatures: ['local-floor'],
      optionalFeatures: kind === 'ar' ? ['hit-test', 'bounded-floor'] : ['bounded-floor'],
    };
    let session = null;
    try {
      session = await navigator.xr.requestSession(mode, init);
      this.session = session;
      this.mode = kind;
      const r = this.renderer;
      r.xr.setReferenceSpaceType('local-floor');
      r.xr.setFoveation(this.foveation);
      r.xr.setFramebufferScaleFactor(this.fbScale);
      if (kind === 'ar') r.setClearAlpha(0); else r.setClearAlpha(1);
      await r.xr.setSession(session);
      r.xr.setFoveation(this.foveation);
      this.wireViewportScale();
      // System recenter (long-press Meta button) resets the reference space.
      const ref = r.xr.getReferenceSpace();
      if (ref && ref.addEventListener) ref.addEventListener('reset', () => { this.area = null; if (this.onReset) this.onReset(); });
      // The Roomscale play area, where the headset shares it (none with a Stationary boundary).
      this.bounded = null; this.area = null; this.areaT = 0;
      session.requestReferenceSpace('bounded-floor').then((sp) => {
        this.bounded = sp;
        if (sp.addEventListener) sp.addEventListener('reset', () => { this.area = null; });
      }).catch(() => { /* not offered */ });
      session.addEventListener('select', () => { if (this.onSelect) this.onSelect(); });
      session.addEventListener('visibilitychange', () => { if (this.onVisibility) this.onVisibility(session.visibilityState); });
      this.applyFrameRate(session);
      if (this.onStart) this.onStart(kind, session);
    } catch (e) {
      console.error('XR session failed', e);
      this.onStatus(`Could not start ${kind.toUpperCase()}: ${e.message || e}`);
      // Don't leave an immersive session running with nothing rendering.
      if (session) { try { await session.end(); } catch { /* already ended */ } }
      this.session = null;
      this.mode = null;
    }
  }

  // Ask for the highest supported refresh rate under the cap (Quest 3S: 72/80/90/120).
  applyFrameRate(session) {
    try {
      this.rates = session.supportedFrameRates ? Array.from(session.supportedFrameRates).sort((a, b) => b - a) : [];
      const cap = Math.min(this.maxRate, CONFIG.xr.maxFrameRate);
      const pick = this.rates.filter((r) => r <= cap)[0] || this.rates[this.rates.length - 1];
      this.setRate(session, pick);
    } catch (e) {
      console.warn('Frame-rate selection unavailable', e);
    }
  }

  // ---- quality levers (render/perf.js). Each one only acts on a change.
  setMaxRate(hz) {
    this.maxRate = hz;
    const s = this.session;
    if (!s || !this.rates.length) return;
    const cap = Math.min(hz, CONFIG.xr.maxFrameRate);
    const pick = this.rates.filter((r) => r <= cap)[0] || this.rates[this.rates.length - 1];
    if (pick !== this.frameRate) this.setRate(s, pick);
  }
  setFoveation(v) {
    if (v === this.foveation) return;
    this.foveation = v;
    if (this.session) this.renderer.xr.setFoveation(v);
  }
  setFramebufferScale(v) { this.fbScale = v; }      // (the next session)
  setViewportScale(v) { this.vpScale = Math.max(0.2, Math.min(1, v)); }

  // Dynamic viewport scaling: three reads each view's viewport (XRWebGLBinding.getViewSubImage with
  // a projection layer, XRWebGLLayer.getViewport without) every frame before our callback runs, and
  // a view's scale has to be requested before that. So the two calls are wrapped on this session's
  // binding / layer: request the scale on the view, then let three read it.
  wireViewportScale() {
    this.vpActive = false;
    if (!this.vpSupported || !CONFIG.xr.dynamicViewport) return;
    try {
      const xr = this.renderer.xr, base = xr.getBaseLayer();
      const ask = (view) => { if (view && view.requestViewportScale) view.requestViewportScale(this.vpScale); };
      if (base && 'textureWidth' in base) {           // XRProjectionLayer: three draws through the binding
        const b = xr.getBinding();
        if (!b || b.__vpWrapped) { this.vpActive = !!b; return; }
        const orig = b.getViewSubImage.bind(b);
        b.getViewSubImage = (layer, view, eye) => { ask(view); return orig(layer, view, eye); };
        b.__vpWrapped = true; this.vpActive = true;
      } else if (base && base.getViewport) {          // XRWebGLLayer
        const orig = base.getViewport.bind(base);
        base.getViewport = (view) => { ask(view); return orig(view); };
        this.vpActive = true;
      }
    } catch (e) { console.warn('Viewport scaling unavailable', e); this.vpActive = false; }
  }

  setRate(session, rate) {
    if (rate && typeof session.updateTargetFrameRate === 'function') {
      session.updateTargetFrameRate(rate)
        .then(() => { this.frameRate = session.frameRate || rate; this.onStatus(`Frame rate ${this.frameRate} Hz`); })
        .catch((e) => { this.frameRate = session.frameRate || null; console.warn('updateTargetFrameRate failed', e); });
    } else {
      this.frameRate = session.frameRate || null;
    }
  }

  // Called once a second with the measured fps: if we can't hold the target
  // for 4 s in a row, step down to the next supported rate (e.g. 90 -> 72).
  // Only with a quality level fixed in the settings: in Auto the governor
  // (render/perf.js) owns the rate, with everything else.
  checkPerformance(fps) {
    const s = this.session;
    if (!s || !this.frameRate || this.rates.length < 2 || !this.autoRate) return;
    if (s.visibilityState && s.visibilityState !== 'visible') { this.slowSeconds = 0; return; }
    if (fps < this.frameRate * 0.88) this.slowSeconds++;
    else this.slowSeconds = 0;
    if (this.slowSeconds >= 4) {
      this.slowSeconds = 0;
      const lower = this.rates.filter((r) => r < this.frameRate && r >= 72)[0];
      if (lower) { console.warn(`Holding ${this.frameRate} Hz failed (${fps.toFixed(0)} fps) -> ${lower} Hz`); this.setRate(s, lower); }
    }
  }

  // { poly, spot: { x, z, room } } in the local-floor space, or null; worked out
  // again every 2 s (the play area can be redrawn mid-session).
  playArea(frame) {
    const b = this.bounded;
    if (!b || !frame || !b.boundsGeometry || b.boundsGeometry.length < 3) return null;
    const now = performance.now();
    if (now - this.areaT < 2000) return this.area;
    this.areaT = now;
    try {
      const pose = frame.getPose(b, this.renderer.xr.getReferenceSpace());
      if (!pose) return this.area || null;
      const poly = toLocal(b.boundsGeometry, pose.transform.matrix);
      // (the search runs only when the area has really changed: a redraw, a recenter)
      const key = poly.length + ':' + poly.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(';');
      if (key !== this.areaKey) { this.areaKey = key; const spot = bestSpot(poly); this.area = spot ? { poly, spot } : null; }
    } catch (e) { this.area = null; }
    return this.area;
  }

  end() { if (this.session) this.session.end().catch(() => {}); }

  // End the current session and start another kind (must be called from an
  // XR 'select' event so the browser still counts it as a user gesture).
  async switchTo(kind) {
    const s = this.session;
    if (!s) return this.start(kind);
    try { await s.end(); } catch { /* already ending */ }
    for (let i = 0; i < 40 && this.session; i++) await new Promise((r) => setTimeout(r, 25));
    return this.start(kind);
  }

  _ended() {
    if (!this.session) return;
    this.session = null;
    this.mode = null;
    this.frameRate = null;
    this.bounded = null; this.area = null;
    this.renderer.setClearAlpha(1);
    if (this.onEnd) this.onEnd();
  }
}
