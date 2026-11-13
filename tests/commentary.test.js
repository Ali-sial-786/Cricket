// The TV commentary (src/audio/commentary.js and the clip bank in assets/commentary): the
// manifest and the files match, and the line engine with a fake backend and a fake clock:
// one exchange at a time, a boundary / wicket cuts off a dot-ball line, notable exchanges
// queue and expire, filler cools down, variants come from a bag, Geoff's reply follows
// Kate's call, the between-ball chat follows the situation, numbers are whole sentences or
// stitched, and the match's event kinds map to the right lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Commentary, MATCH_KINDS } from '../src/audio/commentary.js';

const DIR = new URL('../assets/commentary/', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8'));

// Every clip row of the manifest: [file, transcript, voice, seconds, (gap)].
function allRows(m = MANIFEST) {
  const rows = [];
  for (const exs of Object.values(m.clips)) for (const ex of exs) rows.push(...ex);
  rows.push(...Object.values(m.need), ...m.numbers, ...Object.values(m.fragments));
  return rows;
}
const LENGTH = Object.fromEntries(allRows().map((r) => [r[0], r[3]]));

// A deterministic rng (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fake voices: clips "play" for their manifest length; everything is logged.
function fakeBackend() {
  return {
    played: [],                        // {id, at (set by the test's clock), stopped}
    play(id) {
      const rec = { id, stopped: null };
      this.played.push(rec);
      return { stop: (fade = 0) => { rec.stopped = fade; } };
    },
    duration: (id) => LENGTH[id],
  };
}

async function fresh({ always = true, seed = 7 } = {}) {
  const backend = fakeBackend();
  const c = new Commentary({ sfx: null, manifest: MANIFEST, rng: seeded(seed), backend });
  c.always = always;
  assert.equal(await c.load(), true);
  return { c, backend };
}

const run = (c, seconds, step = 0.05) => { for (let t = 0; t < seconds - 1e-4; t += step) c.update(step); };
const untilQuiet = (c, limit = 40) => { for (let t = 0; (c.speaking() || c.queue.length) && t < limit; t += 0.05) c.update(0.05); };
const reset = (c) => { c.stop(); c.quietUntil = -Infinity; c.lastSaid = {}; };
const kind = (c, k, ctx = {}) => { reset(c); c.say(k, ctx); return c.cur ? c.cur.event : ''; };
const queued = (c, ev) => c.queue.some((u) => u.event === ev);

test('the manifest loads and has every part of the bank', async () => {
  const { c } = await fresh();
  assert.ok(c.manifest && Object.keys(c.manifest.clips).length >= 100);
  assert.deepEqual(MANIFEST.voices, { pbp: 'Kate', col: 'Geoff' });
  assert.equal(MANIFEST.numbers.length, 201);
  for (const ev of ['four', 'six', 'bowled', 'caught', 'dot', 'single', 'lbw_appeal', 'match_start', 'chat_general',
    'need_reply_easy', 'gag_told_you', 'deliv_yorker', 'won_runs', 'tie']) assert.ok(MANIFEST.clips[ev]?.length, ev);
  for (const f of ['they_need', 'runs_from', 'run_from', 'balls', 'ball', 'end_over_score', 'score_is', 'to_win', 'for_0', 'for_10']) assert.ok(MANIFEST.fragments[f], f);
  for (const row of allRows()) {
    assert.ok(typeof row[0] === 'string' && row[0].endsWith('.ogg'), `file ${row[0]}`);
    assert.ok(row[1].length > 0 && (row[2] === 'pbp' || row[2] === 'col') && row[3] > 0.1, `row ${row[0]}`);
  }
  // Every exchange opens on its own line, and a later part's gap is a number.
  for (const exs of Object.values(MANIFEST.clips)) for (const ex of exs) ex.forEach((u, i) => assert.ok(i === 0 ? u[4] === 0 : Number.isFinite(u[4])));
});

test('every clip id the manifest references exists on disk (and nothing is left over)', () => {
  const disk = new Set(readdirSync(DIR).filter((f) => f.endsWith('.ogg')));
  const used = new Set(allRows().map((r) => r[0]));
  const missing = [...used].filter((f) => !disk.has(f));
  assert.deepEqual(missing, []);
  assert.deepEqual([...disk].filter((f) => !used.has(f)), []);
  assert.ok(used.size > 1000);
});

test('say() is ignored before load(), when disabled, and for unknown kinds', async () => {
  const backend = fakeBackend();
  const c = new Commentary({ manifest: MANIFEST, backend, rng: seeded(1) });
  c.always = true;
  c.say('six'); c.update(0.1);
  assert.equal(c.speaking(), false);
  await c.load();
  c.setEnabled(false); c.say('six');
  assert.equal(c.speaking(), false);
  c.setEnabled(true);
  for (const k of ['nonsense', 'pickup', 'runup']) { c.say(k, { type: 1 }); assert.equal(c.speaking(), false, k); }
  c.say('six'); c.update(0.05);
  assert.ok(c.speaking() && backend.played.length === 1);
  // No AudioContext at all: the default backend stays silent and nothing throws.
  const d = new Commentary({ sfx: { ctx: null, enabled: true }, manifest: MANIFEST });
  await d.load(); d.always = true;
  d.say('bowled'); for (let i = 0; i < 400 && d.speaking(); i++) d.update(0.05);
  assert.equal(d.speaking(), false);
  assert.deepEqual(d.history, ['bowled']);
});

test('a big event interrupts filler; minor is dropped, notable queues, the best first', async () => {
  const { c, backend } = await fresh();
  c.say('dot');
  assert.ok(c.speaking() && c.cur.event === 'dot');
  run(c, 0.1);
  assert.ok(c.cur.started, 'it starts at once');
  const dot = backend.played[0];
  c.say('six', { region: 'straight' });
  assert.equal(c.cur.event, 'six_straight', 'a six interrupts the dot-ball line, with its region');
  assert.equal(dot.stopped, 0.12, 'the old line fades out in 0.12 s');
  assert.equal(c.cur.started, false, 'the new line waits for the old one to fade');
  run(c, 0.2);
  assert.ok(c.cur.started && backend.played[1].id.startsWith('six_straight_'));
  c.say('single');
  assert.ok(c.cur.event === 'six_straight' && c.queue.length === 0, "a minor line doesn't cut off a six, and isn't queued");
  c.say('lbw_appeal');
  assert.ok(c.cur.event === 'six_straight' && c.queue.length === 1, 'a notable line waits its turn');
  c.say('four');
  assert.equal(c.cur.event, 'six_straight', "big doesn't interrupt big");
  assert.ok(c.queue.length === 2 && c.queue[0].event === 'four', 'the queue puts the bigger line first');
  untilQuiet(c);
  const h = c.history;
  assert.ok(h.indexOf('six_straight') < h.indexOf('four') && h.indexOf('four') < h.indexOf('lbw_appeal'), `queued lines play in order (${h})`);
});

test('one voice at a time, bar the overlapping reactions', async () => {
  const { c, backend } = await fresh();
  // The gap the bank gives each clip (negative = a reaction over the end of the line before).
  const gap = {};
  for (const exs of Object.values(MANIFEST.clips)) for (const ex of exs) for (const u of ex) gap[u[0]] = u[4];
  // Wrap play() to record when each clip sounds.
  const spans = [];
  const play = backend.play.bind(backend);
  backend.play = (id, o) => { spans.push({ id, from: c.now, to: c.now + LENGTH[id] }); return play(id, o); };
  let overlaps = 0;
  for (let round = 0; round < 6; round++) {
    for (const ev of ['bowled', 'four', 'six', 'toss_bat', 'chat_general', 'caught_behind', 'dropped', 'hat_trick']) { reset(c); c.say(ev); untilQuiet(c); }
    reset(c); c.say('need', { runs: 13, balls: 7 }); untilQuiet(c);
  }
  assert.ok(spans.length >= 100);
  for (let i = 1; i < spans.length; i++) {
    const over = spans[i - 1].to - spans[i].from;
    if (over <= 0.06) continue;        // (stitched pieces cross over by 0.05 s)
    overlaps++;
    assert.ok(gap[spans[i].id] < 0, `${spans[i].id} overlaps ${spans[i - 1].id} by ${over.toFixed(2)} s`);
    assert.ok(over <= -gap[spans[i].id] + 0.06, 'and by no more than the bank says');
  }
  assert.ok(overlaps > 0, 'the bank does overlap some reactions');
  // The exchange lasts its clips and gaps.
  reset(c); c.say('toss_bat'); const t0 = c.now; const parts = c.cur.parts; untilQuiet(c);
  assert.ok(Math.abs((c.now - t0) - (parts[0][3] + parts[1][4] + parts[1][3])) < 0.2, 'the exchange lasts its clips and gaps (within a few 0.05 s frames)');
});

test('cooldowns: a quiet spell after a line, and no immediate repeats', async () => {
  const { c } = await fresh();
  c.say('dot'); untilQuiet(c);
  c.say('defended');
  assert.equal(c.speaking(), false, 'right after a line, filler waits for a quiet spell');
  run(c, 3.0);
  c.say('defended');
  assert.ok(c.speaking() && c.cur.event === 'defended', 'after the quiet spell it talks again');
  const began = c.now;                 // (the cooldown runs from the start of the line)
  c.stop(); run(c, 3.0);
  c.say('defended');
  assert.equal(c.speaking(), false, "the same filler event doesn't repeat within 10 s");
  c.say('leave');
  assert.ok(c.speaking() && c.cur.event === 'leave', 'another filler event can');
  c.stop(); run(c, 6.5);
  c.say('defended');
  assert.equal(c.speaking(), false, 'still within 10 s');
  run(c, 0.6);
  assert.ok(c.now - began > 10);
  c.say('defended');
  assert.ok(c.speaking(), 'it can after the cooldown');
  untilQuiet(c);
  // Minor events cool down for 6 s.
  reset(c); c.say('single'); c.stop(); run(c, 5.0); c.say('single');
  assert.equal(c.speaking(), false, 'a minor event waits 6 s');
  run(c, 1.1); c.say('single');
  assert.ok(c.speaking());
  c.stop();
  // Notable: at most every 3 s. Big: always.
  reset(c); c.say('lbw_appeal'); c.stop(); c.say('lbw_appeal');
  assert.equal(c.speaking(), false, 'a notable event repeats at most every 3 s');
  run(c, 3.1); c.say('lbw_appeal');
  assert.ok(c.speaking());
  c.stop(); c.say('six'); c.stop(); c.say('six');
  assert.ok(c.speaking(), 'big ones are always called');
  // The dice: at chattiness 0 filler mostly stays silent.
  c.always = false; c.setChattiness(0);
  let said = 0;
  for (let i = 0; i < 200; i++) { reset(c); c.say('dot'); if (c.speaking()) said++; }
  assert.ok(said > 0 && said < 60, `filler is rolled against the chattiness (${said} / 200)`);
});

test('queued lines expire, and stop() silences everything', async () => {
  const { c, backend } = await fresh();
  c.say('match_start'); c.say('toss_bat');
  untilQuiet(c);
  assert.ok(c.history.includes('toss_bat'), 'the toss line waits for the long welcome');
  c.say('won_runs'); c.say('milestone_50');
  c.queue[0].until = c.now + 0.1;
  untilQuiet(c);
  assert.ok(!c.history.includes('milestone_50'), 'a stale queued line is dropped');
  c.say('bowled'); run(c, 0.1); c.say('lbw_appeal');
  const last = backend.played.at(-1);
  c.stop();
  assert.ok(!c.speaking() && c.queue.length === 0 && last.stopped === 0);
  run(c, 1.0);
  assert.equal(c.speaking(), false, 'and nothing comes back');
});

test("replies: Geoff follows Kate, gives way to a notable event, and answers every question", async () => {
  const { c } = await fresh();
  c.say('bowled');
  const end = c._curEnd();
  assert.ok(c.cur.parts.length >= 2 && c.cur.parts[0][2] === 'pbp' && c.cur.parts[1][2] === 'col', 'a wicket: Kate calls it, Geoff replies');
  let sawGeoff = false;
  while (c.speaking()) { c.update(0.05); if (c.cur && c.cur.colour) sawGeoff = true; }
  assert.ok(Math.abs(c.now - end) < 0.2 && sawGeoff, 'the exchange lasts its clips and gaps');
  reset(c); c.say('four');
  while (c.speaking() && !c._inReply()) c.update(0.05);
  c.say('lbw_appeal');
  assert.equal(c.cur.event, 'lbw_appeal', 'anything notable cuts off the reply');
  untilQuiet(c);
  // A big moment waiting skips the reply.
  reset(c); c.say('six'); const six = c.cur; c.say('caught');
  assert.ok(c.cur.event === 'six' && c.queue.length === 1);
  untilQuiet(c);
  assert.ok(six.parts.length === six.callLen && c.history.at(-1) === 'caught', 'the reply is skipped, then the wicket is called');
  // The dice (not `always`): a question is always answered; other replies sometimes aren't.
  c.always = false;
  let asked = 0, answered = 0, short = 0;
  for (let i = 0; i < 80; i++) {
    reset(c); c.say('toss_bat');
    const p = c.cur.parts;
    if (p[0][1].endsWith('?')) { asked++; if (p.length >= 2) answered++; } else if (p.length === 1) short++;
  }
  assert.ok(asked > 0 && answered === asked, `Kate's questions get Geoff's answer (${answered} / ${asked})`);
  assert.ok(short > 0, 'other replies are rolled against the chattiness');
});

test("variants don't repeat until the bag is exhausted", async () => {
  const { c } = await fresh();
  for (const ev of ['four', 'bowled', 'dot', 'six']) {
    const n = MANIFEST.clips[ev].length;
    assert.ok(n >= 3, ev);
    let last = '';
    for (let round = 0; round < 3; round++) {
      const seen = new Set();
      let first = '';
      for (let i = 0; i < n; i++) {
        reset(c); c.say(ev);
        if (i === 0) first = c.cur.parts[0][0];
        seen.add(c.cur.parts[0][0]);
      }
      assert.equal(seen.size, n, `every ${ev} call heard once before any repeats (round ${round})`);
      if (round > 0) assert.notEqual(first, last, `${ev}: a refilled bag doesn't open on the call just heard`);
      last = c.cur.parts[0][0];
    }
  }
  // The recency memory: a first line said lately (in any event) is passed over while there's a choice.
  reset(c); c.bags = {}; c.recent = [];
  const rows = MANIFEST.clips.single;
  c.recent.push(rows[0][0][1], rows[1][0][1]);
  for (let i = 0; i < rows.length - 2; i++) {
    const ex = c._pick('single');
    assert.ok(ex !== rows[0] && ex !== rows[1], 'recent lines wait');
  }
});

test('numbers: whole chase sentences, stitched sums and scores use clips that exist', async () => {
  const { c, backend } = await fresh();
  const disk = new Set(readdirSync(DIR));
  c.say('need', { runs: 9, balls: 6 });
  assert.ok(c.speaking() && c.cur.parts[0][0] === 'need_9_6.ogg', 'a common chase sum is one whole sentence');
  assert.ok(c.cur.parts.length === 2 && c.cur.parts[1][2] === 'col' && c.cur.parts[1][4] === 0.35, 'and Geoff has something to say about it');
  reset(c);
  const caps = [];
  c.onCaption = (text, speaker) => caps.push(`${speaker}: ${text}`);
  backend.played.length = 0;
  c.say('need', { runs: 12, balls: 8 });
  assert.ok(c.speaking() && c.cur.stitched && c.cur.callLen === 5, 'an odd one is stitched from pieces');
  assert.equal(c.cur.event, 'need');
  untilQuiet(c);
  const ids = backend.played.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 5), ['frag_they_need.ogg', 'num_12.ogg', 'frag_runs_from.ogg', 'num_8.ogg', 'frag_balls.ogg']);
  assert.ok(ids.length === 6 && ids[5].startsWith('need_reply_'), 'every piece plays in turn, then the reply');
  for (const id of ids) assert.ok(disk.has(id), id);
  assert.equal(caps[0], 'Kate: They need twelve runs from eight balls.', 'the caption shows the whole sentence at once');
  assert.ok(caps[1].startsWith('Geoff: ') && caps.at(-1) === ': ', 'then the reply, then it clears');
  c.onCaption = null;
  reset(c); c.say('need', { runs: 1, balls: 1 });
  assert.ok(c.cur.parts[2][1] === 'run from' && c.cur.parts[4][1] === 'ball.', 'singular');
  reset(c); c.say('end_over_score', { runs: 45, wickets: 2 }); run(c, 0.05);
  assert.equal(c.cur.text, "End of the over, and they're forty five for two.");
  assert.deepEqual(c.cur.parts.map((p) => p[0]), ['frag_end_over_score.ogg', 'num_45.ogg', 'frag_for_2.ogg']);
  reset(c); c.say('target', { runs: 87 }); run(c, 0.05);
  assert.equal(c.cur.text, 'They need eighty seven to win.');
  reset(c); c.say('score', { runs: 0, wickets: 0 }); run(c, 0.05);
  assert.equal(c.cur.text, 'The score is nought for none.');
  reset(c); c.say('need', { runs: 500, balls: 6 });
  assert.equal(c.speaking(), false, 'numbers beyond the bank are skipped');
  // Every sum a short game can throw up picks clips that exist, whole or stitched.
  for (let runs = 1; runs <= 200; runs += 7) {
    for (const balls of [1, 5, 6, 12, 17, 24, 60, 120]) {
      reset(c); c.say('need', { runs, balls });
      assert.ok(c.speaking(), `${runs} from ${balls}`);
      for (const p of c.cur.parts) assert.ok(disk.has(p[0]) && LENGTH[p[0]] > 0, `${runs}:${balls} ${p[0]}`);
      if (MANIFEST.need[`${runs}:${balls}`]) assert.ok(!c.cur.stitched); else assert.ok(c.cur.stitched && c.cur.callLen === 5);
    }
  }
});

