// The TV commentary box: two fictional commentators calling the match. Kate Marsden ("pbp")
// calls the ball; Geoff Hollins ("col"), the old pro, picks up on what she said. A JS port of
// courtside's game/cricket/commentary.gd; every utterance is a clip in assets/commentary and
// manifest.json lists the exchanges with their transcripts, lengths and the gaps between them.
//
// API:
//   new Commentary({ sfx, manifestUrl, baseUrl, rng, backend, manifest })
//   await load()          fetch the manifest (or take the `manifest` option); never throws
//   say(kind, ctx = {})   a match event (toss innings over wicket_side runup release swing hit duck
//                         appeal lbw_call review review_result third_umpire third_result
//                         catch_chance catch drop run_out_chance run_out boundary wicket ball
//                         innings_break result charge; unknown kinds are ignored) mapped to exchanges
//                         here, or an event of the bank directly ("four", "bowled", "misfield",
//                         "direct_miss", "need" with ctx.runs/balls)
//   stop()                silence at once and forget everything queued
//   setEnabled(on) / setVolume(0..1) / setChattiness(0..1)
//   speaking()            an exchange is playing (or about to): duck the crowd under it
//   update(dt)            the only thing that moves the clock
//   onCaption             (text, speaker, voice) => void when a line starts; ('', '', '') when it ends
//   situation             plain object the game keeps up to date (all fields optional):
//                         { runs, wickets, balls, ballsLimit, target|null, battingIsPlayer, lastSix,
//                           partnershipRuns, partnershipBalls, strikerRuns, strikerBalls, bowlerRuns,
//                           bowlerWickets, bowlerBalls, dotsInRow }; see COMMENTARY-NOTES.md
//
// How it talks:
// - One exchange at a time: a short script of utterances (Kate's call, Geoff's reply, now and
//   then Kate back at him), each started after the gap the bank gives it. A negative gap is a
//   reaction that overlaps the end of the line before; otherwise one voice at once.
// - Each exchange has a priority: 0 filler (the delivery, a leave, a dot, the between-ball
//   chat), 1 minor (runs, wides, a new bowler or batter), 2 notable (appeals, reviews,
//   milestones, the chase, the toss), 3 big (fours, sixes, wickets, the result).
// - A big exchange interrupts anything of lower priority (the old one fades out in 0.12 s, then
//   the new one starts). Anything notable or big interrupts a reply in progress (once Kate's
//   call is over) and anything minor or better interrupts the between-ball chat. Otherwise a
//   notable / big exchange waits its turn (a queue of up to 3, the best first, each dropped if
//   it's still waiting 4 s after the exchange playing when it came would have ended); when one
//   is waiting, the reply of the exchange playing is skipped; a filler or minor exchange that
//   can't play is dropped.
// - Whether the reply is said is rolled against the chattiness (a question to Geoff is always
//   answered). Filler and minor exchanges are rolled too, need a quiet spell after the last one
//   (2.6 s at chattiness 0 down to 0.5 s at 1) and the same event can't repeat within 10 s (6 s
//   for minor ones, 90 s for a chat topic). Notable ones repeat at most every 3 s; big ones always.
// - Variants come from a shuffled bag per event, so an exchange doesn't repeat until the others
//   have been heard, and a recency memory keeps a call just said from coming straight back.
// - When a ball ends with nothing said, the two chat about the match situation now and then.
//   Running gags: Geoff predicts a wicket or a six, or Kate praises a batter; if a wicket (or
//   the six) comes within 3 balls, the payoff follows the call ("Told you!").
// - Numbers ("They need twelve runs from eight balls") are whole sentences for the common
//   chase sums, otherwise stitched from number and phrase clips with tight overlaps.
// - Each exchange belongs to a ball (counted at the run-up, or the over / release when there's no
//   run-up). As the next ball starts, whatever is still queued about the last one is dropped and
//   the line being said finishes without its reply; at the release anything still about the last
//   ball fades out (except the first line of a big call), so the delivery is called on time.

const FADE = 0.12;            // an interrupted exchange fades out this fast
const STITCH_GAP = -0.05;     // stitched pieces of one sentence overlap this much
const QUEUE_LIFE = 4.0;
const QUEUE_DELAY = 0.25;     // the breath before a queued exchange
const REPLY_GAP = 0.35;       // before Geoff's answer to the chase sum
const RECENT = 40;            // the recency memory (first lines)
const CHAT_REPEAT = 90.0;
const LOAD_WAIT = 1.5;        // a line holds at most this long for its clip to decode (web only)
const BOUNCER = 11;           // delivery kind
const BIG = ['four', 'six', 'bowled', 'caught', 'caught_behind', 'great_catch', 'stumped', 'run_out', 'out_lbw',
  'won_runs', 'won_wickets', 'tie', 'hat_trick', 'dropped', 'caught_top_edge', 'overthrow_boundary'];
const NOTABLE = ['match_start', 'toss_bat', 'toss_bowl', 'innings_start', 'chase_start', 'innings_end', 'last_over',
  'need', 'chase_close', 'chase_easy', 'milestone_25', 'milestone_50', 'partnership_50', 'lbw_appeal', 'not_out',
  'drs_review', 'drs_umpires_call', 'drs_overturned', 'drs_stays', 'third_umpire', 'near_run_out', 'hat_trick_ball',
  'free_hit', 'no_ball', 'maiden', 'target', 'top_edge', 'gag_told_you', 'gag_six_called', 'gag_six_jinx', 'gag_jinx',
  'milestone_100', 'last_ball'];
const MINOR = ['single', 'two', 'three', 'wide', 'overthrow', 'misfield', 'good_fielding', 'end_over', 'end_over_score',
  'score', 'new_bowler', 'new_bowler_pace', 'new_bowler_swing', 'new_bowler_spin', 'new_batter', 'ducked', 'beaten_bouncer',
  'around_wicket', 'over_wicket', 'keeper_fumble', 'direct_miss', 'backed_up', 'relay'];
const STITCHED = ['need', 'end_over_score', 'score', 'target'];
// The calls that settle a ball: said directly, the "ball" event doesn't call them again.
const CALLS = ['four', 'six', 'bowled', 'caught', 'caught_behind', 'great_catch', 'caught_top_edge', 'stumped', 'run_out', 'out_lbw',
  'overthrow_boundary'];
