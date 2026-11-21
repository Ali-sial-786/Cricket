// Menus (laser-pointer driven), HUD, scoreboard, safety + calibration screens.
// The look (colours, type, icons, wordmark) is theme.js; the broadcast
// graphics (score bug, big screen, stings, scorecard) are broadcast.js.
import * as THREE from 'three';
import { CanvasPanel, fitText, fillFit, reportOverflow, FONT } from './panel.js';
import { C, font, rr, surface, caps, drawIcon, drawWordmark, vgrad, hgrad, slant } from './theme.js';
import { matchState, drawScoreBug, drawBigBar, drawBigScreen, drawPromptCard, drawResultBody, stingKind, shade } from './broadcast.js';
import { drawHintCard, drawController, drawKey } from './controllerHint.js';
import { PLAYER_BOWLERS, PLAYER_BOWLER_ORDER } from '../game/bowlerTypes.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { chaseTarget } from '../game/scoring.js';
import { CONFIG } from '../config.js';
import { buildVisionChart } from './visionChart.js';
import { QUALITY_NAMES } from '../render/quality.js';

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const signed = (v, d = 2) => (v > 0 ? '+' : '') + v.toFixed(d);

const CONTACT = ['off', 'low', 'normal', 'high'];
const VIEWS = ['eyes', 'helmet', 'behind'];
const VIEW_NAMES = { eyes: 'your eyes', helmet: 'eyes + helmet grille', behind: 'behind the player' };
const REPLAYS = ['off', 'bowler'];
const REPLAY_NAMES = { off: 'off', bowler: "after every ball" };
const TURNS = ['smooth', 'snap', 'off'];
// Graphics setting: 'auto' shows the level the governor is on now.
const qualityName = (g, q) => (q === 'auto' || !q ? `Auto · ${g.perf ? g.perf.spec.name : 'Ultra'}` : q[0].toUpperCase() + q.slice(1));
const DEG = Math.PI / 180;
// Running controls: only while the ball is live.
const RUN_HINTS = new Set(['RUN', 'ANOTHER', 'GO BACK', 'DIVE']);
// The big calls also go up on the stadium screen, for this long (real s).
const STING_SECS = 4;
const SCREEN_STINGS = new Set(['four', 'six', 'wicket', 'notout', 'review', 'milestone']);
const PRESS_SECS = 0.14;       // a clicked button looks pressed this long

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

// Settings, by tab: [tab id, label, icon].
const SET_TABS = [['gameplay', 'Gameplay'], ['batting', 'Batting'], ['bowling', 'Bowling'], ['view', 'View & comfort'], ['audio', 'Audio'], ['vision', 'Vision']];