test('the between-ball chat follows the situation, and the running gags pay off', async () => {
  const { c } = await fresh();
  c.prediction = 'wicket';             // (no new prediction slipped into the list while one is pending)
  let topics = c._chatTopics({ need: { runs: 40, balls: 12, wickets: 5 }, score: '60/3', balls: 48 });
  assert.ok(topics.includes('chat_chase_steep'), `a steep chase (${topics})`);
  topics = c._chatTopics({ need: { runs: -1, balls: 12 }, score: '40/0', balls: 18 });
  assert.ok(topics.includes('chat_rate_fast') && topics.at(-1) === 'chat_general', `a fast start (${topics})`);
  c.dotStreak = 4;
  topics = c._chatTopics({ need: { runs: 20, balls: 18, wickets: 2 }, score: '30/6', balls: 12 });
  assert.ok(topics[0] === 'chat_pressure' && topics.includes('chat_tail'), `dot balls and the tail (${topics})`);
  c.dotStreak = 0;
  // The same from the plain situation object, with nothing on ctx.
  c.situation = { runs: 60, wickets: 8, balls: 48, ballsLimit: 60, target: 100, strikerRuns: 31, strikerBalls: 20,
    bowlerRuns: 30, bowlerWickets: 0, bowlerBalls: 12, partnershipRuns: 27, dotsInRow: 0 };
  topics = c._chatTopics({});
  for (const t of ['chat_tail', 'chat_chase_steep', 'chat_batter_set', 'chat_bowler_expensive', 'chat_partnership']) assert.ok(topics.includes(t), `${t} (${topics})`);
  c.situation = { runs: 20, wickets: 1, balls: 30, ballsLimit: 60, target: null, strikerRuns: 2, strikerBalls: 3, bowlerWickets: 2, bowlerBalls: 6 };
  topics = c._chatTopics({});
  for (const t of ['chat_rate_slow', 'chat_batter_new', 'chat_bowler_hot']) assert.ok(topics.includes(t), `${t} (${topics})`);
  c.situation = {}; c.prediction = '';
  topics = c._chatTopics({ score: '40/0', balls: 18 });
  assert.ok(topics.includes('chat_banter') && topics.some((t) => t.startsWith('chat_predict') || t === 'chat_praise_batter'));
  // A quiet ball: they chat (the dot line is on cooldown), and a boundary cuts across it.
  c.now += 60; c.lastSaid.dot = c.now;
  c.say('ball', { runs: 0, score: '50/1', balls: 10 });
  assert.ok(c.speaking() && c.cur.chat && c.cur.parts.length >= 2, `between balls, a chat exchange (${c.cur?.event})`);
  const topic = c.cur.event;
  run(c, 0.4);
  c.say('four');
  assert.equal(c.cur.event, 'four', 'a boundary interrupts the chat at once');
  untilQuiet(c);
  c.quietUntil = -Infinity; c.lastChat = -Infinity;
  c._maybeChat({ score: '50/1', balls: 10 });
  assert.ok(!c.speaking() || c.cur.event !== topic, "the same topic doesn't come straight back");
  // Geoff calls a wicket, and two balls later it comes.
  reset(c); c.prediction = '';
  c.say('chat_predict_wicket');
  assert.equal(c.prediction, 'wicket');
  reset(c); c.say('ball', { outcome: { runs: 1, extras: '' }, report: { runs: 1, wicket: '' } });
  reset(c); c.say('ball', { outcome: { runs: 0, extras: '' }, report: { runs: 0, wicket: 'bowled' } });
  assert.ok(c.cur.event === 'bowled' && queued(c, 'gag_told_you'), '"Told you!" follows the call');
  untilQuiet(c);
  assert.ok(c.history.includes('gag_told_you') && c.prediction === '');
  // Kate praises the batter, who's out next ball; a predicted six that comes; one that never does.
  reset(c); c.say('chat_praise_batter'); reset(c);
  c.say('ball', { wicket: 'caught' });
  assert.ok(queued(c, 'gag_jinx'));
  reset(c); c.say('chat_predict_six'); reset(c);
  c.say('ball', { runs: 6, boundary: 6 });
  assert.ok(queued(c, 'gag_six_called'));
  reset(c); c.say('chat_predict_six');
  for (let i = 0; i < 3; i++) { reset(c); c.say('ball', { runs: 0 }); }
  assert.equal(c.prediction, '', 'a prediction lapses after three balls');
});