// Delivery kinds 0..11 (courtside delivery.gd) -> the delivery line, and their names.
const DELIVERY = ['deliv_seam', 'deliv_outswing', 'deliv_off_break', 'deliv_leg_break', 'deliv_seam', 'deliv_outswing',
  'deliv_inswing', 'deliv_slower', 'deliv_arm_ball', 'deliv_doosra', 'deliv_googly', 'deliv_bouncer'];
const DELIVERY_NAMES = ['fast', 'swing', 'off_spin', 'leg_spin', 'seam', 'outswing', 'inswing', 'slower_ball', 'arm_ball',
  'doosra', 'googly', 'bouncer'];
const PACE_KINDS = [0, 1, 4, 5, 6, 7, 11];
// Running gags: a chat that sticks its neck out, and what pays it off within PREDICT_BALLS balls.
const PREDICT = { chat_predict_wicket: 'wicket', chat_predict_six: 'six', chat_praise_batter: 'praise' };
const PREDICT_BALLS = 3;

/** The match event kinds say() understands (anything else must be a bank event). */
export const MATCH_KINDS = ['toss', 'innings', 'over', 'wicket_side', 'runup', 'release', 'charge', 'duck', 'swing', 'hit', 'appeal',
  'lbw_call', 'review', 'review_result', 'third_umpire', 'third_result', 'catch_chance', 'catch', 'drop',
  'run_out_chance', 'run_out', 'boundary', 'wicket', 'ball', 'innings_break', 'result'];

const num = (v, d = 0) => { const n = typeof v === 'boolean' ? NaN : Number(v ?? NaN); return Number.isFinite(n) ? n : d; };
const int = (v, d = 0) => Math.trunc(num(v, d));
const str = (v) => (v == null ? '' : String(v));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const camel = (k) => k.replace(/_(\w)/g, (_, c) => c.toUpperCase());
// A field under its snake_case (courtside) or camelCase name.
const get = (o, k) => (o == null || typeof o !== 'object' ? undefined : (o[k] ?? o[camel(k)]));

export class Commentary {
  constructor({ sfx = null, manifestUrl = './assets/commentary/manifest.json', baseUrl = './assets/commentary/',
    rng = Math.random, backend = null, manifest = null, cacheSize = 120 } = {}) {
    this.sfx = sfx;
    this.manifestUrl = manifestUrl;
    this.rng = rng;
    this.backend = backend || new WebAudioVoices(sfx, baseUrl, cacheSize);
    this.manifest = null;              // set by load()
    this._given = manifest;
    this.enabled = true;
    this.volume = 1;
    this.chattiness = 0.6;
    this.always = false;               // tests: skip the dice (every reply said; cooldowns still apply)
    this.thirdUmpireMargin = 0.7;      // run outs closer than this (m) go upstairs and get their own line
    this.situation = {};               // the game keeps this up to date (see the header)
    this.onCaption = null;
    this.now = 0;
    // The exchange playing (or about to): {event, prio, parts, callLen, idx (next part), nextAt, endAt,
    // firstEnd, started, text, voice, colour, chat, stitched}. parts: [file, transcript, voice, seconds, gap].
    this.cur = null;
    this.queue = [];                   // waiting exchanges (notable / big)
    this.quietUntil = -Infinity;
    this.lastSaid = {};                // event -> time it was last started
    this.history = [];                 // events started, oldest first (tests and debugging)
    this.bags = {};
    this.lastPick = {};
    this.recent = [];                  // first lines said lately (any event)
    this.voices = [];                  // clips sounding: {h: backend handle, end}
    this.fading = -1;                  // when the interrupted exchange began fading (-1 none)
    this.overlapUntil = -Infinity;     // two voices at once by design until then
    this._cap = ':';                   // the caption last reported (voice:text)
    // What the match has told us this ball / innings.
    this._newBall();
    this.hitSpeed = 0;
    this.partnership = 0;
    this.wicketStreak = 0;
    this.dotStreak = 0;
    this.newBatterDue = 0;             // balls left to welcome the new batter in
    this.lastChat = -Infinity;
    this.prediction = '';              // 'wicket' | 'six' | 'praise': a call or a jinx waiting to pay off
    this.predictionBalls = 0;
    this.started = false;
    this.cardRuns = {};                // batter -> runs at the last ball (for the 25s)
    this.ballNo = 0;                   // the ball each exchange is about (counted as a ball starts)
    this.ballOpen = false;             // the next ball has been counted, its release not seen yet
    this.staleCuts = 0;                // exchanges about an old ball cut off at a release (tests)
  }

  /** Load the manifest. Resolves true / false; safe to call twice. */
  async load() {
    if (this.manifest) return true;
    try {
      let m = this._given;
      if (!m) {
        const r = await fetch(this.manifestUrl);
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        m = await r.json();
      }
      if (!m || typeof m.clips !== 'object') throw new Error('bad manifest');
      this.manifest = { voices: {}, need: {}, numbers: [], fragments: {}, ...m };
      return true;
    } catch (e) {
      console.warn('Commentary unavailable', e);
      return false;
    }
  }

  setEnabled(on) { this.enabled = !!on; if (!on) this.stop(); }
  setVolume(v) { this.volume = clamp(num(v, 1), 0, 1); this.backend.setVolume?.(this.volume); }
  setChattiness(v) { this.chattiness = clamp(num(v, 0.6), 0, 1); }
  speaking() { return this.cur !== null; }

  // --- the public entry: a match event or a bank event

  say(kind, ctx = {}) {
    if (!this.enabled || !this.manifest) return;
    kind = str(kind); ctx = ctx && typeof ctx === 'object' ? ctx : {};
    if (this.manifest.clips[kind] || STITCHED.includes(kind)) {
      if (this._speak(kind, ctx) && CALLS.includes(this._base(kind))) this.ballCalled = true;
      return;
    }
    this._fromMatch(kind, ctx);
  }

  stop() {
    this.cur = null; this.queue = [];
    this._hush(0);
    this.fading = -1; this.overlapUntil = -Infinity;
    this._caption();
  }

  _hush(fade) {
    for (const v of this.voices) { try { v.h.stop(fade); } catch { /* a backend's problem */ } }
    this.voices = [];
  }

  // --- match events -> exchanges

