// The broadcast graphics' pure parts: which look a prompt gets (a sting for
// the big calls, a plain card for the rest) and what the score bug reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stingKind, matchState, shade } from '../src/ui/broadcast.js';
import { ballStyle, teamByName } from '../src/ui/theme.js';
import { Innings } from '../src/game/scoring.js';
import { Scorecard } from '../src/game/scorecard.js';

test('stingKind: the big calls get stings, everything else a plain card', () => {
  const cases = {
    'FOUR!': 'four', 'FOUR BYES!': 'four', 'SIX!': 'six',
    'BOWLED!': 'wicket', 'CAUGHT — Cover!': 'wicket', 'RUN OUT! (3.9 m short)': 'wicket', 'OUT — LBW': 'wicket', 'OUT!': 'wicket', 'STUMPED!': 'wicket', 'DECISION: OUT': 'wicket',
    'NOT OUT': 'notout', 'NOT OUT — back in time!': 'notout', 'DECISION: NOT OUT': 'notout',
    'THIRD UMPIRE…': 'review', 'You review the decision': 'review', 'The batter reviews': 'review',
    'J. Carter reaches 50!': 'milestone',
    'CATCH IT!  Get a hand to the ball': 'info', 'HOWZAT?!': 'info', 'Review? 1 left': 'info', 'FREE HIT — only a run-out counts': 'info',
    'NO BALL — overstepped — free hit next': 'info', 'RUN!': 'info', 'Out-swinger · 132 km/h': 'info',
  };
  for (const [t, k] of Object.entries(cases)) assert.equal(stingKind(t), k, t);
});

test('matchState: score, overs, the chase, batters, bowler and this over from the innings', () => {
  const card = new Scorecard(['A. One', 'B. Two', 'C. Three'], { team: 'Harbour Kings' });
  const inn = new Innings({ balls: 12, wickets: 2, target: 20, batting: 'player', card });
  card.setBowler('Z. Bowler');
  for (const o of [{ runs: 4, boundary: 4 }, { runs: 1 }, { runs: 0, wide: true }, { runs: 0, wicket: 'bowled' }]) inn.record(o);
  const st = matchState({ session: { innings: inn, reviews: { player: 1, per: 2 } } });
  assert.equal(st.team.short, 'HK');
  assert.equal(`${st.runs}/${st.wkts}`, '6/1');
  assert.equal(st.overs, '0.3');
  assert.equal(st.oversLimit, '2');
  assert.equal(st.need, 14);
  assert.equal(st.ballsLeft, 9);
  assert.ok(Math.abs(st.rrr - (14 * 6) / 9) < 1e-9);
  assert.deepEqual(st.over, ['4', '1', '1wd', 'W']);
  assert.equal(st.overLabel, 'THIS OVER');
  assert.equal(st.striker.name, 'C. Three');
  assert.equal(st.bowler.name, 'Z. Bowler');
  assert.deepEqual(st.reviews, { left: 1, per: 2 });
  for (let i = 0; i < 3; i++) inn.record({ runs: 0 });
  const st2 = matchState({ session: { innings: inn } });
  assert.equal(st2.overLabel, 'LAST OVER');          // between overs: the one just bowled
  assert.equal(st2.over.length, 7);
  assert.equal(matchState({ session: { kind: 'nets' } }), null);
  assert.equal(matchState({ session: null }), null);
});

test('theme helpers: ball dot colours, team lookup, shade', () => {
  assert.equal(ballStyle('W').t, 'W');
  assert.equal(ballStyle('•').t, '•');
  assert.notEqual(ballStyle('4').bg, ballStyle('6').bg);
  assert.equal(teamByName('Summit Stars').short, 'SS');
  assert.equal(teamByName('Some New Side').short, 'SNS');
  assert.equal(shade('#ffffff', -0.5), '#808080');
  assert.equal(shade('#000000', 0.5), '#808080');
});
