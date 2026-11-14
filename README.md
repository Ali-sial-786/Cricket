# Crease VR

An original WebXR cricket game for **Meta Quest 3 / 3S** (Quest Browser). Bat against a
bowling machine or an AI bowler with your controller held like a bat handle, bowl overarm
to a physics-driven AI batter, and play short run chases and two-innings matches with
fielders. It also runs in a normal desktop browser in a debug mode, so everything can be
tested without a headset.

* **Static site, no build step:** `index.html` + ES modules in `src/`; three.js r180 comes from
  cdn.jsdelivr.net through an import map.
* **Animated players:** skinned athletes (model from the Courtside project, re-rigged for IK) with helmets, pads and
  gloves. The bowler's arm passes exactly through the physics release point; fielders walk in, chase, dive, pick up
  and throw; batters run, turn and dive; umpires signal.
* **A live ground:** about 25,000 spectators who stand, bounce and do the Mexican wave, recorded crowd reactions
  (oohs, gasps, cheers, groans) and a terrace of clapping chants, drums and whistles.
* **Full match rules:** bowled, caught, LBW (with DRS ball tracking), stumped and run out; wides, no-balls and free
  hits; a third umpire for close run-outs and stumpings; manual running; player-taken catches in slow motion;
  two-voice commentary.