  _newBall() {
    this.ballCalled = false;           // the boundary / wicket of this ball has been called already
    this.ballSpoken = false;           // anything at all was said about this ball
    this.shotName = ''; this.edged = false; this.topEdge = false; this.ducked = false; this.missed = false;
    this.bouncer = false; this.hitDir = null; this.regionHint = null; this.catchTime = Infinity;
  }

  _fromMatch(kind, ctx) {
    switch (kind) {
      case 'toss':
        this._nextBall();              // (the welcome belongs with the first ball: not cut at its release)
        if (!this.started) { this.started = true; this._speak('match_start', ctx, true); }
        this._speak(str(ctx.choice ?? 'bat') === 'bat' ? 'toss_bat' : 'toss_bowl', ctx);
        break;
      case 'innings': {
        this._nextBall();
        this.partnership = 0; this.wicketStreak = 0; this.dotStreak = 0; this.newBatterDue = 0;
        const chase = ctx.innings != null ? int(ctx.innings) >= 1 : !!(ctx.chase ?? (this.situation || {}).target != null);
        if (chase) this._speak('chase_start', ctx);
        else {
          if (!this.started) { this.started = true; this._speak('match_start', ctx, true); }
          this._speak('innings_start', ctx);
        }
        break;
      }
      case 'over': {
        this._nextBall();
        if (int(this._need(ctx).balls) === 6 && this._balls(ctx) > 0) { this._speak('last_over', ctx); break; }
        const style = str(ctx.style).toUpperCase();
        let ev = 'new_bowler';
        if (style === 'FAST' || style === 'PACE') ev = 'new_bowler_pace';
        else if (style === 'SWING') ev = 'new_bowler_swing';
        else if (style.endsWith('SPIN')) ev = 'new_bowler_spin';
        this._speak(ev, ctx);
        break;
      }
      case 'wicket_side': {            // the bowler goes round the wicket (side 1 / 'around'), or back over
        const side = ctx.side;
        this._speak(side === 1 || /^(round|around)/i.test(str(side)) || ctx.around === true ? 'around_wicket' : 'over_wicket', ctx);
        break;
      }
      case 'runup':
        this._nextBall();
        if (this.newBatterDue > 0) {
          if (this._speak('new_batter', ctx)) this.newBatterDue = 0; else this.newBatterDue -= 1;
        }
        break;
      case 'release': {
        this._nextBall();              // (a game that sends no run-up: the ball starts here)
        this.ballOpen = false;
        this._newBall();
        this._cutStale();
        const [k, ev] = this._deliveryLine(ctx);
        if (get(ctx, 'no_ball')) { this.bouncer = k === BOUNCER; this._speak('no_ball', ctx); break; }
        this.bouncer = k === BOUNCER || ev === 'deliv_bouncer';
        if (ev) this._speak(ev, ctx);
        break;
      }
      case 'charge':                   // (also a bank event, so say() gets there first)
        this._speak('charge', ctx);
        break;
      case 'duck':
        this.ducked = true; this.shotName = 'duck'; this.bouncer = true;
        break;
      case 'swing': {
        if (this._flag(ctx, 'short')) this.bouncer = true;
        const res = str(ctx.result);
        if (this._flag(ctx, 'duck') || res === 'duck') { this.ducked = true; this.shotName = 'duck'; }
        else if (res === 'leave') this.shotName = 'leave';
        else if (res === 'miss') this.missed = true;
        const sn = str(ctx.shot).toLowerCase();
        if (sn === 'pull' || sn === 'hook') this.shotName = sn;
        break;
      }
      case 'hit': {
        this.shotName = str(ctx.shot).toLowerCase(); this.edged = str(ctx.result) === 'edge' || ctx.edge === true;
        this.topEdge = this._flag(ctx, 'top_edge');
        if (this._flag(ctx, 'short')) this.bouncer = true;
        if (this._flag(ctx, 'duck')) this.ducked = true;
        this.hitSpeed = num(ctx.speed);
        this.hitDir = this._dir(ctx) || this.hitDir;
        if (ctx.region != null) this.regionHint = str(ctx.region);
        if (this.topEdge) this._speak('top_edge', { ...ctx, region: '' });
        break;
      }
      case 'appeal':
        this._speak('lbw_appeal', ctx);
        break;
      case 'lbw_call':
        if (ctx.out) { this._speak('out_lbw', ctx); this.ballCalled = true; } else this._speak('not_out', ctx);
        break;
      case 'review':
        this._speak('drs_review', ctx);
        break;
      case 'review_result': {
        const over = !!ctx.overturned;
        this._speak(get(ctx, 'umpires_call') && !over ? 'drs_umpires_call' : (over ? 'drs_overturned' : 'drs_stays'), ctx);
        this.ballCalled = true;
        break;
      }
      case 'third_umpire':             // (also a bank event)
        this._speak('third_umpire', ctx);
        break;
      case 'third_result': {
        const what = str(ctx.what);
        if (ctx.out) this._speak(what === 'stumping' ? 'stumped' : 'run_out', ctx);
        else this._speak(what === 'run_out' ? 'near_run_out' : 'not_out', ctx);
        this.ballCalled = true;
        break;
      }
      case 'catch_chance':
        this.catchTime = num(ctx.time, Infinity);
        break;
      case 'catch': {
        const keeper = ctx.keeper === true || int(ctx.fielder, -1) === 1;
        this._speak(this.topEdge ? 'caught_top_edge' : (keeper ? 'caught_behind' : (this.catchTime < 1.1 ? 'great_catch' : 'caught')), ctx);
        this.ballCalled = true;
        break;
      }
      case 'drop':                     // fumble: on the ground (the keeper's, or a misfield), not a catch
        if (ctx.fumble === true) this._speak(ctx.keeper === true || int(ctx.fielder, -1) === 1 ? 'keeper_fumble' : 'misfield', ctx);
        else this._speak('dropped', ctx);
        break;
      case 'run_out_chance': {
        const m = num(ctx.margin);
        if (m <= 0 && m > -1.2 && Math.abs(m) > this.thirdUmpireMargin) this._speak('near_run_out', ctx);
        break;
      }
      case 'run_out':                  // (also a bank event)
        this._speak('run_out', ctx); this.ballCalled = true;
        break;
      case 'boundary': {
        const six = int(ctx.runs, 4) === 6;
        if (ctx.overthrow === true) this._speak('overthrow_boundary', ctx);
        else this._speak(six ? 'six' : 'four', { region: ctx.region != null ? str(ctx.region) : this._region(six) });
        this.ballCalled = true;
        break;
      }
      case 'wicket':
        if (!this.ballCalled) {
          const how = str(ctx.how);
          const ev = { bowled: 'bowled', caught: this.topEdge ? 'caught_top_edge' : 'caught', lbw: 'out_lbw', stumped: 'stumped', run_out: 'run_out' };
          this._speak(ev[how] || (CALLS.includes(how) && this.manifest.clips[how] ? how : 'bowled'), ctx);
        }
        this.ballCalled = true;
        break;
      case 'ball':
        this._ball(ctx);
        break;
      case 'innings_break':
        this._speak('innings_end', ctx);
        break;
      case 'result': {
        const w = int(ctx.winner, -2), by = str(ctx.by).toLowerCase();
        if (w === -1 || ctx.tie === true) this._speak('tie', ctx);
        else if (w >= 0 || by) {
          const runs = by ? by.startsWith('run') : str(ctx.text).toUpperCase().includes(' RUN');
          this._speak(runs ? 'won_runs' : 'won_wickets', ctx);
        }
        break;
      }
      default:
    }
  }

