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
* **Full match rules:** bowled, caught, LBW (DRS with Snicko, Hot Spot and ball tracking, 2 reviews per side per
  innings), stumped and run out; wides, no-balls and free
  hits; a third umpire for close run-outs and stumpings (your bat grounded behind the line counts, even after
  coming down the pitch); manual running; player-taken catches in slow motion;
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
bigger sweet spot. *Hard* is real time and real size. The slow motion gives you more time, never more power: your
bat's speed is always measured in real time.

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
| Swing | The **bat face angle at contact** decides ground or air: a straight/closed face keeps it down, an open face lofts it. **Power comes from your backlift and your bat speed**: the further back and higher you take the bat before the downswing, and the faster you bring it through, the harder the ball goes. A full backlift and a fast swing is the most you can hit it (six territory off the middle); a short backlift or a slow push is a controlled shot that stays in the ring; a gentle block is a dead bat that takes the pace off the ball. Off the middle of the bat you lose some power and the ball goes a bit wider, not most of it. After each hit the panel shows the exit speed, the launch angle, your **bat speed** (the middle of your bat, real m/s), your **backlift %** and how close to the middle you hit it. |
| Hold **right trigger** | Stride down the pitch (about 1.6 m). The sweet spot shrinks, but a clean hit goes up to 32% harder and carries further. Miss and the keeper can stump you. |
| Hold **right grip** (side button) | Sweep: your view drops to a kneeling sweeper's height (about 0.2 s; if you are crouched already it drops only the rest of the way, and your own head still moves the view while you hold it; Settings → Sweep view drop turns it off) and your player goes down on the back knee with the front leg bent out in front, for as long as you hold it, whatever you are doing yourself. Let go and you come back up. Swing toward the leg side for a sweep, toward the off side for a **reverse sweep**: the ball goes where your bat sends it, helped into a sweeper's arc, as hard as your swing (and backlift) hit it. |
| **Trigger + grip** | Come down the pitch and slog-sweep (lofted, in front of square). |
| Get **down low yourself** | Crouch right down (your eyes at about two thirds of your standing height or lower) with the bat low across the line, or swing at the ball from down there, and it is a sweep, exactly as if you held the grip (no extra view drop). A batting crouch, a lunge, ducking under a bouncer with the bat out of the way, or crouching to ground the bat are not sweeps. |
| **Left stick**, or really stepping | Move around in your crease: stick forward = the way your left controller points. |
| **X** | Call a run. The batters stop after each run; press **X** again once they are home for another. |
| **Y** | Turn back mid-run. |
| Hold **left trigger** | Dive: as soon as the crease is within about 4 m your batter throws himself full length, bat stretched out along the ground, and slides in. He then needs a moment to get up before another run. (The trigger of your off hand, the one without the bat.) |
| Look down | You see a faint body (no head): your pads and boots show where you are standing in the crease. A stumping or run-out is judged on those feet **and** on your bat: either one grounded behind the line and you are in (Settings → Own body). |
| **A** | Review a decision that went against you — LBW, or caught off an edge — while the prompt is up. Each side has **2 reviews per innings**; a review that fails is lost, one that overturns the decision or ends on umpire's call is kept. Reviews left are on the HUD between balls. |
| — | **No-ball:** the AI bowler oversteps now and then. One run, the ball is bowled again and the next one is a **free hit** (you can only be run out). |
| **Left trigger**, once the ball is dead | **Skip to the next ball**: the rest of the result, the replay and everyone walking back are skipped. The view dims for a quarter of a second, everyone is put in place (fielders on their marks, the batters at their ends with a new batter in after a wicket, the stumps back up), and as it clears the bowler sets off from his mark (the machine starts its countdown). A new bowler or a free hit gets its card for 1 s first. Not during an appeal, a review or the third umpire, not with a menu open, and never past the end of an innings (that goes straight to its result). It takes a fresh press: a trigger still held from a dive does not skip. |
| **Left stick click** | Menu (also **Y** between balls). |
| Hold **left grip** 1 s | Recenter: puts you back on your mark wherever you are looking (the pitch keeps its direction in your room). Menu → **Face this way** re-aims the pitch to where you look. |