const easeOutBack = (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

export class UI {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    // Menus and result cards draw over everything else (world panels included).
    // 1.28 x 0.84 m at 1.1 m: ~60° x 42°, room for cards, tabs and a scorecard.
    this.menu = new CanvasPanel({ width: 1.28, height: 0.84, ppm: 760, name: 'menu', bg: 'rgba(11,18,32,0.97)' });
    this.menu.mesh.visible = false;
    this.menu.mesh.renderOrder = 30;
    this.menu.mesh.material.depthTest = false;
    this.scene.add(this.menu.mesh);
    this.chart = buildVisionChart();            // (beside the Vision page: tune by eye)
    this.scene.add(this.chart);
    this.page = 'main';
    this.setTab = 'gameplay';

    // HUD (world-locked, beside the pitch): the score bug.
    this.hud = new CanvasPanel({ width: 1.3, height: 0.95, ppm: 600, name: 'hud', bg: 'rgba(9,15,27,0.88)', interactive: false });
    this.scene.add(this.hud.mesh);
    this.hudData = { title: 'Crease VR', score: '', sub: '', players: '', drs: '', last: '', big: '', bigColor: '#ffd34d', detail: '', footer: '' };

    // Big stadium scoreboard: an opaque LED face, mipmapped (it is seen from
    // ~85 m: 1024 px across ~16°, so it must filter down cleanly).
    this.board = new CanvasPanel({ width: 24, height: 9, ppm: 1024 / 24, name: 'scoreboard', bg: null, interactive: false });
    { const t = this.board.tex, m = this.board.mesh.material;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
      m.transparent = false; m.depthWrite = true; }
    this.board.mesh.position.copy(game.env.screen.pos);
    this.board.mesh.lookAt(game.env.screen.look);
    game.env.stadium.add(this.board.mesh);
    this.boardData = { lines: ['CREASE VR', 'Nets'] };
    this.boardSting = null;      // { kind, word, sub, until }: a call up on the screen
    this._boardReplay = false;

    // Laser pointer.
    // Along +Z: Object3D.lookAt() aims an object's +Z axis at the target.
    const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)]);
    this.laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x7fb8ff, transparent: true, opacity: 0.85 }));
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
    // decisions); the big calls (FOUR, SIX, OUT…) as broadcast stings.
    // Commentary is never captioned. 640 ppm at 1.6 m: ~28 px a degree.
    this.promptPanel = new CanvasPanel({ width: 0.9, height: 0.26, ppm: 640, name: 'prompt', bg: null, interactive: false });
    this.promptPanel.mesh.visible = false;
    this.promptPanel.mesh.renderOrder = 11;
    this.scene.add(this.promptPanel.mesh);
    this.promptText = ''; this.promptColor = '#ffffff'; this.promptUntil = 0; this.promptAt = 0; this.promptKind = 'info';
    // Control hints: small controller pictures with the button to press lit.
    this.hintPanel = new CanvasPanel({ width: 0.78, height: 0.25, ppm: 1000, name: 'hints', bg: null, interactive: false });
    this.hintPanel.mesh.visible = false;
    this.hintPanel.mesh.renderOrder = 11;
    this.scene.add(this.hintPanel.mesh);
    this.hintList = []; this.hintKey = ''; this.hintUntil = 0;
    // Delivery card (bowling, at your mark): bowler, deliveries, target, controls.
    // ~30 px text subtends ~1.1° at 1.15 m (ppm 1300).
    this.card = new CanvasPanel({ width: 900 / 1300, height: 640 / 1300, ppm: 1300, name: 'bowlCard', bg: 'rgba(9,14,25,0.88)', interactive: false });
    this.card.mesh.visible = false;
    this.card.mesh.renderOrder = 10;
    this.scene.add(this.card.mesh);
    this.cardData = null;
    this._pt = new THREE.Vector3(); this._pq = new THREE.Quaternion(); this._pf = new THREE.Vector3();
    this.clock = 0;
    this.hudOn = true;           // the HUD panel is wanted (a review board takes its place for a while)
    this.anchorYaw = null;       // where the floating panels were put (see updatePrompt)
    this.pendingPick = null;     // bowler page: the bowler just picked, confirmed before it closes
    this.pressUntil = 0;
    this.prevInnings = null;     // a match's other innings, for the final scorecard
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
  // The big calls (FOUR, SIX, OUT, NOT OUT, third umpire) come up as stings,
  // here and on the stadium screen.
  prompt(text, secs = 3, color = '#ffffff') {
    if (text && this.quiet === 'clear') return;
    if (text === this.promptText && color === this.promptColor) { this.promptUntil = this.clock + secs; return; }
    this.promptText = text; this.promptColor = color; this.promptUntil = this.clock + secs; this.promptAt = this.clock;
    this.promptKind = text ? stingKind(text) : 'info';
    if (text && SCREEN_STINGS.has(this.promptKind)) this.screenSting(this.promptKind, text);
    this.drawPrompt();
  }
  drawPrompt() {
    const P = this.promptPanel, W = [];
    const p = this.clock < this.promptUntil ? this.promptText : '';
    if (p) {
      const color = this.promptColor, kind = this.promptKind;
      W.push({ type: 'custom', draw: (g) => drawPromptCard(g, P.W, P.H, p, color, kind) });
    }
    P.set(W, '');
    this.promptShown = !!p;
  }

  // A call on the stadium screen for STING_SECS (the scoreboard comes back after).
  screenSting(kind, text) {
    const t = String(text).replace(/!+$/, '');
    let word, sub = null;
    if (kind === 'four' || kind === 'six') {
      word = kind === 'six' ? 'SIX' : 'FOUR';
      if (/BYES/i.test(t)) sub = 'BYES';
      else { const st = matchState(this.game); if (st) sub = `${st.team.short}  ${st.runs}/${st.wkts}  ·  ${st.overs} OV`; }
    } else if (kind === 'wicket') { word = /^OUT$/i.test(t) ? 'OUT' : 'WICKET'; sub = /^OUT$/i.test(t) ? 'THIRD UMPIRE' : t; }
    else if (kind === 'notout') { word = 'NOT OUT'; sub = /^NOT OUT$/i.test(t) ? null : t; }
    else if (kind === 'review') { word = 'DECISION PENDING'; sub = t.replace(/…|\.\.\./g, ''); }
    else if (kind === 'milestone') { const m = /(\d+)/.exec(t); word = m ? m[1] : 'MILESTONE'; sub = t; }
    this.boardSting = { kind, word, sub, until: this.clock + STING_SECS };
    this.drawBoard();
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
    if (prompt) {
      // The sting comes in (a quick pop, transform only: no texture work) and
      // fades over its last moments; plain messages just fade in and out.
      const t = this.clock - this.promptAt, m = this.promptPanel.mesh;
      const sc = this.promptKind === 'info' ? 1 : 0.8 + 0.2 * easeOutBack(Math.min(1, t / 0.26));
      m.scale.set(sc, sc, 1);
      m.material.opacity = Math.min(1, t / 0.1) * Math.min(1, Math.max(0, (this.promptUntil - this.clock) / 0.2));
    }
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
      m.position.set(-2.0, 2.2, -14.4 + oz);
      m.lookAt(0.75, 1.65, -19.6 + oz);
    } else if (end === 'mr') {
      m.scale.setScalar(1.0);
      m.position.set(1.6, 1.8, -4.0);
      m.lookAt(-0.4, 1.6, -1.0);
    } else {
      m.scale.setScalar(1.8);
      m.position.set(2.7, 2.75, -5.8);
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
    this.chart.visible = false;
    this.laser.visible = false;
    this.dot.visible = false;
    this.game.onMenuChanged(false);
  }

  refresh() { if (this.menuOpen) this.buildPage(); }

  // ---------------------------------------------------------------- pages
  buildPage() {
    const g = this.game, s = g.settings, P = this.menu, PW = P.W, PH = P.H;
    this.placeChart();
    const W = [];
    const btn = (id, r, text, onClick, extra = {}) => W.push({ type: 'button', id, ...r, text, onClick, ...extra });
    const step = (id, r, label, value, onDec, onInc, extra = {}) => W.push({ type: 'stepper', id, ...r, label, value, onDec, onInc, ...extra });
    const tog = (id, r, label, on, onClick, extra = {}) => W.push({ type: 'toggle', id, ...r, label, active: !!on, onClick, ...extra });
    const label = (x, y, text, extra = {}) => W.push({ type: 'label', x, y, text, ...extra });
    const custom = (draw) => W.push({ type: 'custom', draw });
    const M = 24, CW = PW - 2 * M;
    // The page header: an icon and a title (the wordmark on the main page),
    // a Back button on the right; a hairline under it.
    const header = (title, icon, back) => {
      custom((c) => {
        if (icon) { c.beginPath(); c.arc(M + 26, 52, 26, 0, Math.PI * 2); c.fillStyle = 'rgba(255,201,60,0.14)'; c.fill(); drawIcon(c, icon, M + 26, 52, 30, C.accent); }
        caps(c, title, M + (icon ? 66 : 4), 53, 40, C.text, { weight: 900, track: 0.02, maxW: PW - 2 * M - 70 - (back ? 190 : 0) });
        c.fillStyle = hgrad(c, M, PW - M, 'rgba(255,255,255,0.18)', 'rgba(255,255,255,0.02)'); c.fillRect(M, 94, PW - 2 * M, 2);
      });
      if (back) btn('back', { x: PW - M - 160, y: 24, w: 160, h: 56 }, 'Back', back, { icon: 'back', size: 26 });
    };
    const hint = (text) => label(PW / 2, PH - 24, text, { align: 'center', size: 19, color: C.text3 });

    if (this.page === 'safety') {
      custom((c) => {
        const cx = PW / 2;
        c.beginPath(); c.moveTo(cx, 54); c.lineTo(cx + 46, 134); c.lineTo(cx - 46, 134); c.closePath();
        c.fillStyle = C.accent; c.fill();
        c.fillStyle = '#16120a'; c.font = font(900, 54); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('!', cx, 108);
      });
      label(PW / 2, PH * 0.29, 'Before you play', { align: 'center', size: 48, bold: true, weight: 900, color: C.text });
      label(PW / 2, PH * 0.4,
        'Clear at least 2.5 × 2.5 m — you will swing hard. Use a\nRoomscale boundary (Quest Settings › Boundary), as big as you can.\nA yellow ring marks the roomiest spot: step into it if you can.\nKeep pets/people away. Wrist strap on. No walking needed.',
        { align: 'center', size: 30, color: C.text2 });
      btn('ok', { x: PW * 0.3, y: PH * 0.76, w: PW * 0.4, h: 84 }, 'My space is clear', () => g.actions.safetyOk(), { variant: 'primary', icon: 'check', size: 32 });
      P.set(W, '');
    } else if (this.page === 'calibrate') {
      const cal = g.calib;
      header('Bat calibration', 'calibrate');
      const text = cal.step === 'capture'
        ? 'Hold the RIGHT controller like a bat handle.\nStand in your stance and look at the bowler.\nLet the bat hang straight down, face to the bowler,\nthen press A (or left trigger).'
        : `Check the bat in your hand. Fine-tune its angle with\nthe LEFT thumbstick (up/down): ${signed(s.batAngleDeg, 0)}°\nPress A to save, B to capture again.`;
      custom((c) => surface(c, M, 116, CW, 316, 20, { top: '#16233b', bottom: '#111c30', lift: false }));
      label(PW / 2, 170, text, { align: 'center', size: 31, color: C.text });
      const bw = (CW - 2 * 16) / 3, by = PH - 140, bh = 76;
      if (cal.step === 'adjust') {
        btn('cal-redo', { x: M, y: by, w: bw, h: bh }, 'Recapture', () => g.actions.calibRedo(), { icon: 'refresh' });
        btn('cal-save', { x: M + bw + 16, y: by, w: bw, h: bh }, 'Save', () => g.actions.calibSave(), { active: true, variant: 'primary', icon: 'check' });
      } else {
        btn('cal-cap', { x: M + bw + 16, y: by, w: bw, h: bh }, 'Capture now', () => g.actions.calibCapture(), { active: true, variant: 'primary', icon: 'calibrate' });
      }
      btn('cal-skip', { x: M + 2 * (bw + 16), y: by, w: bw, h: bh }, g.calibration ? 'Cancel' : 'Use default', () => g.actions.calibSkip());
      P.set(W, '');
    } else if (this.page === 'main') {
      const playing = !!g.session;
      // Header: the wordmark; Recenter / Face this way on the right.
      custom((c) => {
        drawWordmark(c, M + 8, 50, 44);
        c.fillStyle = hgrad(c, M, PW - M, 'rgba(255,255,255,0.18)', 'rgba(255,255,255,0.02)'); c.fillRect(M, 94, CW, 2);
        caps(c, 'PLAY', M + 4, 116, 19, C.text3);
        caps(c, 'MORE', M + 4, 434, 19, C.text3);
      });
      btn('realign', { x: PW - M - 200, y: 22, w: 200, h: 56 }, 'Face this way', () => g.actions.realign(), { icon: 'face', size: 23 });
      btn('recenter', { x: PW - M - 200 - 12 - 172, y: 22, w: 172, h: 56 }, 'Recenter', () => g.actions.recenter(), { icon: 'recenter', size: 23 });
      // Play modes: big cards.
      const cw = (CW - 2 * 14) / 3, chh = 136, cy0 = 130;
      const cardR = (i) => ({ x: M + (i % 3) * (cw + 14), y: cy0 + Math.floor(i / 3) * (chh + 14), w: cw, h: chh });
      const cur = playing ? g.session.kind : null;
      const mode = (i, id, text, sub, icon, fn) => btn(id, cardR(i), text, fn, { variant: 'card', icon, sub, size: 30, tag: cur === id || (id === 'nets' && cur === 'nets') || (id === 'bnets' && cur === 'bowlnets') ? 'IN PLAY' : '' });
      mode(0, 'nets', 'Nets: Batting', 'Face the bowling machine', 'bat', () => g.actions.start('nets'));
      mode(1, 'bnets', 'Nets: Bowling', 'Bowl at a batter, no score', 'ball', () => g.actions.start('bowlnets'));
      mode(2, 'chase', 'Run Chase', `Chase ${chaseTarget(s.difficulty, s.overs)} in ${s.overs} over${s.overs > 1 ? 's' : ''}`, 'target', () => g.actions.start('chase'));
      mode(3, 'over', 'Bowl an Over', 'Defend a total in six balls', 'over', () => g.actions.start('over'));
      mode(4, 'match', 'Match', `${s.overs} overs a side, 5 wickets`, 'trophy', () => g.actions.start('match'));
      mode(5, 'machine', 'Bowling machine', 'Pace, line, swing and spin', 'machine', () => this.go('machine'));
      // Secondary.
      const sw = (CW - 2 * 14) / 3, sy = 450, sh = 60;
      btn('howto', { x: M, y: sy, w: sw, h: sh }, !s.seenHowTo ? 'How to play · new' : 'How to play', () => this.go('howto'), { active: !s.seenHowTo, icon: 'help', size: 25 });
      btn('settings', { x: M + sw + 14, y: sy, w: sw, h: sh }, `Settings · ${s.difficulty}`, () => this.go('settings'), { icon: 'gear', size: 25 });
      btn('calib', { x: M + 2 * (sw + 14), y: sy, w: sw, h: sh }, 'Calibrate bat', () => g.actions.calibrate(), { icon: 'calibrate', size: 25 });
      // Primary row: back into the game, or mixed reality.
      const py = 526, ph = 70;
      if (playing && g.session.isBowling) {
        const ok = g.session.canChangeBowler(), bw = (CW - 2 * 14) / 3;
        btn('resume', { x: M, y: py, w: bw, h: ph }, 'Resume', () => this.closeMenu(), { active: true, variant: 'primary', icon: 'play', size: 30 });
        btn('bowler', { x: M + bw + 14, y: py, w: bw, h: ph }, ok ? 'Change bowler' : 'Bowler: next over', () => this.go('bowler'), { disabled: !ok, icon: 'swap', size: 26 });
        btn('quit', { x: M + 2 * (bw + 14), y: py, w: bw, h: ph }, 'End this game', () => g.actions.quit(), { variant: 'danger', icon: 'exit', size: 26 });
      } else if (playing) {
        const bw = (CW - 14) / 2;
        btn('resume', { x: M, y: py, w: bw, h: ph }, 'Resume', () => this.closeMenu(), { active: true, variant: 'primary', icon: 'play', size: 30 });
        btn('quit', { x: M + bw + 14, y: py, w: bw, h: ph }, 'End this game', () => g.actions.quit(), { variant: 'danger', icon: 'exit', size: 26 });
      } else {
        btn('mr', { x: M, y: py, w: CW, h: ph }, g.mr ? 'Mixed reality: re-place the stumps' : (g.input.xr ? 'Switch to mixed reality nets' : 'Mixed reality nets (in headset)'), () => g.actions.mr(), { icon: 'mr', size: 27 });
      }
      hint(g.input.xr ? 'Point with either controller · trigger selects · click the left stick to close' : 'Click to select · Esc / M closes the menu');
      P.set(W, '');
    } else if (this.page === 'howto') {
      const tab = this.howTab || 0;
      const pages = [
        ['Batting', 'bat', [
          'The right controller is the bat.',
          'Bat face at contact: straight = along the ground, open = in the air.',
          'Hold [TRIGGER]: stride down the pitch. More power, harder to time.',
          'Miss it when you stride and the keeper can stump you.',
          'Hold [GRIP]: sweep. Swing to the off side = reverse sweep.',
          '[TRIGGER] + [GRIP]: come down and slog-sweep.',
          '[L STICK] (or really stepping): move in your crease.',
        ]],
        ['Running', 'run', [
          'After you hit it: [X] = RUN.',
          'The batters stop after each run. [X] again for another.',
          '[Y] = turn back.  Hold left [TRIGGER] = DIVE for the line.',
          'Ball dead? Left [TRIGGER] skips to the next ball.',
          'A throw that beats you home is a RUN OUT.',
          'Close run-outs and stumpings go to the third umpire.',
          'Given out LBW? Press [A] to review.',
          'NO BALL: the next ball is a FREE HIT.',
          'On a free hit you can only be run out.',
        ]],
        ['Bowling', 'ball', [
          'Pick your bowler at the start of each over.',
          '[A] / [B]: next / previous delivery (shown on the card).',
          '[L STICK]: move the target on the pitch.',
          'Hold [GRIP] (or left trigger) to run in. Let go early to pull out;',
          'near the crease you are committed.',
          'Hold [TRIGGER], bowl overarm, let go in your stride.',
          'Arm speed + run-up speed = pace.',
          'Stay behind the crease, or it is a no-ball.',
          '[R STICK]: look around. Click it: face forward.',
        ]],
        ['Fielding', 'glove', [
          'Catch chance: time slows and you become the fielder.',
          'Reach out and get a hand to the ball. No button.',
          'A fielder picks up: [A] = throw to the keeper,',
          "[B] = throw to the bowler's end.",
          'Beat the batter home for a RUN OUT.',
          'Bowl slow and batters come down the pitch:',
          'beat the bat and the keeper STUMPS them.',
          'Turned-down LBW? Press [A] to review.',
        ]],
      ];
      const done = () => { s.seenHowTo = true; g.saveSettings(); this.go('main'); };
      header('How to play', 'help', done);
      const tw = (CW - 3 * 12) / 4;
      pages.forEach((pg, i) => btn('tab' + i, { x: M + i * (tw + 12), y: 110, w: tw, h: 56 }, pg[0], () => { this.howTab = i; this.go('howto'); }, { active: i === tab, variant: 'tab', icon: pg[1], size: 25 }));
      const lines = pages[tab][2];
      custom((c) => {
        surface(c, M, 182, CW, PH - 182 - 52, 18, { top: '#15223a', bottom: '#101a2d', lift: false });
        const top = 200, rowH = Math.min(50, (PH - 52 - 18 - top) / lines.length);
        lines.forEach((ln, i) => {
          const y = top + i * rowH + rowH / 2, cont = /^[a-z]/.test(ln);
          if (!cont) { c.beginPath(); c.arc(M + 30, y, 5, 0, Math.PI * 2); c.fillStyle = C.accent; c.fill(); }
          drawRich(c, ln, M + 52, y, 27, CW - 76);
        });
      });
      hint('Buttons are for the Touch controllers · the page beside the pitch says the desktop keys');
      P.set(W, '');
    } else if (this.page === 'machine') {
      const m = s.machine;
      header('Bowling machine', 'machine', () => this.go('main'));
      const cw = (CW - 16) / 2, rh = 62, gap = 12, y0 = 114;
      const R = (c, r) => ({ x: M + c * (cw + 16), y: y0 + r * (rh + gap), w: cw, h: rh });
      const lenName = nearestName(LENGTH_PRESETS, 'length', m.length);
      const lineName = nearestName(LINE_PRESETS, 'line', m.line);
      step('pace', R(0, 0), 'Pace', `${Math.round(m.paceKmh)} km/h`, () => g.actions.machine('paceKmh', -5), () => g.actions.machine('paceKmh', 5));
      step('length', R(1, 0), 'Length', `${lenName} ${fmt1(m.length)}m`, () => g.actions.machinePreset('length', -1), () => g.actions.machinePreset('length', 1), { vw: 190 });
      step('line', R(0, 1), 'Line', lineName, () => g.actions.machinePreset('line', -1), () => g.actions.machinePreset('line', 1), { vw: 200 });
      step('fine', R(1, 1), 'Line fine', `${signed(m.line)} m`, () => g.actions.machine('line', -0.02), () => g.actions.machine('line', 0.02));
      step('swing', R(0, 2), 'Swing', m.swing === 0 ? 'none' : `${m.swing > 0 ? 'out' : 'in'} ${Math.abs(m.swing).toFixed(2)}`, () => g.actions.machine('swing', -0.25), () => g.actions.machine('swing', 0.25));
      step('seam', R(1, 2), 'Seam', m.seam === 0 ? 'none' : `${m.seam > 0 ? 'away' : 'back'} ${Math.abs(m.seam).toFixed(2)}`, () => g.actions.machine('seam', -0.25), () => g.actions.machine('seam', 0.25));
      step('spin', R(0, 3), 'Spin', m.spinType === 'none' ? 'none' : `${m.spinType}-spin`, () => g.actions.machineSpin(-1), () => g.actions.machineSpin(1));
      step('spinAmt', R(1, 3), 'Spin amount', `${Math.round(m.spinAmount * 100)}%`, () => g.actions.machine('spinAmount', -0.1), () => g.actions.machine('spinAmount', 0.1));
      step('rel', R(0, 4), 'Release', m.release === 'over' ? 'over wkt' : 'around', () => g.actions.machineRelease(), () => g.actions.machineRelease());
      step('var', R(1, 4), 'Variation', `${Math.round(m.variation * 100)}%`, () => g.actions.machine('variation', -0.1), () => g.actions.machine('variation', 0.1));
      const by = y0 + 5 * (rh + gap) + 14;
      tog('auto', { x: M, y: by, w: cw, h: 72 }, 'Auto-feed', s.autoFeed, () => g.actions.toggle('autoFeed'), { icon: 'refresh' });
      const inNets = g.session && g.session.kind === 'nets';
      btn('go', { x: M + cw + 16, y: by, w: cw, h: 72 }, inNets ? 'Resume' : 'Nets now', () => (inNets ? this.closeMenu() : g.actions.start('nets')), { active: true, variant: 'primary', icon: 'play', size: 30 });
      hint('− / + step each setting · point at a row and pull the trigger to step it up');
      P.set(W, '');
    } else if (this.page === 'settings' || this.page === 'vision') {
      const vision = this.page === 'vision';
      const tab = vision ? 'vision' : this.setTab;
      header('Settings', 'gear', vision ? () => this.go('settings') : () => this.go('main'));
      // Tabs, sized to their words.
      { const tw = SET_TABS.map(([, t]) => { const c = P.ctx; c.font = font(700, 24); return c.measureText(t).width + 44; });
        const k = (CW - (SET_TABS.length - 1) * 8) / tw.reduce((a, b) => a + b, 0);
        let x = M;
        SET_TABS.forEach(([id, t], i) => {
          const w = tw[i] * k;
          const go = id === 'vision' ? () => this.go('vision') : () => { this.setTab = id; this.go('settings'); };
          btn(id === 'vision' ? 'vision' : 'stab-' + id, { x, y: 108, w, h: 54 }, id === 'vision' && s.vision.on ? 'Vision · on' : t, go, { variant: 'tab', active: tab === id, size: 24 });
          x += w + 8;
        }); }
      const y0 = 178;
      if (!vision) {
        // One full-width row per setting (label, a line of what it does, the control).
        const rows = [];
        const add = (kind, id, labelT, desc, extra) => rows.push({ kind, id, label: labelT, desc, ...extra });
        if (tab === 'gameplay') {
          add('step', 'diff', 'Difficulty', 'How good the bowlers, batters and fielders are', { value: s.difficulty, dec: () => g.actions.difficulty(-1), inc: () => g.actions.difficulty(1) });
          add('step', 'overs', 'Overs', 'Length of a run chase or match innings', { value: String(s.overs), dec: () => g.actions.setting('overs', -1, 1, 5), inc: () => g.actions.setting('overs', 1, 1, 5) });
          add('step', 'replay', 'Replays', 'A replay from the bowler’s end', { value: REPLAY_NAMES[s.replay] || s.replay, dec: () => g.actions.cycle('replay', REPLAYS, -1), inc: () => g.actions.cycle('replay', REPLAYS, 1) });
          add('tog', 'trail', 'Ball trail', 'A streak behind the ball in flight', { on: s.trail, fn: () => g.actions.toggle('trail') });
          add('tog', 'boost', 'Big ball', 'The ball never looks smaller than a dot far away', { on: s.ballBoost, fn: () => g.actions.toggle('ballBoost') });
          add('tog', 'finder', 'Ball finder', 'Arrow, halo and landing ring after a hit', { on: s.ballFinder, fn: () => g.actions.toggle('ballFinder') });
        } else if (tab === 'batting') {
          add('step', 'contact', 'Contact assist', 'Helps the bat find the ball', { value: s.contactAssist, dec: () => g.actions.cycle('contactAssist', CONTACT, -1), inc: () => g.actions.cycle('contactAssist', CONTACT, 1) });
          add('step', 'batAngle', 'Bat angle', 'Tilt of the bat in your hand', { value: `${signed(s.batAngleDeg, 0)}°`, dec: () => g.actions.setting('batAngleDeg', -2, -30, 30), inc: () => g.actions.setting('batAngleDeg', 2, -30, 30) });
          add('step', 'batSpeed', 'Bat power', 'How hard your swing hits the ball', { value: `×${s.batSpeedMultiplier.toFixed(2)}`, dec: () => g.actions.setting('batSpeedMultiplier', -0.05, 0.7, 2.5), inc: () => g.actions.setting('batSpeedMultiplier', 0.05, 0.7, 2.5) });
          const gx = s.guardX;
          const guardName = gx < -0.08 ? 'leg' : gx < -0.02 ? 'mid-leg' : gx < 0.03 ? 'middle' : 'mid-off';
          add('step', 'guard', 'Guard', 'Where you take your stance on the crease', { value: `${guardName} ${gx >= 0 ? '+' : ''}${Math.round(gx * 100)}cm`, dec: () => g.actions.setting('guardX', -0.03, -0.2, 0.15), inc: () => g.actions.setting('guardX', 0.03, -0.2, 0.15) });
          add('tog', 'sweepDrop', 'Sweep view drop', 'Holding sweep lowers your view to a kneeling sweeper’s', { on: s.sweepDrop !== false, fn: () => g.actions.toggle('sweepDrop') });
        } else if (tab === 'bowling') {
          add('step', 'pace', 'Bowl pace', 'Speed your arm action turns into', { value: `×${s.paceMultiplier.toFixed(2)}`, dec: () => g.actions.setting('paceMultiplier', -0.1, 1.0, 5), inc: () => g.actions.setting('paceMultiplier', 0.1, 1.0, 5) });
          add('tog', 'assist', 'Aim assist', 'Pulls deliveries toward the floor target', { on: s.aimAssist, fn: () => g.actions.toggle('aimAssist') });
          add('tog', 'marker', 'Aim marker', 'The target on the pitch (left stick moves it)', { on: s.aimMarker, fn: () => g.actions.toggle('aimMarker') });
          add('tog', 'runup', 'Run-up', 'Run in to bowl; off: bowl from the crease', { on: s.runUp, fn: () => g.actions.toggle('runUp') });
          add('cyc', 'feel', 'Deliveries', 'Choose them, or let your wrist decide', { value: s.bowlByFeel ? 'by wrist action' : 'pick with A/B', fn: () => g.actions.toggle('bowlByFeel') });
          add('cyc', 'relcal', 'Calibrate release', 'Bowl a few balls to learn your release', { value: 'start', fn: () => g.actions.bowlCalib() });
        } else if (tab === 'view') {
          add('step', 'view', 'View', 'Where you see the game from', { value: VIEW_NAMES[s.view] || s.view, dec: () => g.actions.cycle('view', VIEWS, -1), inc: () => g.actions.cycle('view', VIEWS, 1), vw: 300 });
          add('tog', 'body', 'Own body', 'A faint body when you look down', { on: s.ownBody, fn: () => g.actions.toggle('ownBody') });
          add('cyc', 'turn', 'Right-stick turn', 'Smooth, snap, or off (turn for real)', { value: s.turn, fn: () => g.actions.cycle('turn', TURNS, 1) });
          add('step', 'quality', 'Graphics', 'Auto keeps the frame rate; or fix a level', { value: qualityName(g, s.quality), dec: () => g.actions.cycle('quality', QUALITY_NAMES, -1), inc: () => g.actions.cycle('quality', QUALITY_NAMES, 1), vw: 300 });
          add('tog', 'perfPanel', 'Performance panel', 'Frame rate and quality below your view', { on: s.debugFrames, fn: () => g.actions.toggle('debugFrames') });
        } else if (tab === 'audio') {
          add('cyc', 'sound', 'Sound', 'Crowd, bat and ball; the commentators', { value: !s.sound ? 'off' : s.commentary ? 'sound + commentary' : 'sound, no commentary', fn: () => g.actions.soundCycle() });
          add('step', 'hap', 'Haptics', 'Controller buzz on contact and catches', { value: `${Math.round(s.hapticsScale * 100)}%`, dec: () => g.actions.setting('hapticsScale', -0.25, 0, 1), inc: () => g.actions.setting('hapticsScale', 0.25, 0, 1) });
        }
        const avail = PH - 74 - y0, rh = Math.min(74, (avail - (rows.length - 1) * 10) / rows.length);
        rows.forEach((r, i) => {
          const rect = { x: M, y: y0 + i * (rh + 10), w: CW, h: rh };
          const desc = { sub: r.desc };
          if (r.kind === 'step') step(r.id, rect, r.label, r.value, r.dec, r.inc, { vw: r.vw || 250, ...desc });
          else if (r.kind === 'tog') tog(r.id, rect, r.label, r.on, r.fn, desc);
          else btn(r.id, rect, r.label, r.fn, { value: r.value, label: r.label, ...desc });
        });
        const xrRate = g.xrManager && g.xrManager.frameRate ? `${g.xrManager.frameRate} Hz target` : 'no target';
        const vel = g.input.xr ? (g.input.right.hasXRVel ? 'XR' : 'pose') : 'desktop';
        label(PW / 2, PH - 52, `Frame ${Math.round(g.stats.fps)} Hz (${xrRate}) · controller velocity: ${vel} · v${g.version}`, { align: 'center', size: 19, color: C.text3 });
        hint('Y / Esc: back to the game');
      } else {
        const v = s.vision, cw = (CW - 16) / 2, rh = 50, gap = 7;
        const R = (c, r) => ({ x: M + c * (cw + 16), y: y0 + r * (rh + gap), w: cw, h: rh });
        const dz = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}`;
        const info = g.vision && g.vision.info;
        const blur = info && info.eyes && info.eyes.length === 2 ? `left ${info.eyes[0] ? info.eyes[0].radius.toFixed(1) : 0} px · right ${info.eyes[1] ? info.eyes[1].radius.toFixed(1) : 0} px` : '–';
        for (const [col, eye, name] of [[0, 'L', 'Left'], [1, 'R', 'Right']]) {
          const rx = v[eye];
          step(`sph${eye}`, R(col, 0), `${name} sphere`, dz(rx.sph), () => g.actions.vision('sph', -0.25, -10, 6, eye), () => g.actions.vision('sph', 0.25, -10, 6, eye), { vw: 120 });
          step(`cyl${eye}`, R(col, 1), `${name} cylinder`, dz(rx.cyl), () => g.actions.vision('cyl', -0.25, -6, 6, eye), () => g.actions.vision('cyl', 0.25, -6, 6, eye), { vw: 120 });
          step(`axis${eye}`, R(col, 2), `${name} axis`, `${Math.round(rx.axis)}°`, () => g.actions.vision('axis', -5, -5, 185, eye), () => g.actions.vision('axis', 5, -5, 185, eye), { vw: 120 });
        }
        step('tune', R(0, 3), 'Fine tune', `${dz(v.tune)} D`, () => g.actions.vision('tune', -0.25, -2, 2), () => g.actions.vision('tune', 0.25, -2, 2), { vw: 130 });
        step('pupil', R(1, 3), 'Pupil', `${v.pupil.toFixed(1)} mm`, () => g.actions.vision('pupil', -0.5, 2, 7), () => g.actions.vision('pupil', 0.5, 2, 7), { vw: 130 });
        step('strength', R(0, 4), 'Strength', `${Math.round(v.strength * 100)}%`, () => g.actions.vision('strength', -0.25, 0.25, 1), () => g.actions.vision('strength', 0.25, 0.25, 1), { vw: 130 });
        step('steps', R(1, 4), 'Quality (GPU)', `${v.steps} step${v.steps > 1 ? 's' : ''}/frame`, () => g.actions.vision('steps', -1, 1, 6), () => g.actions.vision('steps', 1, 1, 6), { vw: 160 });
        step('region', R(0, 5), 'Area', `${Math.round(v.region * 100)}%`, () => g.actions.vision('region', -0.05, 0.3, 0.9), () => g.actions.vision('region', 0.05, 0.3, 0.9), { vw: 130 });
        step('dist', R(1, 5), 'Headset focus', `${v.imageDist.toFixed(1)} m`, () => g.actions.vision('imageDist', -0.1, 0.8, 3), () => g.actions.vision('imageDist', 0.1, 0.8, 3), { vw: 130 });
        const by = y0 + 6 * (rh + gap) + 2, bw = (CW - 2 * 12) / 3;
        tog('von', { x: M, y: by, w: bw, h: 54 }, 'Correction', v.on, () => g.actions.visionToggle());
        btn('vab', { x: M + bw + 12, y: by, w: bw, h: 54 }, g.vision && !g.vision.show ? 'Showing: without' : 'Showing: with', () => { g.actions.visionCompare(); this.refresh(); }, { size: 24, icon: 'swap' });
        btn('vcopy', { x: M + 2 * (bw + 12), y: by, w: bw, h: 54 }, 'Left eye = right eye', () => g.actions.visionCopyEye(), { size: 24 });
        label(PW / 2, PH - 52, `Your glasses' prescription. A help, not glasses. Blur: ${blur} · ${Math.round(g.stats.fps)} fps`, { align: 'center', size: 20, color: C.text2 });
        hint('Look at the chart on the right. Sphere/cylinder/axis as written on your prescription.');
      }
      P.set(W, '');
    } else if (this.page === 'bowler') {
      // The tick marks who bowls: the bowler you just picked (shown for a
      // moment before the page closes), else the current one. Hover is blue.
      const ses = g.session, cur = s.bowlerType;
      const chosen = this.pendingPick ? this.pendingPick.key : cur;
      const canChange = !ses || !ses.canChangeBowler || ses.canChangeBowler();
      header('Choose your bowler', 'ball');
      const cw = (CW - 16) / 2, chh = 196, y0 = 116;
      PLAYER_BOWLER_ORDER.forEach((k, i) => {
        const b = PLAYER_BOWLERS[k], r = { x: M + (i % 2) * (cw + 16), y: y0 + Math.floor(i / 2) * (chh + 16), w: cw, h: chh }, here = k === chosen;
        const ru = CONFIG.bowling.runUp[k], tw = r.w - 44;
        btn('bw-' + k, r, '', () => this.pickBowler(k), { active: here, disabled: !canChange && k !== cur });
        custom((c) => {
          c.beginPath(); c.arc(r.x + 44, r.y + 46, 24, 0, Math.PI * 2);
          c.fillStyle = here ? 'rgba(255,255,255,0.22)' : 'rgba(255,201,60,0.16)'; c.fill();
          c.fillStyle = here ? '#fff' : C.accent; c.font = font(900, 28); c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(String(i + 1), r.x + 44, r.y + 47);
          if (here) drawIcon(c, 'check', r.x + r.w - 40, r.y + 46, 40, '#ffffff', { weight: 3.2 });
        });
        label(r.x + 82, r.y + 46, b.label, { size: 40, bold: true, weight: 900, color: here ? '#ffffff' : C.text, maxW: tw - 120 });
        label(r.x + 24, r.y + 98, `${b.pace[0]}–${b.pace[1]} km/h · run-up ${ru.length} m`, { size: 26, weight: 700, color: here ? '#ffffff' : C.accentHi, maxW: tw });
        const names = b.deliveryList.map((d) => d.label);
        const lines = names.length > 4 ? [names.slice(0, 3).join(' · '), names.slice(3).join(' · ')] : [names.slice(0, 2).join(' · '), names.slice(2).join(' · ')];
        label(r.x + 24, r.y + 138, lines.filter(Boolean).join('\n'), { size: 23, color: here ? 'rgba(255,255,255,0.9)' : C.text2, maxW: tw, maxH: r.h - 138 + 6 });
      });
      const note = !canChange ? 'You can change bowler at the start of the next over'
        : ses && ses.innings ? 'Pick for this over · your mark is behind you' : 'Pick a bowler · change any time from the menu';
      label(PW / 2, PH - 50, note, { align: 'center', size: 27, color: canChange ? C.text2 : C.warn, maxW: PW - 60 });
      P.set(W, '');
    } else if (this.page === 'result') {
      const r = g.resultInfo || { title: 'Done', lines: [] };
      const lines = r.lines.filter(Boolean);
      // The innings just played (its scorecard), and in a match the other one.
      const ses = g.session, inn = ses && ses.innings && ses.innings.card ? ses.innings : null;
      let prev = null;
      if (inn && ses.kind === 'match') {
        if (this.prevInnings && this.prevInnings.session !== ses && inn.target != null) prev = this.prevInnings.innings;
        if (!prev) this.prevInnings = { session: ses, innings: inn };
      }
      const color = r.color || C.accent;
      const sub = inn || prev ? lines[0] : null;
      const cta = lines.filter((l) => /^Now /.test(l)).join(' ');
      // Result banner.
      custom((c) => {
        const bx = M, by = 22, bw = CW, bh = sub ? 116 : 96;
        shadow2(c, () => { slant(c, bx, by, bw, bh, 26); c.fillStyle = shade(color, -0.62); c.fill(); });
        c.save(); slant(c, bx, by, bw, bh, 26); c.clip();
        c.fillStyle = hgrad(c, bx, bx + bw, shade(color, -0.55), shade(color, -0.78)); c.fillRect(bx, by, bw, bh);
        c.fillStyle = vgrad(c, by, by + bh, 'rgba(255,255,255,0.12)', 'rgba(255,255,255,0)'); c.fillRect(bx, by, bw, bh * 0.5);
        c.fillStyle = color; c.fillRect(bx, by, 40, bh);
        c.restore();
        c.fillStyle = color; c.fillRect(bx + 26, by + bh - 4, bw - 52, 4);
        const tr = fitText(c, r.title, { maxW: bw - 120, size: 54, min: 30, weight: 900 });
        c.save(); c.translate(bx + 70, by + (sub ? 44 : bh / 2)); c.transform(1, 0, -0.1, 1, 0, 0);
        c.fillStyle = '#ffffff'; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(r.title, 0, 2); c.restore();
        c.textAlign = 'left'; c.fillStyle = 'rgba(255,255,255,0.88)';
        if (sub) fillFit(c, sub, bx + 72, by + 92, bw - 120, 600, 28, 18, 'menu');
        void tr;
      });
      const bodyTop = sub ? 158 : 138, btnY = PH - 98;
      const body = { x: M + 4, y: bodyTop, w: CW - 8, h: btnY - bodyTop - (cta ? 52 : 16) };
      const bodyLines = inn || prev ? [] : lines;
      custom((c) => drawResultBody(c, body, { inn, prev, lines: bodyLines }));
      if (cta) label(PW / 2, btnY - 28, cta, { align: 'center', size: 27, weight: 800, bold: true, color: C.accentHi, maxW: CW });
      const bh = 76;
      if (r.choices) {
        const n = Math.max(2, r.choices.length + 1), bw = (CW - (n - 1) * 14) / n;
        const Rr = (i) => ({ x: M + i * (bw + 14), y: btnY, w: bw, h: bh });
        r.choices.forEach((ch, i) => btn('choice' + i, Rr(i), ch.text, ch.fn, { active: true, variant: 'primary', size: 30 }));
        btn('menu', Rr(Math.max(1, r.choices.length)), 'Main menu', () => g.actions.quit(), { icon: 'home', size: 28 });
      } else {
        const bw = (CW - 14) / 2;
        if (r.next) btn('next', { x: M, y: btnY, w: bw, h: bh }, r.nextText || 'Continue', r.next, { active: true, variant: 'primary', icon: 'next', size: 30 });
        else btn('again', { x: M, y: btnY, w: bw, h: bh }, 'Play again', () => g.actions.start(g.lastMode), { active: true, variant: 'primary', icon: 'refresh', size: 30 });
        btn('menu', { x: M + bw + 14, y: btnY, w: bw, h: bh }, 'Main menu', () => g.actions.quit(), { icon: 'home', size: 28 });
      }
      P.set(W, '');
    }
  }

  go(page) { this.page = page; this.buildPage(); }

  // The test chart: on the Vision page, to the right of the menu and turned toward you.
  placeChart() {
    const on = this.menuOpen && this.page === 'vision';
    this.chart.visible = on;
    if (!on) return;
    const m = this.menu.mesh;
    m.updateMatrixWorld(true);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(m.quaternion);
    this.chart.position.copy(m.position).addScaledVector(right, this.menu.w / 2 + 0.46);
    this.chart.position.y += 0.05;
    this.chart.quaternion.copy(m.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.55));   // (turned toward you)
  }

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
    this.menu.press(`${w.id}:${hit.part}`);
    this.pressUntil = this.clock + PRESS_SECS;
    if (w.type === 'stepper') {
      if (hit.part === 'dec' && w.onDec) w.onDec();
      else if (hit.part === 'inc' && w.onInc) w.onInc();
      else if (w.onInc) w.onInc();
    } else if (w.onClick) w.onClick();
    this.refresh();
  }

  // ---------------------------------------------------------------- HUD
  // The score bug (score, overs, the chase, batters, bowler, this over),
  // then this ball's result, the lines under it and the controls footer.
  setHud(patch) {
    Object.assign(this.hudData, patch);
    const d = { ...this.hudData }, P = this.hud, st = matchState(this.game);
    P.set([{ type: 'custom', draw: (g) => drawHud(g, P.W, P.H, d, st) }], '');
  }

  // The stadium screen. lines: [title, score, batters, bowler · this over]
  // (or a nets / welcome card); the scoreboard itself is read from the innings.
  setBoard(lines) {
    this.boardData = { lines: lines.slice(), st: matchState(this.game) };
    this.drawBoard();
  }
  drawBoard() {
    const P = this.board, b = this.boardData, g = this.game;
    const sting = this.boardSting || (this._boardReplay ? { kind: 'replay', word: 'REPLAY', sub: null } : null);
    const title = b.st ? b.lines[0] : '';
    P.set([{ type: 'custom', draw: (c) => drawBigScreen(c, P.W, P.H, { lines: b.lines, st: b.st, title, sting }) }], '');
    void g;
  }

  update() {
    this.updatePrompt(this.game.realDt || 0.016);
    if (this.menu.pressed && this.clock >= this.pressUntil) this.menu.release();
    this.menu.update();
    // The HUD panel: between balls only (not while a delivery is on, not in a replay).
    const g = this.game, replay = !!(g.replay && g.replay.active);
    this.hud.mesh.visible = this.hudOn && !this.quiet && !replay;
    this.hud.update();
    // The screen: a sting ends, a replay starts or ends: one redraw each.
    if (this.boardSting && this.clock >= this.boardSting.until) { this.boardSting = null; this.drawBoard(); }
    if (replay !== this._boardReplay) { this._boardReplay = replay; this.drawBoard(); }
    this.board.update();
  }
}

