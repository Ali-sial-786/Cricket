// Menus (laser-pointer driven), HUD, scoreboard, safety + calibration screens.
import * as THREE from 'three';
import { CanvasPanel, grid } from './panel.js';
import { drawHintCard } from './controllerHint.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const signed = (v, d = 2) => (v > 0 ? '+' : '') + v.toFixed(d);

const CONTACT = ['off', 'low', 'normal', 'high'];
const VIEWS = ['eyes', 'helmet', 'behind'];
const VIEW_NAMES = { eyes: 'your eyes', helmet: 'eyes + helmet grille', behind: 'behind the player' };
const REPLAYS = ['off', 'bowler', 'batter'];
const REPLAY_NAMES = { off: 'off', bowler: "bowler's view", batter: "batter's view" };

export class UI {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.menu = new CanvasPanel({ width: 1.1, height: 0.78, ppm: 760, name: 'menu' });
    this.menu.mesh.visible = false;
    this.scene.add(this.menu.mesh);
    this.page = 'main';

    // HUD (world-locked, beside the pitch).
    this.hud = new CanvasPanel({ width: 1.3, height: 0.72, ppm: 600, name: 'hud', bg: 'rgba(10,16,26,0.78)', interactive: false });
    this.scene.add(this.hud.mesh);
    this.hudData = { title: 'Crease VR', score: '', sub: '', players: '', last: '', big: '', bigColor: '#ffd34d', detail: '', footer: '' };

    // Big stadium scoreboard.
    this.board = new CanvasPanel({ width: 24, height: 9, ppm: 42, name: 'scoreboard', bg: 'rgba(6,10,18,1)', interactive: false });
    this.board.mesh.position.copy(game.env.screen.pos);
    this.board.mesh.lookAt(game.env.screen.look);
    game.env.stadium.add(this.board.mesh);
    this.boardData = { lines: ['CREASE VR', 'Nets'] };

