// Mode factory: wires sessions, innings and AI for each game mode.
import { BattingSession } from './batting.js';
import { BowlingSession } from './bowling.js';
import { Innings } from './scoring.js';

export function createSession(game, kind) {
  switch (kind) {
    case 'bowlnets':
      return new BowlingSession(game, { kind: 'bowlnets', title: 'Nets · Bowling' });
    case 'over':
      return new BowlingSession(game, {
        kind: 'over', title: 'Bowl an Over',
        innings: new Innings({ balls: 6, wickets: 10, batting: 'ai' }),
        onDone: (inn) => game.showResult({ title: 'Over complete', lines: [`${inn.runs} runs conceded · ${inn.wickets} wicket${inn.wickets === 1 ? '' : 's'}`, inn.log.map((l) => l.sym).join('  ')] }),
      });
    case 'nets':
    default:
      return new BattingSession(game, { kind: 'nets', title: 'Nets · Batting' });
  }
}
