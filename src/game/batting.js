// Batting session: the player bats against the bowling machine (nets) or the
// AI bowler (run chase / match), optionally with fielders and an innings.
import { CONFIG } from '../config.js';
import { Vec3, msToKmh, clamp } from '../physics/math.js';
import { PITCH, lengthName, lineName, groundDistance, battingPoppingZ } from '../physics/pitch.js';
import { machineDelivery } from '../physics/bowlingMachine.js';
import { predict } from '../physics/trajectory.js';

const KMH = (v) => Math.round(msToKmh(v));

export class BattingSession {
  constructor(game, { kind = 'nets', title = 'Nets · Batting', innings = null, bowler = 'machine', fielders = null, aiBowler = null, onDone = null } = {}) {
    this.game = game;
    this.kind = kind;
    this.title = title;
    this.innings = innings;
    this.bowler = bowler;          // 'machine' | 'ai'
    this.field = fielders;         // Fielding controller or null
    this.aiBowler = aiBowler;      // AIBowler (picks deliveries) or null
    this.bowlerFig = null;         // BowlerFigure view (ai)
    this.onDone = onDone;
    this.isBowling = false;
    this.state = 'idle';
    this.timer = 1.2;
    this.stats = { balls: 0, fours: 0, sixes: 0, middled: 0, edges: 0, bowled: 0, bestCarry: 0 };
    this.lastText = '';
    this.done = false;
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
    g.nonStriker.visible = !!this.innings;
    if (this.field) this.field.enter();
    this.resetEnds();
    this.updateHud();
  }

  exit() {
    const g = this.game;
    g.machine.setCue(0);
    if (this.bowlerFig) this.bowlerFig.show(false);
    if (this.field) this.field.exit();
    g.nonStriker.visible = false;
  }

  footer() {
    return this.game.input.xr ? 'X: next ball · Y: menu · hold left grip: recenter' : 'Mouse: bat · Space: next ball · Esc: menu · C: camera';
  }

  resetEnds() {
    const g = this.game;
    g.stumps.batting.reset(); g.stumps.bowling.reset();
    g.world.resetWickets();
  }

  handleInput(input) {
    if (input.left.buttons.a.down) this.requestNext();
  }

  requestNext() {
    if (this.state === 'idle' || this.state === 'settle') { this.state = 'idle'; this.timer = 0; }
  }

  autoNext() { return this.kind !== 'nets' || this.game.settings.autoFeed; }

  // ------------------------------------------------------------- per frame
  update(dt, t) {
    const g = this.game;
    if (this.done) return;
    if (this.state === 'idle') {
      if (this.autoNext() || this.timer <= 0) this.timer -= dt;
      if (this.timer <= 0) this.prepare(t);
    } else if (this.state === 'cue') {
      const el = t - this.cueStart, cd = CONFIG.machine.countdownSec;
      const stage = el < cd / 2 ? 1 : el < cd ? 2 : 3;
      if (stage !== this.cueStage) { this.cueStage = stage; g.machine.setCue(stage); g.sfx.beep(stage); }
      if (el >= cd) this.release(t);
    } else if (this.state === 'runup') {
      if (this.bowlerFig.update(dt, t)) this.release(t);
    } else if (this.state === 'live') {
      this.checkLive(t);
    } else if (this.state === 'settle') {
      this.timer -= dt;
      if (this.field) this.field.update(dt, t);
      if (this.timer <= 0) {
        g.machine.setCue(0);
        if (this.innings && this.innings.complete) { this.complete(); return; }
        this.state = 'idle';
        this.timer = this.autoNext() ? 0.3 : 1e9;
        if (!this.autoNext()) this.timer = 1e9;
      }
    }
    if (this.state === 'live' && this.field) this.field.update(dt, t);
    if (this.bowlerFig && this.state !== 'runup') this.bowlerFig.update(dt, t);
  }

