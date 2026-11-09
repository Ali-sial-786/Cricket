// Game orchestrator: owns the physics world, views, input, UI, audio and the
// active session (nets / run chase / bowl an over / match). One frame():
//   input -> session logic -> physics advanceTo(simTime) -> events -> views -> UI -> render
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Vec3, Quat, Pose, DEG, clamp, makeRng } from '../physics/math.js';
import { PhysicsWorld, InterpolatedBatProvider } from '../physics/world.js';
import { PITCH } from '../physics/pitch.js';
import { buildEnvironment } from '../render/env.js';
import { buildBatMesh, BallView, StumpsView, MachineView, PitchMark, buildRingMarker } from '../render/objects.js';
import { toV3, toQ } from '../render/util.js';
import { InputManager } from '../xr/input.js';
import { UI } from '../ui/ui.js';
import { Sfx } from '../audio/sfx.js';
import { loadSettings, saveSettings, loadCalibration, saveCalibration } from './settings.js';
import { computeBatOffset, defaultBatOffset, computeRig, headForward } from './calibration.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { createSession } from './modes.js';
import { MRPlacer } from '../xr/mr.js';
import { AIBatter } from './aiBatter.js';
import { BatterView, BowlerView, FieldView, NonStrikerView, RunningController, PlayerBodyView } from '../render/people.js';
import { FIELD } from './fielding.js';
import { Particles } from '../render/particles.js';
import { ShadowPool } from '../render/humanoid.js';

export const BAT_HEAD = { z: -1.05, legOffset: -0.35 };      // head relative to guard (hand) x
export const BOWL_HEAD = { x: 0.75, z: -19.6 };

const DIFFS = ['easy', 'medium', 'hard'];

export class Game {
  constructor({ renderer, scene, camera, rig, dom }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig;
    this.dom = dom;
    this.rng = makeRng((Date.now() & 0xffff) + 1);
    this.version = '0.1.0';
    this.xrManager = null;

    this.settings = loadSettings();
    this.applySettingsToConfig();
    const cal = loadCalibration();
    this.calibration = cal ? new Quat(cal.offset.x, cal.offset.y, cal.offset.z, cal.offset.w).normalize() : null;
    this.calib = { step: 'capture' };

    this.env = buildEnvironment(scene);
    ShadowPool.init(scene);
    this.world = new PhysicsWorld(CONFIG, (Date.now() & 0xffff) + 7);
    this.playerBatProvider = new InterpolatedBatProvider();
    this.playerBat = this.world.addBat('player', this.playerBatProvider);
    this.aiBatter = new AIBatter(CONFIG);
    this.aiBat = this.world.addBat('ai', this.aiBatter, undefined, 1);
    this.aiBat.enabled = false;

    // Views.
    this.batMesh = buildBatMesh();
    scene.add(this.batMesh);
    this.ballView = new BallView(scene);
    this.ballView.setVisible(false);
    this.stumps = {
      batting: new StumpsView(this.env.pitchGroup, PITCH.battingStumpsZ),
      bowling: new StumpsView(this.env.pitchGroup, PITCH.bowlingStumpsZ),
    };
    this.machine = new MachineView(this.env.pitchGroup);
    this.pitchMark = new PitchMark(scene);
    this.aimMarker = buildRingMarker(0xffe14d, 0.25);
    this.aimMarker.visible = false;
    scene.add(this.aimMarker);
    this.batterView = new BatterView(scene, this.aiBatter);
    this.figures = { bowler: new BowlerView(scene) };
    this.fieldView = new FieldView(scene, FIELD);
    this.nonStrikerView = new NonStrikerView(scene);
    this.runners = new RunningController();
    this.playerBody = new PlayerBodyView(scene);
    this.particles = new Particles(scene);
    this.ballOverride = null;   // fielding drives the ball view after a catch / pick-up

    this.input = new InputManager(renderer, rig, camera, dom);
    this.sfx = new Sfx();
    this.sfx.setEnabled(this.settings.sound);
    this.ui = new UI(this);

    this.simTime = 0;
    this.lastNow = null;
    this.session = null;
    this.lastMode = 'nets';
    this.paused = false;
    this.state = 'menu';             // 'menu' | 'safety' | 'calibrate' | 'play' | 'mrplace'
    this.end = 'batting';
    this.rigState = { x: 0, z: 0, yaw: 0 };
    this.pendingRecenter = null;
    this.xrMode = null;              // null | 'vr' | 'ar'
    this.mr = false;
    this.xrSupported = { vr: false, ar: false };
    this.desktopView = 0;
    this.resultInfo = null;
    this.stats = { frames: 0, fpsAccum: 0, fps: 0 };
    this.actions = makeActions(this);
    this.mrPlacer = null;

    this.setEnd('batting');
    this.ui.setHud({ title: 'Crease VR', sub: 'Choose a mode from the menu', footer: this.footerText() });
    this.ui.setBoard(['CREASE VR', 'Welcome', 'Nets · Run Chase · Bowl an Over · Match']);
    this.ui.openMenu('main');
  }

