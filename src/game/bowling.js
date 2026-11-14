// Bowling session: the player bowls from the bowler's end to the AI batter.
// Pick the delivery (A / B), run in (hold right GRIP or left TRIGGER), hold the
// right trigger (ball in hand), bowl overarm and let go in the delivery stride.
import { CONFIG } from '../config.js';
import { Vec3, clamp, DEG } from '../physics/math.js';

const _hold = new Vec3();
import { PITCH, lengthName, lineName, groundDistance, battingPoppingZ, bowlingPoppingZ } from '../physics/pitch.js';
import { predict, crossingAtZ } from '../physics/trajectory.js';
import { playerDelivery } from './bowlingInput.js';
import { LbwFlow, padHit, deflectOffPad } from './lbwFlow.js';
import { ThirdUmpireFlow } from './thirdUmpire.js';
import { Innings } from './scoring.js';
import { batProfile } from './squad.js';
import { playerBowler, seamFromWrist, stepDelivery, deliveryInfo, PLAYER_BOWLER_ORDER } from './bowlerTypes.js';
import { RunUp } from './runup.js';
import { HINTS } from '../ui/controllerHint.js';

const _palm = new Vec3();
// Ball mesh: the seam is the equator (normal = local Y). Upright seam = normal across the pitch.
const S2 = Math.SQRT1_2;

export class BowlingSession {
  constructor(game, { kind = 'bowlnets', title = 'Nets · Bowling', innings = null, fielders = null, aggression = 0.35, onDone = null } = {}) {
    this.game = game;
    this.kind = kind;
    this.title = title;
    this.innings = innings;
    this.field = fielders;
    this.baseAggression = aggression;
    this.onDone = onDone;
    this.isBowling = true;
    this.state = 'ready';
    this.swingChoice = 0;
    this.holding = false;
    this.stats = { balls: 0, runs: 0, wickets: 0, dots: 0, beaten: 0, edges: 0, fastest: 0 };
    this.calibSamples = [];
    this.done = false;
    const s = game.settings;
    this.aim = { x: 0.08, z: -6.5 };
    this.assist = s.aimAssist;
    this.reviews = { player: CONFIG.match.reviews, ai: CONFIG.match.reviews };
    this.lbw = new LbwFlow(game, this.reviews);
    this.third = new ThirdUmpireFlow(game);
    this.reviewFlow = null; this.pendingRes = null;
    this.path = [];
    this.partnership = 0; this.dots = 0;
    this.noBall = false; this.freeHit = false; this.stumpAt = 0;
    this.keeperUp = false;           // the keeper stands up to the spinners
    this.seamYaw = 0;                // how far the wrist has been turned since gripping the ball (rad)
    this.pick = null;                // the delivery picked with A / B (null = the stock ball)
    this.run = null;                 // the run-up (see runup.js), made at your mark
    this.autoRun = false;            // desktop B: run in and bowl by itself
    this.needRelease = true;         // the run button must be let go first (after a menu click)
    this.cardKey = '';
  }

  get bowler() { return playerBowler(this.game.settings.bowlerType); }
  // The delivery to bowl: the picked one, or null when the wrist decides (Settings: by feel).
  get choice() { return this.game.settings.bowlByFeel ? null : deliveryInfo(this.bowler, this.pick).key; }
  // Seam position for this ball: A / B plus the wrist turn. -1 inswing .. +1 outswing.
  get seam() { return this.bowler.spinner ? 0 : clamp(this.swingChoice + seamFromWrist(this.seamYaw), -1, 1); }
  seamText() {
    const s = this.seam;
    if (!this.game.settings.bowlByFeel) return deliveryInfo(this.bowler, this.pick).label;
    if (this.bowler.spinner) return this.bowler.deliveries;
    return Math.abs(s) < 0.05 ? 'seam upright' : `${s > 0 ? 'OUT-swing' : 'IN-swing'} ${Math.round(Math.abs(s) * 100)}%`;
  }
  // Matches: only at the start of an over (at your mark). Nets: any time.
  canChangeBowler() {
    if (!this.innings) return true;
    return this.state === 'ready' && !this.runStarted() && this.innings.thisOver.length === 0;
  }
  setBowler(key) {
    const g = this.game;
    if (key === g.settings.bowlerType) return true;
    if (!this.canChangeBowler()) { g.ui.prompt('You can change bowler at the start of an over', 1.8, '#ffb347'); return false; }
    g.settings.bowlerType = key; g.saveSettings();
    this.swingChoice = 0; this.seamYaw = 0; this.pick = null;
    this.keeperUp = this.bowler.spinner;
    if (this.field && this.state === 'ready') this.field.setSpinner(this.keeperUp);
    if (this.state === 'ready') this.toMark();
    g.ui.prompt(`You are bowling ${this.bowler.label.toLowerCase()}`, 2.5, '#ffd34d');
    g.sfx.ui();
    this.updateHud();
    return true;
  }
  // The bowler page (opening a menu pauses play).
  chooseBowler() { this.game.ui.openMenu('bowler'); }
  stepPick(dir) {
    const g = this.game;
    this.pick = stepDelivery(this.bowler, this.choice, dir);
    g.input.right.pulse(0.15, 15); g.sfx.ui();
    this.updateHud();
  }