function shadow2(c, fn) { c.save(); c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 16; c.shadowOffsetY = 5; fn(); c.restore(); }

// The whole HUD panel: the bug, the result bar, then the lower lines.
function drawHud(g, W, H, d, st) {
  const N = 'hud', M = 26, tw = W - 2 * M;
  let y = drawScoreBug(g, W, H, d, st);
  if (d.big) y = drawBigBar(g, W, y, d.big, d.bigColor || C.accent) + 12;
  // Lower lines flow down (each may wrap); the footer keeps to the bottom.
  let floor = H - 18;
  if (d.footer) {
    const r = fitText(g, d.footer, { maxW: tw, maxH: 22 + 22 * 1.25, size: 22, min: 18, weight: 500, wrap: true });
    if (!r.fits) reportOverflow(N, d.footer, r.width, tw);
    const h = r.size + (r.lines.length - 1) * r.lh, top = H - 18 - h;
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(M, top - 10, tw, 2);
    g.fillStyle = C.text3; g.textAlign = 'left'; g.textBaseline = 'middle';
    r.lines.forEach((ln, i) => g.fillText(ln, M, top + r.size / 2 + i * r.lh));
    floor = top - 18;
  }
  for (const [text, size, color, weight] of [[d.last, 28, C.text, 600], [d.detail, 25, C.text2, 500]]) {
    if (!text || y >= floor - 18) continue;
    const r = fitText(g, text, { maxW: tw, maxH: Math.min(floor - y, size * 2.4), size, min: 18, weight, wrap: true });
    if (!r.fits) reportOverflow(N, text, r.width, tw);
    g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'middle';
    r.lines.forEach((ln, i) => g.fillText(ln, M, y + r.size / 2 + i * r.lh));
    y += r.size + (r.lines.length - 1) * r.lh + 12;
  }
}

