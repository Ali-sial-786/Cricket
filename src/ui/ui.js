// Menus (laser-pointer driven), HUD, scoreboard, safety + calibration screens.
import * as THREE from 'three';
import { CanvasPanel, grid, fitText, fillFit, reportOverflow, FONT } from './panel.js';
import { drawHintCard, drawController, drawKey } from './controllerHint.js';
import { PLAYER_BOWLERS, PLAYER_BOWLER_ORDER } from '../game/bowlerTypes.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const signed = (v, d = 2) => (v > 0 ? '+' : '') + v.toFixed(d);

const CONTACT = ['off', 'low', 'normal', 'high'];
const VIEWS = ['eyes', 'helmet', 'behind'];
const VIEW_NAMES = { eyes: 'your eyes', helmet: 'eyes + helmet grille', behind: 'behind the player' };
const REPLAYS = ['off', 'bowler'];
const REPLAY_NAMES = { off: 'off', bowler: "after every ball" };
const TURNS = ['smooth', 'snap', 'off'];
const DEG = Math.PI / 180;
// Running controls: only while the ball is live.
const RUN_HINTS = new Set(['RUN', 'ANOTHER', 'GO BACK', 'DIVE']);

// Where the floating panels sit, as seen from your eyes: yaw (degrees, + to
// the right of where you face), elevation (degrees, + up), distance (m).
// Batting: off to the left of the line to the bowler, clear of the pitch, the
// ball's path and the HUD (which is up and to the right); the prompt above the
// control hints, both above the helmet grille's top bar (~19° down).
// Bowling: the delivery card low-left beside the run-up, the prompt and hints
// low-right (the HUD is above them, beside the pitch).
const LAYOUT = {
  batting: { prompt: [-24, -2, 1.6], hints: [-24, -12.5, 1.45] },
  bowling: { prompt: [22, -13, 1.5], hints: [22, -23, 1.4], card: [-25, -9, 1.15] },
};
// The panels stay put while you look around them; they follow once you turn
// more than this far from where they were put.
const FOLLOW_CONE = 32;

export class UI {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    // Menus and result cards draw over everything else (world panels included).
    this.menu = new CanvasPanel({ width: 1.1, height: 0.78, ppm: 760, name: 'menu', bg: 'rgba(14,20,30,0.97)' });
    this.menu.mesh.visible = false;
    this.menu.mesh.renderOrder = 30;
    this.menu.mesh.material.depthTest = false;
    this.scene.add(this.menu.mesh);
    this.page = 'main';

    // HUD (world-locked, beside the pitch).
    this.hud = new CanvasPanel({ width: 1.3, height: 0.8, ppm: 600, name: 'hud', bg: 'rgba(10,16,26,0.78)', interactive: false });
    this.scene.add(this.hud.mesh);
    this.hudData = { title: 'Crease VR', score: '', sub: '', players: '', drs: '', last: '', big: '', bigColor: '#ffd34d', detail: '', footer: '' };

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
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    this.dot.visible = false;
    this.dot.renderOrder = 31;
    this.scene.add(this.laser, this.dot);
    this.ray = new THREE.Raycaster();
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3();
    this.hoverHit = null;
    this.setHudPose('batting');