  // The bouncer flags may sit on the event, or on a shot / outcome dictionary in it.
  _flag(ctx, key) {
    if (get(ctx, key)) return true;
    for (const sub of ['shot_result', 'outcome', 'report']) if (get(get(ctx, sub), key)) return true;
    return false;
  }

  // What's needed: ctx.need {runs (-1 batting first), balls, wickets in hand}, else from the situation.
  _need(ctx) {
    if (ctx.need && typeof ctx.need === 'object') return ctx.need;
    const s = this.situation || {};
    const runs = s.target != null && s.runs != null ? Math.max(0, int(s.target) - int(s.runs)) : -1;
    const balls = s.ballsLimit != null && s.balls != null ? Math.max(0, int(s.ballsLimit) - int(s.balls)) : 0;
    return { runs, balls, wickets: int(s.wicketsLimit, 10) - int(s.wickets) };
  }

  // The score: ctx.score "runs/wickets", else from the situation; null when unknown.
  _score(ctx) {
    const t = str(ctx.score), s = this.situation || {};
    if (t.includes('/')) return { runs: int(t.split('/')[0]), wickets: int(t.split('/')[1]) };
    return s.runs != null ? { runs: int(s.runs), wickets: int(s.wickets) } : null;
  }

  // Legal balls bowled this innings.
  _balls(ctx) { return int(ctx.balls ?? (this.situation || {}).balls); }

  // The shot's direction on the ground {x, z}: ctx.dir ({x, z} or [x, z]), ctx.vel ({x, y, z}) or
  // ctx.angle (degrees: 0 straight back past the bowler, negative = off side). Off side is -x,
  // straight down the ground +z (from the striker).
  _dir(ctx) {
    if (ctx.angle != null) { const a = num(ctx.angle) * Math.PI / 180; return { x: Math.sin(a), z: Math.cos(a) }; }
    const d = ctx.dir ?? ctx.vel;
    if (Array.isArray(d)) return { x: num(d[0]), z: num(d[d.length - 1]) };
    return d && typeof d === 'object' ? { x: num(d.x), z: num(d.z ?? d.y) } : null;
  }

  // [kind 0..11 or -1, the delivery's line]: its kind, unless the length makes it a bouncer, a
  // yorker or a full toss. ctx.type: a kind number or a name ("off_spin", "googly", "yorker" ...);
  // ctx.length: "full_toss" | "yorker" | "bouncer"; or ctx.pitch in courtside metres (z along the
  // pitch from its middle, the striker's popping crease at -8.84).
  _deliveryLine(ctx) {
    let kind = 0, named = '';
    if (typeof ctx.type === 'string') {
      const n = ctx.type.trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (this.manifest.clips[`deliv_${n}`]) named = `deliv_${n}`;
      kind = DELIVERY_NAMES.indexOf(n === 'slower' ? 'slower_ball' : n);
    } else kind = int(ctx.type);
    if (kind === BOUNCER) return [kind, 'deliv_bouncer'];
    const len = str(ctx.length).toLowerCase().replace(/[\s-]+/g, '_');
    if (['full_toss', 'yorker', 'bouncer'].includes(len)) return [kind, `deliv_${len}`];
    const p = ctx.pitch;
    const z = Array.isArray(p) ? num(p[p.length - 1], -4) : (p && typeof p === 'object' ? num(p.z ?? p.y, -4) : -4);
    const pace = ctx.pace ?? PACE_KINDS.includes(kind);
    if (z < -9.4) return [kind, 'deliv_full_toss'];
    if (z < -8.3 && pace) return [kind, 'deliv_yorker'];
    return [kind, named || DELIVERY[kind] || ''];
  }

  // Where the shot went, for the boundary call.
  _region(six) {
    if (this.regionHint != null) return this.regionHint;
    if (this.topEdge) return 'top_edge';
    if (this.edged) return six ? '' : 'edge';
    if (this.shotName === 'hook') return 'hook';
    const d = this.hitDir;
    const a = d && Math.hypot(d.x, d.z) > 0.5 ? Math.atan2(d.x, d.z) * 180 / Math.PI : NaN;
    if (six) {
      if (this.shotName === 'pull') return 'pull';
      if (this.hitSpeed > 42 && this.rng() < 0.6) return 'big';
      if (Number.isNaN(a)) return '';
      if (Math.abs(a) < 25) return 'straight';
      return a < 0 ? 'cover' : 'pull';
    }
    if (['cut', 'pull', 'sweep'].includes(this.shotName)) return this.shotName;
    if (this.shotName === 'glance' || Number.isNaN(a)) return '';
    if (Math.abs(a) < 22) return 'straight';
    if (a < -22 && a > -80) return 'cover';
    if (a <= -80 && a > -140) return 'cut';
    return '';
  }

