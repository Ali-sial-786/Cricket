# Commentary and recorded sounds: integration notes

Ported from courtside (`game/cricket/commentary.gd`, cricket branch). Nothing is wired into the
game yet: `src/audio/commentary.js` and `src/audio/samples.js` are standalone modules.

## Wiring (sketch)

```js
import { Samples } from './audio/samples.js';
import { Commentary } from './audio/commentary.js';

const samples = new Samples(sfx);
const commentary = new Commentary({ sfx });
commentary.load();                         // any time; say() is ignored until it resolves
commentary.onCaption = (text, speaker, voice) => hud.caption(text, speaker); // '' = clear; voice 'pbp' | 'col'
// after sfx.init() (first user gesture):
samples.preload();
const bed = samples.loop('crowd_bed', { gain: 0.3 });
// every frame:
commentary.update(dt);
bed.setGain(commentary.speaking() ? 0.15 : 0.3, 0.3);   // duck the crowd under the voices
// settings:
commentary.setEnabled(on); commentary.setVolume(0..1); commentary.setChattiness(0..1); // default 0.6
```

- The engine clock only moves in `update(dt)`. With no AudioContext, or `sfx.enabled === false`,
  the engine still runs on manifest lengths (captions keep working) and fetches nothing.
- `samples.play(name)` returns `true` only if it started now; `false` if the sample isn't decoded
  yet (it starts loading), is unknown / missing, or sound is off. So
  `samples.play('bat_sweet') || sfx.batCrack(q, v)` falls back to the synth.
- Groups pick a random variant: `bat_sweet` (3), `bat_edge` (2), `bat_block` (2),
  `applause_polite` (2), `footstep` (2). Singles: `crowd_bed applause_warm cheer_four roar_six
  roar_wicket appeal howzat stumps bails gloves pad catch drs_stinger chime umpire_out
  umpire_not_out coin cam_whoosh`.

## `commentary.situation` (optional, plain object the game updates)

Used when the same information isn't on `ctx`; every field may be missing.

| field | used for |
| --- | --- |
| `runs`, `wickets` | end-of-over score, run rate for chat (`ctx.score: "r/w"` wins if given) |
| `balls`, `ballsLimit` | balls bowled / left: last over, chase sum, run rate (`ctx.balls`, `ctx.need.balls` win) |
| `target` (total to reach, or `null`) | the chase: `need` at the over's end, `chat_chase_*`, `chase_start` |
| `wicketsLimit` (extra, default 10) | wickets in hand for `chat_tail` |
| `partnershipRuns` | `partnership_50`, `chat_partnership` (else counted from `ball` events) |
| `dotsInRow` | `chat_pressure` (else counted from `ball` events) |
| `strikerRuns`, `strikerBalls` | `chat_batter_set` (>= 20), `chat_batter_new` (<= 4 balls); 25 / 50 fallback |
| `strikerId` (extra) | tells batters apart for that fallback |
| `bowlerRuns`, `bowlerWickets`, `bowlerBalls` | `chat_bowler_hot` (>= 2 wkts), `chat_bowler_expensive` (> 10 an over) |
| `battingIsPlayer`, `lastSix`, `partnershipBalls` | accepted, **not used** (the bank says "they" for either side) |

## `say(kind, ctx)`: match events

Field names work in snake_case (courtside) or camelCase. Unknown kinds are ignored.

