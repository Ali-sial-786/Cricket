// Bowling-session rules that need no rendering (pure JS, tested in node):
// the wide call, the bouncer limit, whether the fielders appeal for LBW, and how the ball in your
// hand fades near your eyes.
import { CONFIG } from '../config.js';
import { PITCH } from '../physics/pitch.js';
import { clamp, hypot3 } from '../physics/math.js';
import { lbwDecision, isMarginal } from './lbw.js';

// The ball in your hand, drawn at true size: fully there beyond heldBallFade[1]
// m from the eyes, gone nearer than heldBallFade[0] (a hand at the face must not
// put a giant ball in front of the eyes or inside the near clip).
export function heldBallAlpha(ball, eye, cfg = CONFIG) {
  const [n, f] = cfg.bowling.heldBallFade;
  const d = hypot3(ball.x - eye.x, ball.y - eye.y, ball.z - eye.z);
  return clamp((d - n) / (f - n), 0, 1);
}

// Wide (ICC men's ODI/T20I playing conditions 22, as from 1 Oct 2026): the
// ball passes the popping crease beyond the off-side guideline (wideLineX), or
// down the leg side outside the protected-area marker line (legWideX: between
// leg stump and that line is no wide), or over the head of the striker standing
// upright at the popping crease (head, m). Lines are from middle stump with the
// batter in his guard; if he moves across they move with him (shiftX = how far
// he moved, + toward off), so he cannot make it a wide by walking away from it,
// nor a fair ball by stepping across. (Not a wide if it hits bat or person: the
// callers, Law 22.3.)
export function isWide(x, y, { shiftX = 0, head = CONFIG.match.batterHeight } = {}) {
  const off = PITCH.wideLineX + Math.max(0, shiftX), leg = -PITCH.legWideX + Math.min(0, shiftX);
  return x > off || x < leg || y > head;
}

// The striker standing upright: head and shoulder heights (m). eye: your
// standing eye height from the headset (null: the standard figure).
export function strikerHeights(eye = null, cfg = CONFIG) {
  const head = eye ? eye + 0.11 : cfg.match.batterHeight;
  return { head, shoulder: head * cfg.match.shoulderFrac };
}

// A fast short-pitched ball (ICC 41.6): pitched, and passes (or would have
// passed) the popping crease above the striker's shoulder. Spinners exempt.
export function isShortPitched({ bounced, y, shoulder, spinner = false }) {
  return !!bounced && !spinner && y > shoulder;
}

// Fast short-pitched balls in the over (ICC T20I 41.6: one allowed; one over
// head height, called wide, still counts). add() -> { n, noBall }.
export class BouncerCount {
  constructor(limit = CONFIG.match.bouncersPerOver) { this.limit = limit; this.over = -1; this.n = 0; }
  count(over) { return over === this.over ? this.n : 0; }
  add(over) {
    if (over !== this.over) { this.over = over; this.n = 0; }
    this.n++;
    return { n: this.n, noBall: this.n > this.limit };
  }
  reset() { this.over = -1; this.n = 0; }
}

// What the umpire tells bowler and striker (null: nothing to say).
export function bouncerCall({ n, noBall }, limit = CONFIG.match.bouncersPerOver) {
  if (noBall) return 'too many bouncers in the over';
  return n === limit ? (limit === 1 ? "Bouncer — that's the one for the over" : `Bouncer — that's ${limit} for the over`) : `Bouncer — ${n} of ${limit} for the over`;
}

// Is an LBW shout worth making? Not when the Law already says not out clearly:
// pitched outside leg, hit outside the line playing a shot, or missing (unless
// it is close enough to be the umpire's call).
export function shouldAppeal(track, { shotOffered = true } = {}) {
  if (!track) return true;
  if (lbwDecision(track, { shotOffered }) !== 'not_out') return true;
  if (track.pitching === 'outside_leg' && !track.fullToss) return false;
  if (track.impact === 'outside_leg' || (track.impact === 'outside_off' && shotOffered)) return false;
  return isMarginal(track);                       // missing, but only just: the bowler still goes up
}