  // The ball is dead: runs, dots and everything the scorers note. ctx.outcome {runs, extras,
  // boundary} and ctx.report {wicket, runs, over_done, innings_done, hat_trick, milestone,
  // free_hit, maiden} as in courtside, or the same fields flat on ctx (camelCase is fine, and
  // wide: true / noBall: true stand for extras "wide" / "no_ball").
  _ball(ctx) {
    const o = get(ctx, 'outcome') || ctx, r = get(ctx, 'report') || ctx, s = this.situation || {};
    const wicket = r.wicket === true ? 'out' : str(r.wicket || '');
    const runs = int(o.runs), boundary = int(o.boundary);
    const extras = str(o.extras || '') || (o.wide === true ? 'wide' : (get(o, 'no_ball') === true ? 'no_ball' : ''));
    const overDone = !!get(r, 'over_done'), inningsDone = !!get(r, 'innings_done');
    if (this._flag(ctx, 'duck')) this.ducked = true;
    if (wicket !== '') {
      if (!this.ballCalled) this._fromMatch('wicket', { how: wicket });
      this.partnership = 0; this.wicketStreak += 1; this.dotStreak = 0;
      this.newBatterDue = inningsDone ? 0 : 2;
    } else {
      if (extras !== 'wide' && extras !== 'no_ball') this.wicketStreak = 0;
      const before = this.partnership;
      this.partnership = s.partnershipRuns != null ? int(s.partnershipRuns) : before + int(r.runs, runs);
      this.dotStreak = s.dotsInRow != null ? int(s.dotsInRow) : (runs === 0 && extras === '' ? this.dotStreak + 1 : 0);
      if (boundary > 0) {
        if (!this.ballCalled) this._speak(boundary === 6 ? 'six' : 'four', { region: ctx.region != null ? str(ctx.region) : this._region(boundary === 6) });
      } else if (extras === 'wide') this._speak('wide', ctx);
      else if (extras === 'no_ball') { /* called at the release */ }
      else if (runs === 1) this._speak('single', ctx);
      else if (runs === 2) this._speak('two', ctx);
      else if (runs >= 3) this._speak('three', ctx);
      else if (this.ducked) this._speak('ducked', ctx);
      else if (this.bouncer && (this.missed || (!['leave', 'block', ''].includes(this.shotName) && !this.edged))) this._speak('beaten_bouncer', ctx);
      else if (overDone) { /* the end-of-over line says it */ }
      else if (this.shotName === 'leave') this._speak('leave', ctx);
      else if (this.shotName === 'block') this._speak('defended', ctx);
      else if (this.missed) this._speak('beaten', ctx);
      else this._speak('dot', ctx);
      if (before < 50 && this.partnership >= 50) this._speak('partnership_50', ctx);
    }
    this.ballCalled = true;
    this._payOff(wicket !== '', boundary === 6, extras === '');
    if (get(r, 'hat_trick')) this._speak('hat_trick', ctx);
    else if (this.wicketStreak === 2 && !inningsDone) this._speak('hat_trick_ball', ctx);
    const mile = this._milestone(ctx, r, extras === '' ? runs : 0);
    if (mile === 100) this._speak('milestone_100', ctx);
    else if (mile === 50) this._speak('milestone_50', ctx);
    else if (mile === 25) this._speak('milestone_25', ctx);
    if (get(r, 'free_hit')) this._speak('free_hit', ctx);
    // One ball left in a live chase: the build-up.
    const left = this._need(ctx);
    if (!inningsDone && int(left.runs, -1) > 0 && int(left.balls) === 1) this._speak('last_ball', ctx);
    if (overDone && !inningsDone) {
      if (r.maiden) this._speak('maiden', ctx);
      const need = this._need(ctx), score = this._score(ctx);
      const nr = int(need.runs, -1), nb = int(need.balls);
      if (nr > 0 && nb > 0) {
        this._speak('need', { runs: nr, balls: nb, prio: nr <= nb * 2 + 6 ? 2 : 1 });
        if (nb <= 12 && nr <= nb + 6) this._speak('chase_close', ctx);
      } else if (score) {
        if (this.always || this.rng() < 0.4 + 0.6 * this.chattiness) this._speak('end_over_score', { ...score, prio: 2 });
      }
    }
    if (!this.ballSpoken && !inningsDone) this._maybeChat(ctx);
    // (courtside clears these at the next "release"; cleared here too for games that only send "ball")
    this._newBall();
  }

  // A prediction (or a jinx) and the ball that settles it: "Told you!", or a ribbing.
  _payOff(wicket, six, legal) {
    if (this.prediction === '') return;
    let gag = '';
    if (wicket) gag = { wicket: 'gag_told_you', six: 'gag_six_jinx', praise: 'gag_jinx' }[this.prediction];
    else if (six && this.prediction === 'six') gag = 'gag_six_called';
    if (gag) { this.prediction = ''; this._speak(gag, {}, true); return; }
    if (legal) this.predictionBalls -= 1;
    if (this.predictionBalls <= 0) this.prediction = '';
  }

  // A batter passing 25, 50 or 100 on this ball: report.milestone when the scorer says so, else
  // ctx.batterRuns (the runs of the batter who faced it, after the ball), else the situation's
  // strikerRuns compared with the ball before (strikerId tells batters apart when given).
  _milestone(ctx, r, batRuns) {
    const told = int(get(r, 'milestone'));
    if (told === 25 || told === 50 || told === 100) return told;
    let after, before;
    const br = get(ctx, 'batter_runs'), s = this.situation || {};
    if (br != null) { after = int(br); before = after - batRuns; }
    else if (s.strikerRuns != null) {
      const key = str(s.strikerId ?? 'striker');
      after = int(s.strikerRuns); before = int(this.cardRuns[key]); this.cardRuns[key] = after;
      if (after - before > 6 || after < before) return 0;      // a different batter on strike
    } else return 0;
    if (before < 100 && after >= 100) return 100;
    if (before < 50 && after >= 50) return 50;
    return before < 25 && after >= 25 && after < 50 ? 25 : 0;
  }

  // --- the between-ball chat

  _maybeChat(ctx) {
    if (this.speaking() || this.queue.length || this.now < this.quietUntil) return;
    if (this.now - this.lastChat < lerp(40, 14, this.chattiness)) return;
    if (!this.always && this.rng() >= 0.15 + 0.45 * this.chattiness) return;
    const fresh = this._chatTopics(ctx).filter((t) => this.now - (this.lastSaid[t] ?? -Infinity) >= CHAT_REPEAT && this.manifest.clips[t]);
    if (!fresh.length) return;
    const topic = this.rng() < 0.6 ? fresh[0] : fresh[this._randi(0, fresh.length - 1)];
    if (this._speak(topic, ctx)) this.lastChat = this.now;
  }