  // ------------------------------------------------------------- settings
  applySettingsToConfig() {
    CONFIG.bowling.paceMultiplier = this.settings.paceMultiplier;
    CONFIG.bat.speedMultiplier = this.settings.batSpeedMultiplier;
    this.input && (this.input.right.hapticsScale = this.input.left.hapticsScale = this.settings.hapticsScale);
  }
  saveSettings() { saveSettings(this.settings); this.applySettingsToConfig(); }

  get difficulty() { return this.settings.difficulty; }

  batOffset() {
    if (!this.input.xr) return _identity;
    const base = this.calibration || defaultBatOffset();
    _off.copy(base);
    if (this.settings.batAngleDeg) _off.multiply(_tilt.setFromAxisAngle(_xAxis, this.settings.batAngleDeg * DEG));
    return _off;
  }

  footerText() {
    if (this.input && this.input.xr) return 'Left trigger: select · X: next ball · Y: menu';
    return 'Mouse: bat · Space: next ball · Esc: menu · C: camera · B: auto-bowl';
  }

  // ------------------------------------------------------------- rig / ends
  setEnd(end) {
    this.end = end;
    this.ui.setHudPose(this.mr && end !== 'bowling' ? 'mr' : end);
    if (this.mr) {
      // MR: batting end stays anchored to the stumps you placed on the floor;
      // bowling re-anchors the bowler's end at your feet.
      if (end === 'bowling') this.recenter();
      else if (this.mrPlacer && this.mrPlacer.placedRig) this.setRig(this.mrPlacer.placedRig);
      return;
    }
    if (this.input.xr) this.recenter();
    else this.placeDesktopCamera();
  }

  // Re-anchor the world around the player's current head pose.
  recenter() {
    if (this.mr && this.end !== 'bowling') return;
    if (!this.input.xr) { this.placeDesktopCamera(); return; }
    const head = this.input.headRef;
    const f = headForward(head.q);
    let r;
    if (this.end === 'bowling') r = computeRig(head.p, f, BOWL_HEAD.x, BOWL_HEAD.z, +1);
    else r = computeRig(head.p, f, this.settings.guardX + BAT_HEAD.legOffset, BAT_HEAD.z, -1);
    this.setRig(r);
  }

  setRig(r) {
    this.rigState = r;
    this.rig.position.set(r.x, 0, r.z);
    this.rig.rotation.set(0, r.yaw, 0);
    this.rig.updateMatrixWorld(true);
    this.input.right.resetMotion();
    this.input.left.resetMotion();
    // The world head pose was computed this frame with the old rig.
    this.input.refreshHeadWorld();
    this.snapBat = true;
    // Keep an open menu in front of the player after the world moves.
    if (this.ui && this.ui.menuOpen && this.input.xr) this.ui.placeMenu();
  }