  // ------------------------------------------------------------- run-up
  // Back to the top of your mark (an instant reposition).
  toMark() {
    const g = this.game, b = this.bowler;
    this.run = new RunUp(CONFIG.bowling.runUp[b.key] || CONFIG.bowling.runUp.fast, { enabled: !!g.settings.runUp });
    this.autoRun = false; this.needRelease = true;
    g.setRigOffset(0, -this.run.dist);
    g.showRunMarks(this.run.enabled ? this.run.spec : null);
  }
  // Running in (or, without a run-up, the ball gripped): the batter settles, fielders walk in.
  runStarted() { return this.run && this.run.enabled ? this.run.started : this.holding; }
  runHeld(input) {
    const R = input.right, L = input.left, D = input.desktop;
    const held = this.autoRun || R.buttons.squeeze.pressed || L.buttons.trigger.pressed || (!input.xr && D.held('KeyR'));
    if (!held) this.needRelease = false;
    return held && (!this.needRelease || this.autoRun);
  }
  onMenuChanged(open) { if (!open) this.needRelease = true; }
  startedRunning() {
    const g = this.game;
    g.aiBatter.setReady(g.world.time + 0.15);
    if (this.field && !this.field.delivering) this.field.beginDelivery();
  }
  // Drive the run-up (real time) and move you with it.
  stepRun(dt) {
    const g = this.game, run = this.run;
    if (!run || !run.enabled) return;
    const ev = run.update(dt, this.runHeld(g.input));
    if (ev === 'start' || ev === 'resume') { if (ev === 'start') this.startedRunning(); g.input.right.pulse(0.12, 12); }
    else if (ev === 'commit') g.input.right.pulse(0.25, 20);
    else if (ev === 'pullout') g.ui.prompt('Pulled out — hold again to carry on', 1.5, '#cfe3f5');
    else if (ev === 'crease' && this.autoRun && this.state === 'ready') { this.autoRun = false; this.autoBowl(); }
    else if (ev === 'backToMark' || ev === 'deadBall') {
      g.ui.prompt(ev === 'deadBall' ? 'Dead ball — back to your mark' : 'Pulled out — back to your mark', 2.2, '#ffb347');
      g.aiBatter.reset();
      if (this.field) { this.field.reset(); this.field.setSpinner(this.keeperUp); }
      this.toMark();
    }
    g.setRigOffset(0, -run.dist);
  }

  usesY() { return false; }

  enter() {
    const g = this.game;
    g.setEnd('bowling');
    g.machine.setVisible(false);
    g.machine.setCue(0);
    g.aiBatter.setDifficulty(g.settings.difficulty);
    g.aiBatter.reset();
    g.aiBat.enabled = true;
    g.setTeams(false);
    g.batterView.runnerOnly = false;
    g.batterView.running = null;
    g.batterView.show(true);
    g.nonStrikerView.show(!!this.innings);
    // Wider of the stumps than usual, so he is not at the edge of your view at the crease.
    this.nsHome = g.nonStrikerView.home.clone();
    g.nonStrikerView.home.set(CONFIG.bowling.nonStriker[0], 0, CONFIG.bowling.nonStriker[1]);
    g.nonStrikerView.reset();
    g.umpires.place(true);
    g.umpires.show(!!this.field);
    if (this.field) this.field.enter();
    this.keeperUp = this.bowler.spinner;
    if (this.field) this.field.setSpinner(this.keeperUp);
    if (this.innings) { g.say('toss', { choice: 'bowl' }); g.say('innings', { chase: this.innings.target != null }); }
    // By feel there is no delivery card: show the old hints.
    if (g.settings.bowlByFeel) g.coach('bowl', this.bowler.spinner ? [HINTS.bowl] : [HINTS.bowl, HINTS.outswing, HINTS.inswing], 8);
    this.toMark();
    this.resetEnds();
    this.updateAim();
    this.updateHud();
    g.ui.setHud({ big: 'Your ball', bigColor: '#ffd34d', last: this.howTo(), detail: '' });
    this.chooseBowler();
  }

  exit() {
    const g = this.game;
    g.aiBat.enabled = false;
    g.batterView.show(false);
    g.aimMarker.visible = false;
    g.ui.setBowlCard(null);
    g.showRunMarks(null);
    g.setRigOffset(0, 0);
    if (this.field) this.field.exit();
    g.nonStrikerView.show(false);
    if (this.nsHome) { g.nonStrikerView.home.copy(this.nsHome); g.nonStrikerView.reset(); }
    g.umpires.show(false);
    g.drs.hide();
    g.timeScaleTarget = 1;
    g.ballOverride = null;
    g.ui.setHud({ players: '' });
    g.ui.hud.mesh.visible = true;
  }

  howTo() {
    const g = this.game, run = g.settings.runUp;
    if (g.settings.bowlByFeel) {
      return g.input.xr
        ? (this.bowler.spinner ? 'Roll the wrist at release · back of the hand = the wrong \'un' : 'Turn the wrist before you bowl (or A/B) = swing · roll at release = cutter · back of hand = slower')
        : 'Mouse: hold, sweep down, release · B auto-bowl · Q/E wrist roll (+F back of hand) · Z/X swing · 1–4 bowler';
    }
    return g.input.xr
      ? `${run ? 'Hold GRIP to run in · ' : ''}hold TRIGGER, bowl overarm, let go · A / B: delivery`
      : `${run ? 'Hold R to run in · ' : ''}mouse: hold, sweep down, release · Z / X: delivery · B: auto-bowl`;
  }

  footer() {
    return this.game.input.xr ? 'Left stick: aim · A/B: delivery (then throw end, review) · right stick: look · Y: menu' : 'Arrows: aim · R: run in · Z/X: delivery · B: auto-bowl · 1–4: bowler · Esc: menu';
  }

  resetEnds() {
    const g = this.game;
    g.stumps.batting.reset(); g.stumps.bowling.reset();
    g.world.resetWickets();
  }

  updateAim() {
    const g = this.game;
    g.aimMarker.visible = g.settings.aimMarker && this.state !== 'live';
    g.aimMarker.position.set(this.aim.x, 0, this.aim.z);
  }