| kind | ctx read | says |
| --- | --- | --- |
| `toss` | `choice: 'bat'\|'bowl'` | `match_start` (first time), then `toss_bat` / `toss_bowl` |
| `innings` | `innings` (>= 1 = chase) or `chase`, else `situation.target` | `chase_start`, or `match_start` + `innings_start`; resets streaks |
| `over` | `style` (`FAST`/`PACE`, `SWING`, `...SPIN`), `balls`, `need.balls` | `last_over` (6 balls left), else `new_bowler[_pace\|_swing\|_spin]` |
| `runup` | - | `new_batter` (within 2 balls of a wicket) |
| `release` | `type` (0-11 or name: fast swing off_spin leg_spin seam outswing inswing slower arm_ball doosra googly bouncer yorker full_toss), `length: 'full_toss'\|'yorker'\|'bouncer'`, `pitch` (courtside metres, see below), `pace`, `no_ball` | `deliv_*` or `no_ball`; starts a new ball |
| `charge` | - | `charge` |
| `duck` | - | (state: the `ball` then says `ducked`) |
| `swing` | `result: 'leave'\|'miss'\|'duck'`, `shot`, `short`, `duck` | (state for the `ball`: `leave`, `beaten_bouncer`, `ducked`) |
| `hit` | `shot` (cut pull hook sweep glance block ...), `result: 'edge'` or `edge`, `top_edge`, `short`, `speed` (m/s), direction: `dir {x,z}` / `vel {x,y,z}` / `angle` (deg), or `region` | `top_edge` if a top edge; the rest is state for the boundary call |
| `appeal` | - | `lbw_appeal` |
| `lbw_call` | `out` | `out_lbw` / `not_out` |
| `review` | - | `drs_review` |
| `review_result` | `overturned`, `umpires_call` | `drs_overturned` / `drs_umpires_call` / `drs_stays` |
| `third_umpire` | - | `third_umpire` |
| `third_result` | `what: 'stumping'\|'run_out'`, `out` | `stumped` / `run_out` / `near_run_out` / `not_out` |
| `catch_chance` | `time` (s in the air) | (state: under 1.1 s makes it a `great_catch`) |
| `catch` | `fielder` (1 = keeper) or `keeper: true` | `caught_top_edge` / `caught_behind` / `great_catch` / `caught` |
| `drop` | - | `dropped` |
| `run_out_chance` | `margin` (m, <= 0 = safe) | `near_run_out` when safe by 0.7-1.2 m (`thirdUmpireMargin`) |
| `run_out` | - | `run_out` |
| `boundary` | `runs` (4 / 6), optional `region` | `four[_cover\|_straight\|_pull\|_hook\|_cut\|_sweep\|_edge\|_top_edge]`, `six[_straight\|_cover\|_pull\|_hook\|_big\|_top_edge]` |
| `wicket` | `how: bowled\|caught\|lbw\|stumped\|run_out` | the wicket call, unless this ball's was already called |
| `ball` | `outcome {runs, extras: ''\|'wide'\|'no_ball', boundary}`, `report {wicket, runs, over_done, innings_done, hat_trick, milestone, free_hit, maiden}` or the same flat (`runs, wide, noBall, boundary, wicket, overDone, inningsDone, hatTrick, milestone, freeHit, maiden`); `batterRuns`; `score`, `balls`, `need {runs, balls, wickets}` | `single two three wide dot leave defended ducked beaten_bouncer`; any uncalled four / six / wicket; `partnership_50`, `hat_trick`, `hat_trick_ball`, `milestone_25/50`, `free_hit`; at the over's end `maiden`, then `need` (+ `chase_close`) in a chase, else `end_over_score`; the running-gag payoffs; if nothing was said, maybe a `chat_*` exchange |
| `innings_break` | - | `innings_end` |
| `result` | `winner` (-1 tie, >= 0 a side) + `text` containing " RUN", or `by: 'runs'\|'wickets'`, or `tie: true` | `tie` / `won_runs` / `won_wickets` |

Minimum useful set: `innings`, `over`, `release`, `hit`, `boundary`, `wicket`, `ball`, `result`.
`MATCH_KINDS` is exported.

Shot direction convention (courtside): from the striker, straight down the ground is +z, the off
side is -x; `angle` is degrees from straight (negative = off side). `pitch` is where the ball
lands, z along the pitch from its middle, striker's popping crease at -8.84 (z < -9.4 full toss,
z < -8.3 yorker for pace). The JS game's axes differ, so prefer `length` / `angle` / `region`.