  // What's worth talking about now, the most pressing first.
  _chatTopics(ctx) {
    const out = [], s = this.situation || {};
    if (this.bouncer) out.push('bouncer_col');
    const need = this._need(ctx), balls = this._balls(ctx), score = this._score(ctx);
    const crr = score && balls > 0 ? score.runs * 6 / balls : 0;
    if (this.dotStreak >= 3) out.push('chat_pressure');
    if (int(need.runs, -1) > 0 && int(need.balls) > 0) {
      const rrr = num(need.runs) * 6 / num(need.balls);
      if (int(need.wickets, 10) <= 2) out.push('chat_tail');
      if (rrr > 12) out.push('chat_chase_steep');
      else if (rrr > crr + 1.5) out.push('chat_chase_behind');
      else if (rrr < crr - 1.5) out.push('chat_chase_ahead');
      else out.push('chat_chase_level');
    } else if (balls >= 6) out.push(crr > 9 ? 'chat_rate_fast' : (crr < 6 ? 'chat_rate_slow' : 'chat_rate_steady'));
    if (int(s.strikerRuns) >= 20) out.push('chat_batter_set');
    else if (s.strikerBalls != null && int(s.strikerBalls) <= 4 && balls > 6) out.push('chat_batter_new');
    if (int(s.bowlerWickets) >= 2) out.push('chat_bowler_hot');
    else if (int(s.bowlerBalls) >= 6 && num(s.bowlerRuns) * 6 / num(s.bowlerBalls) > 10) out.push('chat_bowler_expensive');
    if (Math.max(this.partnership, int(s.partnershipRuns)) >= 25) out.push('chat_partnership');
    // Sticking a neck out, now and then (the payoff is _payOff's).
    if (this.prediction === '' && (this.always || this.rng() < 0.5)) {
      const pick = ['chat_predict_wicket', 'chat_predict_six', 'chat_praise_batter'][this._randi(0, 2)];
      out.splice(this._randi(0, out.length), 0, pick);
    }
    out.push('chat_banter', 'chat_general');
    return out;
  }

  // --- the exchange engine

  _randi(a, b) { return a + Math.min(b - a, Math.floor(this.rng() * (b - a + 1))); }

  _prio(event) {
    if (this._isChat(event)) return 0;
    if (BIG.includes(this._base(event)) || BIG.includes(event)) return 3;
    if (NOTABLE.includes(event)) return 2;
    return MINOR.includes(event) ? 1 : 0;
  }

  // "four_cover" -> "four"; "six_big" -> "six".
  _base(event) {
    for (const b of ['four', 'six']) if (event === b || event.startsWith(`${b}_`)) return b;
    return event;
  }

  _chance(prio) {
    const c = this.chattiness;
    return prio >= 2 ? 1 : (prio === 1 ? 0.25 + 0.65 * c : 0.1 + 0.4 * c);
  }

  _replyChance(prio) {
    const c = this.chattiness;
    return prio >= 3 ? 0.45 + 0.45 * c : (prio === 2 ? 0.3 + 0.5 * c : 0.15 + 0.45 * c);
  }

  _gap() { return lerp(2.6, 0.5, this.chattiness); }
  _isChat(event) { return event.startsWith('chat_') || event === 'bouncer_col'; }

  // Say a bank event. force: skip the dice and cooldowns. Returns true when it plays or waits its turn.
  _speak(event, ctx = {}, force = false) {
    const region = str(ctx.region);
    if (region !== '' && this.manifest.clips[`${event}_${region}`]) event = `${event}_${region}`;
    const prio = int(ctx.prio, this._prio(event));
    const since = this.now - (this.lastSaid[event] ?? -Infinity);
    if (!force) {
      if (prio <= 1) {
        if (this.now < this.quietUntil) return false;
        if (since < (this._isChat(event) ? CHAT_REPEAT : (prio === 0 ? 10 : 6))) return false;
        if (!this.always && !this._isChat(event) && this.rng() >= this._chance(prio)) return false;
      } else if (prio === 2 && since < 3) return false;
    }
    const utt = this._utterance(event, ctx, prio);
    if (!utt) return false;
    if (this.speaking()) {
      if (this._interrupts(prio)) { this._interrupt(utt); return true; }
      if (prio >= 2) { this._enqueue(utt); return true; }
      return false;
    }
    this._start(utt, this.now);
    return true;
  }

  // A new ball is starting (the run-up; else the over or the release): count it once. What's
  // still queued about the last ball is old news, and nobody starts a new sentence about it: the
  // line being said finishes (a stitched sentence whole), the rest of its exchange is let go.
  _nextBall() {
    if (this.ballOpen) return;
    this.ballOpen = true;
    this.ballNo += 1;
    this.queue = this.queue.filter((u) => (u.ball ?? this.ballNo) >= this.ballNo);
    const c = this.cur;
    if (c && (c.ball ?? this.ballNo) < this.ballNo && c.idx < c.parts.length) {
      const keep = c.stitched && c.idx > 0 && c.idx < c.callLen ? c.callLen : c.idx;
      c.parts = c.parts.slice(0, keep);
      if (!c.parts.length) this.cur = null;
    }
  }

  // The bowler lets go of the next ball. An exchange about an earlier ball (a reply still going,
  // the between-ball chat, anything but the first line of a big call) fades out, so the delivery
  // is called on time and no line from the last ball hangs over this one.
  _cutStale() {
    this.queue = this.queue.filter((u) => (u.ball ?? this.ballNo) >= this.ballNo);
    const c = this.cur;
    if (!c || (c.ball ?? this.ballNo) >= this.ballNo) return;
    if (c.prio >= 3 && !this._inReply() && c.idx <= c.callLen) return;
    if (c.started) { this.fading = this.now; this._hush(FADE); }
    this.cur = null;
    this.staleCuts += 1;
  }

  // Can an exchange of this priority cut off the one playing?
  _interrupts(prio) {
    if (prio >= 3 && prio > this.cur.prio) return true;
    if (this.cur.chat && prio >= 1) return true;
    return prio >= 2 && this._inReply();
  }

  // Kate's call is over: what's left is the reply (or the gap before it).
  _inReply() {
    const c = this.cur;
    return !!c && c.started && c.idx >= 1 && this.now >= c.firstEnd - 0.01 && !c.stitched;
  }

