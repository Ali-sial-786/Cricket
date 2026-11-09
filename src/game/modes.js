// Mode factory: wires sessions, innings, AI bowler/batter and fielders.
import { BattingSession } from './batting.js';
import { BowlingSession } from './bowling.js';
import { Innings, wicketsForOvers, chaseTarget } from './scoring.js';
import { AIBowler } from './aiBowler.js';
import { FieldController } from './fieldController.js';

const DEFEND = { easy: 14, medium: 12, hard: 10 };

export function createSession(game, kind) {
  const s = game.settings;
  const diff = s.difficulty;
  switch (kind) {
    case 'bowlnets':
      return new BowlingSession(game, { kind: 'bowlnets', title: 'Nets · Bowling' });

    case 'over': {
      const target = DEFEND[diff] || 12;
      return new BowlingSession(game, {
        kind: 'over', title: `Bowl an Over · defend ${target - 1}`,
        innings: new Innings({ balls: 6, wickets: 10, target, batting: 'ai' }),
        fielders: new FieldController(game, { bowlerFields: false }),
        onDone: (inn) => {
          const won = inn.runs < target;
          game.showResult({
            title: won ? 'Over defended!' : 'They got there',
            color: won ? '#7dff8a' : '#ff8080',
            lines: [`${inn.runs} runs conceded · ${inn.wickets} wicket${inn.wickets === 1 ? '' : 's'}`, `Over: ${inn.log.map((l) => l.sym).join('  ')}`],
          });
        },
      });
    }

    case 'chase': {
      const overs = s.overs;
      const target = chaseTarget(diff, overs);
      const inn = new Innings({ balls: overs * 6, wickets: wicketsForOvers(overs), target, batting: 'player' });
      return new BattingSession(game, {
        kind: 'chase', title: `Run Chase · ${target} off ${overs * 6}`, innings: inn,
        bowler: 'ai', aiBowler: new AIBowler(diff, game.rng), fielders: new FieldController(game),
        onDone: (i) => {
          const r = i.chaseResult;
          game.showResult({
            title: r === 'won' ? 'Chased it down!' : r === 'tied' ? 'Tied!' : 'Fell short',
            color: r === 'won' ? '#7dff8a' : r === 'tied' ? '#ffd34d' : '#ff8080',
            lines: [`${i.scoreText} in ${i.overs} overs (target ${target})`, `4s: ${i.fours} · 6s: ${i.sixes}`],
          });
        },
      });
    }

    case 'match':
      return matchFirstInnings(game);

    case 'nets':
    default:
      return new BattingSession(game, { kind: 'nets', title: 'Nets · Batting' });
  }
}

// Match: you bat first (N overs), then defend the total with the ball.
function matchFirstInnings(game) {
  const s = game.settings, overs = s.overs, wk = wicketsForOvers(overs);
  const inn1 = new Innings({ balls: overs * 6, wickets: wk, batting: 'player', label: 'You' });
  return new BattingSession(game, {
    kind: 'match', title: 'Match · 1st innings (you bat)', innings: inn1,
    bowler: 'ai', aiBowler: new AIBowler(s.difficulty, game.rng), fielders: new FieldController(game),
    onDone: (i) => {
      game.showResult({
        title: `You made ${i.scoreText}`,
        lines: [`${i.overs} overs · 4s: ${i.fours} · 6s: ${i.sixes}`, `Now bowl — the AI needs ${i.runs + 1} to win.`],
        nextText: 'Bowl 2nd innings',
        next: () => game.startSessionObj(matchSecondInnings(game, i)),
      });
    },
  });
}

function matchSecondInnings(game, inn1) {
  const s = game.settings, overs = s.overs, wk = wicketsForOvers(overs);
  const target = inn1.runs + 1;
  const inn2 = new Innings({ balls: overs * 6, wickets: wk, target, batting: 'ai', label: 'AI' });
  return new BowlingSession(game, {
    kind: 'match', title: `Match · defend ${inn1.runs}`, innings: inn2, fielders: new FieldController(game, { bowlerFields: false }),
    onDone: (i) => {
      const r = i.chaseResult;
      const youWon = r === 'lost';
      game.showResult({
        title: youWon ? 'You won the match!' : r === 'tied' ? 'Match tied!' : 'AI won the match',
        color: youWon ? '#7dff8a' : r === 'tied' ? '#ffd34d' : '#ff8080',
        lines: [`You ${inn1.scoreText} (${inn1.overs}) · AI ${i.scoreText} (${i.overs})`,
          youWon ? `Won by ${target - 1 - i.runs} runs` : r === 'won' ? `AI won with ${i.wicketsLimit - i.wickets} wickets left` : ''],
      });
    },
  });
}
