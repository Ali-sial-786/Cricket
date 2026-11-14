# Progress

_Last updated after the sixth pass (contact, views, replays, keeper, hints, crowd)._

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

## Visual & animation upgrade
- Articulated skinned athletes (IK hands and feet, ball-tracking heads, team kits), with a full bowling action
  (run-up, bound, braced front leg, IK arm through the release point, follow-through).
- Batting footwork and torso rotation. Fielders walk in, crouch, chase, dive, pick up, throw and celebrate;
  the keeper gathers; batters run between the wickets.
- Rebuilt stadium: tiers, roofs, pavilion, LED boards, cloud sky, skyline, floodlight halos, tone mapping.
  Shaped bat, leather ball, dust and fireworks particles.
- Desktop broadcast camera with the player's own animated body.

## Robustness pass (after an independent review of headset-only code paths)
- Menus re-placed from the fresh head pose after every rig move. Y re-summons the menu if you lose it.
- The laser now points forwards. The Quest system recenter (Meta button) triggers a game recenter (VR)
  or stump re-placement (MR).
- The game pauses when the session loses focus. The right thumbstick click opens the menu if the left controller is off.
- Exit VR restores the desktop camera. A failed session start ends the session.
- Automatic frame-rate step-down if 120 Hz can't be held.

## Gameplay overhaul (third pass)
- **Models:** the athlete from the Courtside project, re-rigged to this game's 17-bone IK skeleton, with kit
  colours, helmets, caps, pads and gloves; two LODs. Umpires at the bowler's end and square leg.
- **Difficulty:** easy / medium / hard now change ball-in-flight time scale (0.70 / 0.85 / 1), sweet-spot size,
  bowler pace, fielder speed and the chase target.
- **Bowler types:** swing, fast, seam, off-spin and leg-spin, each with its own pace range, run-up and named
  deliveries; one bowler per over.
- **Batting:** bat-face-led launch angle, wider blade, stride down the pitch (trigger), sweep / reverse sweep /
  slog sweep (grip), movement in the crease (stick or real steps), stumpings.
- **Running:** manual calls (X), one run at a time, turn back (left trigger), dive (Y), run-outs at either end.
- **Bowling:** delivery decided by the action. Hand speed = pace, release timing = length (full toss to bouncer),
  wrist roll + palm direction = off-break / leg-break / doosra / googly / cutters.
- **Fielding:** player-taken catches in slow motion by reaching for the ball; throw to the keeper (A) or the
  bowler's end (B).
- **LBW and DRS:** pad contact, the LBW law, an umpire with an error rate, one review per innings, a review board
  with pitching / impact / wickets and ball tracking (ported from Courtside).
- **Presentation:** umpire signals, two-voice commentary, recorded bat / crowd / stumps samples,
  a How to play page, floating prompts.
- **Format:** 5 overs, 5 wickets.
- 84 unit tests.

## Fourth pass
- **Batting animation:** the AI batters' swings were rebuilt: grounded stance, backlift as the bowler delivers,
  a downswing that accelerates into the ball, wrist roll, a full follow-through and a relaxed recovery. Cross-bat
  shots start from a raised bat. The body strides with the foot picked up, transfers weight, coils and opens with
  the hands, keeps a high front elbow and comes up on the back toe. Contact is still resolved by the same physics.
- **Stumpings when you bowl:** batters come down the pitch to slow bowling; beat the bat and the keeper (who stands
  up to slow bowling) takes the bails off. You could already be stumped when batting.
- **Third umpire** for close run-outs and stumpings, at both ends, in both innings.
- **Extras:** no-balls (you overstepping or bowling a waist-high full toss; the AI bowler overstepping now and
  then) and free hits, as well as wides.
- **Squads and scorecards:** two named teams; batters with their own ability (openers to tail-enders); strike
  rotation; bowling figures; milestones; card on the HUD, the big screen and the result pages.
- **Toss:** call heads or tails; bat or bowl first. The match works in either order.
- 92 unit tests.

## Fifth pass
- **Your bowler types:** fast, medium-fast, off-spin and leg-spin, each with a pace range and only their own
  deliveries. A leg-spinner cannot bowl an off-break or a doosra; an off-spinner cannot bowl a leg-break.
- **Swing and seam for the quicks:** the seam position is set by turning the wrist with the ball in the hand
  (or A / B); cutters by rolling the wrist at release; slower ball from the back of the hand. Fast bowlers swing it
  more, medium-pacers seam it more.
- New spin variations: arm ball, top-spinner, slider.
- The bowler is changed with the right stick at the start of an over; the keeper stands up to your spinners.
- 99 unit tests.

## Sixth pass
- **Bat contact:** measured with simulated swings (timing and placement error at headset frame rate): with
  ±45 ms / ±7 cm the old bat connected 57% of the time. The bat is now 14 x 61 cm, the grip a little higher, and a
  contact assist (normal: 8 cm capture, contact pulled 30% toward the sweet spot, 12 cm invisible toe) brings that
  to about 80%. The pad check (LBW) was also stealing balls from the bat; it is tighter and the bat goes first.
- **No more seeing inside your own helmet:** any figure within reach of your eyes is hidden (the runner who runs
  for you used to stand inside your head).
- **View setting:** your eyes / eyes + helmet grille / behind the player (third person, with a body that copies you
  when batting and when bowling).
- **Replays after every ball** (bowler's or batter's view, then the camera chases the hit; skippable).
- **Keeper and ball handling:** a bug aimed every "hold the ball" pose at the elbow pole, so held balls sat at the
  keeper's crotch; fixed. Balls are held in the right hand; throws are taken over the stumps and the bails come off
  with the glove; stumpings lunge in. Fielders no longer stand inside each other. New gloves and pads.
- **Controller hints** with the button drawn; commentary captions removed.
- **Crowd:** about 25,000 fans (cheaper to draw than the old 3,000), cheering, Mexican wave; 25 recorded crowd
  reactions and synthesised chants, drums and whistles.
- 100 unit tests.

## Known issues / not verified
- **Not tested on a real headset.** All XR paths ran only under Meta's IWER emulator in headless Chromium
  (no pose velocities, haptics, hit-test or passthrough there). Haptics, `updateTargetFrameRate`, pose velocities
  and MR hit-test are coded defensively but unverified.
- The uncalibrated default bat orientation is a guess about the Quest grip-space axes. Calibrate on first use
  (the game prompts you).
- Headless checks covered: all modes, running and run-outs, umpire signals, slow-motion catch, LBW appeal and both
  kinds of review, sweep, stride, stumping (both sides), the third umpire, no-ball and free hit, the toss,
  bowling first, crease movement, the emulated VR and MR flows, and frame strips of every AI batting shot,
  view modes, replays (desktop and emulated headset), keeper holding / taking throws, hints, the crowd.
- Not checkable without a headset: how the contact assist *feels*, replay comfort, the behind-the-player view's
  feel, helmet grille comfort in stereo, crowd audio balance, frame rate with 25,000 spectators. **Not** checkable without
  a headset: palm / back-of-hand detection for doosra and googly, whether the wrist turn for swing feels natural
  and stays put through a real wind-up (it works under the emulator), the feel of the stride and of catching, the
  in-VR switch to mixed reality, commentary timing by ear.
- Only the pads have a collider (for LBW). The ball passes through the rest of a body.
- Left-handed batting is not supported yet.
- Desktop bowling with the mouse is awkward by nature. Use **B** (auto-bowl at the marker) for quick tests.
- Headless test renders run at about 20 fps (software GL), so in-browser timings were checked with
  frame-synchronised scripts, not by feel.