  _enqueue(utt) {
    utt.until = this._curEnd() + QUEUE_LIFE;
    utt.ball = this.ballNo;
    this.queue.push(utt);
    this.queue.sort((a, b) => b.prio - a.prio);
    if (this.queue.length > 3) this.queue.length = 3;
    this.backend.preload?.(utt.parts.map((p) => p[0]));
  }

  // A part's length: the decoded clip's when the backend knows it, else the manifest's.
  _len(part) { return num(this.backend.duration?.(part[0]), num(part[3])); }

  // When the exchange playing will be over (now when nothing is).
  _curEnd() {
    const c = this.cur;
    if (!c) return this.now;
    if (c.idx >= c.parts.length) return c.endAt;
    let t = Math.max(this.now, c.nextAt), last = t;
    for (let k = c.idx; k < c.parts.length; k++) {
      if (k > c.idx) t += c.parts[k][4];
      t += this._len(c.parts[k]); last = Math.max(last, t);
    }
    return c.started ? Math.max(last, c.endAt) : last;
  }

  _interrupt(utt) {
    if (this.cur && this.cur.started) { this.fading = this.now; this._hush(FADE); }
    this._start(utt, this.now + FADE);
  }

  _start(utt, at) {
    if (this.fading >= 0) at = Math.max(at, this.fading + FADE);   // never inside a fade
    Object.assign(utt, { nextAt: at, started: false, idx: 0, endAt: -Infinity, firstEnd: Infinity });
    if (utt.ball == null) utt.ball = this.ballNo;
    this.cur = utt;
    this.ballSpoken = true;
    this.lastSaid[utt.event] = this.now;
    this.history.push(utt.event);
    if (this.history.length > 200) this.history = this.history.slice(-100);
    if (PREDICT[utt.event]) { this.prediction = PREDICT[utt.event]; this.predictionBalls = PREDICT_BALLS; }
    this.recent.push(utt.parts[0][1]);
    if (this.recent.length > RECENT) this.recent = this.recent.slice(-RECENT);
    this.backend.preload?.(utt.parts.map((p) => p[0]));
  }

  // An exchange: the clips to play in order (with their gaps), the voice and caption of each.
  _utterance(event, ctx, prio) {
    const m = this.manifest, part = (row, gap) => (row ? [row[0], row[1], row[2], row[3], gap] : null);
    const n = (v) => m.numbers[clamp(v, 0, m.numbers.length - 1)], frag = (k) => m.fragments[k];
    let parts = [], stitched = false;
    if (event === 'need') {
      const runs = int(ctx.runs), balls = int(ctx.balls);
      if (runs <= 0 || balls <= 0 || runs > 200 || balls > 200) return null;
      const whole = m.need[`${runs}:${balls}`];
      if (whole) parts = [part(whole, 0)];
      else {
        stitched = true;
        parts = [part(frag('they_need'), 0), part(n(runs), STITCH_GAP), part(frag(runs === 1 ? 'run_from' : 'runs_from'), STITCH_GAP),
          part(n(balls), STITCH_GAP), part(frag(balls === 1 ? 'ball' : 'balls'), STITCH_GAP)];
      }
      const rrr = runs * 6 / balls;
      const reply = this._pick(rrr <= 7 ? 'need_reply_easy' : (rrr <= 11 ? 'need_reply_close' : 'need_reply_hard'));
      if (reply) parts.push(part(reply[0], REPLY_GAP));
    } else if (event === 'end_over_score' || event === 'score') {
      const runs = int(ctx.runs, -1), wk = int(ctx.wickets);
      if (runs < 0 || runs > 200 || wk < 0 || wk > 10) return null;
      stitched = true;
      parts = [part(frag(event === 'end_over_score' ? 'end_over_score' : 'score_is'), 0), part(n(runs), STITCH_GAP), part(frag(`for_${wk}`), STITCH_GAP)];
    } else if (event === 'target') {
      const runs = int(ctx.runs, -1);
      if (runs <= 0 || runs > 200) return null;
      stitched = true;
      parts = [part(frag('they_need'), 0), part(n(runs), STITCH_GAP), part(frag('to_win'), STITCH_GAP)];
    } else {
      const ex = this._pick(event);
      if (!ex) return null;
      parts = ex.slice();
    }
    if (!parts.length || parts.includes(null)) return null;
    // Kate's call stitched from pieces counts as one line; whatever follows in Geoff's voice is the reply.
    let callLen = 1;
    if (stitched) while (callLen < parts.length && parts[callLen][2] === parts[0][2]) callLen += 1;
    if (parts.length > callLen && !this.always && !this._isChat(event)) {
      const asked = str(parts[callLen - 1][1]).endsWith('?');
      if (!asked && this.rng() >= this._replyChance(prio)) parts = parts.slice(0, callLen);
    }
    return { event, prio, parts, callLen, stitched, chat: this._isChat(event), text: '', voice: parts[0][2], colour: false };
  }