test('match event kinds map to the right lines', async () => {
  const { c } = await fresh();
  c.say('toss', { winner: 0, choice: 'bowl' });
  assert.ok(c.cur.event === 'match_start' && c.queue.length === 1 && c.queue[0].event === 'toss_bowl', 'the toss: welcome, then the choice');
  assert.equal(kind(c, 'innings', { innings: 1 }), 'chase_start');
  assert.equal(kind(c, 'innings', { innings: 0 }), 'innings_start');
  assert.equal(kind(c, 'over', { style: 'LEG SPIN', balls: 6, need: { balls: 24 } }), 'new_bowler_spin');
  assert.equal(kind(c, 'over', { style: 'FAST', balls: 24, need: { balls: 6 } }), 'last_over');
  assert.equal(kind(c, 'release', { type: 9, pitch: [0.1, -5.0], speed: 25 }), 'deliv_doosra');
  assert.equal(kind(c, 'release', { type: 0, pitch: { x: 0.1, y: 0.5 }, speed: 38 }), 'deliv_seam');
  assert.equal(kind(c, 'release', { type: 4, pitch: { x: 0.1, z: -8.8 }, speed: 38 }), 'deliv_yorker');
  assert.equal(kind(c, 'release', { type: 'googly' }), 'deliv_googly');
  assert.equal(kind(c, 'release', { type: 'off spin', length: 'full toss' }), 'deliv_full_toss');
  assert.equal(kind(c, 'release', { type: 0, no_ball: true }), 'no_ball');
  assert.equal(kind(c, 'release', { type: 11 }), 'deliv_bouncer');
  c.stop(); c.say('hit', { result: 'hit', shot: 'cut', speed: 30 });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_cut');
  c.say('release', { type: 2 }); c.say('hit', { result: 'edge', shot: 'glance', speed: 20 });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_edge');
  c.say('ball', { outcome: { runs: 4, boundary: 4, extras: '' }, report: { runs: 4, wicket: '' } });
  assert.ok(c.history.filter((e) => e.startsWith('four')).length === 2 && c.queue.length === 0, "the ball event doesn't call the boundary twice");
  // The direction of the shot picks the region when the shot's name doesn't.
  c.say('release', { type: 0 }); c.say('hit', { shot: 'drive', speed: 30, dir: { x: 0.5, z: 20 } });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_straight');
  c.say('release', { type: 0 }); c.say('hit', { shot: 'drive', speed: 30, angle: -50 });
  assert.equal(kind(c, 'boundary', { runs: 6 }), 'six_cover');
  c.say('release', { type: 0 }); c.say('hit', { shot: 'hook', speed: 30 });
  assert.equal(kind(c, 'boundary', { runs: 6 }), 'six_hook');
  assert.equal(kind(c, 'boundary', { runs: 6, region: 'big' }), 'six_big');
  c.say('release', { type: 2 });
  assert.equal(kind(c, 'wicket', { how: 'bowled' }), 'bowled');
  c.say('release', { type: 2 }); c.say('catch_chance', { time: 0.8 });
  assert.equal(kind(c, 'catch', { fielder: 5 }), 'great_catch');
  c.say('catch_chance', { time: 2.5 });
  assert.equal(kind(c, 'catch', { fielder: 5 }), 'caught');
  assert.equal(kind(c, 'catch', { fielder: 1 }), 'caught_behind');
  assert.equal(kind(c, 'drop', { fielder: 3 }), 'dropped');
  assert.equal(kind(c, 'appeal'), 'lbw_appeal');
  assert.equal(kind(c, 'lbw_call', { out: true }), 'out_lbw');
  assert.equal(kind(c, 'lbw_call', { out: false }), 'not_out');
  assert.equal(kind(c, 'review'), 'drs_review');
  assert.equal(kind(c, 'review_result', { umpires_call: true, overturned: false }), 'drs_umpires_call');
  assert.equal(kind(c, 'review_result', { overturned: true }), 'drs_overturned');
  assert.equal(kind(c, 'review_result', { overturned: false }), 'drs_stays');
  assert.equal(kind(c, 'third_umpire'), 'third_umpire');
  assert.equal(kind(c, 'third_result', { what: 'stumping', out: true }), 'stumped');
  assert.equal(kind(c, 'third_result', { what: 'run_out', out: false }), 'near_run_out');
  assert.equal(kind(c, 'run_out_chance', { margin: -1.0 }), 'near_run_out');
  assert.equal(kind(c, 'run_out_chance', { margin: -0.3 }), '', 'a close one goes upstairs instead');
  assert.equal(kind(c, 'charge'), 'charge');
  // A run out is called once: the "run_out" event, then the ball that records it.
  c.say('release', { type: 0 });
  assert.equal(kind(c, 'run_out'), 'run_out');
  c.say('ball', { wicket: 'run_out' });
  assert.ok(!queued(c, 'run_out'));
  c.say('release', { type: 2 }); c.say('swing', { result: 'leave' });
  assert.equal(kind(c, 'ball', { outcome: { runs: 0, extras: '' }, report: { runs: 0, wicket: '' } }), 'leave');
  assert.equal(kind(c, 'ball', { outcome: { runs: 2, extras: '' }, report: { runs: 2, wicket: '' } }), 'two');
  assert.equal(kind(c, 'ball', { outcome: { runs: 1, extras: 'wide' }, report: { runs: 1, wicket: '' } }), 'wide');
  assert.equal(kind(c, 'ball', { runs: 1, wide: true }), 'wide', 'flat fields work too');
  assert.equal(kind(c, 'ball', { runs: 3 }), 'three');
  assert.equal(kind(c, 'ball', { runs: 6, boundary: 6 }), 'six');
  assert.equal(kind(c, 'ball', { wicket: 'lbw' }), 'out_lbw');
  reset(c);
  c.say('ball', { outcome: { runs: 0, extras: '' }, report: { runs: 0, wicket: '', over_done: true, maiden: true }, score: '12/1', need: { runs: -1, balls: 18 } });
  assert.ok(c.cur.event === 'maiden' && queued(c, 'end_over_score'), 'end of a maiden over: maiden, then the score');
  reset(c);
  c.say('ball', { runs: 0, overDone: true, score: '40/3', need: { runs: 9, balls: 6 } });
  assert.ok(c.cur.event === 'need' && queued(c, 'chase_close'), "in a chase, the over ends with what's needed");
  // The same from the situation object alone.
  reset(c); c.situation = { runs: 40, wickets: 3, balls: 54, ballsLimit: 60, target: 50 };
  c.say('ball', { runs: 0, overDone: true });
  assert.ok(c.cur.event === 'need' && c.cur.parts[0][0] === 'need_10_6.ogg' && queued(c, 'chase_close'));
  assert.equal(kind(c, 'over', { style: 'swing' }), 'last_over');
  c.situation = { runs: 40, wickets: 3, balls: 12, ballsLimit: 60, target: null };
  reset(c); c.say('ball', { runs: 0, overDone: true }); run(c, 0.05);
  assert.equal(c.cur.text, "End of the over, and they're forty for three.");
  assert.equal(kind(c, 'over', { style: 'swing' }), 'new_bowler_swing');
  c.situation = {};
  assert.equal(kind(c, 'innings_break'), 'innings_end');
  assert.equal(kind(c, 'result', { winner: -1 }), 'tie');
  assert.equal(kind(c, 'result', { winner: 0, text: 'TEAM 1 WIN BY 12 RUNS' }), 'won_runs');
  assert.equal(kind(c, 'result', { winner: 1, text: 'TEAM 2 WIN BY 3 WICKETS (4 BALLS LEFT)' }), 'won_wickets');
  assert.equal(kind(c, 'result', { by: 'wickets' }), 'won_wickets');
  // Milestones: the scorer's word, or the batter's runs after the ball.
  reset(c); c.say('ball', { runs: 4, boundary: 4, milestone: 50 });
  assert.ok(queued(c, 'milestone_50'));
  reset(c); c.say('ball', { runs: 2, batterRuns: 26 });
  assert.ok(queued(c, 'milestone_25') || c.cur.event === 'milestone_25');
  reset(c); c.say('ball', { runs: 2, batterRuns: 28 });
  assert.ok(!queued(c, 'milestone_25'));
  // Two wickets in a row: the hat-trick ball; and the new batter is welcomed at the next run-up.
  reset(c); c.wicketStreak = 0;
  for (let i = 0; i < 2; i++) { reset(c); c.say('ball', { wicket: 'bowled' }); }
  assert.ok(queued(c, 'hat_trick_ball'));
  assert.equal(kind(c, 'runup', { type: 1 }), 'new_batter');
  assert.equal(kind(c, 'runup', { type: 1 }), '', 'once');
  // Every documented match kind is at least accepted without throwing.
  for (const k of MATCH_KINDS) { reset(c); c.say(k, {}); c.say(k); c.update(0.05); }
});

