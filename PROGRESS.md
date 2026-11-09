# Progress

_Last updated by the overnight build._

## Done
- **Phase 1: Nets (batting core)**
  - Real-scale pitch (20.12 m, creases, 71.1 cm stumps, 7.2 cm / 160 g ball).
  - Pure-JS physics at 480 Hz: gravity, quadratic drag, swing, Magnus, spin-coupled bounce, seam.
  - Bowling machine: pace, line, length, swing, seam, off/leg spin, over/around, variation, auto-feed.
    It solves the launch so the ball pitches where you asked. Release cue: red → amber → green lights plus beeps.
  - Swept bat collision. Bat pose is lerp/slerp-interpolated across substeps and sphere-traced
    against the bat SDF, so nothing tunnels at 72/90/120 Hz.
  - Contact physics: relative restitution, sweet spot, thick and thin edges, back of bat, handle.
    Haptics are strongest on the sweet spot.
  - WebXR: `immersive-vr` + `local-floor`, highest frame rate up to 120 Hz, fixed foveation, safety screen,
    calibration saved to `localStorage`, laser menus, recenter, metric units / km/h.
  - Desktop debug mode with mouse batting and bowling, keyboard actions and multiple cameras.
- **Phase 2: Bowling**
  - Teleport to the bowling end; hold the trigger, bowl overarm, release.
  - Pace from hand speed × multiplier with a cap. Line and length come from release direction, with an aim marker assist.
  - Wrist roll gives spin; A/B pick swing; one-tap release calibration.
  - Physics-driven AI batter: leave/defend/drive/pull/cut/flick by line, length and difficulty. It can edge, miss or be bowled.
  - 6-ball overs, runs conceded and wickets.
- **Phase 3: Match**
  - Ten fielders plus the keeper (and the bowler when the AI bowls) with chase, catch, throw and automatic running. 65 m boundary.
  - Run Chase, Bowl an Over (defend a total) and Match (bat, then bowl). Result screens.
  - In-world HUD and stadium scoreboard.
- **Phase 4: Polish**
  - Synthesised audio: quality-dependent bat crack, bounce, stumps, beeps, crowd and cheers.
  - Difficulty (easy/medium/hard) and a settings menu: overs, bat angle, bat power, bowling pace,
    haptics, aim assist and marker, trail, sound.
  - MR nets: place the stumps on your real floor (hit-test, with floor-plane fallback); the pitch extends into passthrough.
- 44 unit tests (`npm test`) covering physics, machine solver, tunnelling, calibration maths,
  bowling mapping, AI batter, fielding and scoring.
- GitHub Pages workflow: tests, then deploy.

## Next (suggested after the first headset session)
1. Tune from the TESTING.md numbers: bat power, pace multiplier, neutral release angle, AI difficulty, fielders.
2. A non-striker figure, and both batters visibly running between the wickets.
3. Simplified LBW (pad collider + "would it hit the stumps" check).
4. Optional left-handed batting (mirror X).
5. A replay of the last ball from a broadcast camera.
6. Wide/no-ball umpire signals; a third-man/fine-leg rotation for left-handers.

## Robustness pass (after an independent review of headset-only code paths)
- Menus re-placed from the fresh head pose after every rig move. Y re-summons the menu if you lose it.
- The laser now points forwards. The Quest system recenter (Meta button) triggers a game recenter (VR)
  or stump re-placement (MR).
- The game pauses when the session loses focus. The right thumbstick click opens the menu if the left controller is off.
- Exit VR restores the desktop camera. A failed session start ends the session.
- Automatic frame-rate step-down if 120 Hz can't be held.

## Known issues / not verified
- **Not tested on a real headset.** All XR paths ran only under Meta's IWER emulator in headless Chromium
  (no pose velocities, haptics, hit-test or passthrough there). Haptics, `updateTargetFrameRate`, pose velocities
  and MR hit-test are coded defensively but unverified.
- The uncalibrated default bat orientation is a guess about the Quest grip-space axes. Calibrate on first use
  (the game prompts you).
- The AI batter has no body collider, so there is no LBW.
- Fielders are figures with simple arm/bob animation (no leg animation). The ball can pass through bodies.
- Desktop bowling with the mouse is awkward by nature. Use **B** (auto-bowl at the marker) for quick tests.
- Headless test renders run at about 20 fps (software GL), so in-browser timings were checked with
  frame-synchronised scripts, not by feel.