  // An exchange from the event's shuffled bag (never the one just heard when the bag refills,
  // and skipping any whose first line was said lately elsewhere when there's a choice).
  _pick(event) {
    const rows = this.manifest.clips[event];
    if (!rows || !rows.length) return null;
    let bag = this.bags[event] || [];
    if (!bag.length) {
      bag = rows.map((_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) { const j = this._randi(0, i); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      const end = bag.length - 1;
      if (bag.length > 1 && bag[end] === (this.lastPick[event] ?? -1)) [bag[0], bag[end]] = [bag[end], bag[0]];
    }
    let at = bag.length - 1;
    for (let k = bag.length - 1; k >= 0; k--) if (!this.recent.includes(rows[bag[k]][0][1])) { at = k; break; }
    const pick = bag.splice(at, 1)[0];
    this.bags[event] = bag; this.lastPick[event] = pick;
    return rows[pick];
  }

  // The clips of Kate's call (or the next part) are decoded, or have waited long enough.
  _loaded(c) {
    if (!this.backend.ready || this.now >= c.nextAt + LOAD_WAIT) return true;
    const to = c.idx === 0 ? Math.min(c.callLen, c.parts.length) : c.idx + 1;
    for (let k = c.idx; k < to; k++) if (!this.backend.ready(c.parts[k][0])) return false;
    return true;
  }

  _playPart() {
    const c = this.cur, i = c.idx, part = c.parts[i];
    const end = this.now + this._len(part);
    if (c.started && c.endAt > this.now + 0.02) this.overlapUntil = Math.max(this.overlapUntil, Math.min(c.endAt, end));
    c.started = true;
    c.endAt = Math.max(c.endAt, end);
    if (i + 1 === c.callLen) c.firstEnd = end;
    c.idx = i + 1;
    if (i + 1 < c.parts.length) c.nextAt = end + c.parts[i + 1][4];
    if (!(c.stitched && i > 0 && i < c.callLen)) { c.text = this._captionText(i); c.voice = part[2]; c.colour = part[2] === 'col'; }
    let h = null;
    try { h = this.backend.play(part[0], { gain: 1, voice: part[2] }); } catch { /* skipped silently */ }
    if (h && typeof h.stop === 'function') this.voices.push({ h, end });
  }

  // The caption from part i: a stitched sentence shows whole.
  _captionText(i) {
    const c = this.cur, whole = c.stitched && i === 0;
    const text = c.parts.slice(i, whole ? c.callLen : i + 1).map((p) => p[1]).join(' ');
    return whole ? `${text.replace(/\.$/, '')}.` : text;
  }

  /** Advance the clock: fades, the next part, the queue, the caption. */
  update(dt) {
    this.now += dt > 0 ? dt : 0;
    if (!this.manifest) return;
    this.voices = this.voices.filter((v) => v.end > this.now);
    // The interrupted exchange fading out (the backend ramps it down; the new one waits).
    if (this.fading >= 0 && (this.now - this.fading) / FADE >= 1) { this.fading = -1; this.overlapUntil = -Infinity; }
    const c = this.cur;
    if (c && this.fading < 0) {
      // A big moment is waiting: skip the reply.
      if (this.queue.length && c.idx >= c.callLen && c.idx < c.parts.length) c.parts = c.parts.slice(0, c.idx);
      if (c.idx < c.parts.length) {
        if (this.now >= c.nextAt && this._loaded(c)) this._playPart();
      } else if (this.now >= c.endAt) this._finished();
    }
    if (!this.cur) {
      this.queue = this.queue.filter((u) => u.until >= this.now);
      if (this.queue.length) this._start(this.queue.shift(), this.now + QUEUE_DELAY);
    }
    this._caption();
  }

  _finished() {
    this.cur = null;
    this.quietUntil = this.now + this._gap();
  }

  // Tell the page when the line on screen changes.
  _caption() {
    const c = this.cur, text = c && c.text ? c.text : '', voice = text ? c.voice : '';
    const key = `${voice}:${text}`;
    if (key === this._cap) return;
    this._cap = key;
    if (typeof this.onCaption !== 'function') return;
    try { this.onCaption(text, text ? (this.manifest?.voices?.[voice] || voice) : '', voice); } catch (e) { console.warn(e); }
  }
}

// The default backend: clips fetched and decoded on first use through sfx.ctx (an LRU of decoded
// buffers), each played BufferSource -> its own gain (for the fade-out) -> the voices' bus ->
// sfx.master. Silent (and fetches nothing) while there's no AudioContext or sound is off.
class WebAudioVoices {
  constructor(sfx, baseUrl, cap) {
    this.sfx = sfx; this.base = baseUrl; this.cap = Math.max(8, cap | 0);
    this.cache = new Map();            // clip id -> AudioBuffer, least recently used first
    this.pending = new Map();          // clip id -> Promise<AudioBuffer | null>
    this.fails = new Map();            // clip id -> failed loads (given up after 2)
    this.bus = null; this.volume = 1;
  }

  get ctx() {
    const s = this.sfx;
    return s && s.enabled !== false && s.ctx && s.master && s.ctx.state !== 'closed' ? s.ctx : null;
  }

  _out(c) {
    if (!this.bus || this.bus.context !== c) {
      this.bus = c.createGain(); this.bus.gain.value = this.volume; this.bus.connect(this.sfx.master);
    }
    return this.bus;
  }

  setVolume(v) {
    this.volume = v;
    if (this.bus) { try { this.bus.gain.setTargetAtTime(v, this.bus.context.currentTime, 0.03); } catch { /* closed */ } }
  }

  duration(id) { return this.cache.get(id)?.duration; }
  ready(id) { return !this.ctx || this.cache.has(id) || this.fails.has(id); }
  preload(ids) { for (const id of ids) this._load(id); }

  _load(id) {
    const c = this.ctx;
    if (!c) return Promise.resolve(null);
    const hit = this.cache.get(id);
    if (hit) { this.cache.delete(id); this.cache.set(id, hit); return Promise.resolve(hit); }
    if (this.pending.has(id)) return this.pending.get(id);
    if ((this.fails.get(id) || 0) >= 2) return Promise.resolve(null);
    const p = Promise.resolve()
      .then(() => fetch(this.base + id))
      .then((r) => { if (!r.ok) throw new Error(`${id} ${r.status}`); return r.arrayBuffer(); })
      .then((bytes) => c.decodeAudioData(bytes))
      .then((buf) => {
        this.cache.set(id, buf); this.fails.delete(id);
        while (this.cache.size > this.cap) this.cache.delete(this.cache.keys().next().value);
        return buf;
      })
      .catch(() => { this.fails.set(id, (this.fails.get(id) || 0) + 1); return null; })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  // Start a clip now (or, still loading, as soon as it's decoded, skipping what was missed).
  play(id, { gain = 1 } = {}) {
    const c = this.ctx;
    if (!c) return null;
    const t0 = c.currentTime;
    let src = null, g = null, dead = false;
    this._load(id).then((buf) => {
      if (!buf || dead || this.ctx !== c) return;
      const late = c.currentTime - t0;
      if (late >= buf.duration - 0.05) return;
      g = c.createGain(); g.gain.value = gain;
      src = c.createBufferSource(); src.buffer = buf;
      src.connect(g).connect(this._out(c));
      src.start(0, late > 0.03 ? late : 0);
    }).catch(() => {});
    return {
      stop(fade = 0) {
        if (dead) return;
        dead = true;
        if (!src) return;
        try {
          const t = c.currentTime, f = Math.max(0.01, fade);
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(Math.max(0.001, g.gain.value), t);
          g.gain.exponentialRampToValueAtTime(0.001, t + f);   // (courtside: 0 -> -60 dB)
          src.stop(t + f + 0.01);
        } catch { /* already over */ }
      },
    };
  }
}