  placeDesktopCamera() {
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    const c = this.camera;
    const views = this.end === 'bowling'
      ? [[[0.75, 1.72, -20.3], [0.0, 0.9, 0.0]], [[9, 3.5, -14], [0, 0.8, -6]], [[0.4, 2.6, 6.0], [0, 0.8, -12]]]
      : [[[0.55, 2.45, 3.9], [0.0, 1.0, -12]], [[-0.42, 1.62, -0.85], [0.25, 1.35, -19]], [[6.5, 1.6, -1.6], [-0.2, 0.9, -1.4]], [[0.4, 2.6, -24], [0, 0.8, -2]], [[0, 55, -10], [0, 0, -10.01]]];
    const v = views[this.desktopView % views.length];
    c.position.set(...v[0]);
    c.lookAt(new THREE.Vector3(...v[1]));
    c.updateMatrixWorld(true);
    if (this.input) {
      this.input.desktop.batHand.set(this.settings.guardX + 0.04, 1.02, -1.25);
    }
  }

  // ------------------------------------------------------------- XR hooks
  onXRStart(mode) {
    this.xrMode = mode;
    this.sfx.init();
    this.mr = mode === 'ar';
    this.env.stadium.visible = !this.mr;
    this.ui.board.mesh.visible = !this.mr;
    if (this.session) this.endSession();
    this.ui.closeMenu();
    this.pendingRecenter = 2;          // after a couple of frames of valid pose
    if (this.mr) {
      this.state = 'mrplace';
      this.startMRPlacement();
    } else {
      this.state = 'safety';
    }
  }

  // System recenter (long-press Meta button) moved the reference space origin.
  onReferenceReset() {
    if (this.mr) { if (this.mrPlacer) { this.endSession(); this.ui.closeMenu(); this.mrPlacer.restart(); } return; }
    this.pendingRecenter = 2;
  }

  // Headset taken off / system menu open: pause play.
  onVisibilityChange(state) {
    if (state !== 'visible' && this.state === 'play' && this.session && !this.ui.menuOpen) this.ui.openMenu('main');
  }

  onXREnd() {
    this.xrMode = null;
    this.mr = false;
    this.input.mode = 'desktop';
    this.pendingRecenter = null;
    // three copied the XR projection onto the user camera: restore it.
    this.camera.fov = 70;
    this.camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.updateProjectionMatrix();
    this.env.stadium.visible = true;
    this.ui.board.mesh.visible = true;
    if (this.mrPlacer) { this.mrPlacer.dispose(); this.mrPlacer = null; }
    this.env.root.position.set(0, 0, 0);
    if (this.session) this.endSession();
    this.state = 'menu';
    this.setEnd('batting');
    this.ui.openMenu('main');
  }

  startMRPlacement() {
    try {
      if (this.mrPlacer) this.mrPlacer.restart();
      else this.mrPlacer = new MRPlacer(this);
    } catch (e) {
      console.warn('MR placement unavailable', e);
      this.state = 'menu';
      this.ui.openMenu('main');
    }
  }

  onMenuChanged(open) {
    this.input.desktop.mode = open ? 'menu' : (this.session && this.session.isBowling ? 'bowl' : 'bat');
    if (!open) this.snapBat = true;
  }

  // ------------------------------------------------------------- sessions
  startSession(kind) {
    if (this.session) this.endSession();
    this.lastMode = kind;
    this.startSessionObj(createSession(this, kind));
  }

  startSessionObj(session) {
    if (this.session) this.endSession();
    this.resultInfo = null;
    this.ballOverride = null;
    this.session = session;
    this.state = 'play';
    this.ui.closeMenu();
    this.session.enter();
    this.input.desktop.mode = this.session.isBowling ? 'bowl' : 'bat';
  }

  endSession() {
    if (!this.session) return;
    this.session.exit();
    this.session = null;
    this.world.removeBall();
    this.ballView.setVisible(false);
    this.ballOverride = null;
  }

  showResult(info) {
    this.resultInfo = info;
    this.ui.openMenu('result');
  }

