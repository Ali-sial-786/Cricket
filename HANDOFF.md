# HANDOFF — replays + run-up text (branch wt-replay2, WIP commit 30d10cd on top of 170638a)

Stopped mid-task on the coordinator's instruction. Nothing is pushed. `npm test` passed 187/187 after the first
round of edits; it was NOT re-run after the later edits (vignette gradient, RATE 90, `fieldController.planCatch`
guard, `config.catching.minTime/minGap`). `final.mjs` (4-mode smoke) has NOT been run on this code.

## 1. Finished and seen working in the harness (emulated headset, 72 Hz)
- **One continuous replay camera** (`src/game/replayFraming.js` `planCamera / cameraAt / cameraBase / pathStats / CAM`,
  used by `src/game/replay.js` `layoutCamera / moveCamera`). Base 7.5 m behind the bowler's stumps, 3.5 m up, x = 0,
  facing down the pitch; from `clip.key` (bat / pad / ball reaching z > -1.6) it turns to the ball (yaw only,
  0.3 s look-ahead) and glides after it once the ball is > (distance to batter + 6 m) away. Whole path is laid out at
  replay start from the recorded ball. Limits: headset 6 m/s, 4 m/s², 75°/s, 220°/s²; monitor 12, 9, 120, 420
  (monitor also tilts to the ball, FOV 36). Height constant. No cuts, no blackout, no second angle.
- **Every ball gets a replay**: `game.js recordForReplay` marks `dead` when the session leaves 'live', and calls
  `replay.schedule(t)` on entering 'settle'. `Replay.plan()` = release - PRE(1.5 s) … dead + TAIL(1.0 s). No crease
  clip, no `reviewed` exclusion any more. Order chosen: **ball → appeal/DRS/third umpire (unchanged) → verdict →
  replay → next ball**. Recording stops TAIL+0.2 s into a 'review' state so the ball is still in the 24 s ring buffer
  after a long DRS. If the session leaves 'settle' before the replay is due (X = next ball), the replay starts at once
  and the next ball waits (`Replay.update`). An open menu pauses a replay instead of stopping it.
- **Skip** = left (off-hand) trigger only (`Replay.skipButton/skip`; Space/Enter on a monitor). The press is consumed:
  `Button.swallow()` in `src/xr/input.js` (reads as up until really released). There is no handedness setting in the
  game: bat and ball are always the right controller, so off-hand = left (right only if no left controller).
- Label: "REPLAY / off-hand (left) trigger skips". HUD panel, message strip, hints and bowl card are hidden in replays.
- Harness results (new code): leave, single, FOUR, SIX, bowled, LBW review (not out), run-out with dive (RUN OUT 3.0 m
  short), caught, nets ball, and bowling `over` ×3 + `bowlnets` ×1: replay happened every time, ended by 'end',
  **0 cuts**, max step ≤ 0.083 m/frame, max speed ≤ 6.0 m/s, max accel ≈ 4.5 m/s² (frame-differenced), max yaw ≤ 75°/s,
  0 dark frames after the first 0.3 s, height 3.50 m constant, min distance to any body 1.86 m, to stumps 26.7 m,
  ball within ±32° of forward 100 % of post-hit frames — EXCEPT a straight hit back past the bowler (bowling ball 2,
  a four): 74 %, worst 58° (needs a ~160° turn at 75°/s; see §4).
- **Your bowler in bowling replays**: he IS recorded and drawn (strip_over_b2, strip_bowler_figure). Root cause of
  "no bowler" in the recording: old camera stood 3.6 m behind the stumps at 4.3–8.3 m (lifted when someone blocked the
  sight line) looking level, so the bowler at the crease was 30–55° below the horizon = under the recorded frame.
  No re-solve was added; the live `PlayerBowlerActor.update` pose (head + hands) is what is replayed.
