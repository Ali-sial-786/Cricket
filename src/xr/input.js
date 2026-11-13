// Unified controller input: real WebXR controllers, or desktop emulation
// (mouse swings the bat / bowls, keyboard for actions). Both produce the same
// Controller objects in WORLD space using physics math types, so game code
// has one path.
import * as THREE from 'three';
import { Vec3, Quat, Pose, angularVelocityFromQuats, clamp } from '../physics/math.js';
import { CONFIG } from '../config.js';

class Button {
  constructor() { this.pressed = false; this.value = 0; this.down = false; this.up = false; }
  set(pressed, value = pressed ? 1 : 0) {
    this.down = pressed && !this.pressed;
    this.up = !pressed && this.pressed;
    this.pressed = pressed;
    this.value = value;
  }
}

const HISTORY = 48;

export class Controller {
  constructor(hand) {
    this.hand = hand;
    this.connected = false;
    this.tracked = true;           // false while the runtime has no pose (e.g. blurred session)
    this.source = null;            // XRInputSource
    this.gripPose = new Pose();    // world
    this.gripRef = new Pose();     // reference space (before rig)
    this.rayPose = new Pose();     // world (target ray)
    this.linVel = new Vec3();      // world, at grip origin
    this.angVel = new Vec3();      // world
    this.hasXRVel = false;
    this.buttons = { trigger: new Button(), squeeze: new Button(), a: new Button(), b: new Button(), stick: new Button() };
    this.stick = { x: 0, y: 0 };
    this.history = [];             // {t, p, v}
    this._prev = new Pose();
    this._prevT = -1;
    this.hapticsScale = 1;
  }

  // Haptic pulse; intensity 0..1, duration ms. Never throws.
  pulse(intensity, ms) {
    const i = clamp(intensity * this.hapticsScale, 0, 1);
    if (i <= 0) return;
    try {
      const gp = this.source && this.source.gamepad;
      if (!gp) return;
      const act = gp.hapticActuators && gp.hapticActuators[0];
      if (act && act.pulse) { act.pulse(i, ms); return; }
      if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: i, weakMagnitude: i });
      }
    } catch { /* haptics are best-effort */ }
  }

  // Record pose; derive velocities by finite difference when XR does not
  // provide them (or when forced to by config).
  _record(t, useXRVel) {
    if (this._prevT >= 0 && t > this._prevT) {
      const dt = t - this._prevT;
      if (!useXRVel) {
        const lv = _tmpV.copy(this.gripPose.p).sub(this._prev.p).scale(1 / dt);
        const av = angularVelocityFromQuats(_tmpW, this._prev.q, this.gripPose.q, dt);
        // Light smoothing to tame tracking jitter.
        this.linVel.lerp(lv, 0.75);
        this.angVel.lerp(av, 0.75);
      }
    } else if (!useXRVel) {
      this.linVel.set(0, 0, 0); this.angVel.set(0, 0, 0);
    }
    this._prev.copy(this.gripPose);
    this._prevT = t;
    const h = this.history.length >= HISTORY ? this.history.shift() : { t: 0, p: new Vec3(), v: new Vec3(), w: new Vec3() };
    h.t = t; h.p.copy(this.gripPose.p); h.v.copy(this.linVel); h.w.copy(this.angVel);
    this.history.push(h);
  }

  resetMotion() { this._prevT = -1; this.history.length = 0; this.linVel.set(0, 0, 0); this.angVel.set(0, 0, 0); }
  releaseButtons() { for (const b of Object.values(this.buttons)) b.set(false); this.stick.x = 0; this.stick.y = 0; }

  // Peak-speed sample in the last windowSec.
  peak(now, windowSec) {
    let best = null;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      if (now - h.t > windowSec) break;
      if (!best || h.v.lengthSq() > best.v.lengthSq()) best = h;
    }
    return best;
  }
}
const _tmpV = new Vec3(), _tmpW = new Vec3();

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _rq = new THREE.Quaternion(), _v = new THREE.Vector3();