  // ------------------------------------------------------------- frame
  frame(timeMs, xrFrame) {
    const now = timeMs / 1000;
    let dt = this.lastNow == null ? 1 / 72 : now - this.lastNow;
    this.lastNow = now;
    dt = clamp(dt, 0, CONFIG.physics.maxFrameDt);
    this.stats.fpsAccum += dt; this.stats.frames++;
    if (this.stats.fpsAccum > 1) {
      this.stats.fps = this.stats.frames / this.stats.fpsAccum; this.stats.frames = 0; this.stats.fpsAccum = 0;
      if (this.xrManager && this.input.xr) this.xrManager.checkPerformance(this.stats.fps);
    }

    const paused = this.ui.menuOpen && this.state === 'play';
    if (!paused) this.simTime += dt;
    this.input.update(this.simTime, xrFrame);

    if (this.pendingRecenter != null && this.input.xr) {
      if (--this.pendingRecenter <= 0) { this.pendingRecenter = null; this.recenter(); this.afterXRSettled(); }
    }

    this.handleGlobalInput(dt);
    this.updatePlayerBat(paused);

    if (this.state === 'calibrate') this.updateCalibration(dt);
    if (this.mrPlacer && this.state === 'mrplace') this.mrPlacer.update(xrFrame, dt);

    if (!paused) {
      if (this.session) this.session.update(dt, this.simTime);
      this.world.advanceTo(this.simTime);
      for (const e of this.world.drainEvents()) this.onPhysicsEvent(e);
    }
    this.updateViews(dt, paused);
    this.ui.updatePointer(this.input);
    this.ui.update();
    this.env.update(dt, now);
    const cu = this.env.crowd.userData.uniforms;
    cu.uTime.value = now;
    cu.uCheer.value = Math.max(0, cu.uCheer.value - dt * 0.35);
    this.input.desktop.endFrame();
  }

  afterXRSettled() {
    this.footerRefresh();
    if (this.state === 'safety') this.ui.openMenu('safety');
    if (this.state === 'mrplace' && this.mrPlacer) this.mrPlacer.restart();   // re-place its prompt at the real head pose
  }

  footerRefresh() { this.ui.setHud({ footer: this.session ? this.session.footer() : this.footerText() }); }

  handleGlobalInput(dt) {
    const L = this.input.left, R = this.input.right, D = this.input.desktop;
    // Menu toggle: Y (left B) in XR, Esc / M on desktop. Without a left
    // controller, the right thumbstick click does it.
    const menuBtn = L.buttons.b.down || (this.input.xr && !L.connected && R.buttons.stick.down);
    if (menuBtn && (this.state === 'play' || this.state === 'menu')) {
      if (this.ui.menuOpen) {
        if (this.session) this.ui.closeMenu();
        else this.ui.openMenu(this.ui.page);   // re-place it in front of you
      } else this.ui.openMenu('main');
    }
    // Hold left grip ~1 s to recenter (XR).
    if (this.input.xr && L.buttons.squeeze.pressed) {
      this.gripHold = (this.gripHold || 0) + dt;
      if (this.gripHold > 1.0 && !this.gripRecentered) { this.recenter(); this.gripRecentered = true; L.pulse(0.4, 40); }
    } else { this.gripHold = 0; this.gripRecentered = false; }
    if (!this.input.xr) {
      if (D.took('KeyC')) { this.desktopView++; this.placeDesktopCamera(); }
      if (D.took('KeyT')) { this.settings.trail = !this.settings.trail; this.saveSettings(); }
    }
    if (this.session && this.state === 'play' && !this.ui.menuOpen) this.session.handleInput(this.input);
  }

