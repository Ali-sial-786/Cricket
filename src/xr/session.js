// WebXR session management: VR (immersive-vr, local-floor) and MR
// (immersive-ar passthrough), highest supported frame rate, fixed foveation.
import { CONFIG } from '../config.js';

export class XRSessionManager {
  constructor(renderer, { onStart, onEnd, onStatus } = {}) {
    this.renderer = renderer;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onStatus = onStatus || (() => {});
    this.session = null;
    this.mode = null;
    this.frameRate = null;
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
    try {
      const session = await navigator.xr.requestSession(mode, init);
      this.session = session;
      this.mode = kind;
      const r = this.renderer;
      r.xr.setReferenceSpaceType('local-floor');
      r.xr.setFoveation(CONFIG.xr.foveation);
      r.xr.setFramebufferScaleFactor(CONFIG.xr.framebufferScale);
      if (kind === 'ar') r.setClearAlpha(0); else r.setClearAlpha(1);
      session.addEventListener('end', () => this._ended());
      await r.xr.setSession(session);
      r.xr.setFoveation(CONFIG.xr.foveation);
      this.applyFrameRate(session);
      if (this.onStart) this.onStart(kind, session);
    } catch (e) {
      console.error('XR session failed', e);
      this.onStatus(`Could not start ${kind.toUpperCase()}: ${e.message || e}`);
      this.session = null;
    }
  }

  // Ask for the highest supported refresh rate (Quest 3S: 72/80/90/120).
  applyFrameRate(session) {
    try {
      const rates = session.supportedFrameRates ? Array.from(session.supportedFrameRates) : [];
      const pick = rates.filter((r) => r <= CONFIG.xr.maxFrameRate).sort((a, b) => b - a)[0];
      if (pick && typeof session.updateTargetFrameRate === 'function') {
        session.updateTargetFrameRate(pick)
          .then(() => { this.frameRate = session.frameRate || pick; this.onStatus(`Frame rate ${this.frameRate} Hz`); })
          .catch((e) => { this.frameRate = session.frameRate || null; console.warn('updateTargetFrameRate failed', e); });
      } else {
        this.frameRate = session.frameRate || null;
      }
    } catch (e) {
      console.warn('Frame-rate selection unavailable', e);
    }
  }

  end() { if (this.session) this.session.end().catch(() => {}); }

  _ended() {
    this.session = null;
    this.mode = null;
    this.renderer.setClearAlpha(1);
    if (this.onEnd) this.onEnd();
  }
}