### Bowling (right controller is your bowling hand)
* **Appeal yourself:** your fielders go up for the obvious shouts. When they keep quiet — the batter was hit on
  the pad, or an edge was caught (or taken by the keeper off what might have been the bat) — and the ball is
  dead, a hint shows **APPEAL · B** for 2.6 s. Press **B** and the umpire answers; if he says not out you can
  **review** it with **A** (2 per innings). Never shown during your run-up.

1. **Choose your bowler** — a page opens when you start bowling and before the first ball of every over: *Fast*,
   *Medium-fast*, *Off-spin* or *Leg-spin*. In the nets you can change any time from the menu (**Change bowler**);
   in a match only at the start of an over.
2. **Pick the delivery** with **A** (next) / **B** (previous). A **delivery card** low on your left while you wait at
   your mark shows your bowler and pace range, the deliveries with the picked one lit and what it does, the target
   in words ("good length · off stump") and the controls.
3. **Aim** with the **left stick**: the blue ring on the pitch is where the ball will land; your release only
   nudges it.
4. **Run in**: hold the **right grip** (or the **left trigger**). You start each ball at the top of your mark and
   accelerate toward the crease. Let go before the amber **commit line** and you pull out (press again within
   1.5 s to carry on, otherwise you go back to your mark); inside it you are committed and the run carries you to
   the crease by itself. The run always stops at the crease, and you then have 2.5 s to bowl (or it is a dead ball).
5. **Bowl**: hold the **right trigger** (the ball is in your hand), bowl overarm and let go in the delivery stride
   or at the crease. Letting go anywhere else is not a delivery ("Run in first").
6. **Skip to your next ball**: once the ball is dead, press the **left trigger** (your off hand): the result, the
   replay and the walk back are skipped and, after a quarter-second dim, you are on your mark with the ball and
   the batters and fielders are in place. That press does not start a run-up; press again to run in.

* **Pace:** how quickly you bring the ball down in the moment before you let go, spread across your bowler's pace
  range, times your run-up: a full run gives full pace; from a standstill a seamer loses about 14%, a spinner 5%.
* After each ball a line near the middle of your view says what you bowled and where it went, e.g. *Out-swinger ·
  128 km/h · good length · 30 cm outside off*.
* **Bounce** comes from pace and length together: at 140 km/h a good length arrives about bail height and a ball
  pitched 10–11 m from the batter about chest height. Lengths stop at 12 m (fast), 11.5 m (medium) and 10.5 m
  (spin), and a ball that passes over the batter's head is a **wide**.

| Bowler | Pace · run-up | Deliveries (for a right-handed batter) |
|---|---|---|
| Fast | 118–152 km/h · 11 m | **Seam-up**, **out-swinger** (swings away), **in-swinger** (swings in), **off-cutter** (cuts back in), **leg-cutter** (cuts away), **slower ball** |
| Medium-fast | 100–132 km/h · 8 m | **Seam-up**, **away-seamer**, **in-seamer** (mostly off the pitch), **off-cutter**, **leg-cutter**, **slower ball** |
| Off-spin | 62–98 km/h · 3.5 m | **Off-break** (turns in), **arm ball** (straight on), **doosra** (turns away) |
| Leg-spin | 60–96 km/h · 3 m | **Leg-break** (turns away), **googly** (turns in), **top-spinner** (dips, bounces), **slider** (skids on) |

* Rolling the wrist as you let go adds a little more spin or cut to a spinner's or a cutter's delivery.
* **Settings → Deliveries: by wrist action** brings back the old "by feel" bowling: the wrist decides the delivery
  (roll = spin or cutter, back of the hand = doosra / googly / slower ball, wrist turn or A / B = swing).
  **Settings → Run-up: off** bowls from the crease with no momentum penalty.
