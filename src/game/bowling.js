// Bowling session: the player bowls from the bowler's end to the AI batter.
// Hold trigger (ball in hand), swing overarm, release trigger.
import { CONFIG } from '../config.js';
import { Vec3, clamp, DEG } from '../physics/math.js';

const _hold = new Vec3();
import { PITCH, lengthName, lineName, groundDistance, battingPoppingZ } from '../physics/pitch.js';
import { predict } from '../physics/trajectory.js';
import { playerDelivery } from './bowlingInput.js';
import { LbwFlow, padHit, deflectOffPad } from './lbwFlow.js';

const _palm = new Vec3();

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
    this.path = [];
    this.partnership = 0; this.dots = 0;
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
    g.nonStrikerView.reset();
    g.umpires.place(true);
    g.umpires.show(!!this.field);
    if (this.field) this.field.enter();
    if (this.innings) { g.say('toss', { choice: 'bowl' }); g.say('innings', { chase: this.innings.target != null }); }
    g.ui.prompt(g.input.xr ? 'Hold TRIGGER, bowl overarm, let go' : 'Hold the mouse, sweep down, let go  (B: auto-bowl)', 6);
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
    g.nonStrikerView.show(false);
    g.umpires.show(false);
    g.drs.hide();
    g.timeScaleTarget = 1;
    g.ballOverride = null;
  }

  howTo() {
    return this.game.input.xr
      ? 'Trigger: hold + bowl + let go · early = full, late = short · roll wrist = spin · A/B swing'
      : 'Mouse: hold, sweep down, release · B auto-bowl · Q/E spin (+F back of hand) · Z/X swing';
  }

  footer() {
    return this.game.input.xr ? 'Left stick: aim marker · stick click: menu · A/B: throw end, review' : 'Arrows: aim · B: auto-bowl · Z/X: throw end / review · Esc: menu';
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
      if (R.buttons.a.down) { this.swingChoice = this.swingChoice === 1 ? 0 : 1; this.updateHud(); R.pulse(0.15, 15); }
      if (R.buttons.b.down) { this.swingChoice = this.swingChoice === -1 ? 0 : -1; this.updateHud(); R.pulse(0.15, 15); }
      if (R.buttons.trigger.down) { this.holding = true; this.game.sfx.ui(); }
      if (this.holding && R.buttons.trigger.up) this.attemptRelease();
      if (!input.xr && D.took('KeyB')) this.autoBowl();
    }
    if (L.buttons.a.down && this.state === 'settle') this.timer = 0;
    if (!R.connected || R.tracked === false) this.holding = false;
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
    this.bowl({ releasePos: pos, handVel: pk.v.clone(), handAngVel: pk.w.clone(), palmDir: g.palmDir(_palm).clone() });
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
    const dirv = new Vec3(Math.sin(az), 0, Math.cos(az));
    this.bowl({ releasePos: rel, handVel: v, handAngVel: w, palmDir: D.held('KeyF') ? dirv.scale(-1) : dirv });
  }

  neutralElev() { return typeof this.game.settings.bowlNeutralElevDeg === 'number' ? this.game.settings.bowlNeutralElevDeg : null; }

  bowl({ releasePos, handVel, handAngVel, palmDir = null }) {
    const g = this.game;
    const d = playerDelivery({
      releasePos, handVel, handAngVel, palmDir,
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
    g.sample('whoosh', { gain: 0.5 }) || g.sfx.whoosh(d.speed * 0.5);
    this.path.length = 0; this.shotOffered = true;
    g.say('release', { type: d.name.split(' ')[0].replace('off-break', 'off_spin').replace('leg-break', 'leg_spin').replace('outswinger', 'outswing').replace('inswinger', 'inswing').replace('seam-up', 'fast'), length: d.fullToss ? 'full_toss' : d.length < 2 ? 'yorker' : d.length > 11 ? 'bouncer' : undefined, pace: d.paceKmh });
    this.launchT = g.world.time;
    this.state = 'live';
    this.hit = null; this.firstBounce = null; this.adjusted = false; this.crossedCrease = false; this.wide = false;
    // AI reads the ball.
    g.aiBatter.aggression = this.aggressionNow();
    g.aiBatter.planDelivery(g.world.ball.clone(), g.world.time, g.rng);
    if (this.field) { if (!this.field.delivering) this.field.beginDelivery(); this.field.released(); }
    g.aimMarker.visible = false;
    g.ui.setHud({ big: `${Math.round(d.paceKmh)} km/h · ${d.name}`, bigColor: '#ffffff', last: `Released: ${d.name}${d.spinAmount ? ` (${Math.round(d.spinAmount * 100)}% spin${d.backOfHand ? ', back of the hand' : ''})` : ''}`, detail: `hand ${d.handSpeed.toFixed(1)} m/s · elev ${d.elevDeg.toFixed(0)}° · az ${d.azDeg.toFixed(1)}° · roll ${d.roll.toFixed(0)} rad/s` });
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
    if (this.field) this.field.update(dt, t);
    if (this.state === 'ready') {
      if (this.field && this.holding && !this.field.delivering) this.field.beginDelivery();
      // Ball sits in the hand.
      const R = g.input.right;
      if (R.connected) {
        _hold.set(...CONFIG.bowling.ballHoldOffset).applyQuat(R.gripPose.q).add(R.gripPose.p);
        g.ballView.setVisible(true);
        g.ballView.update(_hold, 0, null, false);
      }
    } else if (this.state === 'live') {
      this.checkLive(t);
    } else if (this.state === 'review') {
      this.lbw.update(g.realDt || dt);
      if (this.lbw.done) this.finish(this.lbw.out ? { kind: 'lbw' } : { kind: 'dot', padded: true });
    } else if (this.state === 'settle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.innings && this.innings.complete) { this.complete(); return; }
        if (this.field) this.field.reset();
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
    if (b.active && !b.batted) this.path.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z });
    if (!this.crossedCrease && b.pos.z > battingPoppingZ) {
      this.crossedCrease = true;
      if (!b.batted && Math.abs(b.pos.x) > PITCH.wideLineX) this.wide = true;
    }
    // Beaten the bat and struck the pad: appeal.
    const plan = g.aiBatter.plan;
    if (!this.hit && plan && plan.C && plan.shot.type !== 'pull' && plan.shot.type !== 'cut') {
      const body = g.aiBatter.bodyAt(t);
      if (padHit(b, plan.C.x - 0.14, body.z - 0.2)) {
        const impact = b.clone();
        deflectOffPad(b, g.rng);
        this.state = 'review';
        this.lbw.start({ impactState: impact, path: this.path.slice(), shotOffered: plan.shot.type !== 'leave', playerIsBatter: false });
        return;
      }
    }
    if (this.field && b.batted) {
      const res = this.field.result();
      if (res) { this.finish(res); return; }
      if (t - this.launchT > 20) this.finish({ kind: 'runs', runs: g.runs.completed });
      return;
    }
    if (!b.batted && (b.pos.z > 2.4 || (this.field && this.field.keeperHold))) {
      if (this.field && !this.field.keeperHold) this.field.keeperTakes(b);
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
      const pred = predict(g.world.ball, { maxTime: 8, h: 1 / 240 });
      this.hit = { t: e.t, quality: e.quality, edge: e.isEdge, exit: e.speedOut, sixOnFull: !!(pred.boundary && pred.boundary.onFull), pred };
      if (e.isEdge) { this.stats.edges++; g.ui.setHud({ big: 'Edged!', bigColor: '#ff9f43' }); }
      const v = g.world.ball.vel;
      g.say('hit', { shot: plan0(g), edge: e.isEdge, top_edge: e.isEdge && v.y > 6, speed: v.length(), vel: { x: v.x, y: v.y, z: v.z } });
      if (this.field) this.field.onHit(g.world.ball, e.t, pred);
    }
    if (e.type === 'wicket' && e.end === 'batting' && this.state === 'live' && (!this.field || !this.field.fielded) && (!this.hit || e.t - this.hit.t < 0.6)) this.finish({ kind: 'bowled', wicket: 'bowled' });
    if (e.type === 'boundary' && e.batted) {
      g.cheer(e.onFull ? 1 : 0.7);
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
      case 'runout': big = `RUN OUT! (${res.margin.toFixed(1)} m short)`; color = '#7dff8a'; outcome.wicket = 'run out'; outcome.runs = res.runs; break;
      case 'boundary': big = res.runs === 6 ? 'Six…' : 'Four…'; color = '#ff8080'; outcome.runs = res.runs; outcome.boundary = res.runs; break;
      case 'runs': big = res.runs ? `${res.runs} run${res.runs > 1 ? 's' : ''}` : 'Dot ball'; outcome.runs = res.runs || 0; break;
      default:
        big = res.padded ? 'Not out' : this.hit ? 'Dot ball' : (g.aiBatter.plan && g.aiBatter.plan.shot.type === 'leave' ? 'Left alone' : 'Beaten!');
        if (!this.hit && g.aiBatter.plan && g.aiBatter.plan.shot.type !== 'leave') this.stats.beaten++;
    }
    if (this.wide && !this.hit && !outcome.wicket) { outcome.wide = true; big = 'Wide'; color = '#ffb347'; g.umpires.signal('wide', now); }
    if (outcome.boundary) {
      g.umpires.signal(outcome.boundary === 6 ? 'six' : 'four', now);
      g.sample(outcome.boundary === 6 ? 'roar_six' : 'cheer_four', { gain: 0.7 });
      g.say('boundary', { runs: outcome.boundary });
    } else if (outcome.wicket) {
      if (res.kind !== 'lbw') g.umpires.signal('out', now);
      g.sample('roar_wicket'); g.cheer(0.9);
      if (res.kind === 'caught') g.say('catch', { keeper: res.by === 'Keeper' });
      else if (res.kind === 'runout') g.say('run_out');
      g.say('wicket', { how: res.kind === 'runout' ? 'run_out' : res.kind });
    }
    this.stats.balls += outcome.wide ? 0 : 1;
    this.stats.runs += outcome.runs + (outcome.wide ? 1 : 0);
    if (outcome.wicket) this.stats.wickets++;
    if (!outcome.runs && !outcome.wide && !outcome.wicket) this.stats.dots++;
    if (this.innings) {
      const r = this.innings.record(outcome);
      if (r.overDone) big += ' · over';
      this.partnership = outcome.wicket ? 0 : this.partnership + outcome.runs;
      this.dots = outcome.runs || outcome.wide ? 0 : this.dots + 1;
      const inn = this.innings;
      g.commentary.situation = { runs: inn.runs, wickets: inn.wickets, balls: inn.legal, ballsLimit: inn.ballsLimit, target: inn.target, wicketsLimit: inn.wicketsLimit, partnershipRuns: this.partnership, dotsInRow: this.dots, battingIsPlayer: false };
      g.say('ball', { runs: outcome.runs, wide: outcome.wide, boundary: outcome.boundary, wicket: outcome.wicket, overDone: r.overDone });
    }
    g.ui.setHud({ big, bigColor: color });
    if (outcome.wicket || outcome.boundary) g.ui.prompt(big, 2.4, color);
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

  backingUp() { return this.holding || (this.state === 'live' && !this.game.world.ball.batted); }

  updateViews() { /* batters are updated by the game */ }
}

function plan0(g) { const p = g.aiBatter.plan; return p ? p.shot.type : 'drive'; }