  prepare(t) {
    const g = this.game;
    this.resetEnds();
    g.ballView.setVisible(false);
    g.ballView.clearTrail();
    g.world.removeBall();
    const settings = this.aiBowler ? this.aiBowler.next(this.innings) : g.settings.machine;
    this.delivery = machineDelivery(settings, g.rng);
    this.hit = null; this.firstBounce = null; this.wide = false; this.crossedCrease = false;
    this.maxBatSpeedNear = 0;
    if (this.field) this.field.reset();
    if (this.bowler === 'machine') {
      g.machine.setRelease(settings.release || 'over');
      this.state = 'cue';
      this.cueStart = t;
      this.cueStage = 0;
    } else {
      this.state = 'runup';
      this.bowlerFig.startRunup(t, this.delivery.releasePos);
    }
    if (this.aiBowler) this.game.ui.setHud({ sub: this.aiBowler.describe(settings) });
  }

  release(t) {
    const g = this.game, d = this.delivery;
    g.world.launch({ pos: d.releasePos, vel: d.vel, spin: d.spin, swing: d.swing, seamDeg: d.seamDeg });
    g.ballView.setVisible(true);
    g.ballView.mesh.quaternion.identity();
    this.launchT = t;
    this.state = 'live';
    g.sfx.whoosh(d.vel.length() * 0.4);
  }