    // Laser pointer.
    // Along +Z: Object3D.lookAt() aims an object's +Z axis at the target.
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)]);
    this.laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x7fd3ff, transparent: true, opacity: 0.8 }));
    this.laser.frustumCulled = false;
    this.laser.visible = false;
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.dot.visible = false;
    this.scene.add(this.laser, this.dot);
    this.ray = new THREE.Raycaster();
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3();
    this.hoverHit = null;
    this.setHudPose('batting');

    // Message strip that floats in front of the player ("CATCH IT!",
    // decisions). Commentary is never captioned.
    this.promptPanel = new CanvasPanel({ width: 1.05, height: 0.26, ppm: 640, name: 'prompt', bg: 'rgba(8,12,20,0.62)', interactive: false });
    this.promptPanel.mesh.visible = false;
    this.promptPanel.mesh.renderOrder = 11;
    this.scene.add(this.promptPanel.mesh);
    this.promptText = ''; this.promptColor = '#ffffff'; this.promptUntil = 0;
    // Control hints: small controller pictures with the button to press lit.
    this.hintPanel = new CanvasPanel({ width: 0.78, height: 0.3, ppm: 1000, name: 'hints', bg: null, interactive: false });
    this.hintPanel.mesh.visible = false;
    this.hintPanel.mesh.renderOrder = 11;
    this.scene.add(this.hintPanel.mesh);
    this.hintList = []; this.hintKey = ''; this.hintUntil = 0;
    this._pt = new THREE.Vector3(); this._pq = new THREE.Quaternion(); this._pf = new THREE.Vector3();
    this.clock = 0;
  }

  // Big hint line (stays `secs`, or until replaced). Empty string clears it.
  prompt(text, secs = 3, color = '#ffffff') {
    if (text === this.promptText && color === this.promptColor) { this.promptUntil = this.clock + secs; return; }
    this.promptText = text; this.promptColor = color; this.promptUntil = this.clock + secs;
    this.drawPrompt();
  }
  drawPrompt() {
    const P = this.promptPanel, W = [];
    const p = this.clock < this.promptUntil ? this.promptText : '';
    if (p) W.push({ type: 'label', x: P.W / 2, y: 82, text: p, size: p.length > 46 ? 30 : 40, bold: true, align: 'center', color: this.promptColor });
    P.set(W, '');
    this.promptShown = !!p;
  }

  // Show control hints (up to three) for `secs`. Same set again just extends it.
  hints(list, secs = 4) {
    const key = list.map((h) => h.label + h.button + h.hand).join('|');
    this.hintUntil = this.clock + secs;
    if (key === this.hintKey) return;
    this.hintKey = key; this.hintList = list.slice(0, 3);
    const P = this.hintPanel, n = this.hintList.length, desktop = !this.game.input.xr;
    const cw = 240, ch = P.H - 12, gap = 16, x0 = (P.W - (n * cw + (n - 1) * gap)) / 2;
    P.set(this.hintList.map((h, i) => ({ type: 'custom', draw: (g) => drawHintCard(g, x0 + i * (cw + gap), 6, cw, ch, h, desktop) })), '');
  }
  clearHints() { this.hintUntil = 0; }

  updatePrompt(dt) {
    this.clock += dt;
    if (this.promptShown && this.clock >= this.promptUntil) this.drawPrompt();
    const head = this.game.input.headPose;
    this._pq.set(head.q.x, head.q.y, head.q.z, head.q.w);
    this._pf.set(0, 0, -1).applyQuaternion(this._pq); this._pf.y = 0;
    if (this._pf.lengthSq() < 1e-6) this._pf.set(0, 0, -1);
    this._pf.normalize();
    const eye = this.game.eye ? this.game.eye.p : head.p;
    const follow = (panel, show, dist, drop) => {
      panel.mesh.visible = show;
      if (!show) return;
      this._pt.set(eye.x + this._pf.x * dist, eye.y - drop, eye.z + this._pf.z * dist);
      const m = panel.mesh;
      if (m.position.distanceTo(this._pt) > 3) m.position.copy(this._pt);
      else m.position.lerp(this._pt, Math.min(1, dt * 5));
      m.lookAt(eye.x, eye.y - 0.1, eye.z);
      panel.update();
    };
    follow(this.promptPanel, this.promptShown && !this.menuOpen, 1.5, 0.5);
    follow(this.hintPanel, this.hintList.length > 0 && this.clock < this.hintUntil && !this.menuOpen, 1.35, 0.72);
  }

  get menuOpen() { return this.menu.mesh.visible; }

  // Place the HUD next to the pitch for the current end.
  setHudPose(end) {
    const m = this.hud.mesh;
    // Scaled up so ~30 px text subtends ~1° (readable on Quest 3S).
    if (end === 'bowling') {
      m.scale.setScalar(1.5);
      m.position.set(-2.6, 2.4, -15.6);
      m.lookAt(0.75, 1.65, -19.6);
    } else if (end === 'mr') {
      m.scale.setScalar(1.0);
      m.position.set(1.6, 1.8, -4.0);
      m.lookAt(-0.4, 1.6, -1.0);
    } else {
      m.scale.setScalar(1.8);
      m.position.set(2.7, 2.7, -5.8);
      m.lookAt(-0.4, 1.6, -1.05);
    }
  }

  openMenu(page = 'main') {
    this.page = page;
    this.placeMenu();
    this.menu.mesh.visible = true;
    this.buildPage();
    this.game.onMenuChanged(true);
  }

  // Put the menu 1.1 m in front of the player's current head pose.
  placeMenu() {
    const m = this.menu.mesh;
    if (this.game.input.xr) {
      const head = this.game.input.headPose;
      const q = new THREE.Quaternion(head.q.x, head.q.y, head.q.z, head.q.w);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      m.position.set(head.p.x + fwd.x * 1.1, Math.max(1.0, head.p.y - 0.15), head.p.z + fwd.z * 1.1);
      m.lookAt(head.p.x, m.position.y, head.p.z);
    } else {
      // Desktop: centre it in front of the camera.
      const cam = this.game.camera;
      cam.updateMatrixWorld(true);
      const p = cam.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      m.position.copy(p).addScaledVector(fwd, 1.0);
      m.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
    }
  }

  closeMenu() {
    this.menu.mesh.visible = false;
    this.laser.visible = false;
    this.dot.visible = false;
    this.game.onMenuChanged(false);
  }

  refresh() { if (this.menuOpen) this.buildPage(); }

  // ---------------------------------------------------------------- pages
  buildPage() {
    const g = this.game, s = g.settings, P = this.menu;
    const W = [];
    const btn = (id, r, text, onClick, extra = {}) => W.push({ type: 'button', id, ...r, text, onClick, ...extra });
    const step = (id, r, label, value, onDec, onInc) => W.push({ type: 'stepper', id, ...r, label, value, onDec, onInc });
    const label = (x, y, text, extra = {}) => W.push({ type: 'label', x, y, text, ...extra });

    if (this.page === 'safety') {
      label(P.W / 2, P.H * 0.24, 'Before you play', { align: 'center', size: 46, bold: true, color: '#ffd34d' });
      label(P.W / 2, P.H * 0.36,
        'Clear at least 2 × 2 m around you — you will swing hard.\nCheck ceiling height and keep pets/people well away.\nUse the wrist strap. No walking needed: the game moves you.',
        { align: 'center', size: 30 });
      const L = grid(P, { top: 0.72, bottom: 0.06, cols: 1, rows: 1, left: 0.3, right: 0.3 });
      btn('ok', L(0, 0), 'My space is clear', () => g.actions.safetyOk());
      P.set(W, '');
    } else if (this.page === 'calibrate') {
      const cal = g.calib;
      label(P.W / 2, P.H * 0.17, 'Bat calibration', { align: 'center', size: 44, bold: true, color: '#ffd34d' });
      const text = cal.step === 'capture'
        ? 'Hold the RIGHT controller like a bat handle.\nStand in your stance and look at the bowler.\nLet the bat hang straight down, face to the bowler,\nthen press A (or left trigger).'
        : `Check the bat in your hand. Fine-tune its angle with\nthe LEFT thumbstick (up/down): ${signed(s.batAngleDeg, 0)}°\nPress A to save, B to capture again.`;
      label(P.W / 2, P.H * 0.29, text, { align: 'center', size: 29 });
      const L = grid(P, { top: 0.72, bottom: 0.06, cols: 3, rows: 1 });
      if (cal.step === 'adjust') {
        btn('cal-redo', L(0, 0), 'Recapture', () => g.actions.calibRedo());
        btn('cal-save', L(1, 0), 'Save', () => g.actions.calibSave(), { active: true });
      } else {
        btn('cal-cap', L(1, 0), 'Capture now', () => g.actions.calibCapture(), { active: true });
      }
      btn('cal-skip', L(2, 0), g.calibration ? 'Cancel' : 'Use default', () => g.actions.calibSkip());
      P.set(W, '');
    } else if (this.page === 'main') {
      const L = grid(P, { top: 0.15, bottom: 0.04, cols: 2, rows: 6 });
      const playing = !!g.session;
      btn('nets', L(0, 0), 'Nets: Batting', () => g.actions.start('nets'));
      btn('bnets', L(1, 0), 'Nets: Bowling', () => g.actions.start('bowlnets'));
      btn('chase', L(0, 1), `Run Chase (${s.overs} ov)`, () => g.actions.start('chase'));
      btn('over', L(1, 1), 'Bowl an Over', () => g.actions.start('over'));
      btn('match', L(0, 2), `Match (${s.overs} overs, 5 wickets)`, () => g.actions.start('match'));
      btn('machine', L(1, 2), 'Bowling machine…', () => this.go('machine'));
      btn('howto', L(0, 3), 'How to play', () => this.go('howto'), { active: !s.seenHowTo });
      btn('settings', L(1, 3), `Settings… (${s.difficulty})`, () => this.go('settings'));
      btn('calib', L(0, 4), 'Calibrate bat', () => g.actions.calibrate());
      btn('recenter', L(1, 4), 'Recenter here', () => g.actions.recenter());
      if (playing) {
        btn('resume', L(0, 5), 'Resume', () => this.closeMenu(), { active: true });
        btn('quit', L(1, 5), 'End this game', () => g.actions.quit());
      } else {
        btn('mr', L(0, 5, 2), g.mr ? 'Mixed reality: re-place the stumps' : (g.input.xr ? 'Switch to mixed reality nets' : 'Mixed reality nets (in headset)'), () => g.actions.mr());
      }
      P.set(W, 'CREASE VR');
    } else if (this.page === 'howto') {
      const tab = this.howTab || 0;
      const pages = [
        ['BATTING', [
          'The right controller is the bat.',
          'Bat FACE at contact: straight = along the ground,',
          'opened upward = in the air.',
          'Hold TRIGGER: stride down the pitch. Harder to time,',
          'more power. Miss it and the keeper can stump you.',
          'Hold GRIP: sweep. Swing to the off side = reverse sweep.',
          'TRIGGER + GRIP: come down and slog-sweep.',
          'Left stick (or really stepping): move in your crease.',
        ]],
        ['RUNNING', [
          'After you hit it:  X = RUN.',
          'The batters stop after each run. X again for another.',
          'Left TRIGGER = turn back.   Y = DIVE for the line.',
          'A throw that beats you home is a RUN OUT.',
          'Close run-outs and stumpings go to the third umpire.',
          'Given out LBW? Press A to review (1 per innings).',
          'NO BALL: the next ball is a FREE HIT.',
          'On a free hit you can only be run out.',
        ]],
        ['BOWLING', [
          'Hold right TRIGGER, bowl overarm, let go to release.',
          'Arm speed = pace. Early release = full, late = short.',
          'RIGHT STICK left / right: choose your bowler',
          '(fast, medium, off-spin, leg-spin) at the start of an over.',
          'FAST / MEDIUM: with the ball in your hand, turn your wrist',
          'left = OUT-swing, right = IN-swing (or press A / B).',
          'Roll the wrist as you let go = off-cutter / leg-cutter.',
          'OFF-SPIN: roll clockwise. LEG-SPIN: roll anticlockwise.',
          'Back of the hand to the batter = doosra / googly.',
          'Stay behind the crease, or it is a no-ball.',
        ]],
        ['FIELDING', [
          'Catch chance: time slows and you become the fielder.',
          'Reach out and get a hand to the ball. No button.',
          'When a fielder picks up:  A = throw to the keeper,',
          "B = throw to the bowler's end.",
          'Beat the batter home for a RUN OUT.',
          'Bowl slow and batters come down the pitch:',
          'beat the bat and the keeper STUMPS them.',
          'Turned-down LBW? Press A to review.',
        ]],
      ];
      const [name, lines] = pages[tab];
      label(P.W / 2, P.H * 0.19, lines.join('\n'), { align: 'center', size: lines.length > 8 ? 23 : 25 });
      const L = grid(P, { top: 0.78, bottom: 0.05, cols: 5, rows: 1 });
      pages.forEach((pg, i) => btn('tab' + i, L(i, 0), pg[0], () => { this.howTab = i; this.go('howto'); }, { active: i === tab, size: 24 }));
      btn('back', L(4, 0), 'Back', () => { s.seenHowTo = true; g.saveSettings(); this.go('main'); });
      P.set(W, 'HOW TO PLAY — ' + name);
    } else if (this.page === 'machine') {
      const m = s.machine;
      const L = grid(P, { top: 0.15, bottom: 0.04, cols: 2, rows: 6 });
      const lenName = nearestName(LENGTH_PRESETS, 'length', m.length);
      const lineName = nearestName(LINE_PRESETS, 'line', m.line);
      step('pace', L(0, 0), 'Pace', `${Math.round(m.paceKmh)} km/h`, () => g.actions.machine('paceKmh', -5), () => g.actions.machine('paceKmh', 5));
      step('length', L(1, 0), 'Length', `${lenName} ${fmt1(m.length)}m`, () => g.actions.machinePreset('length', -1), () => g.actions.machinePreset('length', 1));
      step('line', L(0, 1), 'Line', lineName, () => g.actions.machinePreset('line', -1), () => g.actions.machinePreset('line', 1));
      step('fine', L(1, 1), 'Line fine', `${signed(m.line)} m`, () => g.actions.machine('line', -0.02), () => g.actions.machine('line', 0.02));
      step('swing', L(0, 2), 'Swing', m.swing === 0 ? 'none' : `${m.swing > 0 ? 'out' : 'in'} ${Math.abs(m.swing).toFixed(2)}`, () => g.actions.machine('swing', -0.25), () => g.actions.machine('swing', 0.25));
      step('seam', L(1, 2), 'Seam', m.seam === 0 ? 'none' : `${m.seam > 0 ? 'away' : 'back'} ${Math.abs(m.seam).toFixed(2)}`, () => g.actions.machine('seam', -0.25), () => g.actions.machine('seam', 0.25));
      step('spin', L(0, 3), 'Spin', m.spinType === 'none' ? 'none' : `${m.spinType}-spin`, () => g.actions.machineSpin(-1), () => g.actions.machineSpin(1));
      step('spinAmt', L(1, 3), 'Spin amount', `${Math.round(m.spinAmount * 100)}%`, () => g.actions.machine('spinAmount', -0.1), () => g.actions.machine('spinAmount', 0.1));
      step('rel', L(0, 4), 'Release', m.release === 'over' ? 'over wkt' : 'around', () => g.actions.machineRelease(), () => g.actions.machineRelease());
      step('var', L(1, 4), 'Variation', `${Math.round(m.variation * 100)}%`, () => g.actions.machine('variation', -0.1), () => g.actions.machine('variation', 0.1));
      btn('auto', L(0, 5), `Auto-feed: ${s.autoFeed ? 'ON' : 'OFF'}`, () => g.actions.toggle('autoFeed'), { active: s.autoFeed });
      const r = L(1, 5), half = (r.w - 12) / 2;
      const inNets = g.session && g.session.kind === 'nets';
      btn('go', { x: r.x, y: r.y, w: half, h: r.h }, inNets ? 'Resume' : 'Nets now', () => (inNets ? this.closeMenu() : g.actions.start('nets')), { active: true });
      btn('back', { x: r.x + half + 12, y: r.y, w: half, h: r.h }, 'Back', () => this.go('main'));
      P.set(W, 'Bowling machine');
    } else if (this.page === 'settings') {
      const L = grid(P, { top: 0.165, bottom: 0.05, cols: 2, rows: 8 });
      const xrRate = g.xrManager && g.xrManager.frameRate ? `${g.xrManager.frameRate} Hz target` : 'no target';
      const vel = g.input.xr ? (g.input.right.hasXRVel ? 'XR' : 'pose') : 'desktop';
      label(P.W / 2, P.H * 0.122, `Frame ${Math.round(g.stats.fps)} Hz (${xrRate}) · controller velocity: ${vel} · v${g.version}`, { align: 'center', size: 22, color: '#8fb3d1' });
      step('diff', L(0, 0), 'Difficulty', s.difficulty, () => g.actions.difficulty(-1), () => g.actions.difficulty(1));
      step('overs', L(1, 0), 'Overs', String(s.overs), () => g.actions.setting('overs', -1, 1, 5), () => g.actions.setting('overs', 1, 1, 5));
      step('contact', L(0, 1), 'Contact assist', s.contactAssist, () => g.actions.cycle('contactAssist', CONTACT, -1), () => g.actions.cycle('contactAssist', CONTACT, 1));
      step('view', L(1, 1), 'View', VIEW_NAMES[s.view] || s.view, () => g.actions.cycle('view', VIEWS, -1), () => g.actions.cycle('view', VIEWS, 1));
      step('replay', L(0, 2), 'Replays', REPLAY_NAMES[s.replay] || s.replay, () => g.actions.cycle('replay', REPLAYS, -1), () => g.actions.cycle('replay', REPLAYS, 1));
      step('batAngle', L(1, 2), 'Bat angle', `${signed(s.batAngleDeg, 0)}°`, () => g.actions.setting('batAngleDeg', -2, -30, 30), () => g.actions.setting('batAngleDeg', 2, -30, 30));
      step('batSpeed', L(0, 3), 'Bat power', `×${s.batSpeedMultiplier.toFixed(2)}`, () => g.actions.setting('batSpeedMultiplier', -0.05, 0.7, 2.5), () => g.actions.setting('batSpeedMultiplier', 0.05, 0.7, 2.5));
      step('pace', L(1, 3), 'Bowl pace', `×${s.paceMultiplier.toFixed(2)}`, () => g.actions.setting('paceMultiplier', -0.1, 1.0, 5), () => g.actions.setting('paceMultiplier', 0.1, 1.0, 5));
      step('hap', L(0, 4), 'Haptics', `${Math.round(s.hapticsScale * 100)}%`, () => g.actions.setting('hapticsScale', -0.25, 0, 1), () => g.actions.setting('hapticsScale', 0.25, 0, 1));
      const gx = s.guardX;
      const guardName = gx < -0.08 ? 'leg' : gx < -0.02 ? 'mid-leg' : gx < 0.03 ? 'middle' : 'mid-off';
      step('guard', L(1, 4), 'Guard', `${guardName} ${gx >= 0 ? '+' : ''}${Math.round(gx * 100)}cm`, () => g.actions.setting('guardX', -0.03, -0.2, 0.15), () => g.actions.setting('guardX', 0.03, -0.2, 0.15));
      btn('assist', L(0, 5), `Bowling aim assist: ${s.aimAssist ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimAssist'), { active: s.aimAssist });
      btn('marker', L(1, 5), `Aim marker: ${s.aimMarker ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimMarker'), { active: s.aimMarker });
      const r4 = L(0, 6), tw3 = (r4.w - 20) / 3;
      btn('trail', { x: r4.x, y: r4.y, w: tw3, h: r4.h }, `Trail ${s.trail ? 'ON' : 'OFF'}`, () => g.actions.toggle('trail'), { active: s.trail, size: 24 });
      btn('boost', { x: r4.x + tw3 + 10, y: r4.y, w: tw3, h: r4.h }, `Big ball ${s.ballBoost ? 'ON' : 'OFF'}`, () => g.actions.toggle('ballBoost'), { active: s.ballBoost, size: 24 });
      btn('finder', { x: r4.x + 2 * (tw3 + 10), y: r4.y, w: tw3, h: r4.h }, `Ball finder ${s.ballFinder ? 'ON' : 'OFF'}`, () => g.actions.toggle('ballFinder'), { active: s.ballFinder, size: 24 });
      btn('sound', L(1, 6), !s.sound ? 'Sound: OFF' : s.commentary ? 'Sound + commentary' : 'Sound, no commentary', () => g.actions.soundCycle(), { active: s.sound });
      btn('relcal', L(0, 7), 'Calibrate bowling release', () => g.actions.bowlCalib());
      btn('recal', L(1, 7), 'Calibrate bat', () => g.actions.calibrate());
      label(P.W * 0.5, P.H * 0.975, 'Y / Esc: back to the game', { align: 'center', size: 20, color: '#7f8fa0' });
      btn('back', { x: P.W - 150, y: 14, w: 130, h: 56 }, 'Back', () => this.go('main'));
      P.set(W, 'Settings');
    } else if (this.page === 'result') {
      const r = g.resultInfo || { title: 'Done', lines: [] };
      label(P.W / 2, P.H * 0.22, r.title, { align: 'center', size: 56, bold: true, color: r.color || '#ffd34d' });
      const lines = r.lines.filter(Boolean);
      label(P.W / 2, P.H * (lines.length > 4 ? 0.31 : 0.36), lines.join('\n'), { align: 'center', size: lines.length > 4 ? 25 : lines.length > 3 ? 28 : 32 });
      const L = grid(P, { top: 0.74, bottom: 0.06, cols: 2, rows: 1 });
      if (r.choices) {
        const C = grid(P, { top: 0.74, bottom: 0.06, cols: Math.max(2, r.choices.length + 1), rows: 1 });
        r.choices.forEach((c, i) => btn('choice' + i, C(i, 0), c.text, c.fn, { active: true }));
        btn('menu', C(Math.max(1, r.choices.length), 0), 'Main menu', () => g.actions.quit());
      } else {
        if (r.next) btn('next', L(0, 0), r.nextText || 'Continue', r.next, { active: true });
        else btn('again', L(0, 0), 'Play again', () => g.actions.start(g.lastMode), { active: true });
        btn('menu', L(1, 0), 'Main menu', () => g.actions.quit());
      }
      P.set(W, '');
    }
  }

  go(page) { this.page = page; this.buildPage(); }

  // ---------------------------------------------------------------- pointer
  updatePointer(input) {
    if (!this.menuOpen) { this.laser.visible = false; this.dot.visible = false; return; }
    const has = input.pointerRay(this._o, this._d);
    if (!has) return;
    this.ray.set(this._o, this._d);
    const hits = this.ray.intersectObject(this.menu.mesh, false);
    let hit = null;
    if (hits.length) {
      const h = hits[0];
      hit = this.menu.hitTest(h.uv);
      this.dot.position.copy(h.point);
      this.dot.visible = true;
    } else this.dot.visible = false;
    if (this.menu.setHover(hit) && hit) {
      this.game.sfx.ui();
      input.pointerController()?.pulse(CONFIG.haptics.uiTickIntensity, 8);
    }
    this.hoverHit = hit;
    if (input.xr) {
      const len = hits.length ? hits[0].distance : 3;
      this.laser.position.copy(this._o);
      this.laser.lookAt(this._o.clone().add(this._d));
      this.laser.scale.set(1, 1, len);
      this.laser.visible = true;
    }
    const c = input.pointerController();
    if (c && c.buttons.trigger.down && hit) this.click(hit);
  }

  click(hit) {
    const w = hit.widget;
    this.game.sfx.ui();
    if (w.type === 'stepper') {
      if (hit.part === 'dec' && w.onDec) w.onDec();
      else if (hit.part === 'inc' && w.onInc) w.onInc();
      else if (w.onInc) w.onInc();
    } else if (w.onClick) w.onClick();
    this.refresh();
  }

  // ---------------------------------------------------------------- HUD
  setHud(patch) {
    Object.assign(this.hudData, patch);
    const d = this.hudData, P = this.hud;
    const W = [];
    W.push({ type: 'label', x: 34, y: 46, text: d.title, size: 40, bold: true, color: '#ffd34d' });
    if (d.score) W.push({ type: 'label', x: P.W - 34, y: 46, text: d.score, size: 44, bold: true, align: 'right' });
    if (d.sub) W.push({ type: 'label', x: 34, y: 104, text: d.sub, size: 30, color: '#c9d6e3' });
    if (d.players) W.push({ type: 'label', x: 34, y: 140, text: d.players, size: 25, color: '#ffe9a8' });
    if (d.big) W.push({ type: 'label', x: P.W / 2, y: d.players ? 204 : 188, text: d.big, size: d.players ? 68 : 76, bold: true, align: 'center', color: d.bigColor });
    if (d.last) W.push({ type: 'label', x: 34, y: 268, text: d.last, size: 28 });
    if (d.detail) W.push({ type: 'label', x: 34, y: 312, text: d.detail, size: 24, color: '#aab8c6' });
    if (d.footer) W.push({ type: 'label', x: 34, y: P.H - 30, text: d.footer, size: 22, color: '#7f8fa0' });
    P.set(W, '');
  }

  setBoard(lines) {
    const P = this.board;
    const W = lines.map((t, i) => ({ type: 'label', x: P.W / 2, y: 60 + i * 72, text: t, size: i === 0 ? 64 : 52, bold: i < 2, align: 'center', color: i === 0 ? '#ffd34d' : '#ffffff' }));
    P.set(W, '');
  }

  update() {
    this.updatePrompt(this.game.realDt || 0.016);
    this.menu.update();
    this.hud.update();
    this.board.update();
  }
}

function nearestName(list, key, v) {
  let best = list[0], bd = Infinity;
  for (const it of list) { const d = Math.abs(it[key] - v); if (d < bd) { bd = d; best = it; } }
  return bd < 0.02 ? best.name : best.name + '~';
}