  // ------------------------------------------------------------- input
  handleInput(input) {
    const R = input.right, L = input.left, D = input.desktop;
    if (this.state === 'ready') {
      const g = this.game, seamer = !this.bowler.spinner, byFeel = g.settings.bowlByFeel;
      if (R.buttons.a.down || R.buttons.b.down) {
        // A = next delivery, B = previous (desktop Z / X).
        if (!byFeel) this.stepPick(R.buttons.a.down ? 1 : -1);
        // By feel, seamers: A = seam to the slips (out-swing), B = to fine leg (in-swing); again for upright.
        else if (seamer) { const want = R.buttons.a.down ? 1 : -1; this.swingChoice = this.swingChoice === want ? 0 : want; this.updateHud(); R.pulse(0.15, 15); g.ui.prompt(`Seam: ${this.seamText()}`, 1.2, '#ffd34d'); }
        else g.ui.prompt(`${this.bowler.label}: roll the wrist at release`, 1.5, '#cfe3f5');
      }
      if (!input.xr) PLAYER_BOWLER_ORDER.forEach((k, i) => { if (D.took('Digit' + (i + 1))) this.setBowler(k); });
      if (R.buttons.trigger.down) {
        this.holding = true; this.seamYaw = 0; this.seamShown = 0; g.sfx.ui();
        if (!this.run.enabled) this.startedRunning();
      }
      // By feel: with the ball in the hand, turning the wrist left / right angles the seam (it locks once the arm is moving).
      if (byFeel && this.holding && seamer && input.xr && R.linVel.length() < 1.5) {
        this.seamYaw = clamp(this.seamYaw + R.angVel.y * (g.realDt || 0.014), -0.9, 0.9);
        const s = this.seam, step = Math.round(s * 4);
        if (step !== this.seamShown) { this.seamShown = step; R.pulse(0.2, 12); this.updateHud(); }
        g.ui.prompt(`Seam: ${this.seamText()}`, 0.3, Math.abs(s) < 0.05 ? '#cfe3f5' : '#ffd34d');
      }
      if (this.holding && R.buttons.trigger.up) this.attemptRelease();
      if (!input.xr && D.took('KeyB')) {
        // Auto-bowl: run in by itself, then let it go at the crease.
        if (this.run.canRelease) this.autoBowl();
        else { this.autoRun = true; this.needRelease = false; }
      }
    }
    if (L.buttons.a.down && this.state === 'settle') this.timer = 0;
    if (!R.connected || R.tracked === false) this.holding = false;
  }

  attemptRelease() {
    const g = this.game, R = g.input.right;
    this.holding = false;
    // Only in the delivery stride or at the crease; anywhere else you keep the ball.
    if (!this.run.canRelease) { g.ui.prompt(`Run in first — hold ${g.input.xr ? 'GRIP' : 'R'}`, 1.8, '#ffb347'); return; }
    // Pace: the fastest the hand came down in the last quarter-second.
    // Length: the hand's direction as you let go (early = up/full, late = down/short).
    // Line: the way the hand was travelling across the ground over the last 0.12 s.
    // Running in moves the rig: take your own run out of the hand's world motion
    // (XR velocities are already relative to the rig; poses are not).
    const runV = this.run.enabled ? this.run.speed : 0, vz = R.hasXRVel ? 0 : runV;
    const last = R.history[R.history.length - 1];
    let pk = null, pkS = -1;
    for (let i = R.history.length - 1; i >= 0; i--) {
      const h = R.history[i];
      if (g.simTime - h.t > CONFIG.bowling.peakWindowMs / 1000) break;
      const sp = Math.hypot(h.v.x, h.v.y, h.v.z - vz);
      if (sp > pkS) { pkS = sp; pk = h; }
    }
    const rel = (v) => new Vec3(v.x, v.y, v.z - vz);
    if (!pk || !last || pkS < CONFIG.bowling.minReleaseHandSpeed) {
      g.ui.setHud({ big: 'Dropped — swing harder', bigColor: '#ffb347' });
      g.aiBatter.reset();
      this.seamYaw = 0; this.updateHud();
      return;
    }
    const dir = rel(last.v).length() > pkS * 0.45 ? rel(last.v) : rel(pk.v);
    let from = last;
    for (let i = R.history.length - 1; i >= 0; i--) { from = R.history[i]; if (last.t - from.t >= 0.12) break; }
    const dx = last.p.x - from.p.x, dz = last.p.z - from.p.z - runV * (last.t - from.t);
    const aimAzDeg = Math.hypot(dx, dz) > 0.05 ? Math.atan2(dx, dz) / DEG : null;
    const pos = R.gripPose.p.clone().add(new Vec3(...CONFIG.bowling.ballHoldOffset).applyQuat(R.gripPose.q));
    this.bowl({ releasePos: pos, handVel: dir, handAngVel: pk.w.clone(), palmDir: g.palmDir(_palm).clone(), paceSpeed: pkS, aimAzDeg });
  }

