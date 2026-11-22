// Game orchestrator: owns the physics world, views, input, UI, audio and the
// active session (nets / run chase / bowl an over / match). One frame():
//   input -> session logic -> physics advanceTo(simTime) -> events -> views -> UI -> render
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Vec3, Quat, Pose, DEG, clamp, makeRng } from '../physics/math.js';
import { PhysicsWorld, InterpolatedBatProvider } from '../physics/world.js';
import { SwingLoad } from '../physics/swingLoad.js';
import { PITCH } from '../physics/pitch.js';
import { buildEnvironment } from '../render/env.js';
import { buildBatMesh, addBatMark, BallView, StumpsView, MachineView, PitchMark, buildRingMarker } from '../render/objects.js';
import { toV3, toQ } from '../render/util.js';
import { InputManager } from '../xr/input.js';
import { UI } from '../ui/ui.js';
import { Sfx } from '../audio/sfx.js';
import { loadSettings, saveSettings, loadCalibration, saveCalibration } from './settings.js';
import { computeBatOffset, defaultBatOffset, computeRig, computeRigFacing, headForward } from './calibration.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { createSession, startMatch, startWithIntro } from './modes.js';
import { Ceremony, ceremonyMode } from './ceremony.js';
import { buildHelmetGrille, PlayerBowlerActor, NearCull } from '../render/viewModes.js';
import { PLAYER_BOWLER_ORDER } from './bowlerTypes.js';
import { Replay, tailFor } from './replay.js';
import { BallFinder } from '../render/ballFinder.js';
import { CrowdAudio } from '../audio/crowd.js';
import { MRPlacer } from '../xr/mr.js';
import { edgeDistance } from '../xr/playArea.js';
import { VisionCorrector } from '../render/visionCorrect.js';
import { eyeError } from './vision.js';
import { AIBatter } from './aiBatter.js';
import { BatterView, BowlerView, FieldView, NonStrikerView, PlayerBodyView } from '../render/people.js';
import { BatterCrew } from '../render/crew.js';
import { FIELD } from './fielding.js';
import { Particles } from '../render/particles.js';
import { Samples } from '../audio/samples.js';
import { Commentary } from '../audio/commentary.js';
import { AudioDirector } from '../audio/director.js';
import { DRSView } from '../render/drsView.js';
import { ContactLog } from './edgeTrack.js';
import { UmpireView } from '../render/umpires.js';
import { BatGeometry, aiBatConfig } from '../physics/bat.js';
import { Runs } from './running.js';
import { ShadowPool, Humanoid } from '../render/humanoid.js';
import { FrameLog } from './frameLog.js';
import { QuickSkip } from './quickSkip.js';
import { noteCrowd } from '../render/gestures.js';
import { PerfControl } from '../render/perf.js';

export const BAT_HEAD = { z: -1.05, legOffset: -0.35 };      // head relative to guard (hand) x
export const BOWL_HEAD = { x: 0.75, z: -19.6 };

const DIFFS = ['easy', 'medium', 'hard'];