* Stay behind the popping crease: if your head is more than 30 cm past it when you let go, it is a **no-ball** (one
  run, bowled again, and the next ball is a free hit). A full toss above the waist is a no-ball too.
* The keeper stands up to the stumps for your spinners, and batters come down the pitch to them. Beat the bat and
  they are **stumped**.

### Looking around

The **right stick** turns you (left / right) in one continuous motion, the same as turning your body: push it
further to turn faster; your figure turns with you. (Settings → **Right stick turn**: smooth / snap 30° per
flick / off.) **Click the right stick** to face down the pitch again; the
view also faces forward by itself before each ball, on recenter, catches and replays.

### Fielding

* **Catches:** when a catch comes your way, time slows and you become the fielder. Reach out and get a hand to
  the ball. No button.
* **Throws:** the fielders throw like fielders. As soon as the ball is hit the keeper runs to his stumps (from
  wherever he is) and the AI bowler to his (or whoever is free, when one of them has the ball), and a fielder backs
  up behind the end the ball is coming to. When you bowl, nobody comes to stand by your stumps: a throw to your end
  is at the stumps, with a man backing up behind them. With a run-out on, the man with the ball shies at the
  stumps (from close in, and he can miss) or throws into the gloves of whoever is over them; with nothing on, a
  safe return (on one bounce from the deep), or he waits a moment for someone to get there. When your side is
  fielding, **A** sends the throw to the keeper's end and **B** to the bowler's end.
* **Overthrows:** a throw nobody takes runs on (backing-up fielders dive to stop it) and the batters can run
  again: you with the usual buttons, the AI batters when the ball is well away. To the rope it is four overthrows
  plus the runs completed and the one in progress if they had crossed when the throw was made (Law 19.8), all to
  the batter (byes if the ball was not hit); shown as "2 + 2 overthrows", "1 + 4 overthrows". A keeper's shy at
  the stumps that misses is a live ball too. Once the ball is dead it is tossed back to the bowler and a broken
  wicket is put back up. A thrown ball never meets a bat, and a throw into the stumps can run a batter out
  (never "bowled").
* **Finding the ball:** after a hit, a yellow arrow at the edge of your view points to the ball when it's out of
  sight, a halo marks it when it's far away, and a ring shows where it will land (Settings → Ball finder).
* **The keeper is physical:** he moves across with the line of the ball, takes it on his feet if he can, leaps for
  a bouncer and dives for a wide one. He only ever has the ball if he actually reaches it. Standing up to the
  spinners he takes the bails off himself; standing back to the quicks he has to throw at the stumps, and can miss.
* **Byes:** a ball that beats the bat and the keeper is live. Press **X** to run; if it reaches the rope it is four
  byes (plus the wide, if it was one). Byes go down as extras, not to the batter or the bowler.
