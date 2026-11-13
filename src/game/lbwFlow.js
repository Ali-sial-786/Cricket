// LBW appeals, the on-field decision, and DRS reviews (shared by the batting
// and bowling sessions).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { trackLbw, umpireDecision, reviewOutcome, lawOut } from './lbw.js';

// Has an unbatted ball reached the batter's legs? (bx, bz) = where the batter stands.
export function padHit(ball, bx, bz) {
  if (!ball.active || ball.batted || ball.padded || ball.vel.z <= 0) return false;
  const p = ball.pos;
  return p.y < 0.74 && Math.abs(p.x - bx) < 0.2 && Math.abs(p.z - bz) < 0.24;
}

// Take the pace off the ball after it hits the pad.
export function deflectOffPad(ball, rng = Math.random) {
  ball.padded = true;
  ball.vel.set(ball.vel.x * 0.3 + (rng() - 0.5) * 2.5, Math.abs(ball.vel.y) * 0.3 + 0.6, -ball.vel.z * 0.12);
  ball.spin.scale(0.2);
}

const ACC = { easy: 0.8, medium: 0.86, hard: 0.92 };
const _head = new THREE.Vector3();

export class LbwFlow {
  constructor(game, reviews) {
    this.g = game;
    this.reviews = reviews;          // { player, ai } left this innings
    this.active = false;
    this.done = false;
    this.out = false;
  }

  start({ impactState, path, shotOffered, playerIsBatter }) {
    const g = this.g;
    this.track = trackLbw({ impactState, cfg: CONFIG });
    this.shotOffered = shotOffered;
    this.playerIsBatter = playerIsBatter;
    this.path = path;
    this.onFieldOut = umpireDecision(this.track, { shotOffered, rng: g.rng, accuracy: ACC[g.settings.difficulty] || 0.86 });
    this.truth = lawOut(this.track, { shotOffered });
    this.phase = 'appeal'; this.t = 0; this.active = true; this.done = false; this.reviewed = false;
    g.sample('appeal') || g.sample('howzat');
    g.sample('howzat', { gain: 0.9 });
    g.say('appeal');
    g.ui.prompt('HOWZAT?!', 1.6, '#ffd34d');
    g.sample('pad', { gain: 0.9 });
  }

  startReview(byPlayer) {
    const g = this.g;
    this.reviewed = true; this.reviewBy = byPlayer ? 'player' : 'ai';
    this.outcome = reviewOutcome(this.track, { onFieldOut: this.onFieldOut, shotOffered: this.shotOffered });
    const hp = g.input.headPose.p;
    _head.set(hp.x, hp.y, hp.z);
    g.drs.startLbw({ track: this.track, deliveryPath: this.path, onFieldOut: this.onFieldOut, outcome: this.outcome, viewerPos: _head });
    if (!this.playerIsBatter) g.drs.placeBoard(_head, { distance: 9, scale: 2.2, height: 3.4 });
    g.umpires.signal('review', g.clock);
    g.say('review');
    g.ui.prompt(byPlayer ? 'You review the decision' : 'The batter reviews', 2.5, '#7fd3ff');
    this.phase = 'review'; this.t = 0;
  }

  finish(out) {
    this.out = out; this.done = true; this.active = false;
    this.g.drs.hide();
  }

  // dt = real seconds.
  update(dt) {
    const g = this.g;
    if (!this.active) return;
    this.t += dt;
    if (this.phase === 'appeal' && this.t > 1.7) {
      g.umpires.signal(this.onFieldOut ? 'out' : 'notout', g.clock);
      g.sample(this.onFieldOut ? 'umpire_out' : 'umpire_not_out');
      g.say('lbw_call', { out: this.onFieldOut });
      g.ui.prompt(this.onFieldOut ? 'OUT — LBW' : 'NOT OUT', 2.2, this.onFieldOut ? '#ff5a5a' : '#7dff8a');
      this.phase = 'decision'; this.t = 0;
      const playerAggrieved = this.playerIsBatter ? this.onFieldOut : !this.onFieldOut;
      this.canPlayer = playerAggrieved && this.reviews.player > 0;
      this.aiWill = !playerAggrieved && this.reviews.ai > 0 && this.truth !== this.onFieldOut && g.rng() < 0.7;
    } else if (this.phase === 'decision') {
      const R = g.input.right, L = g.input.left;
      if (this.canPlayer) {
        if (this.t > 0.9) g.ui.prompt(`Press A to REVIEW (${this.reviews.player} left)`, 0.5, '#7fd3ff');
        if (this.t > 0.4 && (R.buttons.a.down || L.buttons.a.down)) { this.startReview(true); return; }
      } else if (this.aiWill && this.t > 1.4) { this.startReview(false); return; }
      if (this.t > (this.canPlayer ? 4.5 : this.aiWill ? 2 : 1.8)) this.finish(this.onFieldOut);
    } else if (this.phase === 'review') {
      g.drs.update(dt);
      for (const cue of g.drs.takeCues()) {
        if (cue === 'stinger') g.sample('drs_stinger');
        else if (cue.startsWith('chime')) g.sample('chime', { gain: 0.8 });
        else if (cue === 'out') g.sample('umpire_out');
        else if (cue === 'not_out') g.sample('umpire_not_out');
      }
      if (g.drs.done) {
        const r = g.drs.result;
        if (!r.reviewKept) this.reviews[this.reviewBy] = Math.max(0, this.reviews[this.reviewBy] - 1);
        g.say('review_result', { overturned: r.out !== this.onFieldOut, umpires_call: r.umpiresCall });
        g.umpires.signal(r.out ? 'out' : 'notout', g.clock);
        g.ui.prompt(r.out ? 'DECISION: OUT' : 'DECISION: NOT OUT', 2.5, r.out ? '#ff5a5a' : '#7dff8a');
        this.finalOut = r.out;
        this.phase = 'final'; this.t = 0;
      }
    } else if (this.phase === 'final' && this.t > 2.2) {
      this.finish(this.finalOut);
    }
  }
}