export class Game {
  // env: a prebuilt environment (main.js builds it as its own loading step); deferPrewarm: main.js
  // warms up asynchronously behind the loading bar (render/warmup.js) and sets `ready` when done.
  constructor({ renderer, scene, camera, rig, dom, env = null, deferPrewarm = false }) {
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

    this.env = env || buildEnvironment(scene);
    ShadowPool.init(scene);
    this.world = new PhysicsWorld(CONFIG, (Date.now() & 0xffff) + 7);
    this.playerBatProvider = new InterpolatedBatProvider();
    this.playerBat = this.world.addBat('player', this.playerBatProvider);
    this.playerBat.swing = new SwingLoad(new BatGeometry(CONFIG.bat).sweetY);     // how loaded your swing is (the shot's power)
    this.aiBatter = new AIBatter(CONFIG);
    this.aiBat = this.world.addBat('ai', this.aiBatter, new BatGeometry(aiBatConfig()), 1);     // (his bat's original restitution: bat.js aiBatConfig)
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
    for (const s of Object.values(this.stumps)) for (const p of s.pieces) if (p.kind === 'stump') ShadowPool.track(p.mesh, 'stump');   // (sun shadows)
    this.machine = new MachineView(this.env.pitchGroup);
    this.pitchMark = new PitchMark(scene);
    this.aimMarker = buildRingMarker(0x1e8bff, 0.38, 0xffffff);   // blue, so it stands out on the pitch and the grass
    this.aimMarker.visible = false;
    scene.add(this.aimMarker);
    this.batterView = new BatterView(scene, this.aiBatter);
    this.figures = { bowler: new BowlerView(scene) };
    this.fieldView = new FieldView(scene, FIELD);
    this.nonStrikerView = new NonStrikerView(scene);
    // Who walks where between balls (batters changing ends, off and in at a wicket).
    this.crew = new BatterCrew(this, scene);
    this.batterView.crew = this.nonStrikerView.crew = this.crew;
    // (the AI bowler is drawn by his own figure and, when he fields, by a fielder's: the same man)
    this.fieldView.actors[this.fieldView.actors.length - 1].h.copyLook(this.figures.bowler.actor.h);
    this.runs = new Runs(CONFIG);
    this.umpires = new UmpireView(scene);
    this.drs = new DRSView(scene);
    this.contacts = new ContactLog(CONFIG).attach(this.world);   // what the ball touched each delivery (edgeTrack.js: Snicko, Hot Spot)
    this.playerBody = new PlayerBodyView(scene);
    this.playerBowler = new PlayerBowlerActor(scene);   // your body when you bowl (third person / replays)
    this.particles = new Particles(scene);
    // The headset camera hangs off its own rig so it can sit behind your
    // player while the controllers (and the game) stay at the crease.
    this.camRig = new THREE.Group();
    this.camRig.name = 'cameraRig';
    rig.add(this.camRig);
    this.camRig.add(camera);
    this.eye = { p: new THREE.Vector3(0, 1.6, 0), q: new THREE.Quaternion() };
    this.grille = buildHelmetGrille();
    scene.add(this.grille);
    this.nearCull = new NearCull();
    this.replay = new Replay(this);
    this.ballFinder = new BallFinder(scene);
    this.ballOverride = null;   // fielding drives the ball view after a catch / pick-up

    this.input = new InputManager(renderer, rig, camera, dom);
    this.quickSkip = new QuickSkip(this);   // the off-hand trigger once the ball is dead: straight to the next ball
    this.sfx = new Sfx();
    this.sfx.setEnabled(this.settings.sound);
    this.samples = new Samples(this.sfx);
    this.crowd = new CrowdAudio(this.sfx, this.samples);   // (its own dice: the sound must not change the game's)
    this.commentary = new Commentary({ sfx: this.sfx, rng: () => this.rng() });
    this.commentary.load().catch((e) => console.warn('Commentary unavailable', e));
    this.commentary.setEnabled(this.settings.commentary && this.settings.sound);
    this.audio = new AudioDirector(this);     // where every sound comes from (director.js)
    this.ui = new UI(this);
    this.ceremony = new Ceremony(this);   // the beats between pieces of play: intro, toss, wickets, the result (ceremony.js)
    this.timeScale = 1;              // current game-time scale (slow motion)
    this.timeScaleTarget = 1;
    // The hand with the bat and the ball. The game reads both from the right controller
    // (there is no left-handed setting yet); the other one is your off hand (its trigger
    // skips to the next ball once the ball is dead, quickSkip.js, and dives while running).
    this.mainHand = 'right';
    this.rigOffset = { x: 0, z: 0 }; // stick movement / coming down the pitch / the bowling run-up
    // Right stick: look around without turning your body. The rig turns by
    // lookYaw about your head; lookOff keeps the head where it was.
    this.lookYaw = 0;
    this.lookOff = { x: 0, z: 0 };
    this.rigDrop = 0;                     // m the sweep button has lowered your view (updateRigDrop)
    this.turnArmed = true;
    this.turnRate = 0;                    // smooth turn: current rad/s (eased toward the stick)
    this.runMarks = buildRunMarks();
    scene.add(this.runMarks);
    this.viewOverride = null;        // temporary rig (catching)
    this.clock = 0;                  // real seconds since start
    this.catchMarker = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 6, 28), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.85, depthTest: false }));
    this.catchMarker.visible = false; this.catchMarker.renderOrder = 5;
    scene.add(this.catchMarker);
    this.handMarkers = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8), new THREE.MeshLambertMaterial({ color: 0xf2f2f2, emissive: 0x333333, transparent: true, opacity: 0.75 }));
      m.visible = false; scene.add(m); return m;
    });
    this._hands = [new Vec3(), new Vec3()];
    this.applyDifficulty();
    this.vision = renderer && renderer.xr ? new VisionCorrector(renderer) : null;     // (vision correction: render/visionCorrect.js)
    this.applyVision();
    this._lastView = this.settings.view;
    this.coachSeen = new Set();       // control hints already shown this game

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
    this.ready = !deferPrewarm;      // loaded and warmed up (main.js): the headset can be entered
    if (!deferPrewarm) this.prewarm();
    this.perf = new PerfControl(this);   // frame stats, the quality governor, the perf panel (render/perf.js)
    // Long frames (src/game/frameLog.js), sampled by the animation loop (main.js): window.__longFrames.
    this.frameLog = new FrameLog();
    if (typeof window !== 'undefined') { window.__longFrames = this.frameLog.entries; window.__frameLog = this.frameLog; }
  }

  // The animation loop's measure of one frame (main.js): ms spent in frame() + render() (upd, rend: each).
  sampleFrame(now, work, upd = work, rend = 0) {
    const i = this.renderer && this.renderer.info;
    if (!i) return;
    const fi = this._fi || (this._fi = { programs: 0, textures: 0, geometries: 0 }), ctx = this._fctx || (this._fctx = () => this.frameContext());
    fi.programs = i.programs ? i.programs.length : 0; fi.textures = i.memory.textures; fi.geometries = i.memory.geometries;
    this.frameLog.sample(now, work, fi, ctx);
    if (this.perf) this.perf.sample(now, upd, rend);
    // (debug setting: the count on the HUD footer, between balls)
    if (this.settings.debugFrames && this.frameLog.count !== this._longShown && this.ui) {
      this._longShown = this.frameLog.count;
      this.ui.setHud({ footer: `${this.session ? this.session.footer() : this.footerText()} · long frames ${this.frameLog.count}` });
    }
  }

  // What was going on (for a long frame): game / session state, the replay's time and phase.
  frameContext() {
    const s = this.session, R = this.replay, c = R && R.active ? R.clip : null;
    const mem = typeof performance !== 'undefined' && performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null;
    return {
      clock: +this.clock.toFixed(2), state: this.state, xr: !!this.input.xr, menu: !!(this.ui && this.ui.menuOpen),
      session: s ? `${s.kind}:${s.state}` : null,
      replay: c ? { t: +(R.rt - c.start).toFixed(2), phase: R.rt < c.release ? 'run-up' : R.rt < c.key ? 'delivery' : c.dead != null && R.rt >= c.dead ? 'tail' : 'play', job: !!R.job }
        : R && R.pending ? 'due' : null,
      heapMB: mem,
    };
  }

  // Everything that is drawn only now and then (the DRS review and its board,
  // the replay's vignette, fade and label, the menus, cards and message strips,
  // the catch and hand markers, the ball finder, fireworks) has its shader
  // programs compiled and its textures uploaded now, at load, instead of the
  // first time it shows: the first LBW appeal compiled 2 programs, the first
  // review 6, the first replay uploaded 9 textures. On Quest a frame that
  // stalls on that is reprojected by the compositor, which smears / darkens
  // the side of the view you are turning toward (the recording: the first LBW
  // appeal, a replay).
  prewarm() {
    const r = this.renderer;
    if (!r || !r.compile) return;
    const t0 = performance.now();
    try {
      this.drs._build();
      this.drs.prewarmScreen(r);       // (the DRS screen: Snicko and Hot Spot drawn and uploaded once)
      r.compile(this.scene, this.camera);
      // the figures' other looks: see-through (your own body when you bat) and fading (coming / going)
      const me = this.playerBody.actor.h, any = Humanoid.all.find((h) => h !== me);
      if (me && !me.ghost) { me.setGhost(true); r.compile(me.root, this.camera, this.scene); me.setGhost(false); }
      if (any && (any.fade ?? 1) === 1) { any.setFade(0.5); r.compile(any.root, this.camera, this.scene); any.setFade(1); }
      r.compile(this.drs.group, this.camera, this.scene);    // (the review is out of the scene until it starts)
      const seen = new Set();
      const up = (o) => {
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) for (const k of ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'aoMap', 'lightMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'specularMap']) {
          const t = m[k];
          if (t && t.isTexture && !seen.has(t)) { seen.add(t); r.initTexture(t); }
        }
      };
      this.scene.traverse(up);
      this.drs.group.traverse(up);
      // One draw of everything, hidden things too, both levels of detail of
      // every figure, into a single pixel of the canvas (the next frame draws
      // over it): the geometry buffers and skeleton textures are made now, not
      // the first time a figure comes near or a replay shows one up close.
      const restore = [], layers = this.camera.layers.mask;
      this.scene.add(this.drs.group);
      this.scene.traverse((o) => { restore.push([o, o.visible, o.frustumCulled]); o.visible = true; o.frustumCulled = false; });
      this.camera.layers.enableAll();
      const vp = r.getViewport(new THREE.Vector4()), sc = r.getScissor(new THREE.Vector4()), sct = r.getScissorTest();
      r.setViewport(0, 0, 1, 1); r.setScissor(0, 0, 1, 1); r.setScissorTest(true);
      const lods = Humanoid.all.map((h) => h.lod);
      for (const lod of [1, 0]) { for (const h of Humanoid.all) h.setLod(lod); r.render(this.scene, this.camera); }
      Humanoid.all.forEach((h, i) => h.setLod(lods[i]));
      r.setViewport(vp); r.setScissor(sc); r.setScissorTest(sct);
      this.camera.layers.mask = layers;
      for (const [o, v, f] of restore) { o.visible = v; o.frustumCulled = f; }
      this.scene.remove(this.drs.group);
    } catch (e) { console.warn('prewarm', e); }
    this.prewarmMs = performance.now() - t0;
  }

  // ------------------------------------------------------------- settings
  applySettingsToConfig() {
    CONFIG.bowling.paceMultiplier = this.settings.paceMultiplier;
    CONFIG.bat.speedMultiplier = this.settings.batSpeedMultiplier;
    this.input && (this.input.right.hapticsScale = this.input.left.hapticsScale = this.settings.hapticsScale);
  }
  saveSettings() {
    saveSettings(this.settings); this.applySettingsToConfig();
    if (this.commentary) this.commentary.setEnabled(this.settings.commentary && this.settings.sound);
    if (this.audio) this.audio.applySettings(this.settings);
  }

  get diff() { return CONFIG.difficulty[this.settings.difficulty] || CONFIG.difficulty.medium; }

  // Difficulty changes the player's bat hit-zone (invisible assist).
  // Vision correction: the prescription from the settings to the GPU pass.
  applyVision() {
    if (!this.vision) return;
    const v = this.settings.vision;
    this.vision.configure({ L: { ...v.L }, R: { ...v.R }, pupil: v.pupil, tune: v.tune, strength: v.strength, steps: v.steps, region: v.region, imageDist: v.imageDist });
  }

  // On, in the headset, and an eye that needs it (not in mixed reality: the room is real, nothing to correct there).
  visionActive() {
    const v = this.settings.vision;
    if (!this.vision || !v || !v.on || this.mr || !this.input.xr) return false;     // (in the headset: its lenses are what the eye model is of)
    const o = { imageDist: v.imageDist, tune: v.tune };
    return [v.L, v.R].some((rx) => { const e = eyeError(rx, o); return Math.max(Math.abs(e.e1), Math.abs(e.e2)) >= 0.15; });
  }

  applyDifficulty() {
    const a = this.diff.batAssist, B = CONFIG.bat;
    const lvl = CONFIG.contactAssist[this.settings.contactAssist] || CONFIG.contactAssist.normal;
    const c = {
      ...B, bladeWidth: B.bladeWidth * a, bladeThickness: B.bladeThickness * (1 + (a - 1) * 0.6), sweetSpotSigma: B.sweetSpotSigma * (1 + (a - 1) * 0.8),
      bladeLength: B.bladeLength + lvl.toe, sweetSpotFromToe: B.sweetSpotFromToe + lvl.toe,     // invisible extra toe
    };
    this.playerBat.geom = new BatGeometry(c);
    this.playerBat.assist = lvl.capture > 0 || lvl.magnet > 0 ? { capture: lvl.capture, magnet: lvl.magnet } : null;
  }

  // Where the toe of your (visible) bat is, world space.
  batToe(out) {
    if (!this._toeY) this._toeY = new BatGeometry(CONFIG.bat).toeY;
    return out.set(0, this._toeY, 0).applyQuat(this.playerBatProvider.curr.pose.q).add(this.playerBatProvider.curr.pose.p);
  }

  // Distance (m) from a world point to the surface of your bat as the physics sees it.
  batDistance(p) {
    const pose = this.playerBatProvider.curr.pose;
    pose.toLocal(_bd, p);
    return this.playerBat.geom.sdf(_bd);
  }

  // Unit vector out of the right palm (world), from the calibrated bat face.
  palmDir(out) {
    const base = this.input.xr ? (this.calibration || defaultBatOffset()) : _identity;
    return out.set(0, 0, 1).applyQuat(base).applyQuat(this.input.right.gripPose.q);
  }

  // Control hints. coach(): once per game for each id; hint(): every time.
  coach(id, list, secs = 6) {
    if (this.coachSeen.has(id)) return false;
    this.coachSeen.add(id);
    this.ui.hints(list, secs);
    return true;
  }
  hint(list, secs = 0.5) { this.ui.hints(list, secs); }

  // Short commentary / crowd helpers (never throw).
  say(kind, ctx) {
    try { this.commentary.say(kind, ctx || {}); } catch { /* optional */ }
    try { this.audio.cue(kind, ctx || {}); } catch { /* optional: the crowd's mood follows the match */ }
  }
  sample(name, opts) { try { return this.audio.sample(name, opts); } catch { return false; } }
  crowdReact(kind, strength) {
    noteCrowd(kind, this.simTime);              // (the players' body language: src/render/gestures.js)
    try { this.env.crowdReact?.(kind, strength, this.world.ball.pos); } catch { /* optional: the stands react even with the sound off */ }
    try { if (this.settings.sound) this.audio.react(kind, strength, this.world.ball.pos); } catch { /* optional */ }
  }

  get difficulty() { return this.settings.difficulty; }

  batOffset() {
    if (!this.input.xr) return _identity;
    const base = this.calibration || defaultBatOffset();
    _off.copy(base);
    if (this.settings.batAngleDeg) _off.multiply(_tilt.setFromAxisAngle(_xAxis, this.settings.batAngleDeg * DEG));
    return _off;
  }

  // ------------------------------------------------------------- view modes
  // 'eyes' | 'helmet' | 'behind', as it applies right now (menus, catches
  // and replays are always seen through your own eyes).
  viewMode() {
    const v = this.settings.view;
    if (v !== 'behind') return v;
    const live = this.state === 'play' && this.session && !this.ui.menuOpen && !this.viewOverride && !(this.replay && this.replay.active) && !this.mr;
    return live ? 'behind' : 'eyes';
  }

  // Put the camera rig where the view mode wants it (called every frame).
  applyView() {
    const mode = this.viewMode();
    if (this.input.xr) {
      let x = 0, y = 0, z = 0;
      if (mode === 'behind') {
        const D = this.session.isBowling ? CONFIG.view.behindBowling : CONFIG.view.behindBatting;
        const yaw = this.rig.rotation.y, c = Math.cos(yaw), s = Math.sin(yaw);
        x = D[0] * c - D[2] * s; y = D[1]; z = D[0] * s + D[2] * c;    // world offset -> rig space
      }
      const cp = this.camRig.position;
      if (cp.x !== x || cp.y !== y || cp.z !== z) { cp.set(x, y, z); this.camRig.updateMatrixWorld(true); }
    } else {
      if (this.camRig.position.lengthSq() > 0) this.camRig.position.set(0, 0, 0);
      if (this.settings.view !== this._lastView) {
        // On a monitor the setting picks the matching camera (C still cycles).
        this.desktopView = this.settings.view === 'behind' ? (this.end === 'bowling' ? 3 : 0) : this.end === 'bowling' ? 0 : 1;
        this.placeDesktopCamera();
      }
    }
    this._lastView = this.settings.view;
  }

  // Where your eyes really are this frame (after the camera rig moved).
  updateEye() {
    if (this.input.xr) {
      this.rig.updateMatrixWorld(true);
      const hr = this.input.headRef;
      this.eye.p.set(hr.p.x, hr.p.y, hr.p.z).applyMatrix4(this.camRig.matrixWorld);
      this.camRig.getWorldQuaternion(_eq);
      this.eye.q.set(hr.q.x, hr.q.y, hr.q.z, hr.q.w).premultiply(_eq);
    } else {
      this.camera.updateMatrixWorld(true);
      this.camera.getWorldPosition(this.eye.p);
      this.camera.getWorldQuaternion(this.eye.q);
    }
    // Helmet grille: only when batting, through your own eyes (and not while a
    // menu or result card is open: its buttons would sit behind the bars).
    const batting = this.state === 'play' && this.session && !this.session.isBowling && !(this.ui && this.ui.menuOpen);
    const firstPerson = this.input.xr ? this.viewMode() === 'helmet' : this.settings.view === 'helmet' && (this.desktopView % 5) === 1 && this.end === 'batting';
    const g = this.grille;
    g.visible = !!(firstPerson && batting && !this.viewOverride && !(this.replay && this.replay.active));
    if (g.visible) { g.position.copy(this.eye.p); g.quaternion.copy(this.eye.q); }
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

  // Re-anchor the world around where you stand. The pitch keeps the
  // direction it has in your room (set the first time, by "Face this way",
  // or by the Quest's own recenter), so you can look anywhere while you do it.
  recenter() {
    if (this.mr && this.end !== 'bowling') return;
    if (!this.input.xr) { this.placeDesktopCamera(); return; }
    const head = this.input.headRef;
    if (!this.roomForward) this.roomForward = headForward(head.q);
    const f = this.roomForward;
    // You are always put in your place (the crease, your mark) where you stand:
    // never left away from it because the room's best spot is somewhere else.
    const at = head.p;
    this.homeRef = { x: at.x, z: at.z };             // (driftCheck)
    let r;
    this.lookYaw = 0; this.lookOff.x = this.lookOff.z = 0;
    if (this.end === 'bowling') r = computeRig(at, f, BOWL_HEAD.x, BOWL_HEAD.z, +1);
    else r = computeRig(at, f, this.settings.guardX + BAT_HEAD.legOffset, BAT_HEAD.z, -1);
    this.setRig(r);
  }

  // The Roomscale play area (xr/playArea.js) and the yellow ring on the floor
  // at the spot with the most room: shown when you are off it, before play
  // and between balls (it is a spot in your room: a child of the rig). Step
  // into it and the crease is re-centred on you there.
  updatePlayArea(xrFrame) {
    const on = this.input.xr && !this.mr && this.xrManager && this.xrManager.playArea;
    let A = on ? this.xrManager.playArea(xrFrame) : null;
    const p = this.input.headRef.p;
    if (A && edgeDistance(A.poly, p.x, p.z) < -0.5) A = null;       // (you are well outside it: not an area to trust)
    this.playArea = A;
    if (A && !this.areaMark) { this.areaMark = buildRingMarker(0xffd34d, 0.3); this.areaMark.visible = false; this.rig.add(this.areaMark); }
    if (!this.areaMark) return;
    const sst = this.session ? this.session.state : null;
    const calm = this.state === 'safety' || this.state === 'calibrate' || this.state === 'menu' || (this.state === 'play' && sst !== 'live' && sst !== 'review');
    const show = !!A && calm && !this.viewOverride && !(this.replay && this.replay.active) && Math.hypot(p.x - A.spot.x, p.z - A.spot.z) > 0.25;
    // (the ring is only a suggestion: walk into it and your place comes with you -- re-centred there, not mid-ball)
    if (A && calm && !this.viewOverride && !(this.replay && this.replay.active) && this.pendingRecenter == null && this.homeRef
      && Math.hypot(p.x - A.spot.x, p.z - A.spot.z) < 0.2 && Math.hypot(this.homeRef.x - p.x, this.homeRef.z - p.z) > 0.3) this.recenter();
    this.areaMark.visible = show;
    if (show) this.areaMark.position.set(A.spot.x, this.rigDrop + 0.005, A.spot.z);
  }

  // Between balls in VR: wandered well away from the spot play was centred on?
  // Tell the player (and buzz) to step back -- drift adds up ball by ball and
  // ends in the Quest's boundary, which takes you out of the game.
  driftCheck(sst) {
    if (!this.input.xr || this.mr || !this.homeRef || this.state !== 'play' || !this.session || this.viewOverride) return;
    if (sst === 'live' || sst === 'review' || this.ui.menuOpen) return;
    const p = this.input.headRef.p, d = Math.hypot(p.x - this.homeRef.x, p.z - this.homeRef.z);
    const now = this.clock;
    const A = this.playArea, near = A && edgeDistance(A.poly, p.x, p.z) < Math.min(1.0, A.spot.room - 0.25);
    if ((d > CONFIG.xr.driftWarn || near) && !(now < (this._driftT || 0))) {
      this._driftT = now + 4;
      this.ui.prompt(A ? 'Near the edge of your play area — step into the yellow ring' : 'You have drifted — step back to your spot', 2.5, '#ffd34d');
      if (this.input.left) this.input.left.pulse(0.3, 60);
    }
  }

  // Temporarily put the player somewhere else, facing (dirX, dirZ) — used
  // for catching chances.
  beginViewOverride(x, z, dirX, dirZ) {
    this.viewOverride = { x, z, dirX, dirZ };
    this.lookYaw = 0; this.lookOff.x = this.lookOff.z = 0;       // set the rig directly; face forward afterwards
    if (this.input.xr) {
      const head = this.input.headRef;
      const r = computeRigFacing(head.p, headForward(head.q), x, z, dirX, dirZ);
      this.rig.position.set(r.x, 0, r.z);
      this.rig.rotation.set(0, r.yaw, 0);
      this.rig.updateMatrixWorld(true);
      this.input.refreshHeadWorld();
      this.input.right.resetMotion(); this.input.left.resetMotion();
    } else {
      this.camera.position.set(x, 1.62, z);
      this.camera.lookAt(x + dirX * 6, 1.45, z + dirZ * 6);
      this.camera.updateMatrixWorld(true);
    }
  }
  endViewOverride() {
    if (!this.viewOverride) return;
    this.viewOverride = null;
    for (const m of this.handMarkers) m.visible = false;
    if (this.input.xr) this.setRig(this.rigState); else this.placeDesktopCamera();
    if (this.input.xr && this.replay && !this.replay.active) this.replay.fade.cut();   // back from the catch: in from dark, not a jump
  }

  // World positions of the player's hands (XR controllers, or a point on the
  // mouse ray on desktop).
  playerHands() {
    const out = [];
    if (this.input.xr) {
      if (this.input.left.connected) out.push(this._hands[0].copy(this.input.left.gripPose.p));
      if (this.input.right.connected) out.push(this._hands[1].copy(this.input.right.gripPose.p));
    } else {
      this.input.desktop.mouseRay(_ro, _rd);
      out.push(this._hands[0].set(_ro.x + _rd.x * 0.55, _ro.y + _rd.y * 0.55, _ro.z + _rd.z * 0.55));
    }
    return out;
  }

  // Move within the crease / down the pitch (added to the anchored rig).
  setRigOffset(x, z) {
    if (x === this.rigOffset.x && z === this.rigOffset.z) return;
    this.rigOffset.x = x; this.rigOffset.z = z;
    if (this.end === 'bowling' && !(this.mr)) this.ui.setHudPose('bowling', z);
    if (this.viewOverride) return;
    if (this.input.xr) {
      this.rig.position.set(this.rigState.x + x + this.lookOff.x, -this.rigDrop, this.rigState.z + z + this.lookOff.z);
      this.rig.updateMatrixWorld(true);
      this.input.refreshHeadWorld();
    } else if ((this.desktopView % 5) === 1 && this.end === 'batting') {
      this.camera.position.set(-0.42 + x, 1.62, -0.85 + z);
    } else if (this.end === 'bowling' && !(this.replay && this.replay.active)) this.placeDesktopCamera();   // the run-up moves the bowler's cameras
  }

  setRig(r) {
    this.rigState = r;
    const ov = !!this.viewOverride;
    this.rig.position.set(r.x + (ov ? 0 : this.rigOffset.x + this.lookOff.x), ov ? 0 : -this.rigDrop, r.z + (ov ? 0 : this.rigOffset.z + this.lookOff.z));
    this.rig.rotation.set(0, r.yaw + (ov ? 0 : this.lookYaw), 0);
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
      ? [[[0.75, 1.72, -20.3], [0.0, 0.9, 0.0]], [[9, 3.5, -14], [0, 0.8, -6]], [[0.4, 2.6, 6.0], [0, 0.8, -12]], [[1.1, 2.5, -23.6], [0.0, 0.8, -2.0]]]
      : [[[0.7, 3.3, 7.2], [0.0, 0.9, -12]], [[-0.42, 1.62, -0.85], [0.25, 1.35, -19]], [[6.5, 1.6, -1.6], [-0.2, 0.9, -1.4]], [[0.4, 2.6, -24], [0, 0.8, -2]], [[0, 55, -10], [0, 0, -10.01]]];
    const i = this.desktopView % views.length, v = views[i];
    // Bowling: your eyes (0) and behind you (3) come with you on the run-up.
    const oz = this.end === 'bowling' && (i === 0 || i === 3) ? this.rigOffset.z : 0;
    c.position.set(v[0][0], v[0][1], v[0][2] + oz);
    c.lookAt(_lk.set(v[1][0], v[1][1], v[1][2] + oz));
    c.updateMatrixWorld(true);
    if (this.input) {
      this.input.desktop.batHand.set(this.settings.guardX + 0.04, 1.02, -1.25);
      this.input.desktop.bowlShoulder.set(0.6 + this.rigOffset.x, 1.55, -19.4 + (this.end === 'bowling' ? this.rigOffset.z : 0));
    }
  }

  // Where your bowling body is: your head in XR; on a monitor the bowler's
  // eyes at the mark / on the run-up (the desktop camera can be elsewhere).
  bowlerHead() {
    if (this.input.xr) return this.input.headPose;
    const h = this._deskHead || (this._deskHead = new Pose());
    h.p.set(BOWL_HEAD.x + this.rigOffset.x, 1.62, BOWL_HEAD.z + this.rigOffset.z);
    h.q.set(0, 1, 0, 0);                                   // facing +Z, down the pitch
    return h;
  }

  // The floor marks for the run-up: the top of your mark and the commit line.
  // spec: { length, commit } (CONFIG.bowling.runUp[type]) or null to hide.
  showRunMarks(spec) {
    const m = this.runMarks;
    m.visible = !!spec && !this.mr;
    if (!spec) return;
    m.userData.mark.position.set(BOWL_HEAD.x, 0.006, BOWL_HEAD.z + 0.25 - spec.length);
    m.userData.commit.position.set(BOWL_HEAD.x, 0.006, BOWL_HEAD.z + 0.25 - spec.commit);
  }

  // Holding the sweep button lowers your view to a kneeling sweeper's eyes
  // (the figure's kneeling head for your height), vertically only. The drop
  // is set when you press (how far your real eyes are above that height
  // then) and never grows while held, so your own head still moves the view
  // 1:1; crouching further only shrinks it, as far as needed to keep your
  // eyes no lower than DROP_FLOOR under the kneeling height (never a double
  // drop). It moves in a fixed-time smootherstep blend (DROP_IN down, DROP_OUT
  // back up; a new target is blended from where it is), so a long frame never
  // overshoots. Settings -> Sweep view drop; not in replays, menus, a catch,
  // MR, while running or diving, or when not batting.
  updateRigDrop(dt) {
    const ses = this.session, D = this.drop || (this.drop = { held: false, latched: 0, from: 0, to: 0, t: 0, dur: DROP_IN });
    const allow = this.input.xr && !this.mr && this.settings.sweepDrop !== false && ses && !ses.isBowling && ses.sweepDrop && this.end === 'batting'
      && this.state === 'play' && !this.ui.menuOpen && !this.viewOverride && !(this.replay && this.replay.active);
    const held = !!(allow && ses.sweepDrop()), real = this.input.headRef.p.y;
    const kneel = this.playerBody.kneelEyeY(!!(ses && ses.sweepSlog));
    let floor = Infinity;
    if (held) {
      if (!D.held) D.latched = Math.max(0, real - kneel);                     // (set on the press)
      floor = Math.max(0, real - (kneel - DROP_FLOOR));                       // (eyes no lower than the floor)
      D.latched = Math.min(D.latched, floor);                                 // (only ever shrinks while held)
    }
    D.held = held;
    const to = held ? D.latched : 0;
    if (Math.abs(to - D.to) > 1e-6) {                                         // a new target: blended from where it is now
      D.from = this.rigDrop; D.to = to; D.t = 0;
      D.dur = to > D.from ? DROP_IN : DROP_OUT;
    }
    D.t = Math.min(D.dur, D.t + dt);
    const u = D.t / D.dur, e = u * u * u * (u * (u * 6 - 15) + 10);
    let v = D.from + (D.to - D.from) * e;
    if (v > floor) { v = floor; D.from = floor; D.t = 0; D.dur = DROP_OUT; }   // (held to the floor: the blend goes on from there)
    this.rigDrop = Math.max(0, v);
    if (!this.input.xr || this.viewOverride || (this.replay && this.replay.active)) return;    // (they place the rig themselves)
    if (Math.abs(this.rig.position.y + this.rigDrop) > 1e-7) {
      this.rig.position.y = -this.rigDrop;
      this.rig.updateMatrixWorld(true);
      this.input.refreshHeadWorld();
    }
  }

  // ------------------------------------------------------------- look around
  // Turn your view by `delta` rad about where your head is now.
  // smooth: a continuous turn (the stick turning you like turning your body):
  // the bat keeps its swept motion. A snap turn teleports the bat.
  turnLook(delta, smooth = false) {
    if (!this.input.xr || this.viewOverride) return;
    const h = this.input.headRef.p, y0 = this.rigState.yaw + this.lookYaw, y1 = y0 + delta;
    // Head offset from the rig origin, in world xz, at a rig yaw y.
    const wx = (y) => h.x * Math.cos(y) + h.z * Math.sin(y), wz = (y) => -h.x * Math.sin(y) + h.z * Math.cos(y);
    this.lookOff.x += wx(y0) - wx(y1);
    this.lookOff.z += wz(y0) - wz(y1);
    this.lookYaw += delta;
    const r = this.rigState;
    this.rig.position.set(r.x + this.rigOffset.x + this.lookOff.x, -this.rigDrop, r.z + this.rigOffset.z + this.lookOff.z);
    this.rig.rotation.set(0, r.yaw + this.lookYaw, 0);
    this.rig.updateMatrixWorld(true);
    this.input.refreshHeadWorld();
    if (!smooth) this.snapBat = true;
  }
  // Face forward again (back to the anchored view).
  resetLook() {
    if (!this.lookYaw && !this.lookOff.x && !this.lookOff.z) return;
    this.lookYaw = 0; this.lookOff.x = this.lookOff.z = 0;
    if (this.input.xr && !this.viewOverride && !(this.replay && this.replay.active)) this.setRig(this.rigState);
  }
  // Right stick left / right (VR): smooth (default) or snap turn. Click: face forward.
  // Smooth turning is continuous, like turning your body: the rate follows
  // how far the stick is pushed, eased in and out so it never jerks.
  handleTurn(dt) {
    const R = this.input.right, L = this.input.left, mode = this.settings.turn;
    if (!this.input.xr || this.mr || this.ui.menuOpen || this.viewOverride || (this.replay && this.replay.active) || this.state === 'mrplace') { this.turnRate = 0; return; }
    if (R.buttons.stick.down && L.connected) { this.turnRate = 0; this.resetLook(); return; }     // (no left controller: the click is the menu)
    const x = R.stick.x, V = CONFIG.view;
    if (mode === 'smooth') {
      const dz = V.smoothTurnDeadzone, a = Math.abs(x);
      const want = a > dz ? -Math.sign(x) * Math.pow((a - dz) / (1 - dz), 1.4) * V.smoothTurnDegPerSec * DEG : 0;
      this.turnRate += (want - this.turnRate) * (1 - Math.exp(-dt / V.smoothTurnEase));
      if (Math.abs(this.turnRate) < 1e-3 && !want) this.turnRate = 0;
      if (this.turnRate) this.turnLook(this.turnRate * dt, true);
    }
    else if (mode === 'snap') {
      if (Math.abs(x) < 0.3) this.turnArmed = true;
      else if (this.turnArmed && Math.abs(x) > 0.7) {
        this.turnArmed = false;
        this.turnLook(-Math.sign(x) * V.snapTurnDeg * DEG);
        R.resetMotion(); L.resetMotion();
      }
    }
  }

  // ------------------------------------------------------------- XR hooks
  onXRStart(mode) {
    this.xrMode = mode;
    if (this.perf) this.perf.onXRStart();
    this.roomForward = null;              // taken from where you look at the first recenter
    this.sfx.init();
    this.mr = mode === 'ar';
    this.env.stadium.visible = !this.mr;
    this.ui.board.mesh.visible = !this.mr;
    if (this.session) this.endSession();
    this.ceremony.stop();
    this.ui.closeMenu();
    this.pendingRecenter = 2;          // after a couple of frames of valid pose
    if (this.mr) {
      this.state = 'mrplace';
      this.startMRPlacement();
    } else {
      this.state = 'safety';
    }
  }

  // Point the pitch where you are looking now, then recenter.
  realign() {
    if (!this.input.xr) return;
    this.roomForward = headForward(this.input.headRef.q);
    this.recenter();
  }

  // System recenter (long-press Meta button) moved the reference space origin.
  onReferenceReset() {
    this.roomForward = null;              // the Quest has re-aimed "forward" for us
    if (this.mr) { if (this.mrPlacer) { this.endSession(); this.ui.closeMenu(); this.mrPlacer.restart(); } return; }
    this.pendingRecenter = 2;
  }

  // Headset taken off / system menu open: pause play.
  onVisibilityChange(state) {
    if (state !== 'visible' && this.state === 'play' && this.session && !this.ui.menuOpen) this.ui.openMenu('main');
  }

  onXREnd() {
    this.xrMode = null;
    if (this.perf) this.perf.onXREnd();
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
    this.ceremony.stop();
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
    if (this.session && this.session.onMenuChanged) this.session.onMenuChanged(open);
  }

  // ------------------------------------------------------------- sessions
  // intro: started from the menu (the intro and the toss when Ceremonies are on); a direct start has none.
  startSession(kind, { intro = false } = {}) {
    if (this.session) this.endSession();
    this.ceremony.stop();
    this.lastMode = kind;
    this.coachSeen.clear();                 // a new game: show each control hint again
    if (intro && ceremonyMode(this) !== 'off') { this.state = 'play'; this.ui.closeMenu(); startWithIntro(this, kind); return; }
    if (kind === 'match') { this.state = 'menu'; this.setEnd('batting'); startMatch(this); return; }
    this.startSessionObj(createSession(this, kind));
  }

  startSessionObj(session) {
    if (this.session) this.endSession();
    this.resultInfo = null;
    this.ballOverride = null;
    this.session = session;
    this.state = 'play';
    this.ui.setHud({ big: '', last: '', detail: '', players: '' });   // a new game: nothing left over from the last one
    this.ui.closeMenu();
    this.session.enter();
    if (!this.ui.menuOpen) this.input.desktop.mode = this.session.isBowling ? 'bowl' : 'bat';   // (enter() may open a page: the bowler)
  }

  endSession() {
    if (!this.session) return;
    if (this.replay) { this.replay.stop(); this.replay.pending = null; this.replay.count = 0; }
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

    const paused = this.ui.menuOpen && this.state === 'play' && !!this.session;   // (no session: a beat before the game, e.g. the toss's call, goes on round the card)
    // Game-time scale (slow motion for easier difficulties and catching).
    this.timeScale += (this.timeScaleTarget - this.timeScale) * Math.min(1, dt * 10);
    if (Math.abs(this.timeScale - this.timeScaleTarget) < 0.005) this.timeScale = this.timeScaleTarget;
    const realDt = dt;
    this.clock += dt;
    const sdt = dt * (this.session ? this.timeScale : 1);
    this.realDt = realDt;
    if (!paused && !(this.replay && this.replay.active)) this.simTime += sdt;
    // Your controllers and head are sampled on the real clock (the raw frame
    // time): a velocity from pose differences is physical m/s whatever the
    // slow motion, as the runtime's own XR velocities are. The ball, the
    // physics, collisions and the replay tape run on simTime.
    this.realNow = now;
    this.input.update(now, xrFrame);

    this.updatePlayArea(xrFrame);
    if (this.pendingRecenter != null && this.input.xr) {
      if (--this.pendingRecenter <= 0) { this.pendingRecenter = null; this.recenter(); this.afterXRSettled(); }
    }

    this.ceremony.input();                   // (a beat's skip press first, then the skip to the next ball: each uses its press up)
    this.quickSkip.update(realDt);           // (first: a press it uses is gone before anything else reads it)
    this.handleGlobalInput(dt);
    this.updateRigDrop(realDt);
    this.replay.update(realDt);
    // Face forward again: during replays (they move the rig), and when the next
    // ball is about to come (batting: leaving 'idle'; bowling: back to 'ready').
    if (this.replay.active) { this.lookYaw = 0; this.lookOff.x = this.lookOff.z = 0; }
    const sst = this.session ? this.session.state : null;
    if (sst !== this._lookState) {
      if (this.session && (this.session.isBowling ? sst === 'ready' : this._lookState === 'idle')) this.resetLook();
      this._lookState = sst;
    }
    if (this.replay.active) {
      // Replay: play is frozen; the recording poses everything.
      this.applyView();
      this.updateEye();
      this.playerBody.actor.h.setGhost(false); this.playerBowler.h.setGhost(false);   // (Replay.apply poses the joints and your figure's arm lengths)
      if (this.playerBowler.showHand) this.playerBowler.showHand(null);
      if (this.session && this.session.field) this.crew.duringReplay(realDt);   // (a batter walking off / in keeps going)
      this.replay.placeOverlays(this.eye, realDt);
      this.ballView.faceTrail(this.eye.p, realDt);
      this.ballFinder.hide();
      Humanoid.updateLods(this.eye.p);
      this.nearCull.update(this.eye.p, Humanoid.all, 0.6);
      this.commentary.update(realDt);
    } else {
      this.updatePlayerBat(paused);
      if (!paused) this.driftCheck(sst);

      if (this.state === 'calibrate') this.updateCalibration(dt);
      if (this.mrPlacer && this.state === 'mrplace') this.mrPlacer.update(xrFrame, dt);

      if (!paused) {
        if (this.session) this.session.update(sdt, this.simTime);
        this.commentary.update(realDt);
        this.world.advanceTo(this.simTime);
        for (const e of this.world.drainEvents()) this.onPhysicsEvent(e);
      }
      this.applyView();
      this.updateEye();
      this.updateViews(sdt, paused);
      this.ballView.faceTrail(this.eye.p, paused ? 0 : sdt);
      this.umpires.update(paused ? 0 : realDt, this.clock);
      if (this.session && this.state === 'play' && !paused) this.recordForReplay();
      this.replay.placeOverlays(this.eye, realDt);
    }
    this.ceremony.update(realDt);            // (after the eye: its cards and the coin; the beats on real time)
    this.ui.updatePointer(this.input);
    this.ui.update();
    this.env.update(dt, now);
    ShadowPool.update();                     // (after everything is posed: bats, stumps, the upload)
    try { this.audio.update(realDt); } catch (err) { console.warn('audio', err); }   // the listener in your head, the crowd, what has no event of its own
    const cu = this.env.crowd.userData.uniforms;
    // The nets are a training day: a few people scattered round the stands, no cannons, no wave.
    const nets = !!(this.session && (this.session.kind === 'nets' || this.session.kind === 'bowlnets'));
    this.env.crowd.userData.setOccupancy?.(nets ? 0.1 : 1); this.particles.celebrations = !nets;
    cu.uTime.value = now;
    cu.uCheer.value = Math.max(0, cu.uCheer.value - dt * 0.35);
    // Now and then a Mexican wave goes round the ground.
    this.waveIn = (this.waveIn ?? 45) - dt;
    if (this.waveIn <= 0 && !(this.waveLeft > 0) && this.state === 'play' && !nets) {
      this.waveLeft = 16; this.waveIn = 80 + this.rng() * 70;
      if (this.settings.sound) this.sample('crowd_whoa', { gain: 0.35 });
    }
    if (this.waveLeft > 0) {
      this.waveLeft -= dt;
      cu.uWave.value = (cu.uWave.value + dt * 0.7) % (Math.PI * 2);
      cu.uWaveOn.value = Math.max(0, Math.min(1, this.waveLeft / 2, (16 - this.waveLeft) / 2));
    } else cu.uWaveOn.value = 0;
    this.input.desktop.endFrame();
  }

  // After a hit: an arrow to the ball when it's out of view, a halo when it's
  // far away, and where it will land while it's in the air.
  updateBallFinder(dt) {
    const ses = this.session, b = this.world.ball;
    const hit = ses && this.state === 'play' && (ses.hit || ses.byes) && (ses.state === 'live' || ses.state === 'settle') && !this.viewOverride;
    let ball = null, landing = null;
    if (hit && this.settings.ballFinder !== false) {
      if (b.active && (b.batted || ses.byes)) {
        ball = this.ballView.mesh.position;
        const first = ses.hit && ses.hit.pred && ses.hit.pred.bounces && ses.hit.pred.bounces[0];
        if (first && b.bouncesSinceBat === 0 && !b.crossedBoundary) landing = first.pos;
      } else if (this.ballOverride && ses.state === 'live') ball = this.ballView.mesh.position;   // in a fielder's hand / being thrown
    }
    this.ballFinder.update(dt, this.eye, ball, landing);
  }

  // Your other hand (not the bat's) in the headset, or null: your batting body reads it (on the handle or off).
  offHandPos() {
    const off = this.mainHand === 'left' ? this.input.right : this.input.left;
    return this.input.xr && off.connected ? off.gripPose.p : null;
  }

  // Record this frame for the replay and spot the moments it needs.
  recordForReplay() {
    const R = this.replay, ses = this.session, m = R.marks;
    const st = ses.state, t = this.simTime;
    if (m.release != null && !m.played) {
      if (this.ballOverride) R.mark('held', t);
      if (this.world.ball.padded) R.mark('pad', t);
      if (ses.field && ses.field.logic.caught) R.mark('caught', t);
      // The ball is dead once play leaves 'live' (to a review, or to its result).
      if (st === 'review' || st === 'settle') R.mark('dead', t);
      R.observe(ses, t);                        // (the field's moments: a drop, a dive, a direct hit, overthrows)
    }
    // A review (the appeal, DRS, the third umpire) can outlast the tape: only
    // its first moments are recorded, so the ball is still there afterwards.
    if (!(st === 'review' && m.dead != null && t > m.dead + tailFor(m) + 0.2)) R.record(t);
    // The ball's replay, if what happened earns one (Settings -> Replays), after the result (and any review's verdict) is up.
    if (st === 'settle' && this._prevSessState !== 'settle') R.schedule(t);
    this._prevSessState = st;
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
    // Left thumbstick click always toggles the menu; Y does too unless the
    // session is using it (diving while running).
    const yFree = !(this.session && this.session.usesY && this.session.usesY());
    // Running in to bowl, a stick click is easily knocked: it has to be held a moment.
    const runningIn = !!(this.session && this.session.runningIn && this.session.runningIn() && !this.ui.menuOpen);
    let stickMenu = L.buttons.stick.down;
    if (runningIn) {
      const hold = CONFIG.bowling.runUp.menuStickHold;
      const was = this.stickHold || 0;
      this.stickHold = L.buttons.stick.pressed ? was + dt : 0;
      stickMenu = was < hold && this.stickHold >= hold;
    } else this.stickHold = L.buttons.stick.pressed && !L.buttons.stick.down ? Infinity : 0;   // (a click held over the end of the run opens nothing)
    const menuBtn = stickMenu || (L.buttons.b.down && yFree) || (this.input.xr && !L.connected && R.buttons.stick.down && !runningIn);
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
    this.handleTurn(dt);
    // Bowler page: keys 1-4 pick on a monitor too.
    if (!this.input.xr && this.ui.menuOpen && this.ui.page === 'bowler') PLAYER_BOWLER_ORDER.forEach((k, i) => { if (D.took('Digit' + (i + 1))) this.actions.pickBowler(k); });
    if (!this.input.xr) {
      if (D.took('KeyC')) { this.desktopView++; this.placeDesktopCamera(); }
      if (D.took('KeyT')) { this.settings.trail = !this.settings.trail; this.saveSettings(); }
    }
    if (this.session && this.state === 'play' && !this.ui.menuOpen && !(this.replay && this.replay.active) && !this.ceremony.holding) this.session.handleInput(this.input);
  }

  updatePlayerBat(paused) {
    const R = this.input.right;
    const batting = this.session ? !this.session.isBowling : this.state === 'calibrate' || this.state === 'menu';
    const show = batting && R.connected && !(this.state === 'calibrate' && this.calib.step === 'capture' && this.input.xr && !this.calibration);
    this.batMesh.visible = show && !this.viewOverride && !(this.ui.menuOpen && this.input.xr && this.state !== 'calibrate' && !this.session);
    this.playerBat.enabled = batting && !!this.session && !paused && R.connected && R.tracked;
    if (!R.connected || !R.tracked) { this.snapBat = true; return; }
    this.poseBatMesh();
    if (paused) return;
    // (the provider on the game clock, as the ball; the controller's velocities are real m/s, so slow
    // motion gives you more time, not more power. The swing's load is measured on the real clock.)
    // (the grip the bat turns about is the bat's own: lifted onto the turf with it, and a bat riding the
    // turf is not going down into it - its downward speed is not bat speed)
    let lin = R.linVel;
    if (this.batLift > 0 && R.linVel.y < 0) lin = _lin.set(R.linVel.x, 0, R.linVel.z);
    if (this.snapBat) { this.playerBatProvider.snap(this.simTime, _batPose, _batPose.p); this.playerBat.swing.reset(); this.snapBat = false; }
    else this.playerBatProvider.push(this.simTime, _batPose, _batPose.p, lin, R.angVel);
    if (this.input.xr) { const hp = this.input.headPose.p; _swRef.x = hp.x; _swRef.z = hp.z; _swRef.y = this.rig.position.y; }
    this.playerBat.swing.push(this.simTime, this.realNow ?? this.clock, _batPose, this.input.xr ? _swRef : null);
  }

  // The bat where your controller is now (_batPose too). Posed again just
  // before your figure, in case the rig moved since (a new ball resets it).
  poseBatMesh() {
    const R = this.input.right;
    if (!R.connected || !R.tracked) return;
    _batPose.p.copy(R.gripPose.p);
    _batPose.q.multiplyQuats(R.gripPose.q, this.batOffset()).normalize();
    // (the sweep's view drop takes your hands down too: a bat that would go into the turf rides on it
    // instead - lifted by no more than the drop, so a real bat is never moved)
    if (this.rigDrop > 0) {
      const B = CONFIG.bat, toeY = B.gripFromHandleTop - B.handleLength - B.bladeLength, q = _batPose.q;
      _bd.set(0, 1, 0).applyQuat(q); const ay = _bd.y;
      _bd.set(1, 0, 0).applyQuat(q); const xy = Math.abs(_bd.y);
      _bd.set(0, 0, 1).applyQuat(q); const zy = Math.abs(_bd.y);
      const low = _batPose.p.y + ay * toeY - xy * B.bladeWidth / 2 - zy * B.bladeThickness / 2;
      this.batLift = clamp(BAT_ABOVE_TURF - low, 0, this.rigDrop);
      _batPose.p.y += this.batLift;
    } else this.batLift = 0;
    toV3(this.batMesh.position, _batPose.p);
    toQ(this.batMesh.quaternion, _batPose.q);
  }

  onPhysicsEvent(e) {
    try { this.audio.physics(e); } catch (err) { console.warn('audio', err); }   // (the bat, the pitch, the stumps, the boards: where they happen)
    if (e.type === 'launch') { this.replay.mark('release', e.t); this.replay.marks.playerBatting = !!(this.session && !this.session.isBowling); }
    else if (e.type === 'bat') this.replay.mark('hit', e.t);
    else if (e.type === 'wicket') this.replay.mark('wicket', e.t);
    this.replay.event(e);                       // (the ball's exact moments for slow motion; an edge, over the rope)
    if (e.type === 'bounce') {
      if (e.speedIn > 3) this.particles.dust(e.pos, e.speedIn, e.surface !== 'pitch', this.world.ball.vel);
      if (!e.batted && e.surface === 'pitch' && e.index === 1) this.pitchMark.show(e.pos, this.world.ball.vel);
    } else if (e.type === 'bat') {
      this.particles.contact(e.pos, e.quality, e.isEdge);
      if (e.batId === 'player') addBatMark(this.batMesh, e.local, e.quality);      // (a cherry on the face)
      if (e.batId === 'player') {
        const H = CONFIG.haptics;
        const R = this.input.right;
        if (e.isEdge) R.pulse(H.edgeIntensity, H.edgeDurationMs);
        else R.pulse(H.contactMin + (H.contactMax - H.contactMin) * e.quality, H.durationMinMs + (H.durationMaxMs - H.durationMinMs) * e.quality);
      }
    } else if (e.type === 'wicket') {
      this.stumps[e.end].break({ x: 0, y: 0, z: (e.end === 'batting' ? 1 : -1) * e.speed }, e.stump);
      this.particles.splinters({ x: 0, z: e.end === 'batting' ? 0 : -20.12 });
    } else if (e.type === 'boundary' && e.batted) {
      this.particles.celebrate(e.pos, !!e.onFull);         // (roof cannons: five for a six, two for a four)
    }
    if (this.session) this.session.onEvent(e);
  }

  updateViews(dt, paused) {
    const b = this.world.ball;
    if (this.ballOverride) {
      this.ballView.trailGrowing = false;
      this.ballView.update(this.ballOverride.pos, 0, null, false);
    } else if (b.active && this.ballView.visible) {
      // Extrapolate the sub-step remainder so the ball is drawn at frame time.
      const lag = paused ? 0 : clamp(this.simTime - this.world.time, 0, 0.01);
      _render.copy(b.pos).addScaled(b.vel, b.stopped ? 0 : lag);
      if (_render.y < CONFIG.ball.radius) _render.y = CONFIG.ball.radius;
      this.ballView.trailGrowing = !!(this.settings.trail && b.batted);
      this.ballView.update(_render, paused ? 0 : dt, b.spin, this.ballView.trailGrowing);
    }
    // Visibility assist: keep the ball at a minimum angular size (render only).
    let k = 1;
    const inHand = !!(this.session && this.session.isBowling && this.session.state === 'ready');   // true size in your hand
    if (this.settings.ballBoost && this.ballView.visible && !inHand) {
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
    Humanoid.updateLods(this.input.headPose.p);
    if (this.viewOverride && !this.viewOverride.scene) {
      const hs = this.playerHands();
      this.handMarkers.forEach((m, i) => { m.visible = i < hs.length; if (m.visible) m.position.set(hs[i].x, hs[i].y, hs[i].z); });
      this.catchMarker.lookAt(this.input.headPose.p.x, this.input.headPose.p.y, this.input.headPose.p.z);
    }
    // Particles (point size needs the per-eye half height).
    this.particles.pollContacts(this.contacts);     // (dust where the bat's toe hits the turf)
    this.particles.update(pdtFx(paused, dt), this.input.xr ? 900 : this.renderer.getDrawingBufferSize(_dbs).y / 2);
    // People.
    const lookBall = b.active ? _look.set(b.pos.x, b.pos.y, b.pos.z) : (this.ballOverride ? _look.set(this.ballOverride.pos.x, this.ballOverride.pos.y, this.ballOverride.pos.z) : null);
    const pdt = paused ? 0 : dt;
    this.batterView.between = !!(this.session && this.session.isBowling && this.session.state === 'settle');     // (the AI striker out of his stance between balls)
    this.batterView.update(this.simTime, pdt || 1e-4, lookBall);
    this.nonStrikerView.update(pdt || 1e-4, this.simTime, { backingUp: this.nonStrikerBacksUp(), ball: lookBall, watch: this.bowlerSpot(_watch) });
    if (!this.session || !this.session.field) {
      if (!this.session || this.session.isBowling || this.session.bowler !== 'ai') this.figures.bowler.show(false);
    }
    // Your own body: posed every frame you play (replays show it) but only
    // drawn when you are not looking out through its eyes.
    const behind = this.viewMode() === 'behind';
    const replaying = !!(this.replay && this.replay.active);
    const batting = !!(this.session && !this.session.isBowling && this.end === 'batting');
    const deskThird = !this.input.xr && (this.desktopView % 5) !== 1 && !(this.session && this.session.isBowling) && this.end === 'batting';
    // A runner in your kit has taken over: your (solid) figure fades out as he fades in beside it.
    const cover = this.batterView.runnerOnly && this.batterView.shown ? (this.batterView.actor.h.fade ?? 1) : 0;
    const runnerOut = cover > 0.5;
    if (!replaying) {
      // Your figure is your height: sized from the tallest you have stood in the headset.
      if (this.input.xr) {
        this.standEye = Math.min(1.95, Math.max((this.standEye ?? 1.55) - (pdt || 0) * 0.002, this.input.headRef.p.y));   // (your real eyes: not the sweep's view drop)
        for (const h of [this.playerBody.actor.h, this.playerBowler.h]) {
          const k = clamp(this.standEye / (this.playerBody.actor.headRestY * h.baseScale + 0.11), 0.84, 1.12);
          if (Math.abs(h.root.scale.x - h.baseScale * k) > 0.002) h.root.scale.setScalar(h.baseScale * k);
        }
      }
      if (batting || deskThird) {
        if (this.input.xr) this.poseBatMesh();
        this.playerBody.update(pdt || 1e-4, this.simTime, this.batMesh.position, this.batMesh.quaternion, lookBall, this.input.xr ? this.input.headPose : null,
          this.session && this.session.bodyState ? this.session.bodyState() : null, this.offHandPos(), this.input.xr ? this.lookYaw || 0 : 0,
          { t: this.realNow ?? this.clock, dt: paused ? 1e-4 : this.realDt || pdt || 1e-4, drop: this.input.xr ? this.rigDrop : 0 });
      }
      // Through your own eyes you see a faint body below you (no head), so you
      // know where your feet are in the crease.
      const ghost = batting && this.input.xr && !behind && !this.viewOverride && !this.mr && this.settings.ownBody !== false;
      this.playerBody.actor.h.setGhost(ghost, GHOST_LEGS);    // (solid; it steps aside from the ball and your blade: Humanoid.seeThrough)
      if (ghost) { const G = this.batMesh.geometry.userData, M = this.batMesh.updateMatrixWorld() || this.batMesh.matrixWorld; this.playerBody.actor.h.seeThrough(this.ballView.mesh.visible ? this.ballView.mesh.position : null, _fpA.set(0, G.shY, 0).applyMatrix4(M), _fpB.set(0, G.toeY, 0).applyMatrix4(M)); }
      // (through your own eyes the faint body stays under you: it is where you stand)
      if (!ghost) this.playerBody.actor.h.setFade(1 - cover);
      this.playerBody.show((deskThird || ((behind || ghost) && batting)) && (ghost || cover < 0.98));
      this.playerBody.actor.h.replayVisible = batting && !runnerOut;      // replays show your body
      this.batReplayVisible = !runnerOut;                                 // …and your bat, unless your runner has it
      const bowling = !!(this.session && this.session.isBowling);
      if (bowling) {
        const R = this.input.right, L = this.input.left;
        this.playerBowler.update(pdt || 1e-4, this.simTime, this.bowlerHead(), R.connected ? R.gripPose.p : null, L.connected && this.input.xr ? L.gripPose.p : null, lookBall);
      }
      // Bowling through your own eyes: the same faint body, so you can see your
      // feet against the crease as you land.
      const bGhost = bowling && this.input.xr && !behind && !this.viewOverride && this.settings.ownBody !== false;
      this.playerBowler.h.setGhost(bGhost);
      this.playerBowler.visible = bowling && (behind || bGhost || (!this.input.xr && (this.desktopView % 4) === 3));
      this.playerBowler.h.replayVisible = bowling;
    }
    // Nobody (and no bat) is ever drawn inside your head.
    this.nearCull.update(this.eye.p, Humanoid.all);
    this.updateBallFinder(paused ? 0 : dt);
  }

  // The non-striker backs up as the ball is bowled, not all through the
  // run-up: from the bowler's last strides (the AI: 0.8 s before release;
  // you: your delivery stride) until the ball is hit or dead.
  nonStrikerBacksUp() {
    const ses = this.session;
    if (!ses || !ses.backingUp || !ses.backingUp()) return false;
    if (ses.state === 'live') return true;
    if (ses.isBowling) return !!(ses.run && ses.run.canRelease);
    const run = this.figures.bowler.actor.run;
    return ses.state === 'runup' && !!run && this.simTime > run.tr - 0.8;
  }
  // Where the bowler is (for the non-striker to watch): the AI's figure, or you.
  bowlerSpot(out) {
    const ses = this.session;
    if (ses && ses.isBowling) { const p = this.bowlerHead().p; return out.set(p.x, p.y, p.z); }
    const a = this.figures.bowler.actor;
    return a.visible ? out.set(a.pos.x, 1.5, a.pos.z) : null;
  }

  // Kit colours: the player's team is 'home'.
  setTeams(playerBatting) {
    const bat = playerBatting ? 'home' : 'away', bowl = playerBatting ? 'away' : 'home';
    this.fieldView.setTeam(bowl);
    this.figures.bowler.setTeam(bowl);
    this.batterView.setTeam(bat);
    this.nonStrikerView.setTeam(bat);
    this.crew.setTeam(bat);
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
    this.audio.cheer(intensity);
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
const _swRef = { x: 0, y: 0, z: 0 }, _lin = new Vec3();
const BAT_ABOVE_TURF = 0.01;       // m: the lowest corner of your bat's toe is kept this far up while the view is dropped
const DROP_IN = 0.22, DROP_OUT = 0.3, DROP_FLOOR = 0.12;   // s the sweep's view drop takes down / back up; m your eyes may go under the kneeling height
const _fpA = new THREE.Vector3(), _fpB = new THREE.Vector3();   // (your blade's shoulder and toe, for your own body to stay out of your view of it)
const GHOST_LEGS = 0.72;          // opacity of your see-through pads when you look down (boots +0.3, thighs x0.7; Humanoid.setGhost)
const _bd = new Vec3();
const _eq = new THREE.Quaternion();
const _render = new Vec3();
const _look = new THREE.Vector3();
const _dbs = new THREE.Vector2();
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3();
const _lk = new THREE.Vector3();
const _watch = new THREE.Vector3();

// Run-up floor marks: a white line at the top of your mark, an amber one where
// you are committed (inside it the run carries you to the crease).
function buildRunMarks() {
  const g = new THREE.Group();
  g.name = 'runMarks';
  const strip = (color, w, d) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.renderOrder = 2;
    g.add(m); return m;
  };
  g.userData.mark = strip(0xffffff, 0.7, 0.06);
  g.userData.commit = strip(0xffb347, 0.9, 0.05);
  g.visible = false;
  return g;
}
const pdtFx = (paused, dt) => (paused ? 0 : dt);

// UI callbacks.
function makeActions(game) {
  const g = game;
  const persist = () => { g.saveSettings(); g.ui.refresh(); if (g.session && g.session.onSettingsChanged) g.session.onSettingsChanged(); };
  return {
    start: (kind) => { g.sfx.init(); g.startSession(kind); },
    play: (kind) => { g.sfx.init(); g.startSession(kind, { intro: true }); },     // (from the menu: with its intro)
    quit: () => { g.ceremony.stop(); g.endSession(); g.state = 'menu'; g.setEnd('batting'); g.ui.openMenu('main'); g.ui.setHud({ title: 'Crease VR', score: '', sub: 'Choose a mode', big: '', last: '', detail: '' }); },
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
    realign: () => { g.realign(); g.ui.closeMenu(); },
    mr: () => {
      if (g.mr) { g.endSession(); g.ui.closeMenu(); if (g.mrPlacer) g.mrPlacer.restart(); return; }
      if (g.input.xr && g.xrManager) {
        // Switch straight from VR: needs the trigger's "select" event, which arrives on release.
        g.wantMR = g.clock;
        g.ui.setHud({ big: 'Switching to mixed reality…', bigColor: '#5cf2a6', last: 'Pull the trigger once more if nothing happens — or exit VR and press "Enter MR nets" on the page.', detail: '' });
        return;
      }
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
    soundCycle: () => {
      const s = g.settings;
      if (s.sound && s.commentary) s.commentary = false;
      else if (s.sound) s.sound = false;
      else { s.sound = true; s.commentary = true; }
      g.sfx.setEnabled(s.sound);
      if (!s.sound || !s.commentary) g.commentary.stop();
      persist();
    },
    cycle: (key, values, dir) => {
      const i = values.indexOf(g.settings[key]);
      g.settings[key] = values[(Math.max(0, i) + dir + values.length) % values.length];
      if (key === 'contactAssist') g.applyDifficulty();
      if (key === 'view') g.applyView();
      persist();
    },
    toggle: (key) => { g.settings[key] = !g.settings[key]; if (key === 'sound') g.sfx.setEnabled(g.settings.sound); persist(); },
    // Vision page: a field of settings.vision (eye: 'L' | 'R' for the prescription), or turn it on / off.
    vision: (key, d, lo, hi, eye = null) => {
      const v = g.settings.vision, o = eye ? v[eye] : v;
      o[key] = clamp(Math.round((o[key] + d) * 100) / 100, lo, hi);
      if (key === 'axis') o.axis = ((o.axis % 180) + 180) % 180;
      g.applyVision(); persist();
    },
    visionToggle: () => { g.settings.vision.on = !g.settings.vision.on; g.applyVision(); persist(); },
    visionCompare: () => { if (g.vision) g.vision.show = !g.vision.show; },
    visionCopyEye: () => { const v = g.settings.vision; v.L = { ...v.R }; g.applyVision(); persist(); },
    setting: (key, d, lo, hi) => { g.settings[key] = clamp(Math.round((g.settings[key] + d) * 100) / 100, lo, hi); persist(); },
    difficulty: (dir) => { const i = clamp(DIFFS.indexOf(g.settings.difficulty) + dir, 0, 2); g.settings.difficulty = DIFFS[i]; g.applyDifficulty(); persist(); },
    bowlCalib: () => { g.bowlCalibPending = 3; g.sfx.init(); g.startSession('bowlnets'); },
    // Bowler page: pick (closes the menu: you are at your mark).
    pickBowler: (key) => {
      const ses = g.session;
      if (!ses || !ses.isBowling) return;
      if (ses.setBowler(key) !== false) g.ui.closeMenu();
      else g.ui.refresh();
    },
  };
}