export class InputManager {
  constructor(renderer, rig, camera, dom) {
    this.renderer = renderer;
    this.rig = rig;
    this.camera = camera;
    this.left = new Controller('left');
    this.right = new Controller('right');
    this.mode = 'desktop';
    this.slots = [0, 1].map((i) => {
      const ray = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      rig.add(ray, grip);
      const slot = { ray, grip, source: null };
      ray.addEventListener('connected', (e) => { slot.source = e.data; });
      ray.addEventListener('disconnected', () => { slot.source = null; });
      return slot;
    });
    this.desktop = new DesktopControls(dom, camera);
    this.headPose = new Pose();
    this.headRef = new Pose();
  }

  get xr() { return this.mode === 'xr'; }

  // Recompute the world head pose from the reference-space one (after the rig moved).
  refreshHeadWorld() {
    if (this.mode !== 'xr') return;
    this.rig.updateMatrixWorld(true);
    _p.set(this.headRef.p.x, this.headRef.p.y, this.headRef.p.z).applyMatrix4(this.rig.matrixWorld);
    this.rig.getWorldQuaternion(_rq);
    _q.set(this.headRef.q.x, this.headRef.q.y, this.headRef.q.z, this.headRef.q.w).premultiply(_rq);
    this.headPose.p.set(_p.x, _p.y, _p.z);
    this.headPose.q.set(_q.x, _q.y, _q.z, _q.w);
  }

  update(t, frame) {
    this.mode = this.renderer.xr.isPresenting ? 'xr' : 'desktop';
    this.rig.updateMatrixWorld(true);
    // Head pose (world + ref).
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    cam.matrixWorld.decompose(_p, _q, _s);
    this.headPose.p.set(_p.x, _p.y, _p.z);
    this.headPose.q.set(_q.x, _q.y, _q.z, _q.w);
    if (this.mode === 'xr') {
      // Prefer this frame's viewer pose (the XR camera matrix is only updated
      // inside render(), i.e. one frame late).
      let got = false;
      try {
        const ref = this.renderer.xr.getReferenceSpace();
        const vp = frame && ref ? frame.getViewerPose(ref) : null;
        if (vp) {
          const tp = vp.transform.position, to = vp.transform.orientation;
          this.headRef.p.set(tp.x, tp.y, tp.z);
          this.headRef.q.set(to.x, to.y, to.z, to.w);
          _p.set(tp.x, tp.y, tp.z).applyMatrix4(this.rig.matrixWorld);
          this.rig.getWorldQuaternion(_rq);
          _q.set(to.x, to.y, to.z, to.w).premultiply(_rq);
          this.headPose.p.set(_p.x, _p.y, _p.z);
          this.headPose.q.set(_q.x, _q.y, _q.z, _q.w);
          got = true;
        }
      } catch { /* fall back below */ }
      if (!got) {
        // head in ref space = rig^-1 * world
        _m.copy(this.rig.matrixWorld).invert().multiply(cam.matrixWorld).decompose(_p, _q, _s);
        this.headRef.p.set(_p.x, _p.y, _p.z);
        this.headRef.q.set(_q.x, _q.y, _q.z, _q.w);
      }
      this.updateXR(t);
    } else {
      this.headRef.copy(this.headPose);
      this.desktop.update(t, this);
    }
  }