* **Reviews (DRS):** if a decision goes against your side, press **A** while "Review?" is up (2 per side per
  innings, kept when the decision is overturned or it is umpire's call). The board shows the on-field call,
  then, when the bat was involved, **Snicko** (the stump microphone's trace under the camera frames, stepped
  through by the third umpire: a sharp spike exactly as the ball passes the bat is an edge; a spike when the
  ball is nowhere near is the bat hitting the ground; the pad is a broad low bump) and **Hot Spot** (the
  infra-red picture: a bright white mark where the ball touched the bat's edge or the pad), then for an LBW
  ball tracking (pitching, impact, wickets). An inside edge on to the pad is NOT OUT (bat first). Catches
  where the edge is the question — caught behind, at slip, bat-pad — get an on-field decision first (the
  umpire can miss a faint edge, and is sometimes fooled by the bat hitting the ground); a clean catch off the
  middle of the bat is just out. Close run-outs and stumpings go to the third umpire automatically.
* Umpires signal fours, sixes, wides and wickets. Two commentators, Kate Marsden and Geoff Hollins, call the game
  (audio only, no captions; Settings → Sound).

### On-screen help, views and replays

* **Control hints:** a small picture of the controller with the button to press lit up. Each one appears the
  first time that control is needed in a game, and the running ones (RUN / GO BACK / DIVE), the throw choice and
  the review stay up for as long as you can use them. The menu's *How to play* page lists everything.
* **Settings → View:** *your eyes* (plain first person), *eyes + helmet grille* (first person from inside a
  batting helmet), or *behind the player* (third person: the camera sits behind and beside your player, who copies
  your bat, head and hands; menus and catches always switch back to your own eyes).
* **Settings → Vision… (playing without glasses):** enter the prescription from your glasses for each eye
  (sphere, cylinder, axis) and turn *Correction* on. In the headset, the middle of each eye's picture is
  pre-corrected for your eye's blur (the method of ChromaCorrect, Güzel et al. 2023: the picture whose blurred
  version is closest to the sharp one), so that the blur in your eye undoes some of it. It makes things crisper,
  not glasses-sharp: the finest detail (small text) the blur wipes out cannot come back, and to anyone else the
  picture looks over-sharpened. Tune it by eye on the chart beside the menu (*Fine tune*, *Pupil*; *Showing*
  flips with / without). It costs GPU time: lower *Area* or *Quality* if the frame rate drops. Prescription
  lens inserts remain the way to see sharply.
* **Settings → Replays** (*after every ball* / *off*): every ball that is bowled — a leave, a dot ball, a hit, a
  boundary, a wicket, a run-out, a reviewed ball, the balls you bowl — gets its replay, once, at real speed: one
  camera high behind the bowler's arm watches the last strides, the release and the ball's flight, then turns to
  the ball and closes in on it (to about 15 m: the keeper taking it, the fielder picking it up and his throw, the
  catch) until a second after it is dead. One continuous move: no cuts, no second angle. After an appeal, a DRS
  review or the third umpire, the replay comes after the verdict; asking for the next ball (X) during a result only
  cuts the wait short, the replay still shows the whole of the play. In the headset you are moved through it (level,
  gently, the edges of the view dimmed while it moves), and the play is where you face when you bat, wherever you
  happened to be looking when it started. A small *REPLAY* label shows for the first 1.5 s. Your **off-hand
  trigger** (the hand without the bat or the ball: the left one) skips it at any moment and goes straight on to the
  next ball (see *Skip to the next ball* above); that press does nothing else; no other button stops it, and the
  menu only pauses it. A catch, a stumping or a run-out is shown for 2 s after
  the ball is dead (other balls 1 s).
* **The HUD panel** (beside the pitch, between balls only) shows the last ball's result, the delivery and your shot
  (exit speed, launch angle above the horizontal and where the ball went, e.g. "41° · fine leg", bat speed, how
  full the backlift was when the swing reports it, sweet spot, carry). It is cleared when the next ball starts and in a new game; during an appeal it reads *Appeal…*, then
  the umpire's call, *Third umpire…* for a run-out upstairs, then the verdict. The innings ends at the last wicket
  (5 in a 5-over chase): no ball is bowled after it, however quickly X is pressed.
* **Text while the ball is coming:** from the moment the bowler sets off (the machine's countdown; your own run-up
  when you bowl) until the ball reaches the batter, nothing floats in your view. A new bowler's name and a free hit
  are shown just before the run-up, the last ball's result between balls.
* **Settings → Contact assist** (off / low / normal / high, default normal): an invisible margin around your bat so a
  ball that would have just missed is still played (and pulled toward the middle of the bat). The bat itself is
  15 cm wide with a 67 cm blade.
* **Settings → Bat power** (×0.7–2.5, default ×1.25) multiplies your bat's real speed for the shot; the backlift and
  how firmly you swing still decide how much of it reaches the ball.

## Desktop debug mode

Open the page in any WebGL2 browser without a headset. The page starts on the menu; click a mode.

| Input | Batting | Bowling |
|---|---|---|
| Mouse move | Up lifts the bat (backlift), a fast flick down swings it. Left/right moves your hands and turns the swing plane (right = off side). | Arm angle of a virtual overarm action |
| Left button | — | Hold to grip the ball, sweep top → bottom, release near mid-screen (after running in) |
| `Space` / `Enter` | Next ball · call a run | — |
| `Shift` | Stride down the pitch | — |
| `S` | Sweep (hold) | — |
| `G` / `V` | Turn back / dive | — |
| Arrow keys | Move in the crease | Move the aim marker |
| `R` (hold) | — | Run in |
| `B` | — | Run in and bowl a clean delivery at the aim marker by itself |
| `1`–`4` | — | Bowler: fast, medium-fast, off-spin, leg-spin (also on the bowler page) |
| `Q` / `E` (+ `F`) | — | Wrist roll clockwise / anticlockwise (`F` = back of the hand) |
| `Z` / `X` | Review (`Z`) | Next / previous delivery (by feel: seam out / in) · throw to keeper / bowler's end · after the ball: appeal (`X`), review (`Z`) |
| `Esc` or `M` | Menu (click buttons with the mouse) | Menu |
| `C` / `T` | Cycle cameras / toggle ball trail | |
| `Space` / `Enter` during a replay | Skip it | Skip it |
| `N` once the ball is dead | Skip to the next ball (as the left trigger) | Skip to your next ball |

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
                      aiBatter.js, aiBowler.js (bowler types), fielding.js (+fieldController), throwing.js
                      (where a fielder throws, accuracy, overthrows and their scoring), running.js,
                      lbw.js + lbwFlow.js (appeal, decision, review), edgeTrack.js (what the ball touched: Snicko,
                      Hot Spot), reviews.js, thirdUmpire.js, scoring.js, scorecard.js,
                      squad.js, bowlerTypes.js + bowlingInput.js (your bowlers and their deliveries),
                      replay.js (recording and replays)
                      calibration.js, settings.js
src/render/           env (stadium), objects (bat/ball/stumps/machine), humanoid (skinned athlete + IK), gear (helmets, pads, gloves),
                      actors + people + anim, clips (authored animation clips), umpires, drsView (review board + ball tracking;
                      snicko / hotspot draw its screen),
                      viewModes (helmet grille, your bowling body, hiding bodies inside your head)
src/ui/               canvas-texture panels: menus, HUD, scoreboard, laser pointer
src/xr/               session.js (VR/MR, frame rate, foveation), input.js (controllers + desktop emulation), mr.js
src/audio/            sfx.js (synthesised), samples.js (recorded effects), commentary.js (two-voice engine),
                      crowd.js (crowd reactions and terrace)
assets/               athlete model, animation clips (anim/), commentary clips, recorded effects (see assets/CREDITS.md)
tools/                build_athlete.mjs (converts the Courtside athlete for this game),
                      build_clips.mjs (retargets the animation clips onto the game's 17-bone rig)
tests/                node:test suites
```

### Animation clips

Walking, jogging, sprinting, standing about (idle, arms folded), the fielders'
ready set (legs), the overarm throw and the celebrations are authored clips from
Quaternius' *Universal Animation Library* (CC0), retargeted offline by
`tools/build_clips.mjs` onto the 17-bone rig and stored as 30 Hz int16
quaternions (`assets/anim/clips.bin` + `clips.json`, ~65 KB):

```
node tools/build_clips.mjs <courtside>/assets/basketball/spocco/characters/sportsmate.glb <dir with node_modules/three>
```

`src/render/clips.js` samples and blends them (`applyClip`, `applyLocomotion`,
`strideAt`); the stride phase comes from distance travelled with the clips' own
stride length, so planted feet stay put. Everything IK-driven stays procedural
(the bowling action, batting, dives, the keeper's takes, catches, the pick-up),
and if the clips fail to load the old procedural poses in `anim.js` take over.

See also [TESTING.md](TESTING.md) (headset checklist), [PROGRESS.md](PROGRESS.md) and [DECISIONS.md](DECISIONS.md).