    // Message strip that floats in front of the player ("CATCH IT!",
    // decisions). Commentary is never captioned.
    // 640 ppm at 1.6 m: ~28 px a degree.
    this.promptPanel = new CanvasPanel({ width: 0.9, height: 0.26, ppm: 640, name: 'prompt', bg: 'rgba(8,12,20,0.7)', interactive: false });
    this.promptPanel.mesh.visible = false;
    this.promptPanel.mesh.renderOrder = 11;
    this.scene.add(this.promptPanel.mesh);
    this.promptText = ''; this.promptColor = '#ffffff'; this.promptUntil = 0;
    // Control hints: small controller pictures with the button to press lit.
    this.hintPanel = new CanvasPanel({ width: 0.78, height: 0.25, ppm: 1000, name: 'hints', bg: null, interactive: false });
    this.hintPanel.mesh.visible = false;
    this.hintPanel.mesh.renderOrder = 11;
    this.scene.add(this.hintPanel.mesh);
    this.hintList = []; this.hintKey = ''; this.hintUntil = 0;
    // Delivery card (bowling, at your mark): bowler, deliveries, target, controls.
    // ~30 px text subtends ~1.1° at 1.15 m (ppm 1300).
    this.card = new CanvasPanel({ width: 900 / 1300, height: 640 / 1300, ppm: 1300, name: 'bowlCard', bg: 'rgba(8,12,20,0.8)', interactive: false });
    this.card.mesh.visible = false;
    this.card.mesh.renderOrder = 10;
    this.scene.add(this.card.mesh);
    this.cardData = null;
    this._pt = new THREE.Vector3(); this._pq = new THREE.Quaternion(); this._pf = new THREE.Vector3();
    this.clock = 0;
    this.hudOn = true;           // the HUD panel is wanted (a review board takes its place for a while)
    this.anchorYaw = null;       // where the floating panels were put (see updatePrompt)
    this.pendingPick = null;     // bowler page: the bowler just picked, confirmed before it closes
  }

  // The HUD panel beside the pitch: wanted or not (it is also hidden while a
  // delivery is on and during replays, see update()).
  showHud(v) { this.hudOn = !!v; }

  // What may be in the view right now, asked of the session (its quiet()):
  // 'clear': a delivery is on its way: from the start of the run-up (the
  // machine's countdown; your own run-up when you bowl) until the ball has
  // reached the batter (left your hand) there is nothing in the view at all:
  // no HUD panel, no message strip, no control hints, no cards, and messages
  // asked for meanwhile are dropped. 'live': the ball is in play: the HUD
  // panel stays away; only the calls of the moment (RUN!, CATCH IT!,
  // HOWZAT?!) and the running / throwing controls show. null: between balls,
  // everything.
  get quiet() {
    const g = this.game, s = g.session;
    return s && s.quiet && g.state === 'play' ? s.quiet() : null;
  }

  // Big hint line (stays `secs`, or until replaced). Empty string clears it.
  prompt(text, secs = 3, color = '#ffffff') {
    if (text && this.quiet === 'clear') return;
    if (text === this.promptText && color === this.promptColor) { this.promptUntil = this.clock + secs; return; }
    this.promptText = text; this.promptColor = color; this.promptUntil = this.clock + secs;
    this.drawPrompt();
  }
  drawPrompt() {
    const P = this.promptPanel, W = [];
    const p = this.clock < this.promptUntil ? this.promptText : '';
    if (p) {
      // One line, or wrapped onto two, shrunk until it fits; centred on the strip.
      W.push(fitLabel(P, p, { x: P.W / 2, cy: P.H / 2, maxW: P.W - 56, maxH: P.H - 36, size: 42, min: 22, bold: true, align: 'center', color: this.promptColor, wrap: true }));
    }
    P.set(W, '');
    this.promptShown = !!p;
  }

  // Show control hints (up to three) for `secs`. Same set again just extends it.
  hints(list, secs = 4) {
    const key = list.map((h) => h.label + h.button + h.hand).join('|');
    this.hintUntil = this.clock + secs;
    if (key === this.hintKey) return;
    this.hintKey = key; this.hintList = list.slice(0, 3);
    this.hintRunning = this.hintList.every((h) => RUN_HINTS.has(h.label));
    const P = this.hintPanel, n = this.hintList.length, desktop = !this.game.input.xr;
    const cw = 240, ch = P.H - 12, gap = 16, x0 = (P.W - (n * cw + (n - 1) * gap)) / 2;
    P.set(this.hintList.map((h, i) => ({ type: 'custom', draw: (g) => drawHintCard(g, x0 + i * (cw + gap), 6, cw, ch, h, desktop) })), '');
  }
  clearHints() { this.hintUntil = 0; }

  // The bowling delivery card (null hides it). See BowlingSession.updateCard().
  setBowlCard(d) {
    this.cardData = d;
    if (!d) return;
    const P = this.card, desktop = !this.game.input.xr;
    P.set([{ type: 'custom', draw: (g) => drawBowlCard(g, P.W, P.H, d, desktop) }], '');
  }

  updatePrompt(dt) {
    this.clock += dt;
    if (this.promptShown && this.clock >= this.promptUntil) this.drawPrompt();
    if (this.pendingPick && this.clock >= this.pendingPick.at) {
      const k = this.pendingPick.key;
      this.pendingPick = null;
      if (this.menuOpen && this.page === 'bowler') this.game.actions.pickBowler(k);
    }
    const head = this.game.input.headPose;
    this._pq.set(head.q.x, head.q.y, head.q.z, head.q.w);
    this._pf.set(0, 0, -1).applyQuaternion(this._pq); this._pf.y = 0;
    if (this._pf.lengthSq() < 1e-6) this._pf.set(0, 0, -1);
    this._pf.normalize();
    const yaw = Math.atan2(this._pf.x, -this._pf.z);
    const eye = this.game.eye ? this.game.eye.p : head.p;
    const g = this.game, replay = !!(g.replay && g.replay.active);
    const ses = g.session;
    const bowling = !!(ses && ses.isBowling);
    // Nothing floats in the view during a replay, or while a delivery is on its way
    // (what was up when it started is taken down for good).
    const quiet = this.quiet === 'clear';
    if (quiet && !this._wasQuiet) { this.clearHints(); this.promptUntil = 0; this.drawPrompt(); }
    this._wasQuiet = quiet;
    const clear = replay || quiet;
    const card = !!this.cardData && !this.menuOpen && !clear && g.state === 'play';
    // Running controls go as soon as the ball is dead (or a result is up).
    const live = !ses || ses.state === 'live';
    const hints = this.hintList.length > 0 && this.clock < this.hintUntil && !this.menuOpen && !card && !clear && !(this.hintRunning && !live);
    const prompt = this.promptShown && !this.menuOpen && !clear;
    // Tag-along: put the panels where you face when they appear; keep them
    // there while you look around, and drag them along past FOLLOW_CONE.
    const any = prompt || hints || card;
    if (!any) this.anchorYaw = null;
    else if (this.anchorYaw == null) this.anchorYaw = yaw;
    else {
      const d = Math.atan2(Math.sin(yaw - this.anchorYaw), Math.cos(yaw - this.anchorYaw)), cone = FOLLOW_CONE * DEG;
      if (Math.abs(d) > cone) this.anchorYaw += d - Math.sign(d) * cone;
    }
    const L = LAYOUT[bowling ? 'bowling' : 'batting'];
    const follow = (panel, show, at) => {
      const m = panel.mesh, wasShown = m.visible;
      m.visible = show;
      if (!show) return;
      const [yd, el, dist] = at, a = this.anchorYaw + yd * DEG, c = Math.cos(el * DEG);
      this._pt.set(eye.x + Math.sin(a) * c * dist, eye.y + Math.sin(el * DEG) * dist, eye.z - Math.cos(a) * c * dist);
      if (!wasShown || m.position.distanceTo(this._pt) > 3) m.position.copy(this._pt);
      else m.position.lerp(this._pt, Math.min(1, dt * 5));
      // Square on to your eyes (no roll): upright and easy to read.
      m.lookAt(eye.x, eye.y, eye.z);
      panel.update();
    };
    follow(this.promptPanel, prompt, L.prompt);
    // The card already shows the bowling controls: no hint row while it is up.
    follow(this.hintPanel, hints, L.hints);
    // Low and to the left: from the bowler's mark the pitch (and the HUD) are to your right.
    // Upright: turned only about the vertical toward you, not tipped to face the eye, which reads as tilted.
    follow(this.card, card, L.card || LAYOUT.bowling.card);
    if (card) this.card.mesh.rotation.set(0, Math.atan2(eye.x - this.card.mesh.position.x, eye.z - this.card.mesh.position.z), 0);
  }

  get menuOpen() { return this.menu.mesh.visible; }

  // Place the HUD next to the pitch for the current end.
  // oz: the bowling run-up offset (the board comes with you to your mark).
  setHudPose(end, oz = 0) {
    const m = this.hud.mesh;
    // Scaled up so ~30 px text subtends ~1° (readable on Quest 3S).
    if (end === 'bowling') {
      // ~28° right of the line to the batter, just above eye level: beside the pitch, inside the view.
      m.scale.setScalar(1.9);
      m.position.set(-2.0, 2.1, -14.4 + oz);
      m.lookAt(0.75, 1.65, -19.6 + oz);
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
      // Centred just below eye level: the whole card (its buttons too) sits
      // above the helmet grille's top bar, which is hidden while a menu is open.
      m.position.set(head.p.x + fwd.x * 1.1, Math.max(1.0, head.p.y - 0.04), head.p.z + fwd.z * 1.1);
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
    this.pendingPick = null;
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
      { const r = L(1, 4), hw = (r.w - 12) / 2;
        btn('recenter', { x: r.x, y: r.y, w: hw, h: r.h }, 'Recenter', () => g.actions.recenter(), { size: 26 });
        btn('realign', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, 'Face this way', () => g.actions.realign(), { size: 26 }); }
      if (playing && g.session.isBowling) {
        const r = L(0, 5), hw = (r.w - 12) / 2, ok = g.session.canChangeBowler();
        btn('resume', { x: r.x, y: r.y, w: hw, h: r.h }, 'Resume', () => this.closeMenu(), { active: true });
        btn('bowler', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, ok ? 'Change bowler' : 'Bowler: next over', () => this.go('bowler'), { disabled: !ok, size: 26 });
        btn('quit', L(1, 5), 'End this game', () => g.actions.quit());
      } else if (playing) {
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
          'Y = turn back.   Hold left TRIGGER = DIVE for the line.',
          'Ball dead? Left TRIGGER skips to the next ball.',
          'A throw that beats you home is a RUN OUT.',
          'Close run-outs and stumpings go to the third umpire.',
          'Given out LBW? Press A to review (1 per innings).',
          'NO BALL: the next ball is a FREE HIT.',
          'On a free hit you can only be run out.',
        ]],
        ['BOWLING', [
          'Pick your bowler at the start of each over.',
          'A / B: next / previous delivery (shown on the card).',
          'Left stick: move the target on the pitch.',
          'Hold GRIP (or left trigger) to run in. Let go early',
          'to pull out; near the crease you are committed.',
          'Hold TRIGGER, bowl overarm, let go in your stride.',
          'Arm speed + run-up speed = pace.',
          'Stay behind the crease, or it is a no-ball.',
          'Right stick: look around. Click it: face forward.',
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
      const L = grid(P, { top: 0.2, bottom: 0.09, cols: 2, rows: 8 });
      const xrRate = g.xrManager && g.xrManager.frameRate ? `${g.xrManager.frameRate} Hz target` : 'no target';
      const vel = g.input.xr ? (g.input.right.hasXRVel ? 'XR' : 'pose') : 'desktop';
      label(P.W / 2, P.H * 0.162, `Frame ${Math.round(g.stats.fps)} Hz (${xrRate}) · controller velocity: ${vel} · v${g.version}`, { align: 'center', size: 22, color: '#8fb3d1' });
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
      { const r = L(0, 5), hw = (r.w - 12) / 2;
        btn('assist', { x: r.x, y: r.y, w: hw, h: r.h }, `Aim assist: ${s.aimAssist ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimAssist'), { active: s.aimAssist, size: 24 });
        btn('relcal', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, 'Calibrate release', () => g.actions.bowlCalib(), { size: 24 }); }
      { const r = L(1, 5), hw = (r.w - 12) / 2;
        btn('marker', { x: r.x, y: r.y, w: hw, h: r.h }, `Aim marker: ${s.aimMarker ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimMarker'), { active: s.aimMarker, size: 24 });
        btn('body', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, `Own body: ${s.ownBody ? 'ON' : 'OFF'}`, () => g.actions.toggle('ownBody'), { active: s.ownBody, size: 24 }); }
      const r4 = L(0, 6), tw3 = (r4.w - 20) / 3;
      btn('trail', { x: r4.x, y: r4.y, w: tw3, h: r4.h }, `Trail ${s.trail ? 'ON' : 'OFF'}`, () => g.actions.toggle('trail'), { active: s.trail, size: 24 });
      btn('boost', { x: r4.x + tw3 + 10, y: r4.y, w: tw3, h: r4.h }, `Big ball ${s.ballBoost ? 'ON' : 'OFF'}`, () => g.actions.toggle('ballBoost'), { active: s.ballBoost, size: 24 });
      btn('finder', { x: r4.x + 2 * (tw3 + 10), y: r4.y, w: tw3, h: r4.h }, `Ball finder ${s.ballFinder ? 'ON' : 'OFF'}`, () => g.actions.toggle('ballFinder'), { active: s.ballFinder, size: 24 });
      { const r = L(1, 6), hw = (r.w - 12) / 2;
        btn('sound', { x: r.x, y: r.y, w: hw, h: r.h }, !s.sound ? 'Sound OFF' : s.commentary ? 'Sound + comms' : 'Sound, no comms', () => g.actions.soundCycle(), { active: s.sound, size: 24 });
        btn('turn', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, `R-stick turn: ${s.turn}`, () => g.actions.cycle('turn', TURNS, 1), { size: 24 }); }
      { const r = L(0, 7), hw = (r.w - 12) / 2;
        btn('runup', { x: r.x, y: r.y, w: hw, h: r.h }, `Run-up: ${s.runUp ? 'on' : 'off'}`, () => g.actions.toggle('runUp'), { active: s.runUp, size: 24 });
        btn('sweepDrop', { x: r.x + hw + 12, y: r.y, w: hw, h: r.h }, `Sweep view drop: ${s.sweepDrop !== false ? 'ON' : 'OFF'}`, () => g.actions.toggle('sweepDrop'), { active: s.sweepDrop !== false, size: 22 }); }
      btn('feel', L(1, 7), `Deliveries: ${s.bowlByFeel ? 'by wrist action' : 'pick with A/B'}`, () => g.actions.toggle('bowlByFeel'), { size: 26 });
      label(P.W * 0.5, P.H * 0.968, 'Y / Esc: back to the game', { align: 'center', size: 18, color: '#7f8fa0' });
      btn('back', { x: P.W - 150, y: 14, w: 130, h: 56 }, 'Back', () => this.go('main'));
      P.set(W, 'Settings');
    } else if (this.page === 'bowler') {
      // The tick marks who bowls: the bowler you just picked (shown for a
      // moment before the page closes), else the current one. Hover is blue.
      const ses = g.session, cur = s.bowlerType;
      const chosen = this.pendingPick ? this.pendingPick.key : cur;
      const canChange = !ses || !ses.canChangeBowler || ses.canChangeBowler();
      const L = grid(P, { top: 0.14, bottom: 0.17, cols: 2, rows: 2 });
      PLAYER_BOWLER_ORDER.forEach((k, i) => {
        const b = PLAYER_BOWLERS[k], r = L(i % 2, Math.floor(i / 2)), here = k === chosen;
        const ru = CONFIG.bowling.runUp[k], tw = r.w - 44;
        btn('bw-' + k, r, '', () => this.pickBowler(k), { active: here, disabled: !canChange && k !== cur });
        label(r.x + 22, r.y + 38, `${i + 1}  ${b.label}`, { size: 38, bold: true, color: here ? '#ffffff' : '#ffd34d', maxW: tw - 110 });
        if (here) label(r.x + r.w - 22, r.y + 38, '✓', { size: 40, bold: true, align: 'right', color: '#7dff8a' });
        label(r.x + 22, r.y + 82, `${b.pace[0]}–${b.pace[1]} km/h · run-up ${ru.length} m`, { size: 25, color: '#e8eef5', maxW: tw });
        const names = b.deliveryList.map((d) => d.label);
        const lines = names.length > 4 ? [names.slice(0, 3).join(' · '), names.slice(3).join(' · ')] : [names.slice(0, 2).join(' · '), names.slice(2).join(' · ')];
        label(r.x + 22, r.y + 120, lines.filter(Boolean).join('\n'), { size: 21, color: '#b8c8d8', maxW: tw, maxH: r.h - 120 + 10 });
      });
      const note = !canChange ? 'You can change bowler at the start of the next over'
        : ses && ses.innings ? 'Pick for this over · your mark is behind you' : 'Pick a bowler · change any time from the menu';
      label(P.W / 2, P.H * 0.9, note, { align: 'center', size: 26, color: canChange ? '#9fb2c4' : '#ffb347', maxW: P.W - 60 });
      P.set(W, 'Choose your bowler');
    } else if (this.page === 'result') {
      const r = g.resultInfo || { title: 'Done', lines: [] };
      label(P.W / 2, P.H * 0.13, r.title, { align: 'center', size: 56, bold: true, color: r.color || '#ffd34d', maxW: P.W - 80 });
      // The card (score, every batter, extras, bowlers): wrapped and shrunk to
      // fit between the title and the buttons, centred in that space.
      const lines = r.lines.filter(Boolean);
      if (lines.length) W.push(fitLabel(P, lines.join('\n'), { x: P.W / 2, top: P.H * 0.22, bottom: P.H * 0.71, maxW: P.W - 80, size: 32, min: 18, align: 'center', wrap: true }));
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

  // Bowler page: show the tick on the pick for a moment, then take it.
  pickBowler(k) {
    const ses = this.game.session;
    if (ses && ses.canChangeBowler && !ses.canChangeBowler() && k !== this.game.settings.bowlerType) { this.refresh(); return; }
    this.pendingPick = { key: k, at: this.clock + 0.35 };
    this.refresh();
  }

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
    const d = this.hudData, P = this.hud, M = 34, tw = P.W - 2 * M;
    const W = [];
    // Title and score share the top line: the score keeps its size, the title shrinks.
    let scoreW = 0;
    if (d.score) { const r = fitText(P.ctx, d.score, { maxW: tw * 0.5, size: 44, weight: 700 }); scoreW = r.width; W.push({ type: 'label', x: P.W - M, y: 46, text: d.score, size: r.size, bold: true, align: 'right' }); }
    W.push({ type: 'label', x: M, y: 46, text: d.title, size: 40, bold: true, color: '#ffd34d', maxW: tw - scoreW - (scoreW ? 24 : 0) });
    if (d.sub) W.push({ type: 'label', x: M, y: 104, text: d.sub, size: 30, color: '#c9d6e3', maxW: tw });
    // (the DRS reviews left go on the players' line: drs, set by the sessions)
    const players = [d.players, d.drs].filter(Boolean).join('   ·   ');
    if (players) W.push({ type: 'label', x: M, y: 140, text: players, size: 25, color: '#ffe9a8', maxW: tw });
    if (d.big) W.push({ type: 'label', x: P.W / 2, y: players ? 204 : 188, text: d.big, size: players ? 68 : 76, min: 30, bold: true, align: 'center', color: d.bigColor, maxW: tw });
    // Lower lines flow down (each may wrap onto a second line); the footer
    // keeps to the bottom.
    let y = 252;
    const foot = d.footer ? fitLabel(P, d.footer, { x: M, bottom: P.H - 24, maxW: tw, size: 22, min: 18, color: '#7f8fa0', wrap: true, maxLines: 2 }) : null;
    const floor = foot ? foot.top - 8 : P.H - 24;
    for (const [text, size, color] of [[d.last, 28, '#e8eef5'], [d.detail, 24, '#aab8c6']]) {
      if (!text || y >= floor - 18) continue;
      const l = fitLabel(P, text, { x: M, top: y, maxW: tw, maxH: Math.min(floor - y, size * 2.4), size, min: 20, color, wrap: true });
      W.push(l); y = l.bottom + 10;
    }
    if (foot) W.push(foot);
    P.set(W, '');
  }

  setBoard(lines) {
    const P = this.board;
    const W = lines.map((t, i) => ({ type: 'label', x: P.W / 2, y: 60 + i * 72, text: t, size: i === 0 ? 64 : 52, bold: i < 2, align: 'center', color: i === 0 ? '#ffd34d' : '#ffffff', maxW: P.W - 60, maxH: 68 }));
    P.set(W, '');
  }

  update() {
    this.updatePrompt(this.game.realDt || 0.016);
    this.menu.update();
    // The HUD panel: between balls only (not while a delivery is on, not in a replay).
    const g = this.game;
    this.hud.mesh.visible = this.hudOn && !this.quiet && !(g.replay && g.replay.active);
    this.hud.update();
    this.board.update();
  }
}

// A label fitted (shrunk, wrapped) into a box on panel P, measured now so it
// can be placed: o.cy centres it, o.top hangs it from a line, o.bottom stands
// it on one (o.top + o.bottom: centred between). Returns the label widget,
// with .top / .bottom (its extent in px).
function fitLabel(P, text, o) {
  const size = o.size || 30;
  const maxLines = o.maxLines || Infinity;
  let maxH = o.maxH || (o.top != null && o.bottom != null ? o.bottom - o.top : P.H);
  if (maxLines < Infinity) maxH = Math.min(maxH, size + (maxLines - 1) * size * 1.25);
  const r = fitText(P.ctx, text, { maxW: o.maxW, maxH, size, min: o.min, weight: o.bold ? 700 : 500, wrap: !!o.wrap });
  const h = r.size + (r.lines.length - 1) * r.lh;
  const top = o.cy != null ? o.cy - h / 2
    : o.top != null && o.bottom != null ? (o.top + o.bottom) / 2 - h / 2
    : o.top != null ? o.top : o.bottom - h;
  return { type: 'label', x: o.x, y: top + r.size / 2, text: r.lines.join('\n'), size: r.size, min: r.size, bold: !!o.bold, align: o.align || 'left', color: o.color, maxW: o.maxW, top, bottom: top + h };
}

// The delivery card. d: { title, pace, list: [{label, sel}], effect, target, byFeel, runUp }.
// Every line is fitted to its column (shrunk, or wrapped where it may run on).
function drawBowlCard(g, W, H, d, desktop) {
  const N = 'bowlCard';
  const lines = (text, x, y, w, weight, size, maxLines, lh) => {
    const r = fitText(g, text, { maxW: w, maxH: size + (maxLines - 1) * lh, size, min: Math.round(size * 0.75), weight, wrap: true, lineHeight: lh / size });
    if (!r.fits) reportOverflow(N, text, r.width, w);
    r.lines.forEach((ln, i) => g.fillText(ln, x, y + i * r.lh));
    return r.lines.length;
  };
  g.textBaseline = 'middle';
  // Bowler + pace.
  g.textAlign = 'right'; g.fillStyle = '#e8eef5';
  g.font = FONT(600, 34);
  const pw = Math.min(g.measureText(d.pace).width, W * 0.4);
  fillFit(g, d.pace, W - 32, 54, W * 0.4, 600, 34, 22, N);
  g.textAlign = 'left'; g.fillStyle = '#ffd34d';
  fillFit(g, d.title.toUpperCase(), 32, 52, W - 64 - pw - 24, 800, 46, 26, N);
  g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(28, 88, W - 56, 3);
  // Deliveries, the picked one lit.
  const top = 104, bot = 420, n = d.list.length, rh = Math.min(56, (bot - top) / n);
  d.list.forEach((it, i) => {
    const y = top + i * rh + rh / 2;
    if (it.sel) { g.fillStyle = '#ffd34d'; roundRect(g, 24, y - rh / 2 + 3, 380, rh - 6, 12); g.fill(); }
    g.textAlign = 'left'; g.fillStyle = it.sel ? '#141414' : '#c9d6e3';
    fillFit(g, `${it.sel ? '▸ ' : '   '}${it.label}`, 36, y + 1, 360, it.sel ? 800 : 600, Math.min(it.sel ? 36 : 32, rh * 0.62), 18, N);
  });
  // This ball + target.
  const x = 432, w = W - x - 30;
  g.textAlign = 'left'; g.fillStyle = '#8fa3b6';
  fillFit(g, d.byFeel ? 'BY FEEL' : 'THIS BALL', x, 118, w, 700, 26, 18, N);
  g.fillStyle = '#ffffff';
  lines(d.effect, x, 160, w, 600, 31, 4, 38);
  g.fillStyle = '#8fa3b6';
  fillFit(g, 'TARGET', x, 330, w, 700, 26, 18, N);
  g.fillStyle = '#9dff9f';
  lines(d.target, x, 370, w, 700, 32, 2, 40);
  // Controls.
  const items = [];
  if (d.runUp) items.push({ hand: 'R', button: 'grip', key: 'R', head: desktop ? 'HOLD R' : 'HOLD GRIP', text: 'run in' });
  items.push({ hand: 'R', button: 'trigger', key: 'Mouse', head: desktop ? 'MOUSE' : 'HOLD TRIGGER', text: desktop ? 'hold, sweep down, let go' : 'bowl overarm, let go' });
  items.push(d.byFeel
    ? { hand: 'R', button: 'ab', key: 'Z / X', head: desktop ? 'Z / X' : 'A / B', text: 'seam out / in' }
    : { hand: 'R', button: 'ab', key: 'Z / X', head: desktop ? 'Z / X' : 'A / B', text: 'delivery' });
  items.push({ hand: 'L', button: 'stick', key: 'Arrows', head: desktop ? 'ARROWS' : 'L STICK', text: 'aim' });
  const cy = 436, ch = H - cy - 16, gap = 12, cw = (W - 48 - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const cx = 24 + i * (cw + gap), mx = cx + cw / 2;
    g.fillStyle = 'rgba(255,255,255,0.07)'; roundRect(g, cx, cy, cw, ch, 14); g.fill();
    if (desktop) drawKey(g, mx, cy + 46, 140, it.key);
    else drawController(g, mx, cy + 48, 90, it.hand, it.button);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffd34d';
    fillFit(g, it.head, mx, cy + 108, cw - 14, 800, 27, 16, N);
    g.fillStyle = '#e8eef5';
    lines(it.text, mx, cy + 140, cw - 14, 600, 25, 2, 27);
  });
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function nearestName(list, key, v) {
  let best = list[0], bd = Infinity;
  for (const it of list) { const d = Math.abs(it[key] - v); if (d < bd) { bd = d; best = it; } }
  return bd < 0.02 ? best.name : best.name + '~';
}
