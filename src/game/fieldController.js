// Glue between the pure Fielding logic, the physics world and the fielder
// figures; sessions talk to this.
import { Fielding } from './fielding.js';
import { CONFIG } from '../config.js';

export class FieldController {
  constructor(game, { spinner = false, bowlerFields = true } = {}) {
    this.game = game;
    const skill = CONFIG.ai[game.settings.difficulty] || CONFIG.ai.medium;
    this.logic = new Fielding({ rng: game.rng, catchSkill: skill.catchSkill, spinner, bowlerFields });
  }
  enter() {
    this.game.fieldView.show(true);
    this.logic.reset();
    this.game.fieldView.update(0, this.logic.states());
  }
  exit() {
    this.game.fieldView.show(false);
    this.game.ballOverride = null;
  }
  reset() { this.logic.reset(); this.game.ballOverride = null; }
  setSpinner(on) { this.logic.setSpinner(on); }
  onHit(ball, t, pred) { this.logic.onHit(ball, t, pred); }
  onBoundary(e) { this.logic.onBoundary(e); }
  keeperTakes(ball) { this.logic.keeperTakes(ball); }
  get fielded() { return this.logic.fielded; }
  get message() { return this.logic.message; }
  result() { return this.logic.outcome; }
  runsSoFar(t) { return this.logic.runsSoFar(t); }
  update(dt, t) {
    const g = this.game, w = g.world;
    this.logic.update(dt, t, w.ball.active ? w.ball : null, w);
    const st = this.logic.states();
    g.fieldView.update(dt, st);
    // The AI bowler figure hands over to the fielding bowler once it moves.
    const bf = st[st.length - 1];
    if (this.logic.bowlerFields && g.figures.bowler.fig.visible === bf.hidden) g.figures.bowler.show(bf.hidden);
    g.ballOverride = this.logic.ballOverride;
    if (g.ballOverride) g.ballView.setVisible(true);
  }
}
