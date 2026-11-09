# Crease VR

An original WebXR cricket game for **Meta Quest 3 / 3S** (Quest Browser). Bat against a
bowling machine or an AI bowler with your controller held like a bat handle, bowl overarm
to a physics-driven AI batter, and play short run chases and two-innings matches with
fielders. It also runs in a normal desktop browser in a debug mode, so everything can be
tested without a headset.

* **Static site, no build step:** `index.html` + ES modules in `src/`; three.js r180 comes from
  cdn.jsdelivr.net through an import map.
* **Physics** (`src/physics/`) is pure JS at a fixed 480 Hz, independent of the render rate.
  It covers gravity, quadratic drag, swing, Magnus, a spin-coupled bounce and seam movement,
  and swept bat collision that cannot tunnel. Unit tests use `node:test`.
* **All tuning numbers** live in [`src/config.js`](src/config.js).

| Mode | What you do |
|---|---|
| Nets: Batting | Bowling machine with pace (70–150 km/h), line, length, swing, seam, spin, over/around, variation, auto-feed. Red → amber → green lights and beeps cue each release. |
| Nets: Bowling | Bowl to the AI batter from the bowler's end. Stats on dots, beaten balls and edges. |
| Run Chase | Chase a target (set by difficulty and overs) against an AI bowler, with 9 fielders and a keeper. |
| Bowl an Over | Defend a total off 6 balls against the AI batter with a full field. |
| Match | You bat N overs, then bowl N overs while the AI chases your score. |
| Mixed reality nets | Passthrough. Place the stumps on your real floor; the pitch runs off into the room. |

## Playing on Quest

1. Open the deployed URL in the Quest Browser and press **Enter VR**, or **Enter MR nets** for passthrough.
2. **Safety screen:** clear at least 2 × 2 m of swing space, then confirm.
3. **Bat calibration** runs the first time, or from the menu. Hold the **right** controller like a bat
   handle, stand in your stance and look at the bowler, letting the bat hang straight down with the
   face toward the bowler. Press **A**. Fine-tune the angle with the left thumbstick, then press **A** to save.
   The result is stored in `localStorage`.
4. Controls:
   * **Right hand:** the bat. When bowling: hold **trigger** to grip the ball, swing overarm, let go to release.
     **A** toggles out-swing and **B** toggles in-swing. Rolling the wrist at release adds spin.
   * **Left hand:** laser pointer. **Trigger** selects, **X** bowls the next ball (nets), **Y** opens or closes the menu,
     the **thumbstick** moves the bowling aim marker, and **holding grip for 1 s** recenters.
   * There is no artificial locomotion. The game moves you between the batting and bowling ends.

## Desktop debug mode

Open the page in any WebGL2 browser without a headset. The page starts on the menu; click a mode.

| Input | Batting | Bowling |
|---|---|---|
| Mouse move | Up lifts the bat (backlift), a fast flick down swings it. Left/right moves your hands across the crease and turns the swing plane (right = off side). | Arm angle of a virtual overarm action |
| Left button | — | Hold to grip the ball, sweep top → bottom, release near mid-screen |
| `Space` | Next ball | — |
| `B` | — | Auto-bowl a clean delivery at the aim marker (machine pace setting) |
| `Q` / `E` | — | Wrist roll: off-spin / leg-spin (hold while releasing) |
| `Z` / `X` | — | Out-swing / in-swing toggle |
| Arrow keys | — | Move the aim marker |
| `Esc` or `M` | Menu (click buttons with the mouse) | Menu |
| `C` | Cycle cameras: batter's eye, side-on, behind the bowler, overhead | Cycle cameras |
| `T` | Toggle ball trail | |

`window.__game` exposes the game object in the console, for example `__game.world.ball`,
`__game.settings` and `__game.actions.start('chase')`.

## Run locally

```bash
python3 -m http.server 8080     # or: npm run serve
# open http://localhost:8080
npm test                        # physics + game-logic unit tests (Node 20+)
```

WebXR needs a secure context. `localhost` counts as secure, but a headset loading your PC's LAN
IP does not, so use the GitHub Pages deploy (HTTPS) for headset testing. You can also use
`adb reverse tcp:8080 tcp:8080` and open `http://localhost:8080` on the Quest.

## Deploy to GitHub Pages

The workflow `.github/workflows/pages.yml` runs the unit tests on every push to `main`. If they
pass, it publishes `index.html` and `src/`.

1. Merge this branch into `main` (or push to `main`).
2. In the repo on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Push or merge to `main`, or run the workflow manually from the **Actions** tab ("Test and deploy to GitHub Pages").
4. The site goes live at `https://<user>.github.io/<repo>/`. Open that URL in the Quest Browser.

## Project layout

```
index.html            entry page, import map, desktop help overlay
src/config.js         ALL tuning constants (physics, bat, haptics, bowling, fielding, AI, XR)
src/physics/          pure JS, node-tested: math, ball (aero + bounce), bat (SDF sweep + response),
                      wicket, world (fixed step, bat providers), trajectory (prediction), bowlingMachine (solver)
src/game/             game.js (orchestrator + frame loop), batting.js / bowling.js sessions, modes.js,
                      aiBatter.js, aiBowler.js, fielding.js (+fieldController), scoring.js, bowlingInput.js,
                      calibration.js, settings.js
src/render/           env (stadium), objects (bat/ball/stumps/machine), figures + people (low-poly humans)
src/ui/               canvas-texture panels: menus, HUD, scoreboard, laser pointer
src/xr/               session.js (VR/MR, frame rate, foveation), input.js (controllers + desktop emulation), mr.js
src/audio/sfx.js      WebAudio-synthesised sound effects
tests/                node:test suites
```

See also [TESTING.md](TESTING.md) (headset checklist), [PROGRESS.md](PROGRESS.md) and [DECISIONS.md](DECISIONS.md).
