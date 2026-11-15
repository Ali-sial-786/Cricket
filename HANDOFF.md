# Handoff: batting body overhaul (branch wt-bat2)

## Current status (second engineer, keep this section up to date)
- `npm test`: 205 pass (new: tests/shotSense.test.js 8, tests/footwork.test.js 9, tests/playerBody.test.js 7 on the
  real rig: gloves, pops, trunk tilt, slide, turf, stumps, head, sliced replay == live, determinism).
- Node-only metrics runner (no browser, ~12 s for all 14 tracks): `<scratchpad>/bat2n/run.mjs [shot,shot]`
  (ROOT=<tree> for the baseline: `ROOT=<scratchpad>/bat2_before_tree OUT=before.json`); traces: trace.mjs, stages*.mjs,
  slide.mjs, feet.mjs, reach.mjs, kneeang.mjs, caphips.mjs (capture pelvis yaw), capscan.mjs.
- Browser strips: harness/bat2_shots.mjs (out: harness/bat2_out_b2 = latest full set), capture reference gallery
  harness/bat2_caps.mjs -> harness/bat2_out_caps/cap_<shot>.jpg.
- Done since 9de5b08 (see commits): sliced replay re-solve (resolveBegin/Step/End, same interface as wt-replay2),
  arm length logged per frame + replayArms(t) (game.js replay branch calls it), head look rate-limited, knee kept
  out of the turf continuously (liftPole) + shin pad check, pelvis placed by weighted two-ball projection (no squat),
  trunk follows captures at <= 10 rad/s, hips within [-0.6, 0.9] rad of the feet (back foot pivots), knee bend
  direction rate-limited, landing retarget fades out (no slide), shoulders turned about the trunk axis, head
  re-aimed after blends, re-grip after the guard without a second lean, kneel smooth in head height, bat face
  in shot reading (cover vs straight vs on), extra.live logged (between balls only a full shadow stroke engages).
- Next: ghost look (item 6), AI striker smoothing (item 5), final strips, DECISIONS.md, before/after table.

## First engineer's handoff (kept for reference)

Base: 170638a. Everything below is in the WIP commit on wt-bat2. Nothing pushed.
`npm test` was NOT run after the changes (last known: 187 pass at 170638a). The smoke `final.mjs` was NOT run either.

## What exists now (new design, working end to end in the harness)
- `src/render/shotSense.js` (new, pure JS): `ShotSense.update(t, dt, head, grip, axis, off, ctx)` -> continuous
  features, swing phase (0 stance, 1 top of backlift, 2 contact, 3 finish; from the blade's angle/speed, state
  machine ready -> down -> follow -> recover), soft weights over the 14 capture names (`FAMILIES`), hysteresis
  (`SENSE.stay`), weights locked 0.06 s after contact, engagement E (critically damped). `scoreShots`,
  `weighShots`, `captureTime` exported. State is plain data (`save()/load()`).
- `src/render/footwork.js` (new, pure JS): `Footwork.update(dt, {hx, hz, crouch, quiet, engage, pat, kneel, pin, stumpsZ, maxStride})`
  -> planted feet that step (never slide): ranges round the head, one foot at a time, stroke footwork from
  the capture's stance->contact foot displacement (`pat`), kneel layout, stumps box, back-foot pin for stumpings.
- `src/render/playerBody.js` (new): `PlayerBodyView` moved here (people.js now only re-exports it).
  `solve(e)` is the single solver for live and replay: sense -> feet -> neutral body (`BatterActor.solveBody`)
  -> `strokeBody` (weighted captures at the bat's phase, pelvis = real head minus capture trunk, legs IK to
  planted feet) -> blend by E -> `yieldLegs` (continuous replacement for legsClearOfBat) -> `gripBat` -> `look`
  -> `syncShadow` (+ re-grip if the ground guard lifted the root).
- Removed: `src/render/playerShot.js`, `tests/playerShot.test.js`, `BatterActor.playerBatting/playerShotBody`.
- `tests/battingTracks.js` (new): scripted head/bat/off-hand tracks in the log-entry format, 14 scenarios (`SHOTS`).

## Interface changes (tell the replay / people workers)
- `PlayerBodyView.update(dt, t, batPos, batQuat, ball, head, extra, off)`: new 8th arg = off-hand controller
  position or null (game.js passes `input.left.gripPose.p`).
