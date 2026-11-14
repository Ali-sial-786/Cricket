import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Innings } from '../src/game/scoring.js';
import { Scorecard } from '../src/game/scorecard.js';
import { batProfile } from '../src/game/squad.js';

const card = () => { const c = new Scorecard(['A', 'B', 'C', 'D']); c.setBowler('X'); return c; };

test('runs go to the striker and odd runs change the strike', () => {
  const inn = new Innings({ balls: 12, wickets: 3, card: card() });
  inn.record({ runs: 1 });
  assert.equal(inn.card.batters[0].runs, 1);
  assert.equal(inn.card.onStrike.name, 'B');
  inn.record({ runs: 4, boundary: 4 });
  assert.equal(inn.card.onStrike.name, 'B');           // boundaries do not change ends
  assert.equal(inn.card.batters[1].fours, 1);
  inn.record({ runs: 2 });
  assert.equal(inn.card.onStrike.name, 'B');
  assert.equal(inn.card.bowler.runs, 7);
  assert.equal(inn.card.bowler.balls, 3);
});

test('the strike changes at the end of the over', () => {
  const inn = new Innings({ balls: 12, wickets: 3, card: card() });
  for (let i = 0; i < 6; i++) inn.record({ runs: 0 });
  assert.equal(inn.card.onStrike.name, 'B');
  assert.equal(inn.card.batters[0].balls, 6);
});

test('a wicket brings the next batter in at the same end, with the dismissal text', () => {
  const inn = new Innings({ balls: 12, wickets: 3, card: card() });
  const r = inn.record({ wicket: 'caught', fielder: 'Keeper' });
  assert.equal(r.card.dismissed.name, 'A');
  assert.equal(r.card.dismissed.out, 'c Keeper b X');
  assert.equal(r.card.newBatter.name, 'C');
  assert.equal(inn.card.onStrike.name, 'C');
  assert.equal(inn.card.bowler.wickets, 1);
  assert.equal(inn.card.fow[0].score, '0/1');
});

test('a run-out of the non-striker removes the right batter and credits no bowler', () => {
  const inn = new Innings({ balls: 12, wickets: 3, card: card() });
  const r = inn.record({ runs: 1, wicket: 'run out', who: 'nonStriker' });
  assert.equal(r.card.dismissed.name, 'B');
  assert.equal(inn.card.batters[0].runs, 1);
  assert.equal(inn.card.bowler.wickets, 0);
  // A completed the single, so A is at the far end; the new batter replaces B.
  assert.deepEqual([inn.card.onStrike.name, inn.card.offStrike.name].sort(), ['A', 'C']);
});

test('wides and no-balls: one run, bowled again, and a no-ball sets up a free hit', () => {
  const inn = new Innings({ balls: 6, wickets: 3, card: card() });
  inn.record({ wide: true });
  assert.equal(inn.legal, 0); assert.equal(inn.runs, 1); assert.equal(inn.freeHit, false);
  const r = inn.record({ noBall: true, runs: 4, boundary: 4 });
  assert.equal(inn.legal, 0); assert.equal(inn.runs, 6); assert.equal(inn.freeHit, true);
  assert.equal(r.overDone, false);
  assert.equal(inn.card.batters[0].runs, 4);
  assert.equal(inn.card.extras.noBalls, 1);
  inn.record({ wide: true });
  assert.equal(inn.freeHit, true, 'a wide keeps the free hit');
  inn.record({ runs: 0 });
  assert.equal(inn.freeHit, false);
  assert.equal(inn.thisOver.join(' '), '1wd 5nb 1wd •');
});

test('only a run-out counts on a no-ball or a free hit', () => {
  assert.equal(Innings.canDismiss('bowled', { freeHit: true }), false);
  assert.equal(Innings.canDismiss('caught', { noBall: true }), false);
  assert.equal(Innings.canDismiss('run out', { freeHit: true }), true);
  assert.equal(Innings.canDismiss('bowled'), true);
});

