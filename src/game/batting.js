// Batting session: the player bats against the bowling machine (nets) or an
// AI bowling attack (run chase / match) with fielders, umpires and an innings.
//
// Controls (XR / desktop):
//   right trigger / Shift   stride down the pitch (more power, harder to time)
//   right grip / S          sweep (swing toward the off side = reverse sweep;
//                           with the trigger too = slog sweep)
//   left stick / arrows     move in the crease
//   X / Space               RUN (and "next ball" in the nets)
//   left trigger / G        turn back mid-run        Y / V   dive for the line
//   A / Z                   review an LBW decision
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { Vec3, msToKmh, clamp } from '../physics/math.js';
import { PITCH, lengthName, lineName, groundDistance, battingPoppingZ } from '../physics/pitch.js';
import { machineDelivery } from '../physics/bowlingMachine.js';
import { predict } from '../physics/trajectory.js';
import { LbwFlow, padHit, deflectOffPad } from './lbwFlow.js';
import { ThirdUmpireFlow } from './thirdUmpire.js';
import { HINTS } from '../ui/controllerHint.js';

const _fw = new Vec3(), _toe = new Vec3();
const PLAYER_PAD = { halfX: 0.15, front: 0.1, back: 0.26, top: 0.7 };
import { Innings } from './scoring.js';

const KMH = (v) => Math.round(msToKmh(v));
const _hand = new THREE.Vector3();
const STANCE = { x: -0.4, z: -1.05 };

export class BattingSession {
  constructor(game, { kind = 'nets', title = 'Nets · Batting', innings = null, bowler = 'machine', fielders = null, aiBowler = null, onDone = null } = {}) {
    this.game = game;
    this.kind = kind;
    this.title = title;
    this.innings = innings;
    this.bowler = bowler;          // 'machine' | 'ai'
    this.field = fielders;         // FieldController or null
    this.aiBowler = aiBowler;
    this.bowlerFig = null;
    this.onDone = onDone;
    this.isBowling = false;
    this.state = 'idle';
    this.timer = 1.2;
    this.stats = { balls: 0, fours: 0, sixes: 0, middled: 0, edges: 0, bowled: 0, bestCarry: 0 };
    this.done = false;
    this.crease = { x: 0, z: 0 };
    this.advance = 0;
    this.reviews = { player: CONFIG.match.reviews, ai: CONFIG.match.reviews };
    this.lbw = new LbwFlow(game, this.reviews);
    this.third = new ThirdUmpireFlow(game);
    this.reviewFlow = null; this.pendingRes = null;
    this.noBall = false; this.freeHit = false;
    this.path = [];
    this.partnership = 0;
    this.dots = 0;
  }

  enter() {
    const g = this.game;
    g.setEnd('batting');
    g.machine.setVisible(this.bowler === 'machine');
    g.machine.setRelease(g.settings.machine.release);
    g.machine.setCue(0);
    g.aimMarker.visible = false;
    if (this.bowler === 'ai' && g.figures) this.bowlerFig = g.figures.bowler;
    if (this.bowlerFig) this.bowlerFig.show(true);
    g.setTeams(true);
    g.batterView.runnerOnly = true;
    g.batterView.show(false);
    g.nonStrikerView.show(!!this.innings);
    g.nonStrikerView.reset();
    g.umpires.place(false);
    g.umpires.show(!!this.field);
    if (this.field) this.field.enter();
    this.resetEnds();
    this.updateHud();
    if (this.innings) {
      g.say('toss', { choice: this.innings.target != null ? 'bowl' : 'bat' });
      g.say('innings', { chase: this.innings.target != null });
    }
    g.coach('bat', this.field ? [HINTS.stepOut, HINTS.sweep, HINTS.move] : [HINTS.stepOut, HINTS.sweep, HINTS.next], 7);
  }

  exit() {
    const g = this.game;
    g.machine.setCue(0);
    if (this.bowlerFig) this.bowlerFig.show(false);
    if (this.field) this.field.exit();
    g.nonStrikerView.show(false);
    g.umpires.show(false);
    g.ballOverride = null;
    g.timeScaleTarget = 1;
    g.setRigOffset(0, 0);
    g.playerBat.mods = null;
    g.drs.hide();
    g.ui.setHud({ players: '' });
    g.ui.hud.mesh.visible = true;
  }