  updatePlayerBat(paused) {
    const R = this.input.right;
    const batting = this.session ? !this.session.isBowling : this.state === 'calibrate' || this.state === 'menu';
    const show = batting && R.connected && !(this.state === 'calibrate' && this.calib.step === 'capture' && this.input.xr && !this.calibration);
    this.batMesh.visible = show && !(this.ui.menuOpen && this.input.xr && this.state !== 'calibrate' && !this.session);
    this.playerBat.enabled = batting && !!this.session && !paused && R.connected && R.tracked;
    if (!R.connected || !R.tracked) { this.snapBat = true; return; }
    const off = this.batOffset();
    _batPose.p.copy(R.gripPose.p);
    _batPose.q.multiplyQuats(R.gripPose.q, off).normalize();
    toV3(this.batMesh.position, _batPose.p);
    toQ(this.batMesh.quaternion, _batPose.q);
    if (paused) return;
    if (this.snapBat) { this.playerBatProvider.snap(this.simTime, _batPose, R.gripPose.p); this.snapBat = false; }
    else this.playerBatProvider.push(this.simTime, _batPose, R.gripPose.p, R.linVel, R.angVel);
  }

  onPhysicsEvent(e) {
    const s = this.sfx;
    if (e.type === 'bounce') {
      if (e.speedIn > 1.5) s.bounce(e.speedIn, e.surface);
      if (e.speedIn > 3) this.particles.dust(e.pos, e.speedIn, e.surface !== 'pitch');
      if (!e.batted && e.surface === 'pitch' && e.index === 1) this.pitchMark.show(e.pos);
    } else if (e.type === 'bat') {
      s.batCrack(e.quality, e.speedIn + e.batSpeed, e.isEdge);
      if (e.batId === 'player') {
        const H = CONFIG.haptics;
        const R = this.input.right;
        if (e.isEdge) R.pulse(H.edgeIntensity, H.edgeDurationMs);
        else R.pulse(H.contactMin + (H.contactMax - H.contactMin) * e.quality, H.durationMinMs + (H.durationMaxMs - H.durationMinMs) * e.quality);
      }
    } else if (e.type === 'wicket') {
      s.stumps();
      this.stumps[e.end].break({ x: 0, y: 0, z: (e.end === 'batting' ? 1 : -1) * e.speed }, e.stump);
      this.particles.splinters({ x: 0, z: e.end === 'batting' ? 0 : -20.12 });
    } else if (e.type === 'boundary' && e.onFull && e.batted) {
      this.particles.fireworks(e.pos);
    }
    if (this.session) this.session.onEvent(e);
  }

  updateViews(dt, paused) {
    const b = this.world.ball;
    if (this.ballOverride) {
      this.ballView.update(this.ballOverride.pos, 0, null, false);
    } else if (b.active && this.ballView.visible) {
      // Extrapolate the sub-step remainder so the ball is drawn at frame time.
      const lag = paused ? 0 : clamp(this.simTime - this.world.time, 0, 0.01);
      _render.copy(b.pos).addScaled(b.vel, b.stopped ? 0 : lag);
      if (_render.y < CONFIG.ball.radius) _render.y = CONFIG.ball.radius;
      this.ballView.update(_render, paused ? 0 : dt, b.spin, this.settings.trail && b.batted);
    }
    // Visibility assist: keep the ball at a minimum angular size (render only).
    let k = 1;
    if (this.settings.ballBoost && this.ballView.visible) {
      const hp = this.input.headPose.p, bp = this.ballView.mesh.position;
      const d = Math.hypot(bp.x - hp.x, bp.y - hp.y, bp.z - hp.z);
      const want = d * Math.tan((CONFIG.render.ballMinAngleDeg * Math.PI) / 360);
      k = Math.max(1, Math.min(2.2, want / CONFIG.ball.radius));
    }
    this.ballView.mesh.scale.setScalar(k);
    if (!paused) {
      this.stumps.batting.update(dt);
      this.stumps.bowling.update(dt);
      this.pitchMark.update(dt);
    }
    if (this.session && this.session.updateViews) this.session.updateViews(dt, paused);
    // Particles (point size needs the per-eye half height).
    this.particles.update(pdtFx(paused, dt), this.input.xr ? 900 : this.renderer.getDrawingBufferSize(_dbs).y / 2);
    // People.
    const lookBall = b.active ? _look.set(b.pos.x, b.pos.y, b.pos.z) : (this.ballOverride ? _look.set(this.ballOverride.pos.x, this.ballOverride.pos.y, this.ballOverride.pos.z) : null);
    const pdt = paused ? 0 : dt;
    this.batterView.update(this.simTime, pdt || 1e-4, lookBall);
    this.nonStrikerView.update(pdt || 1e-4, this.simTime, { backingUp: !!(this.session && this.session.backingUp && this.session.backingUp()), ball: lookBall });
    if (!this.session || !this.session.field) {
      if (!this.session || this.session.isBowling || this.session.bowler !== 'ai') this.figures.bowler.show(false);
    }
    const thirdPerson = !this.input.xr && (this.desktopView % 5) !== 1 && !(this.session && this.session.isBowling) && this.end === 'batting';
    this.playerBody.show(thirdPerson);
    if (thirdPerson) this.playerBody.update(pdt || 1e-4, this.simTime, this.batMesh.position, this.batMesh.quaternion, lookBall);
  }

