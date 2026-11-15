// Skip to the next ball. Once the ball is dead - its result is up, its replay
// is playing, the field is walking back between balls - one fresh press of
// the off-hand trigger (the hand without the bat / the ball: Replay.skipHand;
// N on a monitor) skips the rest: the result's wait, the replay and the walk
// backs. The view goes down to dark (SKIP.out s), everyone is stood where the
// next ball needs him while it is dark (the session's skipToNext), and it
// comes back in (SKIP.in s) with the next delivery about to start: batting,
// the bowler on his mark sets off as the view clears (the machine starts its
// countdown); bowling, you are on your mark with the ball. Never during an
// appeal, a review or the third umpire (decisionPending), never with a menu
// open, never once the next delivery has started; the end of an innings is
// never skipped past (it goes to the innings' end). The press is used up
// (Button.swallow): held on, it starts nothing else (a dive, a run-up, the
// next replay's skip); a trigger already held when the ball went dead (a
// dive) does not skip: it takes a fresh press.
import { HINTS } from '../ui/controllerHint.js';

export const SKIP = { out: 0.25, in: 0.25, outCap: 1.0 };

// Is an appeal, a review (DRS) or the third umpire's decision in progress?
// The session's own decisionPending() when it has one (the DRS flow: it also
// covers the moments after a quiet shout when you bowl, while you may still
// appeal: a skip must not throw that chance away); its states as well.
// The one place that decides it: extend here.
export function decisionPending(s) {
  if (!s) return false;
  if (typeof s.decisionPending === 'function' && s.decisionPending()) return true;
  return s.state === 'review' || !!(s.lbw && s.lbw.active) || !!(s.third && s.third.active) || !!s.reviewFlow;
}

// Can a press skip to the next ball now? c: the facts (see QuickSkip.facts).
export function skipAllowed(c) {
  if (c.gameState !== 'play' || !c.hasSession || c.done || c.menuOpen || c.decision) return false;
  if (c.replayActive) return true;                       // (a replay only plays once the ball is dead)
  if (c.isBowling) return c.state === 'settle';          // ('ready': you are on your mark already)
  return c.state === 'settle' || c.state === 'idle';    // (not once the run-up / countdown has started)
}

export class QuickSkip {
  constructor(game) {
    this.g = game;
    this.phase = null;          // null | 'out' (going dark) | 'in' (coming back)
    this.t = 0;
    this.last = null;           // what the last skip did (for the harness): { at, dark, result, from }
  }

  facts() {
    const g = this.g, s = g.session;
    return {
      gameState: g.state, hasSession: !!s, done: !!(s && s.done), menuOpen: !!g.ui.menuOpen,
      decision: decisionPending(s), replayActive: !!(g.replay && g.replay.active),
      isBowling: !!(s && s.isBowling), state: s ? s.state : null,
    };
  }
  button() { return this.g.replay.skipHand().buttons.trigger; }
  get busy() { return this.phase != null; }

  // Once a frame, after the controllers are read and before anything else reads them.
  update(dt) {
    const g = this.g, fade = g.replay.fade;
    if (this.phase === 'out') {
      this.t += dt;
      if (g.ui.menuOpen || !g.session || g.state !== 'play') { this.phase = null; fade.cut(SKIP.in); return; }
      if (!fade.fadingOut) fade.fadeOut(SKIP.out);       // (a replay ending meanwhile brought the view back in)
      if (fade.dark || this.t > SKIP.outCap) this.blackout();
      return;
    }
    if (this.phase === 'in') { this.t += dt; if (this.t >= SKIP.in) this.phase = null; return; }
    if (!skipAllowed(this.facts())) return;
    this.coach();
    const xr = !!g.input.xr, b = this.button();
    if (!(xr ? b.down : g.input.desktop.took('KeyN'))) return;
    if (xr && b.swallow) b.swallow();
    this.phase = 'out'; this.t = 0;
    const s = g.session;
    this.last = { at: g.clock, dark: null, result: null, from: g.replay.active ? 'replay' : s.state };
    g.ui.clearHints();
    fade.fadeOut(SKIP.out);
  }

  // Dark: the replay is over, everyone is put in place, the next ball is set up.
  blackout() {
    const g = this.g, R = g.replay, s = g.session;
    if (R.active) { R.stop(); R.stopReason = 'quick'; }
    R.pending = null;
    if (R.marks && R.marks.release != null) R.marks.played = true;
    g.ui.clearHints();
    g.ui.prompt('', 0);
    const f = this.facts();
    const result = f.decision || f.menuOpen || f.done || !s.skipToNext ? null : s.skipToNext(SKIP.in);
    R.fade.cut(SKIP.in);
    this.phase = 'in'; this.t = 0;
    if (this.last) { this.last.dark = g.clock; this.last.result = result; }
  }

  // The first dead ball of a game: a small card for the button (between balls only).
  coach() {
    const g = this.g, s = g.session;
    if (g.replay.active || !s || s.state !== 'settle' || g.coachSeen.has('skip')) return;
    const off = g.replay.skipHand(), L = off === g.input.left;
    g.coach('skip', [{ ...HINTS.skip, hand: L ? 'L' : 'R', sub: `${L ? 'left' : 'right'} trigger: next ball` }], 4);
  }
}