  footer() {
    if (this.game.input.xr) return this.field ? 'X run · L-trigger back · Y dive · stick click: menu' : 'X: next ball · left stick click: menu · hold left grip: recenter';
    return this.field ? 'Space run · G back · V dive · Shift step out · S sweep · Esc menu' : 'Mouse: bat · Space: next ball · Shift step out · S sweep · Esc menu';
  }

  usesY() { return !!(this.field && this.state === 'live' && this.hit); }

  resetEnds() {
    const g = this.game;
    g.stumps.batting.reset(); g.stumps.bowling.reset();
    g.world.resetWickets();
  }

  // Where the batter's legs are (for pads / the crease).
  body() {
    const g = this.game;
    if (g.input.xr) return g.input.headPose.p;
    return { x: STANCE.x + this.crease.x, z: STANCE.z + this.crease.z - this.advance };
  }

  // ------------------------------------------------------------- input (real time)
  handleInput(input) {
    const g = this.game, L = input.left, R = input.right, B = CONFIG.bat, dt = g.realDt || 0.016;
    const preBall = this.state === 'cue' || this.state === 'runup' || (this.state === 'live' && !this.hit && !g.world.ball.padded);
    // Move in the crease with the left stick.
    // Stick forward = the way your left controller points (you stand side-on).
    if (Math.abs(L.stick.x) > 0.15 || Math.abs(L.stick.y) > 0.15) {
      let fx = 0, fz = -1;
      if (input.xr && L.connected) {
        _fw.set(0, 0, -1).applyQuat(L.rayPose.q);
        if (Math.hypot(_fw.x, _fw.z) > 0.2) { const n = Math.hypot(_fw.x, _fw.z); fx = _fw.x / n; fz = _fw.z / n; }
      }
      const mx = fx * -L.stick.y + -fz * L.stick.x, mz = fz * -L.stick.y + fx * L.stick.x;
      this.crease.x = clamp(this.crease.x + mx * B.creaseMoveSpeed * dt, -B.creaseBox[0], B.creaseBox[0]);
      this.crease.z = clamp(this.crease.z + mz * B.creaseMoveSpeed * dt, -B.creaseBox[1], B.creaseBox[1]);
    }
    // Stride down the pitch while the trigger is held.
    const want = preBall && R.buttons.trigger.pressed ? B.advanceDistance : 0;
    if (want > 0 && this.advance === 0) g.say('charge');
    this.advance += clamp(want - this.advance, -B.advanceSpeed * dt, B.advanceSpeed * dt);
    g.setRigOffset(this.crease.x, this.crease.z - this.advance);
    const f = this.advance / B.advanceDistance;
    g.playerBat.mods = { faceLed: B.faceLed, power: 1 + B.advancePower * f, sigmaScale: 1 - B.advanceSweetShrink * f, loftPower: 0.2 * f };

    if (this.lbw.active) return;
    const run = this.field && this.state === 'live' && this.hit && !this.field.result();
    if (run) {
      const r = g.runs;
      if (L.buttons.a.down || (input.xr && !L.connected && R.buttons.a.down)) { if (this.field.callRun()) g.ui.prompt('RUN!', 1.0, '#7dff8a'); }
      if (L.buttons.trigger.down && this.field.turnBack()) g.ui.prompt('BACK!', 1.0, '#ff9f43');
      if (L.buttons.b.down && this.field.dive(g.simTime)) { g.ui.prompt('DIVE!', 0.8, '#ffd34d'); L.pulse(0.5, 40); }
      // The running controls stay up for as long as you can run.
      if (!r.running && !r.closed) g.hint(r.completed > 0 ? [HINTS.another] : [HINTS.run], 0.5);
      else if (r.running) g.hint([HINTS.back, HINTS.dive], 0.5);
    } else if (L.buttons.a.down || (input.xr && !L.connected && R.buttons.a.down)) this.requestNext();
  }

