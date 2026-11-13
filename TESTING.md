# On-headset test checklist (Quest 3S)

About 45 minutes. Each item says what to try and **what to report back**. Report numbers where
asked: they map straight onto constants in `src/config.js`.

Setup: open the GitHub Pages URL in the Quest Browser. Wear the wrist straps and clear 2 × 2 m. Set a
**room-scale** boundary (with a stationary boundary the headset shows your room when you step off centre).

## 1. Boot, comfort, performance (5 min)
- [ ] Press **Enter VR**. The safety screen appears; click it with the **left trigger** (laser pointer).
- [ ] Open **Settings** (left stick click → Settings…). The top line shows the frame rate and whether the controllers
      report XR velocities.
  - **Report:** frame rate (Hz) and controller velocity (`XR` or `pose`).
- [ ] Look around the stadium and play a few nets balls.
  - **Report:** any judder, stutter when the ball is released or hit, or flicker at the edges (foveation).
    Knobs: `xr.maxFrameRate`, `xr.foveation`, `xr.framebufferScale`. If the frame rate sags with the full stadium,
    lower `render.crowdMax` (3000 spectators) or `render.animLodDistance`. The game also steps 120 → 90 Hz by
    itself if it can't hold 120.
- [ ] Watch a few deliveries from the AI bowler (Run Chase). The bowler runs in, bounds and lands side-on, and the ball
      should leave his hand. Fielders walk in and crouch, chase, pick up and throw. Batters run between the wickets.
  - **Report:** anything that looks wrong: sliding feet, arms in odd places, the ball appearing away from the hand,
    or a fielder that gets stuck.

## 2. Bat calibration and feel (5 min)
- [ ] Follow the calibration prompt: stance, look at the bowler, bat hanging straight down with the face
      toward the bowler, then press **A**. Use the left stick to tilt the bat until it feels right, then press **A** to save.
  - **Report:** whether the bat lines up with your hand afterwards, and the angle you settled on (shown in degrees).
- [ ] Hold the left grip for 1 s. The world recenters so you are at the crease, facing the bowler.
  - **Report:** whether you end up in a sensible guard position. If not, say which way it is off.
    Knobs: `settings.guardX`, `BAT_HEAD` in `game.js`.
- [ ] Is the bat length and weight right, and is your hand at a natural point on the handle?
  - **Report:** "too long / short / hand too high / low". Knobs: `bat.gripFromHandleTop`, `bat.bladeLength`.

## 3. Nets batting: the core (10 min)
Start **Nets: Batting**. The default machine is 130 km/h, good length, middle and off. Auto-feed is on;
**X** bowls immediately.
- [ ] Watch the lights: red → amber → green, with a beep on each. The ball leaves on green.
  - **Report:** whether timing is readable, and whether the countdown is too long or too short (`machine.countdownSec`).
- [ ] Play 10 balls: some forward defensives, some straight drives, some full swings.
      After every contact the HUD (up and to your right) shows *Exit km/h · launch ° · bat m/s · sweet % · carry m*.
  - **Report:** typical **bat m/s** for a block and for a big swing, and the best exit km/h and carry you managed.
    Knobs: `bat.speedMultiplier` (also **Settings → Bat power**), `bat.restitutionSweet`.
- [ ] Does the ball ever pass through the bat when it clearly should have hit?
  - **Report:** any tunnelling, with pace and roughly where on the bat. This should never happen.
- [ ] Edges: play away from your body outside off stump.
  - **Report:** whether edges fly believably (thin edges carry behind, thick edges squirt square).
    Knobs: `bat.edgeStart`, `bat.edgeDeflectDeg`, `bat.thinEdge*`.
- [ ] Haptics: compare a sweet-spot hit with an edge.
  - **Report:** whether you can feel the difference, and whether pulses are too strong or too weak
    (`haptics.*`, **Settings → Haptics**).
- [ ] Sound: the crack should be sharp in the middle and a dull click off an edge.
- [ ] Machine settings (menu → Bowling machine…): try 150 km/h, a bouncer, a yorker, out-swing 1.0, seam ±1,
      and off-spin / leg-spin around 85 km/h.
  - **Report:** whether swing, seam and spin are visible and believable, and whether there is too much or too little
    (`ball.swingCoeff`, `surfaces.seamMaxDeg`, `surfaces.spinTurnScale`), and whether bounce height looks right
    (`surfaces.pitch.restitution`).

