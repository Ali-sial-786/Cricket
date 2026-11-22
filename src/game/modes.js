// Mode factory: wires sessions, innings, scorecards, AI bowler/batter and fielders.
// The presentation between pieces of play (the intro, the toss, the teams
// taking the field, the innings break, the result) is ceremony.js's: with
// Settings -> Ceremonies 'off' every path here is the plain one (cards and
// buttons), and the beats never change what is played or scored.
import { BattingSession } from './batting.js';
import { BowlingSession } from './bowling.js';
import { Innings, wicketsForOvers, chaseTarget } from './scoring.js';
import { Scorecard } from './scorecard.js';
import { SQUADS } from './squad.js';
import { AIBowler } from './aiBowler.js';
import { FieldController } from './fieldController.js';
import { ceremonyMode, holdSession, playerOfMatch } from './ceremony.js';

const DEFEND = { easy: 14, medium: 12, hard: 10 };
const HOME = SQUADS.home, AWAY = SQUADS.away;
const homeCard = () => new Scorecard(HOME.batters, { team: HOME.name });
const awayCard = () => new Scorecard(AWAY.batters, { team: AWAY.name });
const fieldForBowling = (game) => new FieldController(game, { bowlerFields: false, playerBatting: false });
// The sessions' classes (a test plays the flow with stand-ins).
export const SESSIONS = { Batting: BattingSession, Bowling: BowlingSession };
const bat = (game, o) => holdSession(game, new SESSIONS.Batting(game, o));
const bowl = (game, o) => holdSession(game, new SESSIONS.Bowling(game, o));

// Ceremonies on (or cards only) for this game?
const beats = (game) => !!game.ceremony && ceremonyMode(game) !== 'off';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The end of a game: the result beat (the winning moment, the banner), then the result page.
function finale(game, info, ctx) {
  if (!beats(game)) return game.showResult(info);
  game.ceremony.play('result', ctx, () => game.showResult(info));
}

// A new innings: with ceremonies, the take-the-field beat starts it (in the dark); else at once.
function begin(game, session, ctx = {}) {
  if (!beats(game)) return game.startSessionObj(session);
  const inn = session.innings, playerBats = !session.isBowling, card = inn && inn.card;
  const openers = card ? [card.onStrike, card.offStrike].filter(Boolean).map((b) => b.name).join(' and ') : '';
  if (game.ui && game.ui.menuOpen) game.ui.closeMenu();          // (the card it was picked on: the beat takes over)
  game.ceremony.play('takeField', {
    playerBats, openers, overs: inn ? inn.ballsLimit / 6 : 1, target: inn ? inn.target : null, balls: inn ? inn.ballsLimit : 0,
    batting: playerBats ? HOME.name : AWAY.name, mode: session.kind, modeName: session.title, ...ctx,
    begin: () => game.startSessionObj(session),
  });
}