- `PlayerBodyView.resolve(t0, t1, write)` kept, same signature. It now restores a saved solver state from the log
  (`e.state`, every 12 frames) and re-runs `solve`; returns true whenever the log covers the clip (before: false
  when no shot). Measured live-vs-replay difference: 0.00 deg / 0.00 cm on all 14 scenarios.
- `PlayerBodyView.reader` (old ShotReader) is gone; use `.sense`, `.feet`, `.st`, `.shotLabel()`, `.reset()`.
- Log entries: `{t, dt, bp, bq, head:{p,q}, off, ball, extra:{sweep, hit:{t}, crease}, sc, state?}` (plain objects).
- Replay caveat (not mine to fix): replays restore arms to their own length (`game.js` restArms), but the live
  figure stretches arms up to ~4-10% when the bat is out of reach, so gloves can sit a few cm off the handle in
  replays. Storing the 4 arm bone positions per frame in replay.js would fix it.
- Shared-file edits (small): `humanoid.js clearFoot(side, pole = null)`; `actors.js` solveBody options
  `noGrip, noLegClear, yawPoint`, `plantFeetYaw` stores `_poleL/_poleR`, `kneel(sweep, k, yawL, yawR)` with
  `sweep.planted` (feet stay planted, poles/feet blended by k), `reachLean` honours `this.leanMax`,
  `reachShift` honours `this.reachLimit`. `people.js`: class removed, re-export added, ShotReader import removed.

## Root causes found (do not rediscover)
- Old flow: `ShotReader` picked one class at swing start, re-picked at contact, then a capture was played on a
  clock anchored at the feet. Kneel/crouch at contact of a drive and splayed legs come from that (reproduced:
  `bat2_out_before_try/strip_cover_drive.jpg`). Baseline numbers for cover_drive at 170638a: joint jump 177 deg
  per frame, pelvis 31 cm/frame, foot slide 95 cm, head error 34 cm, live-vs-replay 180 deg / 37 cm.