## 4. Bowling: your priority feature (10 min)
Start **Nets: Bowling**. You are teleported to the bowler's end. The yellow ring on the pitch is the aim
marker; move it with the left stick.
- [ ] Hold the **right trigger**, bowl a normal overarm action, and let go of the trigger at release.
      The HUD shows *km/h* and then *hand m/s · elev ° · az ° · roll rad/s*.
  - **Report:** km/h for a gentle, a normal and a flat-out action, and the hand m/s values.
    Knob: **Settings → Bowling pace ×** (`bowling.paceMultiplier`, default 2.6, capped at `paceCapKmh` 150).
- [ ] Bowl five balls aimed at a good length. **Report** the `elev °` values you see.
      Then run **Settings → Calibrate bowling release**: bowl three normal balls and the game learns your
      neutral release angle.
  - **Report:** whether length is controllable before and after calibration (`bowling.lengthPerDeg`, `assistStrength`).
- [ ] Line: aim at off stump and bowl ten balls.
  - **Report:** whether line feels too twitchy or too sticky (`bowling.lineGain`).
- [ ] Spin: roll your wrist hard at release, clockwise for off-spin and anti-clockwise for leg-spin (from behind your hand).
  - **Report:** the `roll rad/s` values, and whether spin triggers too easily or not enough
    (`bowling.spinDeadzone`, `bowling.spinMultiplier`). Check the turn direction looks right.
- [ ] **A** / **B** toggle out-swing / in-swing (shown on the HUD sub-line).
  - **Report:** whether the swing is visible.
- [ ] Turn the aim assist off (**Settings**) and try again. **Report:** whether it is playable without it.
- [ ] AI batter: on **Settings → Difficulty** easy, medium and hard, bowl a few overs.
  - **Report:** whether it leaves wide balls, defends straight ones, drives full ones, pulls short ones, edges and gets bowled
    sometimes. Say if any difficulty is too easy or too hard (`ai.easy/medium/hard`).

## 5. New batting controls (5 min)
Use **Run Chase** on *Easy* first.
- [ ] Difficulty: play an over each on easy, medium and hard.
  - **Report:** whether easy feels about 30% slower and hittable, and medium a bit slower than hard
    (`difficulty.*.timeScale`, `batAssist`, `paceScale`).
- [ ] Bat face: play the same drive with the face straight, then opened upward.
  - **Report:** whether a straight face keeps the ball on the ground and an open face lofts it (`bat.faceLed`, `loftGain`).
- [ ] Hold the **right trigger** before the ball: you stride down the pitch. Hit a few, miss one on purpose.
  - **Report:** whether the stride feels comfortable (it moves the world 1.6 m; `bat.advanceDistance`, `advanceSpeed`),
    whether hits go clearly further, and whether the keeper stumps you when you miss.
- [ ] Hold the **right grip** and sweep; swing to the off side for a reverse sweep; trigger + grip for the slog sweep.
  - **Report:** whether the right shot is recognised (the HUD names it) and the ball goes where you expect.
- [ ] Move in the crease with the **left stick** and by physically stepping.
  - **Report:** whether the world stays put when you step, and how far you can go before the Quest boundary appears.
- [ ] Bat width: the blade is 12.5 cm (real: 10.8). **Report:** easier to hit? too wide? (`bat.bladeWidth`)

## 6. Running, run-outs, umpires (5 min)
- [ ] Hit into a gap and press **X**. The floating prompt shows RUN / the runs so far. The batters stop after each run.
      Press **X** again for a second. Try **left trigger** to turn back and **Y** to dive.
  - **Report:** whether the prompts make it clear what to press, whether you can judge a run from where the
    fielders are, and whether run-outs feel fair (`field.pickupTime`, `field.throwSpeed`).
- [ ] Watch the umpire at the bowler's end after a four, a six, a wide and a wicket.
- [ ] Get hit on the pad in front of the stumps (leave a straight one). The umpire decides; if given out, press **A**
      to review. **Report:** whether the review board is readable from the crease and how long it feels.

## 7. Bowling deliveries and fielding (10 min)
Start **Nets: Bowling**, then **Bowl an Over**.
- [ ] Pace: bowl gentle, normal and flat-out. The HUD names the delivery and speed.
- [ ] Length by release timing: let go early (full / full toss), normally, and late (short / bouncer).
  - **Report:** whether length follows your release point (`bowling.lengthRange`, `lengthPerDeg`).
