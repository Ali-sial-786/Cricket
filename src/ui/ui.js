// Menus (laser-pointer driven), HUD, scoreboard, safety + calibration screens.
import * as THREE from 'three';
import { CanvasPanel, grid } from './panel.js';
import { LENGTH_PRESETS, LINE_PRESETS } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const signed = (v, d = 2) => (v > 0 ? '+' : '') + v.toFixed(d);

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
    this.hudData = { title: 'Crease VR', score: '', sub: '', last: '', big: '', bigColor: '#ffd34d', detail: '', footer: '' };

    // Big stadium scoreboard.
    this.board = new CanvasPanel({ width: 24, height: 9, ppm: 42, name: 'scoreboard', bg: 'rgba(6,10,18,1)', interactive: false });
    this.board.mesh.position.set(-58, 18, -42);
    this.board.mesh.lookAt(0, 12, -10);
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
      const L = grid(P, { top: 0.17, bottom: 0.05, cols: 2, rows: 5 });
      const playing = !!g.session;
      btn('nets', L(0, 0), 'Nets: Batting', () => g.actions.start('nets'));
      btn('bnets', L(1, 0), 'Nets: Bowling', () => g.actions.start('bowlnets'));
      btn('chase', L(0, 1), `Run Chase (${s.overs} ov)`, () => g.actions.start('chase'));
      btn('over', L(1, 1), 'Bowl an Over', () => g.actions.start('over'));
      btn('match', L(0, 2), `Match (${s.overs} ov each)`, () => g.actions.start('match'));
      btn('machine', L(1, 2), 'Bowling machine…', () => this.go('machine'));
      btn('settings', L(0, 3), 'Settings…', () => this.go('settings'));
      btn('calib', L(1, 3), 'Calibrate bat', () => g.actions.calibrate());
      if (playing) {
        btn('resume', L(0, 4), 'Resume', () => this.closeMenu(), { active: true });
        btn('recenter', L(1, 4), 'Recenter here', () => g.actions.recenter());
      } else {
        btn('mr', L(0, 4), g.mr ? 'MR: re-place stumps' : 'Mixed reality nets…', () => g.actions.mr());
        btn('recenter', L(1, 4), 'Recenter here', () => g.actions.recenter());
      }
      P.set(W, 'CREASE VR');
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
      const L = grid(P, { top: 0.165, bottom: 0.05, cols: 2, rows: 6 });
      const xrRate = g.xrManager && g.xrManager.frameRate ? `${g.xrManager.frameRate} Hz target` : 'no target';
      const vel = g.input.xr ? (g.input.right.hasXRVel ? 'XR' : 'pose') : 'desktop';
      label(P.W / 2, P.H * 0.122, `Frame ${Math.round(g.stats.fps)} Hz (${xrRate}) · controller velocity: ${vel} · v${g.version}`, { align: 'center', size: 22, color: '#8fb3d1' });
      step('diff', L(0, 0), 'Difficulty', s.difficulty, () => g.actions.difficulty(-1), () => g.actions.difficulty(1));
      step('overs', L(1, 0), 'Overs', String(s.overs), () => g.actions.setting('overs', -1, 1, 5), () => g.actions.setting('overs', 1, 1, 5));
      step('batAngle', L(0, 1), 'Bat angle', `${signed(s.batAngleDeg, 0)}°`, () => g.actions.setting('batAngleDeg', -2, -30, 30), () => g.actions.setting('batAngleDeg', 2, -30, 30));
      step('batSpeed', L(1, 1), 'Bat power', `×${s.batSpeedMultiplier.toFixed(2)}`, () => g.actions.setting('batSpeedMultiplier', -0.05, 0.7, 2.5), () => g.actions.setting('batSpeedMultiplier', 0.05, 0.7, 2.5));
      step('pace', L(0, 2), 'Bowl pace', `×${s.paceMultiplier.toFixed(2)}`, () => g.actions.setting('paceMultiplier', -0.1, 1.0, 5), () => g.actions.setting('paceMultiplier', 0.1, 1.0, 5));
      step('hap', L(1, 2), 'Haptics', `${Math.round(s.hapticsScale * 100)}%`, () => g.actions.setting('hapticsScale', -0.25, 0, 1), () => g.actions.setting('hapticsScale', 0.25, 0, 1));
      btn('assist', L(0, 3), `Bowling aim assist: ${s.aimAssist ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimAssist'), { active: s.aimAssist });
      btn('marker', L(1, 3), `Aim marker: ${s.aimMarker ? 'ON' : 'OFF'}`, () => g.actions.toggle('aimMarker'), { active: s.aimMarker });
      const hw = (L(0, 4).w - 12) / 2, r4 = L(0, 4);
      btn('trail', { x: r4.x, y: r4.y, w: hw, h: r4.h }, `Trail: ${s.trail ? 'ON' : 'OFF'}`, () => g.actions.toggle('trail'), { active: s.trail });
      btn('boost', { x: r4.x + hw + 12, y: r4.y, w: hw, h: r4.h }, `Ball boost: ${s.ballBoost ? 'ON' : 'OFF'}`, () => g.actions.toggle('ballBoost'), { active: s.ballBoost });
      btn('sound', L(1, 4), `Sound: ${s.sound ? 'ON' : 'OFF'}`, () => g.actions.toggle('sound'), { active: s.sound });
      btn('relcal', L(0, 5), 'Calibrate bowling release', () => g.actions.bowlCalib());
      const gx = s.guardX;
      const guardName = gx < -0.08 ? 'leg' : gx < -0.02 ? 'mid-leg' : gx < 0.03 ? 'middle' : 'mid-off';
      step('guard', L(1, 5), 'Guard', `${guardName} ${gx >= 0 ? '+' : ''}${Math.round(gx * 100)}cm`, () => g.actions.setting('guardX', -0.03, -0.2, 0.15), () => g.actions.setting('guardX', 0.03, -0.2, 0.15));
      label(P.W * 0.5, P.H * 0.975, 'Y / Esc: back to the game', { align: 'center', size: 20, color: '#7f8fa0' });
      btn('back', { x: P.W - 150, y: 14, w: 130, h: 56 }, 'Back', () => this.go('main'));
      P.set(W, 'Settings');
    } else if (this.page === 'result') {
      const r = g.resultInfo || { title: 'Done', lines: [] };
      label(P.W / 2, P.H * 0.22, r.title, { align: 'center', size: 56, bold: true, color: r.color || '#ffd34d' });
      label(P.W / 2, P.H * 0.36, r.lines.join('\n'), { align: 'center', size: 32 });
      const L = grid(P, { top: 0.74, bottom: 0.06, cols: 2, rows: 1 });
      if (r.next) btn('next', L(0, 0), r.nextText || 'Continue', r.next, { active: true });
      else btn('again', L(0, 0), 'Play again', () => g.actions.start(g.lastMode), { active: true });
      btn('menu', L(1, 0), 'Main menu', () => g.actions.quit());
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
    if (d.big) W.push({ type: 'label', x: P.W / 2, y: 188, text: d.big, size: 76, bold: true, align: 'center', color: d.bigColor });
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