// A line with [KEY] tokens drawn as key caps, shrunk together to fit maxW.
function drawRich(g, text, x, y, size, maxW) {
  const parts = String(text).split(/(\[[^\]]+\])/).filter(Boolean);
  const measure = (s) => parts.reduce((t, p) => {
    if (p[0] === '[') { g.font = font(800, s * 0.74); return t + g.measureText(p.slice(1, -1)).width + s * 0.9; }
    g.font = font(500, s); return t + g.measureText(p).width;
  }, 0);
  let s = size;
  while (measure(s) > maxW && s > 16) s -= 1;
  if (measure(s) > maxW) reportOverflow('menu', text, measure(s), maxW);
  let cx = x;
  g.textBaseline = 'middle'; g.textAlign = 'left';
  for (const p of parts) {
    if (p[0] === '[') {
      const k = p.slice(1, -1);
      g.font = font(800, s * 0.74);
      const w = g.measureText(k).width + s * 0.6;
      rr(g, cx + s * 0.08, y - s * 0.58, w, s * 1.16, s * 0.22);
      g.fillStyle = vgrad(g, y - s * 0.58, y + s * 0.58, '#2a3d60', '#1b2a45'); g.fill();
      g.strokeStyle = 'rgba(255,201,60,0.55)'; g.lineWidth = 2; g.stroke();
      g.fillStyle = C.accentHi; g.fillText(k, cx + s * 0.38, y + 1);
      cx += w + s * 0.3;
    } else {
      g.font = font(500, s); g.fillStyle = C.text;
      g.fillText(p, cx, y);
      cx += g.measureText(p).width;
    }
  }
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
  // Header band: the bowler, the pace range in a chip.
  g.save(); rr(g, 4, 4, W - 8, 92, 28); g.clip();
  g.fillStyle = vgrad(g, 4, 96, 'rgba(255,255,255,0.09)', 'rgba(255,255,255,0.02)'); g.fillRect(0, 0, W, 96);
  g.restore();
  g.font = FONT(800, 30);
  const pw = Math.min(g.measureText(d.pace).width + 36, W * 0.42);
  rr(g, W - 28 - pw, 30, pw, 48, 12); g.fillStyle = 'rgba(255,255,255,0.1)'; g.fill();
  g.textAlign = 'center'; g.fillStyle = C.text;
  fillFit(g, d.pace, W - 28 - pw / 2, 55, pw - 24, 800, 32, 22, N);
  g.textAlign = 'left'; g.fillStyle = C.accent;
  fillFit(g, d.title.toUpperCase(), 32, 54, W - 64 - pw - 24, 900, 46, 26, N);
  g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(24, 96, W - 48, 2);
  // Deliveries, the picked one lit.
  const top = 108, bot = 420, n = d.list.length, rh = Math.min(56, (bot - top) / n);
  d.list.forEach((it, i) => {
    const y = top + i * rh + rh / 2;
    if (it.sel) {
      rr(g, 22, y - rh / 2 + 3, 384, rh - 6, 12); g.fillStyle = vgrad(g, y - rh / 2, y + rh / 2, C.accentHi, C.accent); g.fill();
      g.fillStyle = '#16120a'; g.beginPath(); g.moveTo(36, y - 9); g.lineTo(50, y + 1); g.lineTo(36, y + 11); g.fill();
    }
    g.textAlign = 'left'; g.fillStyle = it.sel ? '#16120a' : C.text2;
    fillFit(g, it.label, 60, y + 1, 336, it.sel ? 900 : 600, Math.min(it.sel ? 36 : 32, rh * 0.62), 18, N);
  });
  g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(418, 112, 2, 304);
  // This ball + target.
  const x = 436, w = W - x - 30;
  caps(g, d.byFeel ? 'BY FEEL' : 'THIS BALL', x, 122, 24, C.text3, { maxW: w });
  g.fillStyle = C.text; g.textAlign = 'left';
  lines(d.effect, x, 162, w, 600, 31, 4, 38);
  caps(g, 'TARGET', x, 332, 24, C.text3, { maxW: w });
  g.fillStyle = C.ok; g.textAlign = 'left';
  lines(d.target, x, 372, w, 800, 32, 2, 40);
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
    surface(g, cx, cy, cw, ch, 14, { top: '#1c2b46', bottom: '#142036', lift: false });
    if (desktop) drawKey(g, mx, cy + 46, 140, it.key);
    else drawController(g, mx, cy + 48, 90, it.hand, it.button);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = C.accent;
    fillFit(g, it.head, mx, cy + 108, cw - 14, 900, 27, 16, N);
    g.fillStyle = C.text;
    lines(it.text, mx, cy + 140, cw - 14, 600, 25, 2, 27);
  });
}

function nearestName(list, key, v) {
  let best = list[0], bd = Infinity;
  for (const it of list) { const d = Math.abs(it[key] - v); if (d < bd) { bd = d; best = it; } }
  return bd < 0.02 ? best.name : best.name + '~';
}