  updateXR(t) {
    this.rig.getWorldQuaternion(_rq);
    const useXR = CONFIG.bat.velocitySource !== 'pose';
    for (const c of [this.left, this.right]) {
      const slot = this.slots.find((s) => s.source && s.source.handedness === c.hand);
      if (!slot) {
        if (c.connected) c.releaseButtons();
        c.connected = false; c.source = null;
        continue;
      }
      if (!c.connected) c.resetMotion();
      c.connected = true;
      c.source = slot.source;
      // three hides the grip group when the runtime has no grip pose.
      c.tracked = slot.grip.visible !== false;
      if (!c.tracked) { c.linVel.set(0, 0, 0); c.angVel.set(0, 0, 0); c.hasXRVel = false; c.resetMotion(); c.releaseButtons(); continue; }
      slot.grip.matrixWorld.decompose(_p, _q, _s);
      c.gripPose.p.set(_p.x, _p.y, _p.z);
      c.gripPose.q.set(_q.x, _q.y, _q.z, _q.w);
      slot.grip.matrix.decompose(_p, _q, _s);
      c.gripRef.p.set(_p.x, _p.y, _p.z);
      c.gripRef.q.set(_q.x, _q.y, _q.z, _q.w);
      slot.ray.matrixWorld.decompose(_p, _q, _s);
      c.rayPose.p.set(_p.x, _p.y, _p.z);
      c.rayPose.q.set(_q.x, _q.y, _q.z, _q.w);
      const g = slot.grip;
      const xrVel = useXR && g.hasLinearVelocity && g.hasAngularVelocity;
      c.hasXRVel = !!xrVel;
      if (xrVel) {
        _v.copy(g.linearVelocity).applyQuaternion(_rq);
        c.linVel.set(_v.x, _v.y, _v.z);
        _v.copy(g.angularVelocity).applyQuaternion(_rq);
        c.angVel.set(_v.x, _v.y, _v.z);
      }
      c._record(t, xrVel);
      // xr-standard gamepad mapping.
      const gp = slot.source.gamepad;
      if (gp) {
        const b = gp.buttons;
        const val = (i) => (b[i] ? b[i].value : 0);
        const pr = (i) => !!(b[i] && b[i].pressed);
        c.buttons.trigger.set(pr(0) || val(0) > 0.55, val(0));
        c.buttons.squeeze.set(pr(1) || val(1) > 0.55, val(1));
        c.buttons.stick.set(pr(3));
        c.buttons.a.set(pr(4));
        c.buttons.b.set(pr(5));
        const ax = gp.axes || [];
        c.stick.x = ax.length >= 4 ? ax[2] : (ax[0] || 0);
        c.stick.y = ax.length >= 4 ? ax[3] : (ax[1] || 0);
      }
    }
  }

  // World-space ray for the menu pointer: left controller in XR, mouse on desktop.
  pointerRay(outOrigin, outDir) {
    if (this.mode === 'xr') {
      const c = this.left.connected ? this.left : this.right.connected ? this.right : null;
      if (!c) return false;
      outOrigin.set(c.rayPose.p.x, c.rayPose.p.y, c.rayPose.p.z);
      outDir.set(0, 0, -1).applyQuaternion(_q.set(c.rayPose.q.x, c.rayPose.q.y, c.rayPose.q.z, c.rayPose.q.w));
      return true;
    }
    return this.desktop.mouseRay(outOrigin, outDir);
  }

  pointerController() {
    if (this.mode === 'xr') return this.left.connected ? this.left : this.right;
    return this.left; // desktop: left button state mirrors mouse click
  }
}