test('milestones and summary text', () => {
  const inn = new Innings({ balls: 60, wickets: 3, card: card() });
  let ms = [];
  for (let i = 0; i < 5; i++) ms = ms.concat(inn.record({ runs: 6, boundary: 6 }).card.milestones);
  assert.deepEqual(ms.map((m) => m.type), ['twentyfive']);
  assert.match(inn.card.topBatters(1)[0], /^A 30\* \(5\)$/);
  assert.match(inn.card.bowlerText(), /^X 0\.5-30-0$/);
});

test('tail-enders are worse than the top order', () => {
  assert.ok(batProfile(6).sigma > batProfile(2).sigma);
  assert.equal(batProfile(99).role, 'tail-ender');
});

// Parse "Name 12* (7)" back out of the result card's batting lines.
const parseBatters = (lines) => lines.filter((l) => !/^Extras|\//.test(l)).flatMap((l) => l.split(' · ')).map((t) => {
  const m = t.match(/^(.+) (\d+)(\*?) \((\d+)\)$/);
  assert.ok(m, `batter entry "${t}"`);
  return { name: m[1], runs: +m[2], notOut: !!m[3], balls: +m[4] };
});

test('the result card lists every batter who batted and adds up to the total', () => {
  const names = ['J. Carter', 'K. Mensah', 'R. Tanaka', 'D. Okafor', 'S. Whitlock', 'A. Rahimi', 'T. Vance'];
  const c = new Scorecard(names); c.setBowler('C. Warrick');
  const inn = new Innings({ balls: 18, wickets: 5, card: c });
  const balls = [
    { runs: 0, wicket: 'bowled' },                          // Carter b, first ball
    { runs: 1 },                                            // Mensah's single: Tanaka on strike
    { runs: 4, boundary: 4 },
    { wide: true, runs: 1 },                                // 2 wides, ran one: ends change
    { runs: 2, byes: true },                                // byes: to extras, a ball faced
    { noBall: true, runs: 1 },                              // a no-ball: one off the bat and one extra
    { runs: 1, wicket: 'run out', who: 'nonStriker' },      // the non-striker run out going for the second
    { runs: 0, wicket: 'stumped' },
    { runs: 0 },
    { runs: 3, byes: true },
    { runs: 0, wicket: 'caught', fielder: 'Keeper' },
    { runs: 4, boundary: 4 },
    { runs: 0, wicket: 'lbw' },
  ];
  for (const b of balls) { if (inn.complete) break; inn.record(b); }
  assert.ok(inn.complete, 'five down');
  assert.equal(inn.wickets, 5);
  const lines = c.lines({ bowlers: 1 });
  const bats = parseBatters(lines);
  // Everyone who went in, once each, in batting order; no one walks in after the last wicket.
  assert.deepEqual(bats.map((b) => b.name), names.slice(0, 6));
  assert.equal(bats.filter((b) => !b.notOut).length, 5);
  assert.equal(bats.filter((b) => b.notOut).length, 1);
  // Runs off the bat + extras = the total; balls faced = legal balls + no-balls.
  const extras = lines.find((l) => l.startsWith('Extras'));
  assert.ok(extras, 'extras line');
  const ex = +extras.match(/^Extras (\d+)/)[1];
  assert.equal(bats.reduce((t, b) => t + b.runs, 0) + ex, inn.runs);
  assert.equal(c.total(), inn.runs);
  assert.equal(bats.reduce((t, b) => t + b.balls, 0), inn.legal + c.extras.noBalls);
  assert.equal(inn.extras, ex);
  assert.match(lines[lines.length - 1], /^C\. Warrick 4\//);
});

test('openers who have not faced yet are on the card (not out)', () => {
  const c = card();
  const inn = new Innings({ balls: 6, wickets: 3, card: c });
  inn.record({ runs: 0, wicket: 'bowled' });
  const bats = parseBatters(c.lines());
  assert.deepEqual(bats.map((b) => `${b.name}${b.notOut ? '*' : ''}${b.balls}`), ['A1', 'B*0', 'C*0']);
});