export function createSession(game, kind) {
  const s = game.settings;
  const diff = s.difficulty;
  switch (kind) {
    case 'bowlnets':
      return bowl(game, { kind: 'bowlnets', title: 'Nets · Bowling' });

    case 'over': {
      const target = DEFEND[diff] || 12;
      return bowl(game, {
        kind: 'over', title: `Bowl an Over · defend ${target - 1}`,
        innings: new Innings({ balls: 6, wickets: 5, target, batting: 'ai', card: awayCard() }),
        fielders: fieldForBowling(game),
        onDone: (inn) => {
          const won = inn.runs < target;
          const info = {
            title: won ? 'Over defended!' : 'They got there',
            color: won ? '#7dff8a' : '#ff8080',
            lines: [`${inn.runs} runs conceded · ${inn.wickets} wicket${inn.wickets === 1 ? '' : 's'}`, `Over: ${inn.log.map((l) => l.sym).join('  ')}`, ...inn.card.lines({ bowlers: 1 })],
          };
          finale(game, info, { winner: won ? 'home' : 'away', fieldingWon: won, title: won ? 'OVER DEFENDED' : `${AWAY.name.toUpperCase()} GOT THERE`, word: won ? 'DEFENDED' : 'CHASED', margin: `${inn.runs} off the over · target ${target}`, sub: info.lines[0] });
        },
      });
    }

    case 'chase': {
      const overs = s.overs;
      const target = chaseTarget(diff, overs);
      const inn = new Innings({ balls: overs * 6, wickets: wicketsForOvers(overs), target, batting: 'player', card: homeCard() });
      return bat(game, {
        kind: 'chase', title: `Run Chase · ${target} off ${overs * 6}`, innings: inn,
        bowler: 'ai', aiBowler: new AIBowler(diff, game.rng), fielders: new FieldController(game),
        onDone: (i) => {
          const r = i.chaseResult;
          const info = {
            title: r === 'won' ? 'Chased it down!' : r === 'tied' ? 'Tied!' : 'Fell short',
            color: r === 'won' ? '#7dff8a' : r === 'tied' ? '#ffd34d' : '#ff8080',
            lines: [`${i.scoreText} in ${i.overs} overs (target ${target})`, `4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines({ bowlers: 2 })],
          };
          const margin = r === 'won' ? `by ${plural(i.wicketsLeft, 'wicket')}` : r === 'tied' ? '' : `by ${plural(target - 1 - i.runs, 'run')}`;
          const potm = playerOfMatch([i], r === 'won' ? HOME.name : AWAY.name);
          if (potm) info.potm = potm;
          finale(game, info, { winner: r === 'won' ? 'home' : r === 'tied' ? 'tie' : 'away', fieldingWon: r === 'lost', potm, margin, word: r === 'won' ? `${HOME.short} WIN` : r === 'tied' ? 'TIED' : `${AWAY.short} WIN`, title: r === 'tied' ? 'MATCH TIED' : `${(r === 'won' ? HOME : AWAY).name.toUpperCase()} WIN ${margin.toUpperCase()}` });
        },
      });
    }

    case 'match':
      return null;          // starts with the toss: see startMatch()

    case 'nets':
    default:
      return bat(game, { kind: 'nets', title: 'Nets · Batting' });
  }
}

// What the intro's title card says for a mode.
export function introCtx(game, kind) {
  const s = game.settings, overs = s.overs;
  if (kind === 'chase') return { mode: 'chase', target: chaseTarget(s.difficulty, overs), balls: overs * 6, wickets: wicketsForOvers(overs) };
  if (kind === 'over') return { mode: 'over', target: DEFEND[s.difficulty] || 12 };
  return { mode: 'match', overs, wickets: wicketsForOvers(overs), toss: true };
}

// A game started from the menu with ceremonies on: the intro, then the game
// (a match goes on to the toss); nets get their title card. Direct starts
// (Game.startSession(kind) without intro: the harness, tests) skip all this.
export function startWithIntro(game, kind) {
  const C = game.ceremony;
  if (kind === 'match') { C.play('intro', introCtx(game, 'match'), () => startMatch(game, { intro: true })); return; }
  if (kind === 'nets' || kind === 'bowlnets') {
    game.startSessionObj(createSession(game, kind));
    const m = game.settings.machine;
    const sub = kind === 'nets' ? `Bowling machine ${Math.round(m.paceKmh)} km/h${m.spinType !== 'none' ? ` · ${m.spinType}-spin` : ''} · no fielders, no score` : 'Bowl at the batter · no fielders, no score';
    C.play('nets', { title: kind === 'nets' ? 'BATTING' : 'BOWLING', sub });
    return;
  }
  const session = createSession(game, kind);
  C.play('intro', introCtx(game, kind), () => begin(game, session));
}

// ---------------------------------------------------------------- match
// Coin toss, then one innings each (N overs, 5 wickets). The call and its
// outcome are the same either way: with ceremonies (`intro`) the call is
// made in the middle with the other captain and a real coin (ceremony.js),
// and the cards go compact; without, the toss is a card.
export function startMatch(game, { intro = false } = {}) {
  const scene = intro && beats(game) && ceremonyMode(game) === 'on';
  const decide = (side) => {
    const coin = game.rng() < 0.5 ? 'heads' : 'tails';
    const won = coin === side;
    return { side, coin, won, aiBats: won ? null : game.rng() < 0.5 };
  };
  const choose = (o) => {
    if (o.won) {
      game.showResult({
        title: `${o.coin.toUpperCase()} — you win the toss`, color: '#7dff8a', toss: o.coin, compact: scene,
        lines: [`${HOME.name} v ${AWAY.name}`, `${game.settings.overs} overs a side · ${wicketsForOvers(game.settings.overs)} wickets`, 'Bat first or bowl first?'],
        choices: [
          { text: 'Bat first', fn: () => begin(game, battingInnings(game, null)) },
          { text: 'Bowl first', fn: () => begin(game, bowlingInnings(game, null)) },
        ],
      });
    } else if (scene) {
      // (the card on the coin said it: they bat or bowl, and on we go)
      begin(game, o.aiBats ? bowlingInnings(game, null) : battingInnings(game, null));
    } else {
      const aiBats = o.aiBats;
      game.showResult({
        title: `${o.coin.toUpperCase()} — ${AWAY.name} win the toss`, color: '#ffd34d', toss: o.coin,
        lines: [`${HOME.name} v ${AWAY.name}`, aiBats ? 'They will bat first. You bowl.' : 'They put you in. You bat first.'],
        choices: [{ text: aiBats ? 'Take the ball' : 'Pad up', fn: () => begin(game, aiBats ? bowlingInnings(game, null) : battingInnings(game, null)) }],
      });
    }
  };
  const call = (side) => {
    const o = decide(side);
    if (!scene) return choose(o);
    game.ui.closeMenu();
    game.ceremony.play('flip', o, () => choose(o));
  };
  const ask = () => game.showResult({
    title: 'The toss', color: '#ffd34d', toss: 'call', compact: scene,
    lines: [`${HOME.name} (you) v ${AWAY.name}`, scene ? `${AWAY.name}' captain tosses. Call it.` : 'Call it.'],
    choices: [{ text: 'Heads', fn: () => call('heads') }, { text: 'Tails', fn: () => call('tails') }],
  });
  if (scene) game.ceremony.play('toss', {}, ask);
  else ask();
}

function matchResult(game, home, away, homeBattedFirst) {
  const first = homeBattedFirst ? home : away, second = homeBattedFirst ? away : home;
  const r = second.chaseResult;                       // 'won' | 'lost' | 'tied' for the side batting second
  const homeWon = homeBattedFirst ? r === 'lost' : r === 'won';
  const margin = r === 'won' ? `by ${second.wicketsLeft} wicket${second.wicketsLeft === 1 ? '' : 's'}` : `by ${first.runs - second.runs} run${first.runs - second.runs === 1 ? '' : 's'}`;
  game.say('result', { winner: homeWon ? 0 : 1, tie: r === 'tied', by: r === 'won' ? 'wickets' : 'runs' });
  const potm = playerOfMatch([first, second], r === 'tied' ? null : homeWon ? HOME.name : AWAY.name);
  const info = {
    title: r === 'tied' ? 'Match tied!' : homeWon ? `You win ${margin}!` : `${AWAY.name} win ${margin}`,
    color: r === 'tied' ? '#ffd34d' : homeWon ? '#7dff8a' : '#ff8080',
    lines: [
      `${HOME.short} ${home.scoreText} (${home.overs})   ·   ${AWAY.short} ${away.scoreText} (${away.overs})`,
      `${HOME.short}: ${home.card.topBatters(2).join(' · ')}`,
      `${AWAY.short}: ${away.card.topBatters(2).join(' · ')}`,
      `Best bowling: ${[...away.card.topBowlers(1), ...home.card.topBowlers(1)].join(' · ')}`,
    ],
  };
  if (potm) info.potm = potm;
  // (the side batting second won with the ball in their hands' opponents': the fielding side won when the side batting last lost)
  const fieldingWon = r === 'lost';
  finale(game, info, {
    winner: r === 'tied' ? 'tie' : homeWon ? 'home' : 'away', fieldingWon, potm, margin: r === 'tied' ? '' : margin,
    word: r === 'tied' ? 'TIED' : `${homeWon ? HOME.short : AWAY.short} WIN`,
    title: r === 'tied' ? 'MATCH TIED' : `${(homeWon ? HOME : AWAY).name.toUpperCase()} WIN ${margin.toUpperCase()}`,
  });
}

// The innings break: with ceremonies a scene (the score and the target on
// the big screen, the field emptying), then the second innings takes the
// field; without, the card with its button.
function inningsBreak(game, i, next, card) {
  if (!beats(game)) return game.showResult(card);
  const c = i.card, top = c ? c.topBatters(1)[0] : '', best = c ? c.topBowlers(1)[0] : '';
  const chasing = i.batting === 'player' ? AWAY.name : HOME.name;
  game.ceremony.play('inningsBreak', {
    team: i.label || (c && c.team) || '', score: i.scoreText, overs: i.overs, target: i.runs + 1, balls: i.ballsLimit, chasing,
    best: [top && `top score ${top}`, best && `best bowling ${best}`].filter(Boolean).join(' · ') || `${i.fours} fours · ${i.sixes} sixes`,
    endFirst: () => { game.endSession(); },
  }, () => begin(game, next(), { second: true }));
}

// You bat. `first` = the AI's completed innings if you are chasing, else null.
function battingInnings(game, first) {
  const s = game.settings, overs = s.overs, wk = wicketsForOvers(overs);
  const target = first ? first.runs + 1 : null;
  const inn = new Innings({ balls: overs * 6, wickets: wk, target, batting: 'player', label: HOME.name, card: homeCard() });
  return bat(game, {
    kind: 'match', title: first ? `Match · chase ${target}` : 'Match · 1st innings (you bat)', innings: inn,
    bowler: 'ai', aiBowler: new AIBowler(s.difficulty, game.rng), fielders: new FieldController(game),
    onDone: (i) => {
      if (first) return matchResult(game, i, first, false);
      game.say('innings_break');
      inningsBreak(game, i, () => bowlingInnings(game, i), {
        title: `You made ${i.scoreText}`,
        lines: [`${i.overs} overs · 4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines({ bowlers: 2 }), `Now bowl — ${AWAY.name} need ${i.runs + 1} to win.`],
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
  return bowl(game, {
    kind: 'match', title: first ? `Match · defend ${first.runs}` : 'Match · 1st innings (you bowl)', innings: inn,
    aggression: first ? 0.35 : 0.5,
    fielders: fieldForBowling(game),
    onDone: (i) => {
      if (first) return matchResult(game, first, i, true);
      game.say('innings_break');
      inningsBreak(game, i, () => battingInnings(game, i), {
        title: `${AWAY.name} made ${i.scoreText}`,
        lines: [`${i.overs} overs · 4s: ${i.fours} · 6s: ${i.sixes}`, ...i.card.lines({ bowlers: 1 }), `Now bat — you need ${i.runs + 1} to win.`],
        nextText: 'Bat 2nd innings',
        next: () => game.startSessionObj(battingInnings(game, i)),
      });
    },
  });
}