  // Desktop helper: a clean release at the marker with the machine pace.
  autoBowl() {
    const g = this.game, D = g.input.desktop;
    const rel = new Vec3(0.5, 2.05, -18.95);
    const bw = this.bowler;
    const kmh = clamp(g.settings.machine.paceKmh, bw.pace[0], bw.pace[1]);
    const E = CONFIG.bowling.effortHandSpeed;
    const effort = Math.pow((kmh - bw.pace[0]) / Math.max(1, bw.pace[1] - bw.pace[0]), 1 / 0.85);
    const speed = (E[0] + (E[1] - E[0]) * effort) * 2.6 / CONFIG.bowling.paceMultiplier;
    const el = (this.neutralElev() ?? CONFIG.bowling.neutralElevationDeg) * DEG;
    const az = Math.atan2(this.aim.x - rel.x, this.aim.z - rel.z);
    const v = new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).scale(speed);
    const roll = (D.held('KeyQ') ? 1 : 0) - (D.held('KeyE') ? 1 : 0);
    const w = new Vec3(Math.sin(az), 0, Math.cos(az)).scale(roll * 30);
    const dirv = new Vec3(Math.sin(az), 0, Math.cos(az));
    this.bowl({ releasePos: rel, handVel: v, handAngVel: w, palmDir: D.held('KeyF') ? dirv.scale(-1) : dirv });
  }

  neutralElev() { return typeof this.game.settings.bowlNeutralElevDeg === 'number' ? this.game.settings.bowlNeutralElevDeg : null; }

  bowl({ releasePos, handVel, handAngVel, palmDir = null, paceSpeed = null, aimAzDeg = null }) {
    const g = this.game;
    const d = playerDelivery({
      releasePos, handVel, handAngVel, palmDir, paceSpeed, aimAzDeg,
      swingChoice: this.seam,
      bowler: this.bowler,
      choice: this.choice,
      paceScale: this.run.paceFactor,
      aim: g.settings.aimAssist ? this.aim : null,
      assist: g.settings.aimAssist,
      neutralElevDeg: this.neutralElev(),
      rng: g.rng,
    });
    this.delivery = d;
    this.run.released();
    this.resetEnds();
    g.world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0.5 });
    g.ballView.setVisible(true);
    g.ballView.clearTrail();
    g.input.right.pulse(CONFIG.haptics.releaseIntensity, CONFIG.haptics.releaseDurationMs);
    g.sample('whoosh', { gain: 0.5 }) || g.sfx.whoosh(d.speed * 0.5);
    this.path.length = 0; this.shotOffered = true;
    g.say('release', { type: d.name.split(' ')[0].replace('off-break', 'off_spin').replace('leg-break', 'leg_spin').replace('outswinger', 'outswing').replace('inswinger', 'inswing').replace('seam-up', 'fast'), length: d.fullToss ? 'full_toss' : d.length < 2 ? 'yorker' : d.length > 11 ? 'bouncer' : undefined, pace: d.paceKmh });
    this.launchT = g.world.time;
    // Where it would pass the stumps (for the one-line summary at the bounce).
    try { const c = crossingAtZ(predict(g.world.ball, { maxTime: 2.5, h: 1 / 240 }), PITCH.battingStumpsZ); this.atStumps = c ? { x: c.x, y: c.y } : null; } catch { this.atStumps = null; }
    this.state = 'live';
    this.hit = null; this.byes = null; this.firstBounce = null; this.adjusted = false; this.crossedCrease = false; this.wide = false; this.beamerChecked = false;
    this.stumpAt = 0; this.pendingRes = null; this.reviewFlow = null;
    // Overstepping: your head is past the popping crease as you let go.
    this.noBall = false;
    this.freeHit = !!(this.innings && this.innings.freeHit);
    if (this.innings && g.input.xr && g.input.headPose.p.z > bowlingPoppingZ + CONFIG.match.overstep) this.callNoBall('overstepped — stay behind the line');
    if (d.note) g.ui.prompt(d.note, 2.6, '#ffb347');
    this.keeperUp = this.bowler.spinner;                   // the keeper stands up to the spinners
    // AI reads the ball. Each batter in the order has their own ability.
    const diff = g.settings.difficulty;
    const card = this.innings && this.innings.card;
    const prof = card && card.onStrike ? batProfile(card.onStrike.position) : null;
    g.aiBatter.setProfile(diff, prof);
    g.aiBatter.aggression = clamp(this.aggressionNow() + (prof ? prof.aggr : 0) + (this.freeHit ? 0.4 : 0), 0.05, 1);
    const plan = g.aiBatter.planDelivery(g.world.ball.clone(), g.world.time, g.rng, { charge: (CONFIG.ai.charge[diff] ?? 0.4) * (prof ? prof.charge : 1) * (this.freeHit ? 1.3 : 1) });
    if (plan.adv) { g.say('charge'); g.ui.prompt('He comes down the pitch!', 1.2, '#ffd34d'); }
    if (this.field) { if (!this.field.delivering) this.field.beginDelivery(); this.field.released(); }
    g.aimMarker.visible = false;
    const run = this.run.enabled ? ` · run-up ${this.run.best.toFixed(1)} m/s (pace ×${this.run.paceFactor.toFixed(2)})` : '';
    g.ui.setHud({ big: `${Math.round(d.paceKmh)} km/h · ${d.name}`, bigColor: '#ffffff', last: `${cap(d.name)}${d.spinAmount ? ` · ${Math.round(d.spinAmount * 100)}% spin` : ''}${run}`, detail: '' });
    if (d.paceKmh > this.stats.fastest) this.stats.fastest = d.paceKmh;
    if (g.bowlCalibPending) this.calibSamples.push(d.elevDeg);
  }

  callNoBall(why) {
    const g = this.game;
    if (this.noBall || !this.innings) return;
    this.noBall = true;
    g.umpires.signal('noball', g.clock);
    g.ui.prompt(`NO BALL — ${why}`, 2.6, '#ffb347');
    g.sample('umpire_not_out', { gain: 0.6 });
  }

  // Close run-outs go to the third umpire. Returns true if the result waits for the verdict.
  upstairs(res) {
    const g = this.game, lim = CONFIG.match.thirdUmpire;
    let margin = null;
    if (res.kind === 'runout' && res.margin < lim) margin = res.margin;
    else if (res.kind === 'runs' && res.closeCall != null && res.closeCall < lim * 0.8) {
      margin = -res.closeCall;
      const end = res.end || 'batting';
      if (this.field) this.field.breakStumps(end, g.simTime, 0.05);
    }
    if (margin == null) return false;
    this.pendingRes = res; this.reviewFlow = this.third; this.state = 'review';
    this.third.start({ kind: 'run_out', end: res.end || 'batting', margin, out: res.kind === 'runout' });
    return true;
  }

  aggressionNow() {
    const inn = this.innings;
    if (!inn || inn.target == null) return this.baseAggression;
    const need = inn.runsNeeded, balls = Math.max(1, inn.ballsLeft);
    const rate = need / balls;                 // runs per ball required
    const wk = inn.wicketsLimit - inn.wickets;
    let a = clamp(0.15 + rate * 0.35, 0.1, 0.95);
    if (wk <= 1) a *= 0.75;
    return a;
  }

  // ------------------------------------------------------------- per frame
  update(dt, t) {
    const g = this.game;
    if (this.done) return;
    const L = g.input.left;
    if (this.state !== 'live' && (g.settings.aimMarker || g.settings.aimAssist) && (Math.abs(L.stick.x) > 0.15 || Math.abs(L.stick.y) > 0.15)) {
      this.aim.x = clamp(this.aim.x - L.stick.x * 0.8 * dt, -1.0, 1.0);
      this.aim.z = clamp(this.aim.z - L.stick.y * 3.0 * dt, -13, -0.3);
      this.updateAim();
    }
    if (this.field) this.field.update(dt, t);
    // The run-up goes on after the ball has gone (a committed run reaches the crease).
    if (this.state === 'ready' || this.state === 'live' || this.state === 'settle') this.stepRun(g.realDt || dt);
    this.updateCard();
    if (this.state === 'ready') {
      if (this.field && this.runStarted() && !this.field.delivering) this.field.beginDelivery();
      // Ball sits in the hand.
      const R = g.input.right;
      if (R.connected) {
        _hold.set(...CONFIG.bowling.ballHoldOffset).applyQuat(R.gripPose.q).add(R.gripPose.p);
        g.ballView.setVisible(true);
        g.ballView.update(_hold, 0, null, false);
        // Show the seam the way it is being held (upright, or angled for swing).
        if (!this.bowler.spinner) { const a = this.seam * 0.25, sn = Math.sin(a) * S2, cs = Math.cos(a) * S2; g.ballView.mesh.quaternion.set(sn, sn, cs, cs); }
      }
    } else if (this.state === 'live') {
      this.checkLive(t);
    } else if (this.state === 'review') {
      const flow = this.reviewFlow || this.lbw;
      flow.update(g.realDt || dt);
      if (flow.done) {
        const res = flow === this.lbw ? (this.lbw.out ? { kind: 'lbw' } : { kind: 'dot', padded: true }) : this.pendingRes;
        this.reviewFlow = null;
        this.finish(res);
      }
    } else if (this.state === 'settle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.innings && this.innings.complete) { this.complete(); return; }
        if (this.field) { this.field.reset(); this.field.setSpinner(this.keeperUp); }
        this.state = 'ready';
        g.world.removeBall();
        g.aiBatter.reset();
        if (this.innings && this.innings.freeHit) {
          g.umpires.signal('freehit', g.clock);
          g.ui.prompt('FREE HIT — only a run-out counts', 3.5, '#ffd34d');
        } else if (this.innings && this.innings.thisOver.length === 0 && this.innings.legal > 0) {
          g.ui.prompt(`New over · ${this.bowler.label}`, 2.5, '#ffd34d');
          this.chooseBowler();
        }
        this.seamYaw = 0; this.holding = false;
        this.toMark();
        this.resetEnds();
        this.updateAim();
        g.ui.setHud({ big: 'Your ball', bigColor: '#ffd34d', last: this.howTo() });
      }
    }
  }

  checkLive(t) {
    const g = this.game, b = g.world.ball;
    if (b.active && !b.batted) this.path.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && (Math.abs(b.pos.x) > PITCH.wideLineX || b.pos.y > CONFIG.match.wideHeight)) this.wide = true;   // too wide, or over his head
    }
    const plan = g.aiBatter.plan;
    // A full toss above the waist is a no-ball.
    if (!b.batted && b.bounces === 0 && !this.beamerChecked && b.pos.z > (plan && plan.C ? plan.C.z - 0.3 : battingPoppingZ)) {
      this.beamerChecked = true;
      if (b.pos.y > CONFIG.match.beamerHeight) this.callNoBall('full toss above the waist');
    }
    // Gone past a batter who came down the pitch: he scrambles back.
    if (!b.batted && plan && plan.adv && plan.C && b.pos.z > plan.C.z + 0.35) g.aiBatter.retreat(t);
    // Beaten the bat and struck the pad: appeal.
    if (!this.hit && plan && plan.C && plan.shot.type !== 'pull' && plan.shot.type !== 'cut') {
      const body = g.aiBatter.bodyAt(t);
      if (padHit(b, plan.C.x - 0.14, body.z - 0.2)) {
        const impact = b.clone();
        deflectOffPad(b, g.rng);
        if (this.noBall || this.freeHit) { this.finish({ kind: 'dot', padded: true }); return; }
        this.state = 'review';
        this.lbw.start({ impactState: impact, path: this.path.slice(), shotOffered: plan.shot.type !== 'leave', playerIsBatter: false });
        return;
      }
    }
    if (this.field && (b.batted || this.byes)) {
      const res = this.field.result();
      if (res) { if (!this.upstairs(res)) this.finish(res); return; }
      if (t - this.launchT > 20) this.finish({ kind: 'runs', runs: g.runs.completed });
      return;
    }
    // Not hit. What happens next is whatever the ball and the keeper really do.
    if (!b.batted && this.field) {
      if (this.field.keeperHold) {
        // He has it: out of his ground, the batter can be stumped (or thrown out from where the keeper stands back).
        if (!this.stumpAt) {
          if (g.aiBatter.advanceAt(t) <= 0.2) { this.finish({ kind: 'dot' }); return; }
          this.stumpAt = this.field.keeperAttack(t);
          return;
        }
        if (t < this.stumpAt) return;
        const atk = this.field.attack, margin = g.aiBatter.advanceAt(t) - 0.5, lim = CONFIG.match.thirdUmpire;   // m short of his ground
        if (atk.kind === 'shy' && !atk.hit) { this.finish({ kind: 'dot', shyMissed: true }); return; }
        if (atk.kind === 'break') this.field.breakStumps('batting', t, 0);
        const res = margin <= 0 ? { kind: 'dot', backInTime: true }
          : atk.kind === 'break' ? { kind: 'stumped' } : { kind: 'runout', runs: 0, margin, end: 'batting', who: 'striker' };
        if (Math.abs(margin) < lim) {
          this.pendingRes = res; this.reviewFlow = this.third; this.state = 'review';
          this.third.start({ kind: atk.kind === 'break' ? 'stumping' : 'run_out', end: 'batting', margin, out: margin > 0 });
        } else this.finish(res);
        return;
      }
      // It beat the keeper as well: byes.
      if (this.field.keeperMissed && b.active) { this.startByes(t); return; }
    } else if (!b.batted && b.pos.z > 2.4) {                           // nets: past the stumps
      this.finish({ kind: 'dot' });
      return;
    }
    if (b.batted && !this.field) {
      if (b.stopped || groundDistance(b.pos.x, b.pos.z) > 95 || t - this.hit.t > 6 || (b.crossedBoundary && t - this.hit.t > 1.2)) {
        this.finish(this.estimateRuns(b));
        return;
      }
    }
    if (t - this.launchT > 10) this.finish({ kind: b.batted ? 'runs' : 'dot', runs: 0 });
  }

  // The ball has gone past the bat and the keeper: it is in play, like a hit.
  startByes(t) {
    const g = this.game, b = g.world.ball;
    this.byes = { t };
    this.field.onHit(b, t, predict(b, { maxTime: 9, h: 1 / 240 }), { byes: true });
    g.ui.prompt(this.wide ? 'Wide — and past the keeper!' : 'Past the keeper — byes!', 2.2, '#ffb347');
    g.crowdReact('close');
  }

  // Without fielders (bowling nets): estimate runs from where the ball went.
  estimateRuns(b) {
    if (b.crossedBoundary) return { kind: 'boundary', runs: this.hit && this.hit.sixOnFull ? 6 : 4 };
    const d = Math.hypot(b.pos.x, b.pos.z + 1.2);
    return { kind: 'runs', runs: d < 18 ? 0 : d < 35 ? 1 : d < 52 ? 2 : 3 };
  }

  onEvent(e) {
    const g = this.game;
    if (this.state !== 'live' && this.state !== 'settle') return;
    if (e.type === 'bounce' && !e.batted && !this.firstBounce) {
      this.firstBounce = e.pos.clone();
      g.aiBatter.adjust(g.world.ball.clone(), g.world.time);
      g.ui.setHud({ last: `Pitched: ${lengthName(-e.pos.z)} (${(-e.pos.z).toFixed(1)} m) · ${lineName(e.pos.x)} · moved ${e.deviationDeg.toFixed(1)}°` });
      // What you bowled and where it went, near the middle of your view.
      const d = this.delivery;
      if (d) {
        const len = lengthName(PITCH.battingStumpsZ - e.pos.z);
        g.ui.prompt(`${cap(d.name)} · ${Math.round(d.paceKmh)} km/h\n${len === 'good' ? 'good length' : len} · ${stumpLine(this.atStumps)}`, 2.4, '#ffffff');
      }
    }
    if (e.type === 'bat' && e.batId === 'ai' && !this.hit) {
      const pred = predict(g.world.ball, { maxTime: 8, h: 1 / 240 });
      this.hit = { t: e.t, quality: e.quality, edge: e.isEdge, exit: e.speedOut, sixOnFull: !!(pred.boundary && pred.boundary.onFull), pred };
      if (e.isEdge) { this.stats.edges++; g.ui.setHud({ big: 'Edged!', bigColor: '#ff9f43' }); g.crowdReact('edge'); }
      else if (e.vel.y > 7 && e.speedOut > 20) g.crowdReact('skied');
      const v = g.world.ball.vel;
      g.say('hit', { shot: plan0(g), edge: e.isEdge, top_edge: e.isEdge && v.y > 6, speed: v.length(), vel: { x: v.x, y: v.y, z: v.z } });
      if (this.field) this.field.onHit(g.world.ball, e.t, pred);
    }
    if (e.type === 'wicket' && e.end === 'batting' && this.state === 'live' && (!this.field || !this.field.fielded) && (!this.hit || e.t - this.hit.t < 0.6)) this.finish({ kind: 'bowled', wicket: 'bowled' });
    if (e.type === 'boundary' && (e.batted || this.byes)) {
      g.cheer(e.onFull && e.batted ? 1 : 0.7);
      if (this.hit) this.hit.sixOnFull = e.onFull;
      if (this.field) this.field.onBoundary(e);
    }
  }

  finish(res) {
    const g = this.game;
    if (this.state === 'settle') return;
    if (this.field) this.field.endDelivery();
    this.state = 'settle';
    this.timer = this.kind === 'bowlnets' ? 2.4 : 3.2;
    const outcome = { runs: 0, wide: false, wicket: null, boundary: 0 };
    let big = '', color = '#ffffff';
    const now = g.clock;
    switch (res.kind) {
      case 'bowled': big = 'BOWLED HIM!'; color = '#7dff8a'; outcome.wicket = 'bowled'; break;
      case 'caught': big = res.by === 'you' ? 'CAUGHT — great hands!' : `CAUGHT${res.by ? ' — ' + res.by : ''}!`; color = '#7dff8a'; outcome.wicket = 'caught'; break;
      case 'lbw': big = 'LBW — OUT!'; color = '#7dff8a'; outcome.wicket = 'lbw'; break;
      case 'stumped': big = 'STUMPED!'; color = '#7dff8a'; outcome.wicket = 'stumped'; break;
      case 'runout': big = `RUN OUT! (${res.margin.toFixed(1)} m short)`; color = '#7dff8a'; outcome.wicket = 'run out'; outcome.runs = res.runs; break;
      case 'boundary': big = res.runs === 6 ? 'Six…' : 'Four…'; color = '#ff8080'; outcome.runs = res.runs; outcome.boundary = res.runs; break;
      case 'runs': big = res.runs ? `${res.runs} run${res.runs > 1 ? 's' : ''}` : 'Dot ball'; outcome.runs = res.runs || 0; break;
      default:
        big = res.padded ? 'Not out' : res.backInTime ? 'Not out — back in time' : res.shyMissed ? 'Keeper misses the stumps' : this.hit ? 'Dot ball' : (g.aiBatter.plan && g.aiBatter.plan.shot.type === 'leave' ? 'Left alone' : 'Beaten!');
        if (!this.hit && g.aiBatter.plan && g.aiBatter.plan.shot.type !== 'leave') this.stats.beaten++;
    }
    outcome.who = res.who; outcome.fielder = res.by === 'you' ? 'You' : res.by;
    // A no-ball or a free hit: only a run-out counts.
    if (outcome.wicket && !Innings.canDismiss(outcome.wicket, { noBall: this.noBall, freeHit: this.freeHit })) {
      big = `NOT OUT — ${this.noBall ? 'no-ball' : 'free hit'}`; color = '#ffb347'; outcome.wicket = null;
    }
    // Byes: runs off a ball that was not hit are extras.
    if (this.byes && !outcome.wicket) {
      outcome.byes = true; outcome.boundary = 0;
      big = res.kind === 'boundary' ? 'Four byes' : outcome.runs ? `${outcome.runs} bye${outcome.runs > 1 ? 's' : ''}` : 'No run'; color = '#ffb347';
      if (outcome.runs) g.umpires.signal('bye', now);
    }
    if (this.noBall) { outcome.noBall = true; if (!outcome.wicket && !outcome.boundary) big = `No-ball${outcome.runs ? ` + ${outcome.runs}` : ''}`; }
    else if (this.wide && !this.hit && !outcome.wicket) { outcome.wide = true; big = outcome.runs ? `Wide + ${outcome.runs}` : 'Wide'; color = '#ffb347'; g.umpires.signal('wide', now); }
    if (outcome.boundary) {
      g.umpires.signal(outcome.boundary === 6 ? 'six' : 'four', now);
      g.crowdReact('boundaryAgainst');
      g.say('boundary', { runs: outcome.boundary });
    } else if (outcome.wicket) {
      if (res.kind !== 'lbw') g.umpires.signal('out', now);
      g.crowdReact('wicketFor'); g.cheer(0.9);
      if (res.kind === 'caught') g.say('catch', { keeper: res.by === 'Keeper' });
      else if (res.kind === 'runout') g.say('run_out');
      else if (res.kind === 'stumped') g.say('third_result', { what: 'stumping', out: true });
      g.say('wicket', { how: res.kind === 'runout' ? 'run_out' : res.kind });
    }
    const extra = outcome.wide || outcome.noBall;
    if (!outcome.wicket && !outcome.boundary) {
      if (res.backInTime || res.padded) g.crowdReact('close');
      else if (!this.hit && g.aiBatter.plan && g.aiBatter.plan.shot.type !== 'leave') g.crowdReact('beaten');
      else if (!outcome.runs) g.crowdReact('dot');
    }
    this.stats.balls += extra ? 0 : 1;
    this.stats.runs += outcome.runs + (extra ? 1 : 0);
    if (outcome.wicket) this.stats.wickets++;
    if (!outcome.runs && !extra && !outcome.wicket) this.stats.dots++;
    if (this.innings) {
      if (this.innings.card) this.innings.card.setBowler('You');
      const r = this.innings.record(outcome);
      if (r.overDone) big += ' · over';
      this.cardNews(r.card);
      this.partnership = outcome.wicket ? 0 : this.partnership + outcome.runs;
      this.dots = outcome.runs || extra ? 0 : this.dots + 1;
      const inn = this.innings;
      g.commentary.situation = { runs: inn.runs, wickets: inn.wickets, balls: inn.legal, ballsLimit: inn.ballsLimit, target: inn.target, wicketsLimit: inn.wicketsLimit, partnershipRuns: this.partnership, dotsInRow: this.dots, battingIsPlayer: false };
      const pl = g.aiBatter.plan;
      if (!this.hit && !outcome.wicket && pl) g.say('swing', { result: pl.shot.duck ? 'duck' : pl.shot.type === 'leave' ? 'leave' : 'miss', shot: pl.shot.type, short: pl.info && pl.info.yb > 1.3 });
      g.say('ball', { runs: outcome.runs, wide: outcome.wide, boundary: outcome.boundary, wicket: outcome.wicket, overDone: r.overDone });
    }
    g.ui.setHud({ big, bigColor: color });
    if (outcome.wicket || outcome.boundary) g.ui.prompt(big, 2.4, color);
    this.updateHud();
    if (g.bowlCalibPending && this.calibSamples.length >= g.bowlCalibPending) this.finishReleaseCalibration();
  }

  // New batter / milestone announcements from the scorecard.
  cardNews(c) {
    const g = this.game;
    if (!c) return;
    for (const m of c.milestones) { g.ui.prompt(`${m.name} reaches ${m.runs}`, 2.5, '#ffd34d'); g.sample('applause_warm', { gain: 0.6 }); }
    if (c.newBatter && !this.innings.complete) {
      const prof = batProfile(c.newBatter.position);
      g.ui.setHud({ detail: `New batter: ${c.newBatter.name} (${prof.role})` });
    }
  }

  finishReleaseCalibration() {
    const g = this.game;
    const s = this.calibSamples;
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    g.settings.bowlNeutralElevDeg = Math.round(mean * 10) / 10;
    g.bowlCalibPending = 0;
    g.saveSettings();
    g.ui.setHud({ big: 'Release calibrated', bigColor: '#7dff8a', detail: `Neutral release elevation ${g.settings.bowlNeutralElevDeg}° (from ${s.length} balls)` });
  }

  updateHud() {
    const g = this.game, s = this.stats;
    const sw = `${this.bowler.label}${this.bowler.spinner ? '' : ' · ' + this.seamText()}`;
    let score, sub;
    if (this.innings) {
      score = `${this.innings.scoreText}  (${this.innings.overs})`;
      sub = this.innings.target != null
        ? `Defend: they need ${this.innings.runsNeeded} off ${this.innings.ballsLeft} · ${sw}`
        : `Conceded ${this.innings.runs} · ${this.innings.wickets} wkt · ${sw}`;
      const card = this.innings.card;
      g.ui.setBoard([this.title.toUpperCase(), score, card ? card.pairText() : sub.split(' · ').slice(0, 1).join(''), card ? `${card.bowlerText()}   ·   ${this.innings.thisOver.join(' ') || '-'}` : `This over: ${this.innings.thisOver.join(' ') || '-'}`]);
      g.ui.setHud({ players: card ? `${card.pairText()}${this.innings.freeHit ? '   ·   FREE HIT' : ''}` : '' });
    } else {
      g.ui.setHud({ players: '' });
      score = `${s.runs}/${s.wickets} (${Math.floor(s.balls / 6)}.${s.balls % 6})`;
      sub = `${sw} · difficulty ${g.settings.difficulty}${g.bowlCalibPending ? ` · calibrating release ${this.calibSamples.length}/${g.bowlCalibPending}` : ''}`;
      g.ui.setBoard(['BOWLING NETS', score, `Dots ${s.dots} · beaten ${s.beaten} · edges ${s.edges}`, `Fastest ${Math.round(s.fastest)} km/h`]);
    }
    g.ui.setHud({ title: this.title, score, sub, footer: this.footer() });
  }

  onSettingsChanged() {
    if (this.state === 'ready' && !this.runStarted() && this.run && this.run.enabled !== !!this.game.settings.runUp) this.toMark();
    this.updateAim(); this.updateHud();
    this.game.ui.setHud({ last: this.howTo() });
  }

  // The delivery card: while you stand at your mark waiting to bowl.
  updateCard() {
    const g = this.game, b = this.bowler, s = g.settings;
    const show = this.state === 'ready' && !this.runStarted();
    if (!show) { if (this.cardKey) { this.cardKey = ''; g.ui.setBowlCard(null); } return; }
    const len = lengthName(PITCH.battingStumpsZ - this.aim.z);
    const target = `${len === 'good' ? 'good length' : len} · ${lineName(this.aim.x)}`;
    const sel = this.choice;
    const key = [b.key, sel, target, s.bowlByFeel, s.runUp, s.aimMarker || s.aimAssist, g.input.xr].join('|');
    if (key === this.cardKey) return;
    this.cardKey = key;
    g.ui.setBowlCard({
      title: b.label, pace: `${b.pace[0]}–${b.pace[1]} km/h`, byFeel: s.bowlByFeel, runUp: s.runUp,
      list: b.deliveryList.map((d) => ({ label: d.label, sel: !s.bowlByFeel && d.key === sel })),
      effect: s.bowlByFeel ? 'By feel: your wrist action decides the delivery' : deliveryInfo(b, sel).effect,
      target: s.aimMarker || s.aimAssist ? target : 'where you throw it',
    });
  }

  complete() {
    this.done = true;
    if (this.onDone) this.onDone(this.innings);
  }

  backingUp() { return (this.state === 'ready' && this.runStarted()) || (this.state === 'live' && !this.game.world.ball.batted); }

  updateViews() { /* batters are updated by the game */ }
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
// Where the ball passes the batter's stumps, in words (off side = +x for a right-hander).
function stumpLine(c) {
  if (!c) return '';
  const half = PITCH.wicketHalfWidth + CONFIG.ball.radius;
  if (Math.abs(c.x) <= half) return c.y > PITCH.stumpHeight + 0.1 ? 'over the stumps' : 'hitting the stumps';
  const cm = Math.round((Math.abs(c.x) - PITCH.wicketHalfWidth) * 100);
  return `${cm} cm outside ${c.x > 0 ? 'off' : 'leg'}`;
}

function plan0(g) { const p = g.aiBatter.plan; return p ? p.shot.type : 'drive'; }