  // Kit colours: the player's team is 'home'.
  setTeams(playerBatting) {
    const bat = playerBatting ? 'home' : 'away', bowl = playerBatting ? 'away' : 'home';
    this.fieldView.setTeam(bowl);
    this.figures.bowler.setTeam(bowl);
    this.batterView.setTeam(bat);
    this.nonStrikerView.setTeam(bat);
  }

  // After an odd number of runs the batters have changed ends.
  swapBatters() {
    const a = this.batterView.actor;
    this.batterView.actor = this.nonStrikerView.actor;
    this.nonStrikerView.actor = a;
    this.nonStrikerView.actor.visible = this.nonStrikerView.visible;
    this.batterView.actor.visible = !!this.batterView.shown;
  }

  cheer(intensity) {
    this.sfx.cheer(intensity);
    const cu = this.env.crowd.userData.uniforms;
    cu.uCheer.value = Math.min(1, intensity);
  }

  // ------------------------------------------------------------- calibration
  beginCalibration() {
    if (this.session) this.endSession();
    this.state = 'calibrate';
    this.calib.step = 'capture';
    this.end = 'batting';
    this.ui.openMenu('calibrate');
  }

  captureCalibration() {
    const R = this.input.right;
    if (!R.connected) return;
    if (this.input.xr) {
      const f = headForward(this.input.headRef.q);
      this.calibration = computeBatOffset(R.gripRef.q, f);
      this.recenter();
    }
    this.settings.batAngleDeg = 0;
    this.calib.step = 'adjust';
    R.pulse(0.6, 60);
    this.ui.refresh();
  }

  updateCalibration(dt) {
    const L = this.input.left, R = this.input.right;
    if (this.calib.step === 'capture') {
      if (R.buttons.a.down || (L.buttons.trigger.down && !this.ui.hoverHit)) this.captureCalibration();
    } else {
      if (Math.abs(L.stick.y) > 0.3) {
        this.settings.batAngleDeg = clamp(this.settings.batAngleDeg - Math.sign(L.stick.y) * 20 * dt, -30, 30);
        this.calibAdjustT = (this.calibAdjustT || 0) + dt;
        if (this.calibAdjustT > 0.15) { this.calibAdjustT = 0; this.ui.refresh(); }
      }
      if (R.buttons.a.down) this.finishCalibration();
      if (R.buttons.b.down) { this.calib.step = 'capture'; this.ui.refresh(); }
    }
  }

  finishCalibration() {
    if (this.calibration) {
      const q = this.calibration;
      saveCalibration({ offset: { x: q.x, y: q.y, z: q.z, w: q.w }, when: new Date().toISOString() });
    }
    this.settings.batAngleDeg = Math.round(this.settings.batAngleDeg);
    this.saveSettings();
    this.state = 'menu';
    this.ui.openMenu('main');
  }
}

const _identity = new Quat();
const _off = new Quat(), _tilt = new Quat(), _xAxis = new Vec3(1, 0, 0);
const _batPose = new Pose();
const _render = new Vec3();
const _look = new THREE.Vector3();
const _dbs = new THREE.Vector2();
const pdtFx = (paused, dt) => (paused ? 0 : dt);