  requestNext() {
    if (this.state === 'idle' || this.state === 'settle') { this.state = 'idle'; this.timer = 0; }
  }

  autoNext() { return this.kind !== 'nets' || this.game.settings.autoFeed; }

  // ------------------------------------------------------------- per frame (game time)
  update(dt, t) {
    const g = this.game;
    if (this.done) return;
    g.timeScaleTarget = this.state === 'live' && !this.hit && !g.world.ball.padded && g.world.ball.active ? g.diff.timeScale : 1;
    if (this.state === 'idle') {
      if (this.autoNext() || this.timer <= 0) this.timer -= dt;
      this.waitField = (this.waitField || 0) + dt;
      const fieldReady = !this.field || this.field.inPosition() || this.waitField > 4;
      if (this.timer <= 0 && fieldReady) { this.waitField = 0; this.prepare(t); }
    } else if (this.state === 'cue') {
      const el = t - this.cueStart, cd = CONFIG.machine.countdownSec;
      const stage = el < cd / 2 ? 1 : el < cd ? 2 : 3;
      if (stage !== this.cueStage) { this.cueStage = stage; g.machine.setCue(stage); g.sfx.beep(stage); }
      if (el >= cd) this.release(t);
    } else if (this.state === 'runup') {
      if (this.bowlerFig.update(dt, t)) this.release(t);
      else if (this.bowlerFig.holdingBall()) { g.ballOverride = { pos: this.bowlerFig.handPos(_hand) }; g.ballView.setVisible(true); }
    } else if (this.state === 'live') {
      this.checkLive(t);
    } else if (this.state === 'review') {
      const flow = this.reviewFlow || this.lbw;
      flow.update(g.realDt || dt);
      if (flow.done) {
        const res = flow === this.lbw ? (this.lbw.out ? { kind: 'lbw' } : { kind: 'beaten', padded: true }) : this.pendingRes;
        this.reviewFlow = null;
        this.finish(res);
      }
    } else if (this.state === 'settle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        g.machine.setCue(0);
        if (this.innings && this.innings.complete) { this.complete(); return; }
        this.state = 'idle';
        this.timer = this.autoNext() ? 0.3 : 1e9;
      }
    }
    if (this.field) this.field.update(dt, t);
    if (this.bowlerFig && this.state !== 'runup') this.bowlerFig.update(dt, t);
    g.umpires.setLook(g.ballView.visible ? g.ballView.mesh.position : null);
  }

  prepare(t) {
    const g = this.game;
    this.resetEnds();
    g.ballView.setVisible(false);
    g.ballView.clearTrail();
    g.world.removeBall();
    if (this.newBatter) { g.ui.setHud({ detail: `New batter in: ${this.newBatter}` }); this.newBatter = null; }
    const settings = this.aiBowler ? this.aiBowler.next(this.innings) : g.settings.machine;
    const rel = this.bowler === 'ai'
      ? new Vec3((settings.release === 'around' ? -1 : 1) * CONFIG.machine.releaseX, settings.spinner ? CONFIG.bowlerAI.releaseHeight : CONFIG.bowlerAI.releaseHeightPace, CONFIG.machine.releaseZ)
      : null;
    this.delivery = machineDelivery(settings, g.rng, CONFIG, rel);
    // The umpire and the non-striker stay out of the bowler's way.
    if (this.bowler === 'ai') {
      const side = settings.release === 'around' ? -1 : 1;
      if (this.lastSide != null && side !== this.lastSide && !settings.newBowler) g.say('wicket_side', { around: side < 0 });
      this.lastSide = side;
      g.umpires.place(false, side);
      if (this.innings) g.nonStrikerView.setSide(side);
    }
    this.settingsUsed = settings;
    this.hit = null; this.firstBounce = null; this.wide = false; this.crossedCrease = false;
    this.maxBatSpeedNear = 0; this.stumpAt = 0; this.stumpBroke = false; this.path.length = 0; this.shotName = '';
    this.pendingRes = null; this.reviewFlow = null;
    // Extras: the AI bowler oversteps now and then; the ball after a no-ball is a free hit.
    this.freeHit = !!(this.innings && this.innings.freeHit);
    this.noBall = !!(this.innings && this.bowler === 'ai' && g.rng() < (CONFIG.match.noBallChance[g.settings.difficulty] ?? 0.03));
    if (this.innings && this.innings.card && settings.bowler) this.innings.card.setBowler(settings.bowler, settings.bowlerLabel);
    if (this.freeHit) { g.umpires.signal('freehit', g.clock); g.ui.prompt('FREE HIT — you can only be run out', 3.5, '#ffd34d'); }
    if (this.field) { this.field.reset(); this.field.setSpinner(!!settings.spinner); this.field.beginDelivery(); }
    if (this.bowlerFig) this.bowlerFig.show(true);
    if (this.bowler === 'machine') {
      g.machine.setRelease(settings.release || 'over');
      this.state = 'cue';
      this.cueStart = t;
      this.cueStage = 0;
    } else {
      this.state = 'runup';
      this.bowlerFig.startRunup(t, this.delivery.releasePos, settings.runup);
      if (settings.newBowler) {
        g.say('over', { style: settings.spinner ? 'SPIN' : settings.bowlerType === 'swing' ? 'SWING' : 'FAST', balls: this.innings ? this.innings.ballsLeft : 6 });
        g.ui.prompt(`${settings.bowler} — ${settings.bowlerLabel}`, 3, '#ffd34d');
      } else g.say('runup');
    }
    if (this.aiBowler) g.ui.setHud({ sub: this.aiBowler.describe(settings) });
  }

  release(t) {
    const g = this.game, d = this.delivery, s = this.settingsUsed;
    g.world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg });
    g.ballOverride = null;
    if (this.field) this.field.released();
    g.ballView.setVisible(true);
    g.ballView.mesh.quaternion.identity();
    this.launchT = t;
    this.state = 'live';
    g.sample('whoosh', { gain: 0.5 }) || g.sfx.whoosh(d.vel.length() * 0.4);
    if (this.noBall) { g.umpires.signal('noball', g.clock); g.ui.prompt('NO BALL! Swing freely — free hit next', 2.2, '#ffb347'); g.sample('umpire_not_out', { gain: 0.6 }); }
    const len = d.length;
    g.say('release', { type: s.name && /googly|doosra|arm ball|slower|outswing|inswing/.test(s.name) ? s.name.replace('outswinger', 'outswing').replace('inswinger', 'inswing').replace(' ', '_') : s.spinType === 'off' ? 'off_spin' : s.spinType === 'leg' ? 'leg_spin' : s.bowlerType === 'swing' ? 'swing' : 'fast',
      length: len < 2 ? 'yorker' : len > 11 ? 'bouncer' : undefined, pace: d.paceKmh });
  }

  checkLive(t) {
    const g = this.game, b = g.world.ball;
    if (b.active && !b.batted) this.path.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    // Track bat speed while the ball is near the batter (play-and-miss vs leave).
    if (!b.batted && b.pos.z > -3.5 && b.pos.z < 0.5) {
      this.maxBatSpeedNear = Math.max(this.maxBatSpeedNear, g.input.right.linVel.length());
    }
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && (Math.abs(b.pos.x) > PITCH.wideLineX || b.pos.y > CONFIG.match.wideHeight)) this.wide = true;   // too wide, or over your head
    }
    // Struck on the pad: LBW appeal (match modes, not on easy).
    if (this.field && g.diff.lbwAgainstPlayer && !this.hit) {
      // Your head stands in for your legs, so the box is kept tight and sits
      // under / behind it, and the bat always gets the first go at the ball.
      const body = this.body();
      if (padHit(b, body.x, body.z, PLAYER_PAD) && g.batDistance(b.pos) > 0.3) {
        const impact = b.clone();
        deflectOffPad(b, g.rng);
        if (this.noBall || this.freeHit) { this.finish({ kind: 'beaten', padded: true }); return; }
        this.state = 'review';
        this.lbw.start({ impactState: impact, path: this.path.slice(), shotOffered: this.maxBatSpeedNear > 2, playerIsBatter: true });
        return;
      }
    }
    if (this.field && b.batted) {
      const res = this.field.result();
      if (res) { if (!this.upstairs(res)) this.finish(res); return; }
      if (t - this.launchT > 20) this.finish({ kind: 'runs', runs: g.runs.completed });
      return;
    }
    // Through to the keeper (or past the stumps in the nets).
    if (!b.batted && (b.pos.z > 2.4 || (this.field && this.field.keeperHold))) {
      if (this.field && !this.field.keeperHold) this.field.keeperTakes(b);
      const out = this.shortOfGround() > 0.07;                     // out of your ground
      if (this.field && out && !this.stumpAt) {
        this.stumpAt = t + (this.settingsUsed.spinner ? 0.3 : 0.85);
        this.field.keeperBreak(t, this.stumpAt);                    // he goes for the stumps…
        g.ui.prompt('GET BACK!', 1, '#ff5a5a');
        return;
      }
      if (this.stumpAt) {
        if (t < this.stumpAt) return;
        const margin = this.shortOfGround();                          // m short of your ground
        const lim = CONFIG.match.thirdUmpire;
        if (margin > -lim * 0.6) {                                    // the bails come off; close ones go upstairs
          if (!this.stumpBroke) { this.stumpBroke = true; this.field.breakStumps('batting', t, 0); }
          const res = margin > 0 ? { kind: 'stumped' } : { kind: 'beaten', backInTime: true };
          if (Math.abs(margin) < lim) {
            this.pendingRes = res; this.reviewFlow = this.third; this.state = 'review';
            this.third.start({ kind: 'stumping', end: 'batting', margin });
          } else this.finish(res);
          return;
        }
      }
      this.finish({ kind: this.maxBatSpeedNear > 3.5 ? 'beaten' : 'left' });
      return;
    }
    if (b.batted && !this.field) {
      const far = groundDistance(b.pos.x, b.pos.z) > 95;
      if (b.stopped || far || t - this.hit.t > 6 || (b.crossedBoundary && t - this.hit.t > 1.2)) {
        this.finish(this.netsHitResult(b));
        return;
      }
    }
    if (t - this.launchT > 12) this.finish({ kind: b.batted ? 'hit' : 'left' });
  }

  netsHitResult(b) {
    const h = this.hit;
    if (b.crossedBoundary) return { kind: 'boundary', runs: h.sixOnFull ? 6 : 4 };
    return { kind: 'hit', runs: 0 };
  }

  // Sweep / reverse sweep / slog sweep: the shot is steered square (or
  // behind square) on the side you swing to.
  applySweep(e) {
    const g = this.game, b = g.world.ball, R = g.input.right, B = CONFIG.bat;
    if (e.isEdge || e.face !== 'front') return false;
    const reverse = R.linVel.x > 0.6;                 // swinging toward the off side
    const slog = R.buttons.trigger.pressed || this.advance > 0.4;
    const q = e.quality;
    const speed = Math.min(44, (e.batSpeed * B.sweepSpeedGain + 0.3 * e.speedIn) * (0.5 + 0.5 * q) * (slog ? 1.3 : 1));
    const behind = slog ? -(0.25 + g.rng() * 0.45) : (0.1 + g.rng() * 0.5);   // radians behind square (+) / in front (-)
    const elev = slog ? 0.42 + g.rng() * 0.18 : 0.03 + g.rng() * 0.08 + (1 - q) * 0.25;
    const side = reverse ? 1 : -1;
    const ch = Math.cos(elev);
    b.vel.set(side * Math.cos(behind) * ch * speed, Math.sin(elev) * speed, Math.sin(behind) * ch * speed);
    e.vel.copy(b.vel); e.speedOut = speed;
    this.shotName = reverse ? 'reverse sweep' : slog ? 'slog sweep' : 'sweep';
    return true;
  }

  onEvent(e) {
    const g = this.game;
    if (this.state !== 'live' && this.state !== 'settle') return;
    if (e.type === 'bounce' && !e.batted && !this.firstBounce) this.firstBounce = e.pos.clone();
    if (e.type === 'bat' && e.batId === 'player' && !this.hit) {
      const b = g.world.ball;
      if (g.input.right.buttons.squeeze.pressed) this.applySweep(e);
      const pred = predict(b, { maxTime: 9, h: 1 / 240 });
      const land = pred.bounces[0];
      const carry = land ? Math.hypot(land.pos.x - b.pos.x, land.pos.z - b.pos.z) : 0;
      const v = b.vel;
      const launch = Math.atan2(v.y, Math.hypot(v.x, v.z)) / (Math.PI / 180);
      this.hit = {
        t: e.t, quality: e.quality, edge: e.isEdge, exit: v.length(), batSpeed: e.batSpeed, launch, carry,
        sixOnFull: !!(pred.boundary && pred.boundary.onFull), pred, advanced: this.advance > 0.5,
      };
      if (e.isEdge) this.stats.edges++; else if (e.quality > 0.75) this.stats.middled++;
      const qual = e.isEdge ? 'EDGE' : e.quality > 0.85 ? 'MIDDLED' : e.quality > 0.5 ? 'good contact' : 'mistimed';
      g.ui.setHud({ big: this.shotName ? `${qual} · ${this.shotName}` : qual, bigColor: e.isEdge ? '#ff9f43' : e.quality > 0.85 ? '#7dff8a' : '#ffffff', detail: this.shotDetail() });
      g.say('hit', { shot: this.shotName.includes('sweep') ? 'sweep' : launch > 20 ? 'loft' : 'drive', edge: e.isEdge, top_edge: e.isEdge && launch > 35, speed: v.length(), vel: { x: v.x, y: v.y, z: v.z } });
      if (this.field) this.field.onHit(b, e.t, pred);
      if (!e.isEdge && e.quality > 0.8 && v.length() > 30) g.cheer(0.3);
      if (e.isEdge) g.crowdReact('edge');
      else if (launch > 22 && v.length() > 22) g.crowdReact('skied');
    }
    if (e.type === 'wicket' && e.end === 'batting' && this.state === 'live') {
      if (!this.field || (!this.field.fielded && !this.hit)) this.finish({ kind: 'bowled', wicket: 'bowled' });
      else if (this.hit && !this.field.fielded && e.t - this.hit.t < 0.6) this.finish({ kind: 'bowled', wicket: 'bowled' });   // played on
    }
    if (e.type === 'boundary' && e.batted) {
      g.cheer(e.onFull ? 1 : 0.7);
      if (this.hit) this.hit.sixOnFull = e.onFull;
      if (this.field) this.field.onBoundary(e);
    }
  }

  shotDetail() {
    const h = this.hit;
    if (!h) return '';
    return `Exit ${KMH(h.exit)} km/h · ${Math.round(h.launch)}° · bat ${h.batSpeed.toFixed(1)} m/s · sweet ${Math.round(h.quality * 100)}%${h.advanced ? ' · stepped out' : ''}\nCarry ${Math.round(h.carry)} m`;
  }

  // Non-striker backs up while the ball is being bowled.
  backingUp() { return this.state === 'runup' || this.state === 'cue' || (this.state === 'live' && !this.game.world.ball.batted); }

  // How far (m) you are short of the popping crease: your body, or your bat
  // if it is grounded (the toe near the ground) behind the line — whichever is
  // better. <= 0: in your ground.
  shortOfGround() {
    const g = this.game;
    const body = battingPoppingZ - 0.05 - this.body().z;
    if (!g.input.xr && !g.input.right.connected) return body;
    const toe = g.batToe(_toe);
    const bat = toe.y < 0.25 ? battingPoppingZ - toe.z : Infinity;
    return Math.min(body, bat);
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
    g.timeScaleTarget = 1;
    this.third.start({ kind: 'run_out', end: res.end || 'batting', margin });
    return true;
  }

  // ------------------------------------------------------------- results
  finish(res) {
    const g = this.game;
    if (this.state === 'settle') return;
    if (this.field) this.field.endDelivery();
    this.state = 'settle';
    this.timer = this.kind === 'nets' ? CONFIG.machine.autoFeedDelay : 3.0;
    g.timeScaleTarget = 1;
    const d = this.delivery, s = this.settingsUsed;
    this.stats.balls++;
    const len = this.firstBounce ? -this.firstBounce.z : -1;
    const ballText = `${Math.round(d.paceKmh)} km/h${s.name ? ' · ' + s.name : ''} · ${lengthName(len)}${len > 0 ? ` (${len.toFixed(1)} m)` : ''} · ${lineName(d.line)}`;

    let big = '', color = '#ffffff';
    const outcome = { runs: 0, wide: false, wicket: null, boundary: 0 };
    const now = g.clock;
    switch (res.kind) {
      case 'bowled': big = 'BOWLED!'; color = '#ff5a5a'; outcome.wicket = 'bowled'; this.stats.bowled++; break;
      case 'caught': big = `CAUGHT${res.by ? ' — ' + res.by : ''}!`; color = '#ff5a5a'; outcome.wicket = 'caught'; break;
      case 'lbw': big = 'OUT — LBW'; color = '#ff5a5a'; outcome.wicket = 'lbw'; break;
      case 'stumped': big = 'STUMPED!'; color = '#ff5a5a'; outcome.wicket = 'stumped'; break;
      case 'runout': big = `RUN OUT! (${res.margin.toFixed(1)} m short)`; color = '#ff5a5a'; outcome.wicket = 'run out'; outcome.runs = res.runs; break;
      case 'boundary':
        big = res.runs === 6 ? 'SIX!' : 'FOUR!'; color = res.runs === 6 ? '#ff6bd6' : '#4dd2ff';
        outcome.runs = res.runs; outcome.boundary = res.runs;
        if (res.runs === 6) this.stats.sixes++; else this.stats.fours++;
        break;
      case 'runs':
        big = res.runs === 0 ? 'Dot ball' : `${res.runs} run${res.runs > 1 ? 's' : ''}`;
        if (res.closeCall != null && res.closeCall < 0.9 && res.runs > 0) big += ' — just home!';
        outcome.runs = res.runs;
        break;
      case 'beaten': big = res.padded ? 'Not out' : res.backInTime ? 'NOT OUT — back in time!' : 'Beaten!'; color = '#ffb347'; break;
      case 'left': big = 'Left alone'; break;
      default: big = this.hit ? `Carried ${Math.round(this.hit.carry)} m` : 'Dot ball';
    }
    outcome.who = res.who; outcome.fielder = res.by;
    // A no-ball or a free hit: only a run-out counts.
    if (outcome.wicket && !Innings.canDismiss(outcome.wicket, { noBall: this.noBall, freeHit: this.freeHit })) {
      big = `NOT OUT — ${this.noBall ? 'no-ball' : 'free hit'}!`; color = '#7dff8a'; outcome.wicket = null;
    }
    if (this.noBall && this.innings) { outcome.noBall = true; if (!outcome.wicket && !outcome.boundary) big = `No-ball${outcome.runs ? ` + ${outcome.runs}` : ''}`; }
    else if (this.wide && !this.hit && !outcome.wicket && this.innings) { outcome.wide = true; big = 'Wide'; g.umpires.signal('wide', now); }

    // Umpires, crowd, commentary.
    if (outcome.boundary) {
      g.umpires.signal(outcome.boundary === 6 ? 'six' : 'four', now);
      g.crowdReact(outcome.boundary === 6 ? 'six' : 'four');
      g.say('boundary', { runs: outcome.boundary });
    } else if (outcome.wicket) {
      if (res.kind !== 'lbw') g.umpires.signal('out', now);
      g.crowdReact('wicketAgainst');
      if (res.kind === 'caught') g.say('catch', { keeper: res.by === 'Keeper' });
      else if (res.kind === 'runout') g.say('run_out');
      else if (res.kind === 'stumped') g.say('third_result', { what: 'stumping', out: true });
      g.say('wicket', { how: res.kind === 'runout' ? 'run_out' : res.kind });
    } else if (outcome.runs > 0) {
      g.sample('applause_polite', { gain: 0.7 });
      if (res.closeCall != null && res.closeCall < 0.9) g.crowdReact('close');
    } else if (res.kind === 'beaten' && !res.padded && !res.backInTime) g.crowdReact(this.maxBatSpeedNear > 9 ? 'miss' : 'beaten');
    else if (res.backInTime || (res.kind === 'beaten' && res.padded)) g.crowdReact('close');
    else if (outcome.wide || outcome.noBall) { /* nothing */ } else g.crowdReact('dot');

    let overDone = false;
    if (this.innings) {
      const r = this.innings.record(outcome);
      overDone = r.overDone;
      if (overDone) big += '  · over';
      if (r.card) {
        for (const m of r.card.milestones) { g.ui.prompt(`${m.name} reaches ${m.runs}!`, 2.5, '#ffd34d'); g.crowdReact('milestone'); g.cheer(0.5); }
        if (r.card.newBatter && !this.innings.complete) this.newBatter = r.card.newBatter.name;
      }
      this.partnership = outcome.wicket ? 0 : this.partnership + outcome.runs;
      this.dots = outcome.runs || outcome.wide || outcome.noBall ? 0 : this.dots + 1;
      const inn = this.innings;
      g.commentary.situation = { runs: inn.runs, wickets: inn.wickets, balls: inn.legal, ballsLimit: inn.ballsLimit, target: inn.target, wicketsLimit: inn.wicketsLimit, partnershipRuns: this.partnership, dotsInRow: this.dots, battingIsPlayer: true };
      if (!this.hit && !outcome.wicket) g.say('swing', { result: res.kind === 'beaten' && !res.padded ? 'miss' : 'leave' });
      g.say('ball', { runs: outcome.runs, wide: outcome.wide, boundary: outcome.boundary, wicket: outcome.wicket, overDone });
    }
    if (this.hit && res.kind === 'hit' && this.hit.carry > this.stats.bestCarry) this.stats.bestCarry = this.hit.carry;
    g.ui.setHud({ big, bigColor: color, last: ballText, detail: this.shotDetail() || (res.kind === 'beaten' ? 'Played and missed' : '') });
    if (outcome.wicket || outcome.boundary) g.ui.prompt(big, 2.4, color);
    this.updateHud();
  }

  updateHud() {
    const g = this.game;
    let score, sub;
    if (this.innings) {
      const inn = this.innings;
      score = `${inn.scoreText}  (${inn.overs})`;
      sub = inn.target != null ? `Need ${inn.runsNeeded} off ${inn.ballsLeft} · ${inn.wicketsLimit - inn.wickets} wkts left` : `${inn.ballsLeft} balls left · ${inn.wicketsLimit - inn.wickets} wkts in hand`;
      const card = inn.card;
      g.ui.setBoard([this.title.toUpperCase(), score, card ? card.pairText() : sub, card && card.bowler ? `${card.bowlerText()}   ·   ${inn.thisOver.join(' ') || '-'}` : `This over: ${inn.thisOver.join(' ') || '-'}`]);
      g.ui.setHud({ title: this.title, score, sub, footer: this.footer(), players: card ? `${card.pairText()}${inn.freeHit ? '   ·   FREE HIT' : ''}` : '' });
    } else {
      const s = this.stats;
      score = `${s.balls} balls`;
      const m = g.settings.machine;
      sub = `Machine: ${Math.round(m.paceKmh)} km/h · ${lengthName(m.length)} · ${lineName(m.line)}${m.swing ? (m.swing > 0 ? ' · out-swing' : ' · in-swing') : ''}${m.seam ? ' · seam' : ''}${m.spinType !== 'none' ? ` · ${m.spinType}-spin` : ''}`;
      g.ui.setBoard(['NETS', `${s.balls} balls · ${s.fours}×4 · ${s.sixes}×6`, `Middled ${s.middled} · edges ${s.edges} · bowled ${s.bowled}`, `Best carry ${Math.round(s.bestCarry)} m`]);
      g.ui.setHud({ title: this.title, score, sub, footer: this.footer() });
    }
  }

  onSettingsChanged() { this.updateHud(); }

  complete() {
    this.done = true;
    if (this.onDone) this.onDone(this.innings);
  }
}
