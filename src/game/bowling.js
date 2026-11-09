// Bowling session: the player bowls from the bowler's end to the AI batter.
// Hold trigger (ball in hand), swing overarm, release trigger.
import { CONFIG } from '../config.js';
import { Vec3, Quat, clamp, msToKmh, DEG } from '../physics/math.js';
import { PITCH, lengthName, lineName, groundDistance, battingPoppingZ } from '../physics/pitch.js';
import { predict } from '../physics/trajectory.js';
import { playerDelivery } from './bowlingInput.js';

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
  }

  enter() {
    const g = this.game;
    g.setEnd('bowling');
    g.machine.setVisible(false);
    g.machine.setCue(0);
    g.aiBatter.setDifficulty(g.settings.difficulty);
    g.aiBatter.reset();
    g.aiBat.enabled = true;
    g.batterView.show(true);
    if (this.field) this.field.enter();
    this.resetEnds();
    this.updateAim();
    this.updateHud();
    g.ui.setHud({ big: 'Your ball', bigColor: '#ffd34d', last: this.howTo(), detail: '' });
  }

  exit() {
    const g = this.game;
    g.aiBat.enabled = false;
    g.batterView.show(false);
    g.aimMarker.visible = false;
    if (this.field) this.field.exit();
  }

  howTo() {
    return this.game.input.xr
      ? 'Hold TRIGGER, bowl overarm, let go to release. A out-swing · B in-swing · roll wrist to spin'
      : 'Hold mouse, sweep top→bottom, release. Z/X swing · Q/E spin · arrows aim · B auto-bowl';
  }

  footer() {
    return this.game.input.xr ? 'Left stick: move aim marker · Y: menu · hold left grip: recenter' : 'Arrows: aim · B: auto-bowl · Esc: menu · C: camera';
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
    if (R.buttons.a.down) { this.swingChoice = this.swingChoice === 1 ? 0 : 1; this.updateHud(); R.pulse(0.15, 15); }
    if (R.buttons.b.down) { this.swingChoice = this.swingChoice === -1 ? 0 : -1; this.updateHud(); R.pulse(0.15, 15); }
    if (this.state === 'ready') {
      if (R.buttons.trigger.down) { this.holding = true; this.game.sfx.ui(); }
      if (this.holding && R.buttons.trigger.up) this.attemptRelease();
      if (!input.xr && D.took('KeyB')) this.autoBowl();
    }
    if (L.buttons.a.down && this.state === 'settle') this.timer = 0;
  }

  attemptRelease() {
    const g = this.game, R = g.input.right;
    this.holding = false;
    // Use the velocity at release unless the hand clearly peaked just before
    // (a late trigger release) — then the peak sample is the "real" release.
    const last = R.history[R.history.length - 1];
    let pk = R.peak(g.simTime, CONFIG.bowling.peakWindowMs / 1000);
    if (last && pk && pk.v.length() < last.v.length() * 1.12) pk = last;
    if (!pk || pk.v.length() < CONFIG.bowling.minReleaseHandSpeed) {
      g.ui.setHud({ big: 'Dropped — swing harder', bigColor: '#ffb347' });
      return;
    }
    const pos = R.gripPose.p.clone().add(new Vec3(...CONFIG.bowling.ballHoldOffset).applyQuat(R.gripPose.q));
    this.bowl({ releasePos: pos, handVel: pk.v.clone(), handAngVel: pk.w.clone() });
  }

  // Desktop helper: a clean release at the marker with the machine pace.
  autoBowl() {
    const g = this.game, D = g.input.desktop;
    const rel = new Vec3(0.5, 2.05, -18.95);
    const kmh = g.settings.machine.paceKmh;
    const speed = kmh / 3.6 / CONFIG.bowling.paceMultiplier;
    const el = (this.neutralElev() ?? CONFIG.bowling.neutralElevationDeg) * DEG;
    const az = Math.atan2(this.aim.x - rel.x, this.aim.z - rel.z);
    const v = new Vec3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).scale(speed);
    const roll = (D.held('KeyQ') ? 1 : 0) - (D.held('KeyE') ? 1 : 0);
    const w = new Vec3(Math.sin(az), 0, Math.cos(az)).scale(roll * 30);
    this.bowl({ releasePos: rel, handVel: v, handAngVel: w });
  }

  neutralElev() { return typeof this.game.settings.bowlNeutralElevDeg === 'number' ? this.game.settings.bowlNeutralElevDeg : null; }

  bowl({ releasePos, handVel, handAngVel }) {
    const g = this.game;
    const d = playerDelivery({
      releasePos, handVel, handAngVel,
      swingChoice: this.swingChoice,
      aim: g.settings.aimAssist ? this.aim : null,
      assist: g.settings.aimAssist,
      neutralElevDeg: this.neutralElev(),
      rng: g.rng,
    });
    this.delivery = d;
    this.resetEnds();
    g.world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg, seamRandomScale: 0.5 });
    g.ballView.setVisible(true);
    g.ballView.clearTrail();
    g.input.right.pulse(CONFIG.haptics.releaseIntensity, CONFIG.haptics.releaseDurationMs);
    g.sfx.whoosh(d.speed * 0.5);
    this.launchT = g.world.time;
    this.state = 'live';
    this.hit = null; this.firstBounce = null; this.adjusted = false; this.crossedCrease = false; this.wide = false;
    // AI reads the ball.
    g.aiBatter.aggression = this.aggressionNow();
    g.aiBatter.planDelivery(g.world.ball.clone(), g.world.time, g.rng);
    if (this.field) this.field.reset();
    g.aimMarker.visible = false;
    const spinTxt = d.spinType !== 'none' ? ` · ${d.spinType}-spin ${Math.round(d.spinAmount * 100)}%` : d.swing ? (d.swing > 0 ? ' · out-swing' : ' · in-swing') : '';
    g.ui.setHud({ big: `${Math.round(d.paceKmh)} km/h`, bigColor: '#ffffff', last: `Released${spinTxt}`, detail: `hand ${d.handSpeed.toFixed(1)} m/s · elev ${d.elevDeg.toFixed(0)}° · az ${d.azDeg.toFixed(1)}° · roll ${d.roll.toFixed(0)} rad/s` });
    if (d.paceKmh > this.stats.fastest) this.stats.fastest = d.paceKmh;
    if (g.bowlCalibPending) this.calibSamples.push(d.elevDeg);
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
    if (this.state !== 'live' && (Math.abs(L.stick.x) > 0.15 || Math.abs(L.stick.y) > 0.15)) {
      this.aim.x = clamp(this.aim.x - L.stick.x * 0.8 * dt, -1.0, 1.0);
      this.aim.z = clamp(this.aim.z - L.stick.y * 3.0 * dt, -13, -0.3);
      this.updateAim();
    }
    if (this.state === 'ready') {
      // Ball sits in the hand.
      const R = g.input.right;
      if (R.connected) {
        const p = R.gripPose.p.clone().add(new Vec3(...CONFIG.bowling.ballHoldOffset).applyQuat(R.gripPose.q));
        g.ballView.setVisible(true);
        g.ballView.update(p, 0, null, false);
      }
    } else if (this.state === 'live') {
      this.checkLive(t);
      if (this.field) this.field.update(dt, t);
    } else if (this.state === 'settle') {
      if (this.field) this.field.update(dt, t);
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.innings && this.innings.complete) { this.complete(); return; }
        this.state = 'ready';
        g.world.removeBall();
        g.aiBatter.reset();
        this.resetEnds();
        this.updateAim();
        g.ui.setHud({ big: 'Your ball', bigColor: '#ffd34d', last: this.howTo() });
      }
    }
  }

  checkLive(t) {
    const g = this.game, b = g.world.ball;
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && Math.abs(b.pos.x) > PITCH.wideLineX) this.wide = true;
    }
    if (this.field && b.batted) {
      const res = this.field.result();
      if (res) { this.finish(res); return; }
      if (t - this.launchT > 14) this.finish({ kind: 'runs', runs: 0 });
      return;
    }
    if (!b.batted && b.pos.z > 2.4) {
      if (this.field) this.field.keeperTakes(b);
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
    }
    if (e.type === 'bat' && e.batId === 'ai' && !this.hit) {
      const pred = predict(g.world.ball, { maxTime: 8 });
      this.hit = { t: e.t, quality: e.quality, edge: e.isEdge, exit: e.speedOut, sixOnFull: !!(pred.boundary && pred.boundary.onFull), pred };
      if (e.isEdge) { this.stats.edges++; g.ui.setHud({ big: 'Edged!', bigColor: '#ff9f43' }); }
      if (this.field) this.field.onHit(g.world.ball, e.t, pred);
    }
    if (e.type === 'wicket' && e.end === 'batting' && (!this.field || !this.field.fielded)) this.finish({ kind: 'bowled', wicket: 'bowled' });
    if (e.type === 'boundary' && e.batted) {
      g.cheer(e.onFull ? 1 : 0.7);
      if (this.hit) this.hit.sixOnFull = e.onFull;
      if (this.field) this.field.onBoundary(e);
    }
  }

  finish(res) {
    const g = this.game;
    if (this.state === 'settle') return;
    this.state = 'settle';
    this.timer = this.kind === 'bowlnets' ? 2.4 : 3.0;
    const outcome = { runs: 0, wide: false, wicket: null, boundary: 0 };
    let big = '', color = '#ffffff';
    switch (res.kind) {
      case 'bowled': big = 'BOWLED HIM!'; color = '#7dff8a'; outcome.wicket = 'bowled'; g.cheer(0.9); break;
      case 'caught': big = `CAUGHT${res.by ? ' — ' + res.by : ''}!`; color = '#7dff8a'; outcome.wicket = 'caught'; g.cheer(0.9); break;
      case 'boundary': big = res.runs === 6 ? 'Six…' : 'Four…'; color = '#ff8080'; outcome.runs = res.runs; outcome.boundary = res.runs; break;
      case 'runs': big = res.runs ? `${res.runs} run${res.runs > 1 ? 's' : ''}` : 'Dot ball'; outcome.runs = res.runs || 0; break;
      default:
        big = this.hit ? 'Dot ball' : (g.aiBatter.plan && g.aiBatter.plan.shot.type === 'leave' ? 'Left alone' : 'Beaten!');
        if (!this.hit && g.aiBatter.plan && g.aiBatter.plan.shot.type !== 'leave') this.stats.beaten++;
    }
    if (this.wide && !this.hit && !outcome.wicket) { outcome.wide = true; big = 'Wide'; color = '#ffb347'; }
    this.stats.balls += outcome.wide ? 0 : 1;
    this.stats.runs += outcome.runs + (outcome.wide ? 1 : 0);
    if (outcome.wicket) this.stats.wickets++;
    if (!outcome.runs && !outcome.wide && !outcome.wicket) this.stats.dots++;
    if (this.innings) {
      const r = this.innings.record(outcome);
      if (r.overDone) big += ' · over';
    }
    g.ui.setHud({ big, bigColor: color });
    this.updateHud();
    if (g.bowlCalibPending && this.calibSamples.length >= g.bowlCalibPending) this.finishReleaseCalibration();
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
    const sw = this.swingChoice === 1 ? 'OUT-swing' : this.swingChoice === -1 ? 'IN-swing' : 'no swing';
    let score, sub;
    if (this.innings) {
      score = `${this.innings.scoreText}  (${this.innings.overs})`;
      sub = this.innings.target != null
        ? `Defend: they need ${this.innings.runsNeeded} off ${this.innings.ballsLeft} · ${sw}`
        : `Conceded ${this.innings.runs} · ${this.innings.wickets} wkt · ${sw}`;
      g.ui.setBoard([this.title.toUpperCase(), score, sub.split(' · ').slice(0, 1).join(''), `This over: ${this.innings.thisOver.join(' ') || '-'}`]);
    } else {
      score = `${s.runs}/${s.wickets} (${Math.floor(s.balls / 6)}.${s.balls % 6})`;
      sub = `${sw} · difficulty ${g.settings.difficulty}${g.bowlCalibPending ? ` · calibrating release ${this.calibSamples.length}/${g.bowlCalibPending}` : ''}`;
      g.ui.setBoard(['BOWLING NETS', score, `Dots ${s.dots} · beaten ${s.beaten} · edges ${s.edges}`, `Fastest ${Math.round(s.fastest)} km/h`]);
    }
    g.ui.setHud({ title: this.title, score, sub, footer: this.footer() });
  }

  onSettingsChanged() { this.updateAim(); this.updateHud(); }

  complete() {
    this.done = true;
    if (this.onDone) this.onDone(this.innings);
  }

  updateViews(dt, paused) {
    const g = this.game;
    g.batterView.update(paused ? g.simTime : g.simTime);
  }
}