// UI callbacks.
function makeActions(game) {
  const g = game;
  const persist = () => { g.saveSettings(); g.ui.refresh(); if (g.session && g.session.onSettingsChanged) g.session.onSettingsChanged(); };
  return {
    start: (kind) => { g.sfx.init(); g.startSession(kind); },
    quit: () => { g.endSession(); g.state = 'menu'; g.setEnd('batting'); g.ui.openMenu('main'); g.ui.setHud({ title: 'Crease VR', score: '', sub: 'Choose a mode', big: '', last: '', detail: '' }); },
    safetyOk: () => {
      g.settings.seenSafety = true; g.saveSettings();
      if (!g.calibration && g.input.xr) g.beginCalibration();
      else { g.state = 'menu'; g.ui.openMenu('main'); }
    },
    calibrate: () => g.beginCalibration(),
    calibCapture: () => g.captureCalibration(),
    calibRedo: () => { g.calib.step = 'capture'; g.ui.refresh(); },
    calibSave: () => g.finishCalibration(),
    calibSkip: () => { g.state = 'menu'; g.ui.openMenu('main'); },
    recenter: () => g.recenter(),
    mr: () => {
      if (g.mr) { g.endSession(); g.ui.closeMenu(); if (g.mrPlacer) g.mrPlacer.restart(); return; }
      // A new XR session needs a page gesture: point the player at the page button.
      g.ui.setHud({ big: 'Mixed reality', bigColor: '#5cf2a6', last: g.input.xr ? 'Exit VR, then press "Enter MR nets" on the page.' : 'Press "Enter MR nets" on the page (needs a headset).', detail: '' });
    },
    machine: (key, d) => {
      const m = g.settings.machine;
      const lim = { paceKmh: [CONFIG.machine.paceMinKmh, CONFIG.machine.paceMaxKmh], line: [-0.6, 0.8], swing: [-1, 1], seam: [-1, 1], spinAmount: [0, 1], variation: [0, 1] }[key];
      m[key] = clamp(Math.round((m[key] + d) * 100) / 100, lim[0], lim[1]);
      persist();
    },
    machinePreset: (key, dir) => {
      const m = g.settings.machine;
      const list = key === 'length' ? LENGTH_PRESETS : LINE_PRESETS;
      let idx = 0, bd = Infinity;
      list.forEach((p, i) => { const d = Math.abs(p[key] - m[key]); if (d < bd) { bd = d; idx = i; } });
      if (bd > 0.02 && dir < 0 && list[idx][key] < m[key]) idx++;
      idx = clamp(idx + dir, 0, list.length - 1);
      m[key] = list[idx][key];
      persist();
    },
    machineSpin: (dir) => {
      const order = ['none', 'off', 'leg'];
      const m = g.settings.machine;
      const i = (order.indexOf(m.spinType) + dir + 3) % 3;
      m.spinType = order[i];
      if (m.spinType !== 'none' && m.paceKmh > 100) m.paceKmh = 85;
      if (m.spinType === 'none' && m.paceKmh < 110) m.paceKmh = 130;
      persist();
    },
    machineRelease: () => { const m = g.settings.machine; m.release = m.release === 'over' ? 'around' : 'over'; g.machine.setRelease(m.release); persist(); },
    toggle: (key) => { g.settings[key] = !g.settings[key]; if (key === 'sound') g.sfx.setEnabled(g.settings.sound); persist(); },
    setting: (key, d, lo, hi) => { g.settings[key] = clamp(Math.round((g.settings[key] + d) * 100) / 100, lo, hi); persist(); },
    difficulty: (dir) => { const i = clamp(DIFFS.indexOf(g.settings.difficulty) + dir, 0, 2); g.settings.difficulty = DIFFS[i]; persist(); },
    bowlCalib: () => { g.bowlCalibPending = 3; g.sfx.init(); g.startSession('bowlnets'); },
  };
}