- **Text during the delivery**: `ui.quiet` (getter, asks `session.quiet()`): 'clear' = nothing at all (HUD panel,
  prompt strip, hints, card hidden; `prompt()` calls dropped), 'live' = HUD hidden, prompts/hints allowed, null = all.
  Batting: clear from 'cue'/'runup' until hit/pad/byes/stumpAt/crossedCrease, then live until dead. Bowling: clear while
  run state is running/committed/crease (or ball gripped with run-up off), live after release. HUD visibility now goes
  through `ui.showHud()` (lbwFlow, thirdUmpire, batting/bowling exit) and is computed in `ui.update()`.
  Batting `prepare()` now has an announce phase: new-bowler card / FREE HIT shown for ANNOUNCE = 1.8 s while state is
  still 'idle', then the run-up starts. "NO BALL" text at release removed (signal + sound stay; text at the result).
  "New batter in" moved to `finish()`. Bowling harness: UI list empty at run-up start+0.2 s, mid, release (3 balls).
- Item 5 ("hitting the stumps" on a dot ball): `bowling.js stumpLine()` describes the LINE as bowled (predicted
  crossing at the stumps, computed at release), shown at first bounce — not a result. Reworded to "on the stumps" /
  "over the top of the stumps".

## 2. Half-done / not verified — exactly where I stopped
- `rp2_skip.mjs` was running when stopped: **no result seen**. Skip logic is written but unverified (incl. bowling: the
  skip press must not start a run-up since left trigger is a run button; X-before-replay; menu pause).
- Sliced re-pose of your batting figure: `people.js PlayerBodyView.resolveBegin/resolveStep/resolveEnd` (+ `resolve`
  kept as a wrapper), driven by `Replay.stepJob` (4 poses a frame, starts writing 0.8 s into the clip). Runs without
  errors in the batting scenarios but the figure was not looked at close up, and start-up cost was not re-measured.
- `fieldController.planCatch` guard (no player catch if ball arrives < 0.3 game-s after the bat, or the stand point is
  < 3 m from the striker; the AI fielder then takes it): written, syntax-checked, **never run**.
