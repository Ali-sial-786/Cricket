Scenarios for the headless harness (a Playwright page that loads the game with software GL and
steps frames by hand: `GAME_ROOT=<repo> node harness.mjs <scenario.mjs> <outDir>`).

- `fastbat.mjs`: your bat swung very fast at full reach (also at 30 Hz, `HZ=30`) through stance,
  a captured shot, a sweep and a pinned back foot; per frame the distance from each glove to where
  it grips the handle. Pass: max < 2 cm (it is ~0.2 cm).
- `vrshots.mjs`: every reference shot (tools/video_shots/takes.json: the batter's tracked head and
  hands, the bat's direction keyframed per shot) fed as headset input at 72 Hz, live and through the
  replay re-solve; logs the class read, grip error, joint jumps and leg metrics; renders strips.
  `MODE=real|still|early|noisy|leave|nodir`, `TAKES=label,...`, `RENDER=0`.
- `ghost2.mjs` (needs `body.mjs` POSES from the harness): your see-through body looking down, on the
  pitch and on the grass.