  checkLive(t) {
    const g = this.game, b = g.world.ball;
    // Track bat speed while the ball is near the batter (play-and-miss vs leave).
    if (!b.batted && b.pos.z > -3 && b.pos.z < 0.5) {
      this.maxBatSpeedNear = Math.max(this.maxBatSpeedNear, g.input.right.linVel.length());
    }
    // Wide (only counted in innings).
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && Math.abs(b.pos.x) > PITCH.wideLineX) this.wide = true;
    }
    if (this.field && b.batted) {
      const res = this.field.result();
      if (res) { this.finish(res); return; }
      if (t - this.launchT > 14) this.finish({ kind: 'hit', runs: 0 });
      return;
    }
    if (!b.batted && b.pos.z > 2.4) {
      if (this.field) this.field.keeperTakes(b);
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
    if (t - this.launchT > 10) this.finish({ kind: b.batted ? 'hit' : 'left' });
  }

  netsHitResult(b) {
    const h = this.hit;
    if (b.crossedBoundary) return { kind: 'boundary', runs: h.sixOnFull ? 6 : 4 };
    return { kind: 'hit', runs: 0 };
  }

  onEvent(e) {
    const g = this.game;
    if (this.state !== 'live' && this.state !== 'settle') return;
    if (e.type === 'bounce' && !e.batted && !this.firstBounce) this.firstBounce = e.pos.clone();
    if (e.type === 'bat' && e.batId === 'player' && !this.hit) {
      const b = g.world.ball;
      const pred = predict(b, { maxTime: 8, h: 1 / 240 });
      const land = pred.bounces[0];
      const carry = land ? Math.hypot(land.pos.x - b.pos.x, land.pos.z - b.pos.z) : 0;
      const v = e.vel;
      const launch = Math.atan2(v.y, Math.hypot(v.x, v.z)) / (Math.PI / 180);
      this.hit = {
        t: e.t, quality: e.quality, edge: e.isEdge, exit: e.speedOut, batSpeed: e.batSpeed, launch, carry,
        sixOnFull: !!(pred.boundary && pred.boundary.onFull),
        pred,
      };
      if (e.isEdge) this.stats.edges++; else if (e.quality > 0.75) this.stats.middled++;
      const qual = e.isEdge ? 'EDGE' : e.quality > 0.85 ? 'MIDDLED' : e.quality > 0.5 ? 'good contact' : 'mistimed';
      g.ui.setHud({ big: qual, bigColor: e.isEdge ? '#ff9f43' : e.quality > 0.85 ? '#7dff8a' : '#ffffff', detail: this.shotDetail() });
      if (this.field) this.field.onHit(b, e.t, pred);
      if (!e.isEdge && e.quality > 0.8 && e.speedOut > 30) g.cheer(0.3);
    }
    if (e.type === 'wicket' && e.end === 'batting') {
      if (!this.field || !this.field.fielded) this.finish({ kind: 'bowled', wicket: 'bowled' });
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
    return `Exit ${KMH(h.exit)} km/h · ${Math.round(h.launch)}° · bat ${h.batSpeed.toFixed(1)} m/s · sweet ${Math.round(h.quality * 100)}%\nCarry ${Math.round(h.carry)} m`;
  }

  // ------------------------------------------------------------- results
  finish(res) {
    const g = this.game;
    if (this.state === 'settle') return;
    this.state = 'settle';
    this.timer = this.kind === 'nets' ? CONFIG.machine.autoFeedDelay : 2.6;
    const d = this.delivery;
    this.stats.balls++;
    const len = this.firstBounce ? -this.firstBounce.z : -1;
    const ballText = `Ball: ${Math.round(d.paceKmh)} km/h · ${lengthName(len)}${len > 0 ? ` (${len.toFixed(1)} m)` : ''} · ${lineName(d.line)}`;

    let big = '', color = '#ffffff';
    const outcome = { runs: 0, wide: false, wicket: null, boundary: 0 };
    switch (res.kind) {
      case 'bowled':
        big = 'BOWLED!'; color = '#ff5a5a'; outcome.wicket = 'bowled'; this.stats.bowled++;
        g.sfx.groan();
        break;
      case 'caught':
        big = `CAUGHT${res.by ? ' — ' + res.by : ''}!`; color = '#ff5a5a'; outcome.wicket = 'caught';
        break;
      case 'boundary':
        big = res.runs === 6 ? 'SIX!' : 'FOUR!'; color = res.runs === 6 ? '#ff6bd6' : '#4dd2ff';
        outcome.runs = res.runs; outcome.boundary = res.runs;
        if (res.runs === 6) this.stats.sixes++; else this.stats.fours++;
        break;
      case 'runs':
        big = res.runs === 0 ? 'Dot ball' : `${res.runs} run${res.runs > 1 ? 's' : ''}`;
        outcome.runs = res.runs;
        break;
      case 'beaten':
        big = 'Beaten!'; color = '#ffb347';
        break;
      case 'left':
        big = 'Left alone';
        break;
      default:
        big = this.hit ? `Carried ${Math.round(this.hit.carry)} m` : 'Dot ball';
    }
    if (this.wide && !this.hit && !outcome.wicket && this.innings) { outcome.wide = true; big = 'Wide'; }
    if (this.hit && res.kind === 'hit' && this.hit.carry > this.stats.bestCarry) this.stats.bestCarry = this.hit.carry;

    if (this.innings) {
      const r = this.innings.record(outcome);
      if (r.overDone) big += '  · over';
    }
    g.ui.setHud({ big, bigColor: color, last: ballText, detail: this.shotDetail() || (res.kind === 'beaten' ? 'Played and missed' : '') });
    this.updateHud();
  }

  updateHud() {
    const g = this.game;
    let score, sub;
    if (this.innings) {
      score = `${this.innings.scoreText}  (${this.innings.overs})`;
      sub = this.innings.target != null ? `Need ${this.innings.runsNeeded} off ${this.innings.ballsLeft} · ${this.innings.wicketsLimit - this.innings.wickets} wkts left` : `${this.innings.ballsLeft} balls left`;
      g.ui.setBoard([this.title.toUpperCase(), score, sub, `This over: ${this.innings.thisOver.join(' ') || '-'}`]);
    } else {
      const s = this.stats;
      score = `${s.balls} balls`;
      const m = g.settings.machine;
      sub = `Machine: ${Math.round(m.paceKmh)} km/h · ${lengthName(m.length)} · ${lineName(m.line)}${m.swing ? (m.swing > 0 ? ' · out-swing' : ' · in-swing') : ''}${m.seam ? ' · seam' : ''}${m.spinType !== 'none' ? ` · ${m.spinType}-spin` : ''}`;
      g.ui.setBoard(['NETS', `${s.balls} balls · ${s.fours}×4 · ${s.sixes}×6`, `Middled ${s.middled} · edges ${s.edges} · bowled ${s.bowled}`, `Best carry ${Math.round(s.bestCarry)} m`]);
    }
    g.ui.setHud({ title: this.title, score, sub: this.aiBowler ? g.ui.hudData.sub : sub, footer: this.footer() });
  }

  onSettingsChanged() { this.updateHud(); }

  complete() {
    this.done = true;
    if (this.onDone) this.onDone(this.innings);
  }
}