- `bowling.js toMark()`: view fades in from dark (`g.replay.fade.cut()`) when it moves you > 0.5 m: written, not looked at.
- ViewFade (0.22 s in from black) on replay start, end and skip: works at start (first strip tile is black); exit not looked at.
- Comfort vignette gradient tightened (clear to ~32°, dark by ~58°): changed after the last look.
- NOT done: unit tests for planCamera/pathStats and replay-for-every-outcome; "before" (HEAD) runs for comparison
  (HEAD export is at scratchpad/rp2_head); batting text screenshots/UI list at run-up start/mid/release per mode;
  desktop (DESK=1) runs; final.mjs; README / DECISIONS / TESTING updates (they still describe the old director,
  crease replay, batter's-view option, "any button skips").

## 3. Root causes found (don't rediscover)
- **Missing replays**: (a) a pending replay was dropped whenever the session left 'settle' — pressing X (run / next
  ball) after the result did `requestNext()` → 'idle' → dropped (D07 FOUR, D10 run-out); (b) `marks.reviewed` → no
  replay after DRS; (c) `marks.break` replaced the ball's replay with the square-on crease clip (run-out/dive balls).
- **Cut short**: any button (trigger/A/B/grip, either hand) or an open menu stopped it.
- **Cuts/dips**: `Replay.direct()` built 2–3 shots (fixed behind bowler → 'side' at K-0.35 → 'chase') with a blackout
  dip (`FADE`) between; XR chase only existed if > 0.8 s remained after hit+0.7.
- **Black slab**: not geometry. `Replay.start()` blocked the frame: measured 99.5 ms on this desktop (86 ms in
  `playerBody.resolve`, rest in `direct()`'s `score()` = dozens of `apply()` calls); on Quest that is a 0.2–0.4 s frozen
  frame, and the compositor reprojects the old frame as the head turns → black where there is no image, sliding in
  from the side you turn to. Fix = no `apply()` loops at start + sliced resolve.
- **Recording rate**: RATE was 60 with a "skip if dt < 1/60" rule → 36 fps at 72 Hz, 45 fps at 90 Hz. Now RATE 90,
  24 s buffer (1558 floats/frame with 18 figures ≈ 13.5 MB).
- **UI that survives `clearHints()`**: the prompt strip (`ui.prompt`: bowler card 3 s, FREE HIT 3.5 s, NO BALL 2.2 s —
  all were issued at/after run-up start) and the world-locked HUD panel (`ui.hud`: last result, stats, footer control
  line; also visible inside replays).
- **"Dive pose" in replay 6 (2:34.6)**: not a dive and not a replay-side leak. It is your own figure
  (`playerBody.actor`); zooming the behind-bowler phase (2:34.2–2:34.5) shows it tipping over progressively before the
  cut, then recovering as the captured shot fades in (`actors.js playerBatting`, w = sstep(c.t0-0.02, c.t0+0.15)). So the
  procedural pose (`batProcedural`, head-driven) was near horizontal just before the shot blended in. `updateDive` is
  only ever called on the runner / non-striker actors (people.js:40,175); `Replay.apply` only writes recorded bones.
  Belongs to the batting-body worker. Could not reproduce (no real headset tracks).
- **Catch camera (4:21.5)**: `fieldController.planCatch` gives the player every airborne chance when bowling; with the
  keeper up to a spinner the catch point is ~1 m behind the bat, so `beginViewOverride` put the player 0.42 m behind
  it facing the striker (his body fills the view) with ~0.15 game-s of flight (×1/0.22 slow-mo). Guard added (§2).
- **View jump 4:31.7**: `bowling.js` settle end → `toMark()` (instant reposition to the top of the mark).

## 4. Remaining work, in priority order
1. Run `npm test` and `final.mjs`; run `rp2_skip.mjs`, fix what it shows.
2. Unit tests: planCamera (continuity, speed/accel/yaw bounds, ball-in-cone for square/cover/pull/six/edge/leave,
   documented exception for the straight hit) — `scratchpad/rp2/plan_try.mjs` has the synthetic shots; plan()/schedule().
3. Before/after numbers on HEAD (`GAME_ROOT=…/scratchpad/rp2_head`; rp2_lib tolerates the old Replay API).
4. Batting text proof: `window.__uiList()` + screenshots at run-up start+0.2 s / mid / release in nets, chase, match.
5. Verify planCatch guard, toMark fade, replay exit fade, sliced resolve (start cost with `rp2_cost.mjs` idea).
6. Straight hit past the bowler: ball out of the ±32° cone ~1.5 s (limit = (180-64)/75°/s). Options: higher wMax for
   that case, or accept (user can turn the head; rig yaw is independent of the head, reference taken at replay start).
7. Docs: README (replays section, controls table), DECISIONS R1/B10/H6/H10, TESTING §10, PROGRESS.
8. Merge note: `people.js` resolve was split (other workers touch people.js / the body solver).

## 5. Harness (run from /tmp/claude-0/-home-user/7a34817a-ee95-55d8-8096-5738f2047226/scratchpad/harness)
`GAME_ROOT=/home/user/wt-replay2 node harness.mjs <scenario> <outdir>`; all rp2 scenarios emulate a headset
(`rp2_lib.mjs install()`: fake head/controllers via `window.__head/__hand/__btn`, `__render`, `__uiList`, `__capFrame`,
`__stats`; `DESK=1` = monitor path). They step without rendering (software GL is slow) — expect 2–6 min each.
- `rp2_lib.mjs` — helpers (startBatting/__toBat/__hit/__play, startBowling/__bowl, captureReplay → strip + stats).
- `rp2_bat.mjs` (`CASES=leave,single,four,six,bowled,lbw,runout,caught,nets`) → `rp2_out_bat_a1/strip_*.jpg`.
- `rp2_bowl.mjs` (`MODES=over,bowlnets`) → `rp2_out_bowl_a1/strip_over_b1..3.jpg`, `strip_bowlnets_b1.jpg`.
- `rp2_bowlfig.mjs` → `rp2_out_bowl_a1/strip_bowler_figure.jpg`. `rp2_skip.mjs` → console only (unverified).
- `rp2_cost.mjs` (HEAD start cost: 99.5 ms), `rp2_dbgbowl.mjs`, `rp2_dbg2.mjs` — one-off probes (old API in places).
- Recording crops I made: scratchpad/rp2_vid/farcrop.jpg (the "dive" figure tipping over), full.jpg.