test('the bouncer: hooks, top edges, ducks and being beaten', async () => {
  const { c } = await fresh();
  c.say('release', { type: 11, pitch: [0, -3] }); c.stop();
  c.say('hit', { result: 'hit', shot: 'hook', speed: 34 });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_hook');
  c.say('release', { type: 11 }); c.say('hit', { result: 'hit', shot: 'pull', speed: 30 });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_pull');
  assert.equal(kind(c, 'boundary', { runs: 6 }), 'six_pull');
  c.say('release', { type: 11 }); reset(c);
  c.say('hit', { result: 'edge', shot: 'hook', top_edge: true, speed: 12 });
  assert.equal(c.cur.event, 'top_edge', 'a top edge in the air is called');
  assert.equal(kind(c, 'catch', { fielder: 6 }), 'caught_top_edge');
  c.say('release', { type: 11 }); c.say('hit', { result: 'edge', shot: 'hook', topEdge: true });
  assert.equal(kind(c, 'boundary', { runs: 4 }), 'four_top_edge');
  c.say('release', { type: 11 }); c.say('swing', { result: 'leave', duck: true });
  assert.equal(kind(c, 'ball', { runs: 0 }), 'ducked');
  c.say('release', { type: 11 }); c.say('duck');
  assert.equal(kind(c, 'ball', { runs: 0 }), 'ducked');
  c.say('release', { type: 0 }); c.say('swing', { result: 'miss', shot: 'hook', short: true });
  assert.equal(kind(c, 'ball', { runs: 0 }), 'beaten_bouncer');
  c.say('release', { type: 11 }); c.say('swing', { result: 'miss', shot: 'hook' });
  assert.equal(kind(c, 'ball', { runs: 0 }), 'beaten_bouncer');
});

test('captions: each line as it starts, cleared when the exchange ends', async () => {
  const { c } = await fresh();
  const caps = [];
  c.onCaption = (text, speaker, voice) => caps.push([text, speaker, voice]);
  c.say('bowled');
  const parts = c.cur.parts;
  untilQuiet(c);
  assert.deepEqual(caps, [[parts[0][1], 'Kate', 'pbp'], [parts[1][1], 'Geoff', 'col'], ['', '', '']]);
  caps.length = 0;
  c.say('six'); run(c, 0.1); c.stop();
  assert.deepEqual(caps.at(-1), ['', '', ''], 'stop() clears it');
  c.onCaption = () => { throw new Error('a page bug'); };
  c.say('four'); untilQuiet(c);       // a throwing listener doesn't break the engine
  assert.equal(c.speaking(), false);
});
