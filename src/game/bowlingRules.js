// Bowling-session rules that need no rendering (pure JS, tested in node):
// the wide call, whether the fielders appeal for LBW, and how the ball in your
// hand fades near your eyes.
import { CONFIG } from '../config.js';
import { PITCH } from '../physics/pitch.js';
import { clamp } from '../physics/math.js';
import { lbwDecision, isMarginal } from './lbw.js';

// The ball in your hand, drawn at true size: fully there beyond heldBallFade[1]
// m from the eyes, gone nearer than heldBallFade[0] (a hand at the face must not
// put a giant ball in front of the eyes or inside the near clip).
export function heldBallAlpha(ball, eye, cfg = CONFIG) {
  const [n, f] = cfg.bowling.heldBallFade;
  const d = Math.hypot(ball.x - eye.x, ball.y - eye.y, ball.z - eye.z);
  return clamp((d - n) / (f - n), 0, 1);
}

// Wide (limited-overs guideline): the ball passes the popping crease beyond the
// wide line on either side, or over head height. The line is measured from
// middle stump with the batter in his stance; if he moves across, it moves with
// him (shiftX = how far he moved, + toward off), so he cannot make it a wide by
// walking away from it, nor a fair ball by stepping across.
export function isWide(x, y, shiftX = 0, cfg = CONFIG) {
  const off = PITCH.wideLineX + Math.max(0, shiftX), leg = -PITCH.wideLineX + Math.min(0, shiftX);
  return x > off || x < leg || y > cfg.match.wideHeight;
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
