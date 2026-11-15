// DRS reviews per innings (ICC playing conditions): each side starts every
// innings with `per` reviews (CONFIG.match.reviews, 2). An unsuccessful review
// is lost; one that overturns the decision, or that ends on umpire's call, is
// kept. Each innings is a new session, so a new Reviews: the count resets.
// The fields `player` / `ai` are the reviews left (lbwFlow.js reads them).
export class Reviews {
  constructor(per = 2) {
    this.per = per;
    this.player = per;
    this.ai = per;
  }

  left(side) { return this[side] || 0; }
  can(side) { return this.left(side) > 0; }

  // A review by `side` has ended. reviewKept: the decision was overturned or
  // it was umpire's call. Returns the reviews that side has left.
  settle(side, { reviewKept }) {
    if (!reviewKept) this[side] = Math.max(0, this.left(side) - 1);
    return this[side];
  }

  reset() { this.player = this.ai = this.per; }

  // For the HUD between balls.
  text() { return `Reviews · you ${this.player} · them ${this.ai}`; }
}