- `legsClearOfBat` pushes the knee pole >= 0.5 m sideways the moment the blade is within clearance: a one-frame
  knee flip, sometimes bending the knee backwards (likely the "leg pointing sideways" in the recording). Replaced
  for the player by `yieldLegs` (rate-limited push, knee kept on the foot's forward side via `kneeWay`).
- `h.clearFoot` re-solves with its own pole whenever the sole is a hair under the turf: bistable flicker of
  10-25 deg on static input. Fixed by passing the pole the leg was planted with.
- Blending knee poles by lerp flips when the two directions are far apart; captures (from video) have knees
  that point backwards on straight legs. Fixed with `kneeWay` + rotating one direction into the other.
- `kneel()` switched pole and foot orientation at k > 0.01 (130-150 deg pop going down). Now blended by k.
- Capture ankle yaw is noisy (up to 2 rad): only 50-60% of it is used, capped; back foot uses toe-pivot from
  the capture's heel height, not the capture's foot quaternion.
- A stride needs the head to come down: max stride = 2*sqrt(leg^2 - hipHeight^2); passed to the planner.
- groundGuard lifts the root after the grip, taking the gloves off the handle (8 cm in the sweep): re-grip added.
- Sense: velocities must be taken relative to the head (walking down the pitch read as a swing); lifting the
  bat must not trigger (requires blade coming down or sweeping round the vertical); a block needs the hands in
  front of the head (the middle of the bat is under the eyes in a forward defence).
- Harness: the figure must be scaled to the player (`h.root.scale = baseScale * 1.62 / (headRestY + 0.11)`),
  game.frame does that in the real game; the scenarios do it by hand.

## Numbers so far (new solver, 72 Hz, last full metrics run, strips in `bat2_out_a2`)
glove error <= 0.19 cm all shots; replay diff 0; ground guard <= 2.4 cm except sweep 9.3 cm;
max body-joint jump per frame (deg): fwd defence 17.7, cover 9.5, straight 9.3, on drive 11.7, cut 11, pull 24.5,
hook 94.5 (head look yaw wrap), sweep 41.5, punch 17.3, leave 11.4, advance 18.8, slog 24, waggle 11.8, deep_back 9.7;
foot slide total <= 0.3 cm except advance_drive 18.5 cm (max 4.5 cm/frame);
head error max: cover 24.8, on drive 20.6, sweep 21.6, advance 19.7 cm, others 4-15 cm; stumps clearance deep_back -6 cm.
Shot read: all 14 name the intended family; early in the downswing the name can change once or twice
(defence -> drive as speed builds, square_cut -> pull/hook) while E is still small.
Full baseline (170638a) run of all 14 scenarios has NOT been done, only cover_drive.

## Half-done / where I stopped
1. Was tracing advance_drive foot slide with `harness/bat2_dbg3.mjs` (prints frames where a grounded ankle moves
   > 0.8 cm). Its output was not read. Not yet known whether it is unreachable legs while walking upright or
   the planner retargeting a landing foot.
2. `PlayerBodyView.look`: yaw wrap still pops (hook 94 deg at 2.61 s): unwrap against `st.look` and rate-limit.
3. Sweep: body still sinks ~9 cm (guard lifts it) and pelvis moves 8.8 cm/frame going down; the `KNEE_MIN` loop
   is only in `strokeBody`, check the neutral `kneel` path and the blend re-pin in `solve`.
4. deep_back: legs still 6 cm into the stumps; planner clamps feet (`stumpX/stumpZ`) but knees/shins are not
   checked, and the first placement (`init` in Footwork.update) is not clamped.
5. Head error in follow-throughs comes from `gripBat -> reachLean` (limited to 0.2+0.1 rad via `leanMax`). Idea
   not yet done: raise the chest-yaw-to-hands gain (0.45) in `strokeBody` when the hands are out of reach.
6. "stretch" reads 1.035-1.04 in every scenario (even the leave): arms seem to stretch ~4% all the time; cause
   not investigated (`stretchTo` in actors.js).

## Not started (priority order)
1. Unit tests: `tests/shotSense.test.js` (features -> weights, hysteresis, no trigger on lift/walk),
   `tests/footwork.test.js`, `tests/playerBody.test.js` (invariants on the real rig; setup pattern in groundContact.test.js).
2. Run `npm test` and `final.mjs` (4 modes); fix whatever the removal of playerShot.js broke
   (`src/game/crease.js` only mentions it in a comment). Desktop (no headset) path uses a synthetic head in
   `solve` and is untested.
3. Ghost look (task item 6): nothing done. Plan: depth pre-pass mesh for the ghost so pads/gloves draw one
   layer (no smoke), gloves opaque with a fade when within ~0.35 m of the eye, in `humanoid.js setGhost` / kitMaterial.
4. AI striker smoothing (task item 5): nothing done; `BatterActor.mocapBody/batProcedural` untouched and still
   use `legsClearOfBat` (same knee-flip risk).
5. Full before/after table and final strips; DECISIONS.md entry (B9/B10 are now out of date).

## Harness (shared folder /tmp/claude-0/-home-user/7a34817a-ee95-55d8-8096-5738f2047226/scratchpad/harness)
- `bat2_shots.mjs`: all scenarios, metrics + strips. `GAME_ROOT=/home/user/wt-bat2 node harness.mjs bat2_shots.mjs <out>`;
  env `SHOTS=a,b`, `NOSTRIPS=1`, `HZ`. Pipe stdout through `python3 bat2_fmt.py` for one line per shot.
  Works on the old tree too: baseline export at /tmp/claude-0/-home-user/7a34817a-ee95-55d8-8096-5738f2047226/scratchpad/bat2_before_tree
- `bat2_dbg.mjs` (per-frame trace: `SHOT`, `TH` deg, `FROM/TO`), `bat2_dbg2.mjs` (one leg's joints), `bat2_dbg3.mjs` (foot slide), `bat2_rig.mjs` (rig sizes, capture foot patterns).
- Outputs: `harness/bat2_out_before_try/` (baseline cover drive strip), `harness/bat2_out_a1/` (first full run, strips, older code),
  `harness/bat2_out_a2/` (latest: strips for sweep, deep_back, advance_drive, cover_drive; metrics.json for those four).
- Node-only checks: /tmp/claude-0/-home-user/7a34817a-ee95-55d8-8096-5738f2047226/scratchpad/bat2_sense.mjs (shot timeline per track), bat2_feet.mjs (planner trace).