* **First person throughout:** you see the game through the batter's eyes when you bat and the bowler's (or the
  catching fielder's) when you field. There are no broadcast cameras in the headset.
* **Physics** (`src/physics/`) is pure JS at a fixed 480 Hz, independent of the render rate.
  It covers gravity, quadratic drag, swing, Magnus, a spin-coupled bounce and seam movement,
  and swept bat collision that cannot tunnel. Unit tests use `node:test`.
* **All tuning numbers** live in [`src/config.js`](src/config.js).

| Mode | What you do |
|---|---|
| Nets: Batting | Bowling machine with pace (70–150 km/h), line, length, swing, seam, spin, over/around, variation, auto-feed. Red → amber → green lights and beeps cue each release. |
| Nets: Bowling | Bowl to the AI batter from the bowler's end. Stats on dots, beaten balls and edges. |
| Run Chase | Chase a target against a rotating attack of five AI bowlers, with fielders, a keeper and two umpires. 5 overs, 5 wickets by default. |
| Bowl an Over | Defend a total off 6 balls against the AI batters with a full field. |
| Match | Coin toss (call heads or tails; the winner chooses to bat or bowl), then one innings each: 5 overs, 5 wickets. Named batters and bowlers, with a scorecard on the HUD, the big screen and the result page. |
| Mixed reality nets | Passthrough. Place the stumps on your real floor; the pitch runs off into the room. |

**Difficulty** (Settings): *Easy* plays the ball in flight at 70% speed (a 140 km/h ball feels like ~100), with a
55% bigger sweet spot, slower bowlers, slower fielders and no LBW against you. *Medium* is 85% speed with a 25%
bigger sweet spot. *Hard* is real time and real size.

**The AI attack** (one bowler per over): swing (126–138 km/h: out-swinger, in-swinger, yorker), express pace
(136–150: bouncer, yorker, back of a length), seam (114–127: off-cutter, leg-cutter, slower ball), off-spin
(78–92: off-break, arm ball, doosra) and leg-spin (74–89: leg-break, googly, top-spinner, flipper).

## Playing on Quest

1. Open the deployed URL in the Quest Browser and press **Enter VR**, or **Enter MR nets** for passthrough.
2. **Safety screen:** clear at least 2 × 2 m of swing space, then confirm. Use a **room-scale boundary**, not a
   stationary one: with a stationary boundary the headset shows your room as soon as you step away from the centre.
3. **Bat calibration** runs the first time, or from the menu. Hold the **right** controller like a bat
   handle, stand in your stance and look at the bowler, letting the bat hang straight down with the
   face toward the bowler. Press **A**. Fine-tune the angle with the left thumbstick, then press **A** to save.
4. The menu has a **How to play** page with all of this in the headset.

### Batting (right controller is the bat)

| Input | What it does |
|---|---|
| Swing | The **bat face angle at contact** decides ground or air: a straight/closed face keeps it down, an open face lofts it. |
| Hold **right trigger** | Stride down the pitch (about 1.6 m). The sweet spot shrinks, but a clean hit goes up to 32% harder and carries further. Miss and the keeper can stump you. |
| Hold **right grip** (side button) | Sweep. Swing toward the leg side for a sweep, toward the off side for a **reverse sweep**. |
| **Trigger + grip** | Come down the pitch and slog-sweep. |
| **Left stick**, or really stepping | Move around in your crease. |
| **X** | Call a run. The batters stop after each run; press **X** again once they are home for another. |
| **Left trigger** | Turn back mid-run. |
| **Y** | Dive for the crease. |
| **A** | Review an LBW decision (1 review per innings) while the prompt is up. |
| — | **No-ball:** the AI bowler oversteps now and then. One run, the ball is bowled again and the next one is a **free hit** (you can only be run out). |
| **Left stick click** | Menu (also **Y** between balls). Hold **left grip** 1 s to recenter. |

### Bowling (right controller is your bowling hand)

Hold the **trigger** to grip the ball, bowl overarm, let go to release.

* **Pace** comes from how fast your hand is moving at release, scaled into your bowler's range.
* **Line** comes from the direction of the hand. **Length** from *when* you let go: early = full (very early = a
  full toss), late = short, very late = a bouncer.
* **Your bowler:** flick the **right stick left / right** (start of an over in a match, any time in the nets) to
  bowl as a fast, medium-fast, off-spin or leg-spin bowler. A bowler only bowls their own deliveries:

| Bowler | Pace | What the action does |
|---|---|---|
| Fast | 118–152 km/h | Seam position → **out-swinger / in-swinger** (most swing). Wrist roll at release → **off-cutter** (seams in) / **leg-cutter** (seams away). Back of the hand → **slower ball**. |
| Medium-fast | 100–132 km/h | The same deliveries with less swing and more movement off the seam. |
| Off-spin | 62–98 km/h | Clockwise roll → **off-break**. Back of the hand → **doosra**. No roll (or the wrong roll) → **arm ball**. No leg-breaks. |
| Leg-spin | 60–96 km/h | Anticlockwise roll → **leg-break**. Back of the hand → **googly**. Clockwise roll → **top-spinner**. No roll → **slider**. No off-breaks or doosras. |

* **Setting the seam (fast and medium):** once the ball is in your hand, turn your wrist **left** (seam toward the
  slips) for out-swing or **right** (toward fine leg) for in-swing. About 10° does nothing, 30° is full swing. The
  ball in your hand shows the seam angle, a prompt shows the setting and the controller ticks as it changes. It
  locks when your arm starts moving. **A** / **B** set full out-swing / in-swing directly if you prefer buttons.
* Rolls are judged as seen from behind your hand; "back of the hand" means the back of your hand faces the batter
  as you let go.
* The left stick moves the aim marker (the assist nudges you toward it; turn it off in Settings).
* Stay behind the popping crease: if your head is more than 30 cm past it when you let go, it is a **no-ball** (one
  run, bowled again, and the next ball is a free hit). A full toss above the waist is a no-ball too.
* The keeper stands up to the stumps for your spinners, and batters come down the pitch to them. Beat the bat and
  they are **stumped**.

### Fielding

* **Catches:** when a catch comes your way, time slows and you become the fielder. Reach out and get a hand to
  the ball. No button.
* **Throws:** when a fielder picks up, **A** throws to the keeper's end and **B** to the bowler's end. Beat the
  batter home for a run out.
* **Reviews:** if an LBW appeal is turned down, press **A** to send it upstairs (ball tracking, umpire's call).
  Close run-outs and stumpings go to the third umpire automatically.
* Umpires signal fours, sixes, wides and wickets. Two commentators call the game (audio only, no captions; Settings → Sound).

### On-screen help, views and replays

* **Control hints:** a small picture of the controller with the button to press lit up. Each one appears the
  first time that control is needed in a game, and the running ones (RUN / GO BACK / DIVE), the throw choice and
  the review stay up for as long as you can use them. The menu's *How to play* page lists everything.
* **Settings → View:** *your eyes* (plain first person), *eyes + helmet grille* (first person from inside a
  batting helmet), or *behind the player* (third person: the camera sits behind and beside your player, who copies
  your bat, head and hands; menus and catches always switch back to your own eyes).
* **Settings → Replays:** after every ball a short replay plays, from the *bowler's view* (default) or the
  *batter's view*; once the ball is hit the camera chases it. In the headset you are moved through it with a dimmed
  edge to the view; press any button to skip. *Off* turns them off.
* **Settings → Contact assist** (off / low / normal / high, default normal): an invisible margin around your bat so a
  ball that would have just missed is still played (and pulled toward the middle of the bat). The bat itself is
  14 cm wide with a 61 cm blade.

## Desktop debug mode

Open the page in any WebGL2 browser without a headset. The page starts on the menu; click a mode.

| Input | Batting | Bowling |
|---|---|---|
| Mouse move | Up lifts the bat (backlift), a fast flick down swings it. Left/right moves your hands and turns the swing plane (right = off side). | Arm angle of a virtual overarm action |
| Left button | — | Hold to grip the ball, sweep top → bottom, release near mid-screen |
| `Space` / `Enter` | Next ball · call a run | — |
| `Shift` | Stride down the pitch | — |
| `S` | Sweep (hold) | — |
| `G` / `V` | Turn back / dive | — |
| Arrow keys | Move in the crease | Move the aim marker |
| `B` | — | Auto-bowl a clean delivery at the aim marker |
| `1`–`4` | — | Bowler: fast, medium-fast, off-spin, leg-spin |
| `Q` / `E` (+ `F`) | — | Wrist roll clockwise / anticlockwise (`F` = back of the hand) |
| `Z` / `X` | Review (`Z`) | Seam for out-swing / in-swing · throw to keeper / bowler's end |
| `Esc` or `M` | Menu (click buttons with the mouse) | Menu |
| `C` / `T` | Cycle cameras / toggle ball trail | |
| `Space` during a replay | Skip it | Skip it |

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

The workflow `.github/workflows/pages.yml` runs the unit tests on every push. If they pass and the push was to
the repository's **default branch**, it publishes `index.html`, `src/` and `assets/`.

1. In the repo on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Push to the default branch, or run the workflow from the **Actions** tab ("Test and deploy to GitHub Pages").
3. The site goes live at `https://<user>.github.io/<repo>/`. Open that URL in the Quest Browser.

## Project layout

```
index.html            entry page, import map, desktop help overlay
src/config.js         ALL tuning constants (physics, bat, haptics, bowling, fielding, AI, XR)
src/physics/          pure JS, node-tested: math, ball (aero + bounce), bat (SDF sweep + response),
                      wicket, world (fixed step, bat providers), trajectory (prediction), bowlingMachine (solver)
src/game/             game.js (orchestrator + frame loop), batting.js / bowling.js sessions, modes.js,
                      aiBatter.js, aiBowler.js (bowler types), fielding.js (+fieldController), running.js,
                      lbw.js + lbwFlow.js (appeal, decision, review), thirdUmpire.js, scoring.js, scorecard.js,
                      squad.js, bowlerTypes.js + bowlingInput.js (your bowlers and their deliveries),
                      replay.js (recording and replays)
                      calibration.js, settings.js
src/render/           env (stadium), objects (bat/ball/stumps/machine), humanoid (skinned athlete + IK),
                      actors + people + anim, umpires, drsView (review board + ball tracking),
                      viewModes (helmet grille, your bowling body, hiding bodies inside your head)
src/ui/               canvas-texture panels: menus, HUD, scoreboard, laser pointer
src/xr/               session.js (VR/MR, frame rate, foveation), input.js (controllers + desktop emulation), mr.js
src/audio/            sfx.js (synthesised), samples.js (recorded effects), commentary.js (two-voice engine),
                      crowd.js (crowd reactions and terrace)
assets/               athlete model, commentary clips, recorded effects (see assets/CREDITS.md)
tools/                build_athlete.mjs (converts the Courtside athlete for this game)
tests/                node:test suites
```

See also [TESTING.md](TESTING.md) (headset checklist), [PROGRESS.md](PROGRESS.md) and [DECISIONS.md](DECISIONS.md).
