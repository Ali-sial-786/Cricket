// WebXR session management: VR (immersive-vr, local-floor) and MR
// (immersive-ar passthrough), highest supported frame rate, fixed foveation.
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
      r.xr.setFoveation(CONFIG.xr.foveation);
      r.xr.setFramebufferScaleFactor(CONFIG.xr.framebufferScale);
      if (kind === 'ar') r.setClearAlpha(0); else r.setClearAlpha(1);
      await r.xr.setSession(session);
      r.xr.setFoveation(CONFIG.xr.foveation);
      // System recenter (long-press Meta button) resets the reference space.
      const ref = r.xr.getReferenceSpace();
      if (ref && ref.addEventListener) ref.addEventListener('reset', () => { if (this.onReset) this.onReset(); });
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

  // Ask for the highest supported refresh rate (Quest 3S: 72/80/90/120).
  applyFrameRate(session) {
    try {
      this.rates = session.supportedFrameRates ? Array.from(session.supportedFrameRates).sort((a, b) => b - a) : [];
      const pick = this.rates.filter((r) => r <= CONFIG.xr.maxFrameRate)[0];
      this.setRate(session, pick);
    } catch (e) {
      console.warn('Frame-rate selection unavailable', e);
    }
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
  // for 4 s in a row, step down to the next supported rate (e.g. 120 -> 90).
  checkPerformance(fps) {
    const s = this.session;
    if (!s || !this.frameRate || this.rates.length < 2) return;
    if (s.visibilityState && s.visibilityState !== 'visible') { this.slowSeconds = 0; return; }
    if (fps < this.frameRate * 0.88) this.slowSeconds++;
    else this.slowSeconds = 0;
    if (this.slowSeconds >= 4) {
      this.slowSeconds = 0;
      const lower = this.rates.filter((r) => r < this.frameRate && r >= 72)[0];
      if (lower) { console.warn(`Holding ${this.frameRate} Hz failed (${fps.toFixed(0)} fps) -> ${lower} Hz`); this.setRate(s, lower); }
    }
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
    this.renderer.setClearAlpha(1);
    if (this.onEnd) this.onEnd();
  }
}