- [ ] Bowler types: flick the **right stick** left / right to go through fast, medium-fast, off-spin and leg-spin.
  - **Report:** km/h for a normal action with each bowler (ranges in `src/game/bowlerTypes.js`: `pace`, `paceScale`).
- [ ] **Fast / medium, swing:** grip the ball, then turn your wrist left (seam to the slips) and right before you
      bowl. Watch the seam on the ball in your hand and the "Seam: …" prompt.
  - **Report:** whether the seam follows your wrist the right way round, whether it changes when you did not mean
    it to (dead zone 10°, full at 31°: `seamFromWrist` in `bowlerTypes.js`), whether it survives your wind-up
    (it should lock once the hand moves faster than 1.5 m/s), and whether the ball then swings the way it said.
    Also try **A** / **B**.
- [ ] **Fast / medium, cutters:** roll the wrist as you let go. Clockwise should be an off-cutter (seams in to the
      right-hander), anticlockwise a leg-cutter. Back of the hand: slower ball.
- [ ] **Off-spin:** clockwise roll = off-break; back of the hand = doosra; no roll = arm ball. An anticlockwise
      roll should *not* produce a leg-break (you get an arm ball and a note).
- [ ] **Leg-spin:** anticlockwise roll = leg-break; back of the hand = googly; clockwise = top-spinner; no roll = slider.
  - **Report:** whether the game names the delivery you meant. Back-of-the-hand detection uses the calibrated
    bat-face direction as your palm (`bowling.palmDot`), so calibrate first. Say which ones it gets wrong.
- [ ] Catching: when the batter skies one, time slows and you are moved under the ball. Reach for it.
  - **Report:** whether the move is comfortable, whether there is enough time, and whether the catch radius is fair
    (`catching.slowMo`, `leadTime`, `handRadius`).
- [ ] Throws: when a fielder picks up, press **A** (keeper) or **B** (bowler's end).
  - **Report:** whether you get run-outs and whether the prompt appears in time.
- [ ] Turned-down LBW: press **A** to review.

## 7b. The AI batters (5 min)
Bowl a few overs in **Bowl an Over** or a **Match** and watch the batter from your end.
- [ ] Stance and backlift: the bat is grounded by the back foot and comes up as you grip the ball.
- [ ] Drives, forward defence, pulls, cuts, flicks and leaves.
  - **Report:** any shot that looks stiff or wrong: a jerk at the start, arms detached from the bat, feet sliding,
    a finish that looks odd. Say which shot (the HUD names it) so the template in `SHOTS` (`src/game/aiBatter.js`)
    can be tuned.
- [ ] Bowl slow (under 100 km/h) for an over: the keeper comes up to the stumps and batters start coming down the pitch.
  - **Report:** how often they charge (`ai.charge`), whether you can get them **stumped**, and whether the third
    umpire board is readable from your end.
- [ ] Step well past the white line as you bowl: it should be called a **no-ball**, and the next ball a free hit.
  - **Report:** whether no-balls are called when you did not overstep (`match.overstep`, default 0.3 m).

## 8. Match modes and sound (5 min)
- [ ] **Run Chase** and one **Match** (toss, then 5 overs and 5 wickets each; try bowling first once).
  - **Report:** any point where the game got stuck (no ball coming, no way forward), and whether targets are
    fair on each difficulty.
- [ ] Commentary and captions (Settings → Sound cycles all / effects only / off).
  - **Report:** lines that are wrong for what happened, clipped, or too frequent.

## 9. Mixed reality nets (3 min)
- [ ] In VR, open the menu and choose **Switch to mixed reality nets**. If nothing happens after a second trigger
      pull, exit VR and press **Enter MR nets** on the page. **Report which one worked.**
- [ ] Point the **left** controller at the floor; a green ring and arrow follow it. Pull the trigger to drop the
      stumps. The pitch runs the way you are facing. Walk to the crease, then open **Nets: Batting**.
  - **Report:** whether the ring sits on the real floor (hit-test) and whether the stumps stay put when you move.

## What to send back
1. The numbers above: frame rate, velocity source, bat m/s, exit km/h, hand m/s, elev °, roll rad/s.
2. A "too much / too little" list for: bat power, bounce, swing, seam, spin, bowling pace, AI difficulty, fielders.
3. Anything that broke or got stuck, and what you pressed just before.
