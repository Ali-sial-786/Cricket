// Mode factory: wires sessions, innings, scorecards, AI bowler/batter and fielders.
import { BattingSession } from './batting.js';
import { BowlingSession } from './bowling.js';
import { Innings, wicketsForOvers, chaseTarget } from './scoring.js';
import { Scorecard } from './scorecard.js';
import { SQUADS } from './squad.js';
import { AIBowler } from './aiBowler.js';
import { FieldController } from './fieldController.js';

const DEFEND = { easy: 14, medium: 12, hard: 10 };
const HOME = SQUADS.home, AWAY = SQUADS.away;
const homeCard = () => new Scorecard(HOME.batters, { team: HOME.name });
const awayCard = () => new Scorecard(AWAY.batters, { team: AWAY.name });
const fieldForBowling = (game) => new FieldController(game, { bowlerFields: false, playerBatting: false });

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
        innings: new Innings({ balls: 6, wickets: 5, target, batting: 'ai', card: awayCard() }),
        fielders: fieldForBowling(game),
        onDone: (inn) => {
          const won = inn.runs < target;
          game.showResult({
            title: won ? 'Over defended!' : 'They got there',
            color: won ? '#7dff8a' : '#ff8080',
            lines: [`${inn.runs} runs conceded · ${inn.wickets} wicket${inn.wickets === 1 ? '' : 's'}`, `Over: ${inn.log.map((l) => l.sym).join('  ')}`, ...inn.card.lines(2, 1)],
          });
        },
      });
    }

    case 'chase': {
      const overs = s.overs;
      const target = chaseTarget(diff, overs);
      const inn = new Innings({ balls: overs * 6, wickets: wicketsForOvers(overs), target, batting: 'player', card: homeCard() });
      return new BattingSession(game, {
        kind: 'chase', title: `Run Chase · ${target} off ${overs * 6}`, innings: inn,
        bowler: 'ai', aiBowler: new AIBowler(diff, game.rng), fielders: new FieldController(game),
        onDone: (i) => {
          const r = i.chaseResult;
          game.showResult({
            title: r === 'won' ? 'Chased it down!' : r === 'tied' ? 'Tied!' : 'Fell short',
            color: r === 'won' ? '#7dff8a' : r === 'tied' ? '#ffd34d' : '#ff8080',
            lines: [`${i.scoreText} in ${i.overs} overs (target ${target})`, `4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines(3, 2)],
          });
        },
      });
    }

    case 'match':
      return null;          // starts with the toss: see startMatch()

    case 'nets':
    default:
      return new BattingSession(game, { kind: 'nets', title: 'Nets · Batting' });
  }
}

// ---------------------------------------------------------------- match
// Coin toss, then one innings each (N overs, 5 wickets).
export function startMatch(game) {
  const call = (side) => {
    const coin = game.rng() < 0.5 ? 'heads' : 'tails';
    const won = coin === side;
    if (won) {
      game.showResult({
        title: `${coin.toUpperCase()} — you win the toss`, color: '#7dff8a',
        lines: [`${HOME.name} v ${AWAY.name}`, `${game.settings.overs} overs a side · ${wicketsForOvers(game.settings.overs)} wickets`, 'Bat first or bowl first?'],
        choices: [
          { text: 'Bat first', fn: () => game.startSessionObj(battingInnings(game, null)) },
          { text: 'Bowl first', fn: () => game.startSessionObj(bowlingInnings(game, null)) },
        ],
      });
    } else {
      const aiBats = game.rng() < 0.5;
      game.showResult({
        title: `${coin.toUpperCase()} — ${AWAY.name} win the toss`, color: '#ffd34d',
        lines: [`${HOME.name} v ${AWAY.name}`, aiBats ? 'They will bat first. You bowl.' : 'They put you in. You bat first.'],
        choices: [{ text: aiBats ? 'Take the ball' : 'Pad up', fn: () => game.startSessionObj(aiBats ? bowlingInnings(game, null) : battingInnings(game, null)) }],
      });
    }
  };
  game.showResult({
    title: 'The toss', color: '#ffd34d',
    lines: [`${HOME.name} (you) v ${AWAY.name}`, 'Call it.'],
    choices: [{ text: 'Heads', fn: () => call('heads') }, { text: 'Tails', fn: () => call('tails') }],
  });
}

function matchResult(game, home, away, homeBattedFirst) {
  const first = homeBattedFirst ? home : away, second = homeBattedFirst ? away : home;
  const r = second.chaseResult;                       // 'won' | 'lost' | 'tied' for the side batting second
  const homeWon = homeBattedFirst ? r === 'lost' : r === 'won';
  const margin = r === 'won' ? `by ${second.wicketsLimit - second.wickets} wicket${second.wicketsLimit - second.wickets === 1 ? '' : 's'}` : `by ${first.runs - second.runs} run${first.runs - second.runs === 1 ? '' : 's'}`;
  game.say('result', { winner: homeWon ? 0 : 1, tie: r === 'tied', by: r === 'won' ? 'wickets' : 'runs' });
  game.showResult({
    title: r === 'tied' ? 'Match tied!' : homeWon ? `You win ${margin}!` : `${AWAY.name} win ${margin}`,
    color: r === 'tied' ? '#ffd34d' : homeWon ? '#7dff8a' : '#ff8080',
    lines: [
      `${HOME.short} ${home.scoreText} (${home.overs})   ·   ${AWAY.short} ${away.scoreText} (${away.overs})`,
      `${HOME.short}: ${home.card.topBatters(2).join(' · ')}`,
      `${AWAY.short}: ${away.card.topBatters(2).join(' · ')}`,
      `Best bowling: ${[...away.card.topBowlers(1), ...home.card.topBowlers(1)].join(' · ')}`,
    ],
  });
}

// You bat. `first` = the AI's completed innings if you are chasing, else null.
function battingInnings(game, first) {
  const s = game.settings, overs = s.overs, wk = wicketsForOvers(overs);
  const target = first ? first.runs + 1 : null;
  const inn = new Innings({ balls: overs * 6, wickets: wk, target, batting: 'player', label: HOME.name, card: homeCard() });
  return new BattingSession(game, {
    kind: 'match', title: first ? `Match · chase ${target}` : 'Match · 1st innings (you bat)', innings: inn,
    bowler: 'ai', aiBowler: new AIBowler(s.difficulty, game.rng), fielders: new FieldController(game),
    onDone: (i) => {
      if (first) return matchResult(game, i, first, false);
      game.say('innings_break');
      game.showResult({
        title: `You made ${i.scoreText}`,
        lines: [`${i.overs} overs · 4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines(3, 2), `Now bowl — ${AWAY.name} need ${i.runs + 1} to win.`],
        nextText: 'Bowl 2nd innings',
        next: () => game.startSessionObj(bowlingInnings(game, i)),
      });
    },
  });
}

// You bowl. `first` = your completed innings if you are defending, else null.
function bowlingInnings(game, first) {
  const s = game.settings, overs = s.overs, wk = wicketsForOvers(overs);
  const target = first ? first.runs + 1 : null;
  const inn = new Innings({ balls: overs * 6, wickets: wk, target, batting: 'ai', label: AWAY.name, card: awayCard() });
  return new BowlingSession(game, {
    kind: 'match', title: first ? `Match · defend ${first.runs}` : 'Match · 1st innings (you bowl)', innings: inn,
    aggression: first ? 0.35 : 0.5,
    fielders: fieldForBowling(game),
    onDone: (i) => {
      if (first) return matchResult(game, first, i, true);
      game.say('innings_break');
      game.showResult({
        title: `${AWAY.name} made ${i.scoreText}`,
        lines: [`${i.overs} overs · 4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines(3, 1), `Now bat — you need ${i.runs + 1} to win.`],
        nextText: 'Bat 2nd innings',
        next: () => game.startSessionObj(battingInnings(game, i)),
      });
    },
  });
}
