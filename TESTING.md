# On-headset test checklist (Quest 3S)

About 30–40 minutes. Each item says what to try and **what to report back**. Report numbers where
asked: they map straight onto constants in `src/config.js`.

Setup: open the GitHub Pages URL in the Quest Browser. Wear the wrist straps and clear 2 × 2 m.

## 1. Boot, comfort, performance (5 min)
- [ ] Press **Enter VR**. The safety screen appears; click it with the **left trigger** (laser pointer).
- [ ] Open **Settings** (Y → Settings…). The top line shows the frame rate and whether the controllers
      report XR velocities.
  - **Report:** frame rate (Hz) and controller velocity (`XR` or `pose`).
- [ ] Look around the stadium and play a few nets balls.
  - **Report:** any judder, stutter when the ball is released or hit, or flicker at the edges (foveation).
    Knobs: `xr.maxFrameRate`, `xr.foveation`, `xr.framebufferScale`.

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

## 5. Match modes (5 min)
- [ ] **Run Chase** (2 overs). AI bowler run-up, fielders chase and throw, catches, boundaries at 65 m.
  - **Report:** whether singles and twos feel attainable, and whether fielders are too good or too poor
    (`field.fielderSpeed`, `fielderReaction`, `runFirst`, `runNext`).
- [ ] **Bowl an Over** (defend a total) and one **Match** (bat, then bowl).
  - **Report:** any point where the game got stuck (no ball coming, no way forward).

## 6. Mixed reality nets (3 min)
- [ ] Exit VR, then press **Enter MR nets**. Point the **left** controller at the floor; a green ring and arrow follow it.
      Pull the trigger to drop the stumps. The pitch runs the way you are facing. Walk to the crease, then open
      **Nets: Batting**.
  - **Report:** whether the ring sits on the real floor (hit-test) and whether the stumps stay put when you move.

## What to send back
1. The numbers above: frame rate, velocity source, bat m/s, exit km/h, hand m/s, elev °, roll rad/s.
2. A "too much / too little" list for: bat power, bounce, swing, seam, spin, bowling pace, AI difficulty, fielders.
3. Anything that broke or got stuck, and what you pressed just before.