## `say(kind, ctx)`: bank events (played directly)

Any key of `manifest.clips` (112 events). `ctx.region` picks a variant event (`four` + `cover`);
`ctx.prio` overrides the priority.

- Big (3): `four* six* bowled caught caught_behind great_catch caught_top_edge stumped run_out
  out_lbw dropped hat_trick won_runs won_wickets tie`
- Notable (2): `match_start toss_bat toss_bowl innings_start chase_start innings_end last_over
  chase_close chase_easy milestone_25 milestone_50 partnership_50 lbw_appeal not_out drs_review
  drs_umpires_call drs_overturned drs_stays third_umpire near_run_out hat_trick_ball free_hit
  no_ball maiden top_edge gag_told_you gag_six_called gag_six_jinx gag_jinx`
- Minor (1): `single two three wide overthrow misfield good_fielding end_over new_bowler
  new_bowler_pace new_bowler_swing new_bowler_spin new_batter ducked beaten_bouncer`
- Filler (0): `dot leave defended charge deliv_seam deliv_outswing deliv_inswing deliv_slower
  deliv_off_break deliv_leg_break deliv_arm_ball deliv_doosra deliv_googly deliv_bouncer
  deliv_yorker deliv_full_toss`, the chat (`chat_rate_fast/slow/steady chat_chase_ahead/behind/
  steep/level chat_tail chat_batter_set/new chat_partnership chat_pressure chat_bowler_hot/
  expensive chat_banter chat_general chat_predict_wicket chat_predict_six chat_praise_batter
  bouncer_col`) and `need_reply_easy/close/hard` (Geoff's answers to the chase sum)
- Stitched numbers: `need {runs, balls}` (180 whole sentences for 6 / 12 / 18 / 24 balls left,
  otherwise stitched; 1-200), `end_over_score {runs, wickets}`, `score {runs, wickets}`,
  `target {runs}` (runs 0-200, wickets 0-10; out of range = silent)

Only reachable directly (no match event maps to them): `overthrow misfield good_fielding
end_over chase_easy score target`.

## Differences from the Godot original / not ported

- Captions: no UI here, only `onCaption`. No `set_captions`.
- Volume is linear 0..1 (was dB); settings are methods / properties, not the tuning registry.
- `audio.gd`'s mixing is not ported: the crowd bed ducking under speech and the commentary dip
  under the bat crack / appeal are the game's job (`speaking()`, `setVolume()`, `loop().setGain()`).
- Context the original read from the match object now comes from `ctx` / `situation`: the hit
  direction (`dir` / `vel` / `angle` / `region`), run rate, striker and bowler figures. The 25
  milestone (original: batting cards) needs `milestone: 25`, or `batterRuns` on the `ball` event;
  the `situation.strikerRuns` fallback misses a batter who reaches it and goes off strike.
- Deliberate deviations: (1) a wicket / boundary said as a direct bank event, or `run_out`, marks
  the ball as called so the following `ball` doesn't call it twice (the original double-called a
  run out); (2) per-ball state is also cleared at the end of `ball`, so a game that never sends
  `release` still works; (3) a line holds up to 1.5 s for its clip to decode instead of starting
  clipped (web only); part lengths come from the decoded buffer when cached, else the manifest.
- Clips: fetched on first use (an exchange's clips are requested when it is chosen), LRU of 120
  decoded buffers (`cacheSize` option), two attempts per clip, then skipped silently.
- The welcome lines name the ground "Courtside Oval" (2 clips, `match_start_0_0`, `_4_0`): the
  audio is as recorded.
- Not ported from the courtside test: checking each .ogg's real duration against the manifest
  (no decoder in node). The WebAudio backend and `Samples` were checked by hand in headless
  Chrome, not by `node --test`.
- Skipped assets: `assets/cricket/audio/source/`, `bat_*.wav` fallbacks, `bounce.wav`, `whoosh.wav`,
  `crowd-manifest.json` (not in the requested list).