// ---------------------------------------------------------------------------
// Desktop emulation.
//   Batting: mouse position drives a virtual right controller (bat) — move the
//            mouse UP to lift the bat, flick DOWN to swing; left/right steers
//            the swing plane (off side / leg side).
//   Bowling: hold the left mouse button, sweep the mouse from top to bottom
//            (overarm), release the button to let go. Q/E = wrist roll.
//   Menus:   the mouse ray is the pointer; left click selects.
export class DesktopControls {
  constructor(dom, camera) {
    this.dom = dom;
    this.camera = camera;
    this.nx = 0; this.ny = 0.3;
    this.mouseDown = false;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.mode = 'bat';             // 'bat' | 'bowl' | 'menu'
    this.batHand = new Vec3(-0.12, 1.02, -1.15);
    this.bowlShoulder = new Vec3(0.6, 1.55, -19.4);
    this.wheel = 0;
    this._q = new Quat(); this._qa = new Quat(); this._qb = new Quat();
    const el = dom;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    });
    el.addEventListener('pointerdown', (e) => { if (e.button === 0) this.mouseDown = true; });
    globalThis.addEventListener('pointerup', (e) => { if (e.button === 0) this.mouseDown = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    globalThis.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedKeys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    globalThis.addEventListener('keyup', (e) => this.keys.delete(e.code));
    globalThis.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
  }

  // Edge-triggered key press (consumed).
  took(code) {
    if (this.pressedKeys.has(code)) { this.pressedKeys.delete(code); return true; }
    return false;
  }
  held(code) { return this.keys.has(code); }
  endFrame() { this.pressedKeys.clear(); }

  mouseRay(o, d) {
    _v.set(this.nx, this.ny, 0.5).unproject(this.camera);
    this.camera.getWorldPosition(o);
    d.copy(_v).sub(o).normalize();
    return true;
  }

  update(t, input) {
    const R = input.right, L = input.left;
    R.connected = true; L.connected = true;
    R.source = null; L.source = null;
    // Left "controller" = mouse pointer for menus.
    // Keyboard stand-ins for the controller buttons (see README).
    L.buttons.trigger.set((this.mouseDown && this.mode === 'menu') || this.held('KeyG'));   // select / "go back"
    L.buttons.a.set(this.held('Space') || this.held('Enter'));                              // X: next ball / RUN
    L.buttons.b.set(this.held('KeyV'));                                                     // Y: dive
    L.buttons.stick.set(this.held('Escape') || this.held('KeyM'));                          // stick click: menu
    L.stick.x = (this.held('ArrowRight') ? 1 : 0) - (this.held('ArrowLeft') ? 1 : 0);
    L.stick.y = (this.held('ArrowDown') ? 1 : 0) - (this.held('ArrowUp') ? 1 : 0);
    R.buttons.a.set(this.held('KeyZ'));
    R.buttons.b.set(this.held('KeyX'));
    R.buttons.trigger.set((this.mouseDown && this.mode === 'bowl') || (this.mode === 'bat' && this.held('ShiftLeft')));  // bowl / come down the pitch
    R.buttons.squeeze.set(this.mode === 'bat' && this.held('KeyS'));                        // sweep
    L.rayPose.p.set(0, 0, 0);

    if (this.mode === 'bowl') this.bowlPose(R);
    else this.batPose(R, t);
    R.gripRef.copy(R.gripPose);
    R._record(t, false);
    // Desktop wrist roll for spin (Q = off-spin, E = leg-spin).
    const roll = (this.held('KeyQ') ? 1 : 0) - (this.held('KeyE') ? 1 : 0);
    if (roll && this.mode === 'bowl') {
      R.angVel.addScaled(_fwdTravel, roll * 25);
      const h = R.history[R.history.length - 1];
      if (h) h.w.copy(R.angVel);
    }
  }

  // Bat swing from the mouse. Pose is the BAT pose directly (offset = identity).
  // Light exponential smoothing (~15 ms) removes mouse-event jitter without
  // adding noticeable lag to a flick.
  batPose(R, t) {
    const dt = this._lastT != null ? Math.max(0, t - this._lastT) : 0;
    this._lastT = t;
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.015) : 1;
    this.sx = this.sx == null ? this.nx : this.sx + (this.nx - this.sx) * k;
    this.sy = this.sy == null ? this.ny : this.sy + (this.ny - this.sy) * k;
    const alpha = clamp(-this.sy, -1, 1) * 2.15;          // up = backlift, down = follow-through
    const beta = clamp(this.sx, -1, 1) * 0.6;             // right = off side
    // face toward the bowler: 180° about Y; then swing about X; then plane yaw.
    this._q.set(0, 1, 0, 0);
    this._qa.setFromAxisAngle(_X, alpha);
    this._qb.setFromAxisAngle(_Y, -beta);
    R.gripPose.q.multiplyQuats(this._qa, this._q).premultiply(this._qb).normalize();
    // Hands move forward slightly through the swing.
    const fwd = Math.sin(clamp(alpha, -1.2, 1.2)) * 0.18;
    const across = clamp(this.sx, -1, 1) * 0.3;         // hands move across the crease too
    R.gripPose.p.set(this.batHand.x + across + Math.sin(beta) * fwd, this.batHand.y + Math.abs(Math.sin(alpha)) * 0.06, this.batHand.z - Math.cos(beta) * fwd);
  }

  // Overarm bowling arc from the mouse: top of screen = arm back, bottom =
  // arm through. Facing +Z (bowling end).
  bowlPose(R) {
    const phi = -clamp(this.ny, -1, 1) * 2.2 + 0.2;       // radians from vertical
    const yaw = clamp(this.nx, -1, 1) * 0.14;
    const L = 0.72;
    const s = this.bowlShoulder;
    const lx = 0, ly = Math.cos(phi) * L, lz = Math.sin(phi) * L;
    R.gripPose.p.set(s.x + lx + Math.sin(yaw) * lz, s.y + ly, s.z + Math.cos(yaw) * lz);
    this._qa.setFromAxisAngle(_X, phi);
    this._qb.setFromAxisAngle(_Y, yaw);
    R.gripPose.q.copy(this._qb).multiply(this._qa).normalize();
  }
}
const _X = new Vec3(1, 0, 0), _Y = new Vec3(0, 1, 0), _fwdTravel = new Vec3(0, 0, 1);
