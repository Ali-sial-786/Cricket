# Decisions log

Every judgment call made while building this unattended, with the reasoning.
Tuning numbers live in `src/config.js`; this file explains *why* they are what they are.

## Project / tech

| # | Decision | Why |
|---|----------|-----|
| D1 | three.js pinned to **0.180.0** via importmap from cdn.jsdelivr.net. | Mature, well-known WebXR API surface (r180, Sep 2025). Newer releases exist but buy nothing here and carry more risk of deprecation surprises. |
| D2 | Physics written as pure ES modules under `src/physics/` with their own tiny `Vec3`/`Quat`/`Pose` classes. | Requirement: no three.js imports in physics, unit-testable in node. Mirrors three's conventions so conversion is trivial. |
| D3 | Physics runs at **480 Hz** fixed substeps (config `physics.substepHz`). | Spec says ≥240. At 480 Hz a 150 km/h ball moves ~8.7 cm per step, which keeps the linearised relative bat-ball path very accurate. Cost is negligible (one ball). |
| D4 | World frame: batting stumps at origin, pitch along **-Z**, bowler's stumps at z = -20.12. RH batter's off side = **+X**. | -Z is three.js/WebXR "forward", so a batter facing the bowler looks down -Z by default. |
| D5 | Tests use `node --test "tests/**/*.test.js"` (npm test). | `node --test tests/` (directory) doesn't work on Node 22. |

## Ball physics

| # | Decision | Why |
|---|----------|-----|
| B1 | Drag Cd = 0.40, quadratic. | Gives ~6% speed loss release→bounce for a 140 km/h ball, in line with broadcast speed-gun vs. arrival data. |
| B2 | Swing: horizontal lateral force ⟂ velocity, coefficient 0.20 at full swing, ramps in from 15→30 m/s, **only before the first bounce**. | Conventional swing is an in-air effect of the seam/shine asymmetry; ramp avoids slow balls "swinging" absurdly. Sign: + = toward (up × v) = outswing to a RH batter. |
| B3 | Magnus via lift coefficient CL = 0.4 × spin parameter (capped 0.25). | Literature-style model; produces dip for topspin, hold-up for backspin, drift from tilted spin axes, and *zero* drift for pure side-spin (axis along velocity). |
| B4 | Bounce = sphere-on-plane impulse model with restitution (pitch e = 0.52) and Coulomb friction (μ = 0.25), capped at the rolling condition, spin coupling via I = 0.4 m r². | Physically based: spin turn, top-spin "kick", and pace-off at the bounce all fall out naturally. e = 0.52 makes a good-length 140 km/h ball reach the stumps at ~0.66 m (top of off stump), bouncers at head height. μ tuned from 0.30 → 0.25 so a 140 km/h ball arrives at ~115 km/h rather than 112. |
| B5 | `spinTurnScale` = 1.6 multiplies the physically computed turn angle by **rotating** the post-bounce velocity (energy neutral). | Pure friction physics gives ~2° turn — realistic but hard to read in VR. Rotation instead of adding velocity keeps "bounce never adds energy" true. |
| B6 | Seam deflection is an explicit rotation at the first pitch bounce: slider ±1 → ±3°, plus 0.6° random wobble (machine only; deterministic when no RNG is passed). | Seam movement is chaotic in reality; a controlled ± setting is what a nets machine user wants. |
| B7 | Ball rolls when the vertical rebound < 0.7 m/s; rolling uses a constant decel (1.3 m/s², 20% more on the pitch strip) + drag. | Simple, stable, gives fast outfields where a well-struck ground ball reaches a 65 m rope. |
| B8 | White ball, dark sightscreens. | Highest contrast in VR at distance; limited-overs look. |

## Bat collision

| # | Decision | Why |
|---|----------|-----|
| C1 | Swept collision = sphere-tracing the ball's **bat-relative** path (ball centre transformed into bat-local space at substep start/end) against an SDF of the bat (rounded-box blade + capsule handle) with conservative advancement. | Exact for the linearised relative motion and provably can't step over the surface (SDF is 1-Lipschitz). Bat pose at each substep comes from lerp/slerp of the two latest frame poses. Tested at 72/90/120 Hz × 110–160 km/h × many phase offsets. |
| C2 | Exit velocity uses an **apparent COR** (relative restitution against a kinematic bat): 0.42 at the sweet spot, falling to 0.12 at toe/shoulder (Gaussian, σ = 13 cm), 0.10 off the back, 0.08 off the handle. | Kinematic bat + apparent COR is mathematically equivalent to the effective-mass formula (e_A = (e − m/M)/(1 + m/M)) and needs no bat mass model. |
| C3 | Bat speed multiplier 1.25 on the controller's point velocity. | Home swings are gentle and one-handed; without a boost, sweet-spot drives top out ~120 km/h exit. Tune after testing. |
| C4 | Thick edges: face normal tilted up to 15° and COR reduced. Thin edges (contact > 85% of the half-width, full by 115%): exit velocity blends toward "carry on along the incoming path" (72% speed + 16% sideways). | Pure reflection off a rounded edge sends thin edges out square; real thin edges carry to keeper/slips. |
| C5 | 0.15 s per-bat cooldown after contact; ball always pushed 2 mm outside the surface. | Prevents double hits while the bat follows through. |
| C6 | Bat dims: blade 56 × 10.8 × 5.0 cm, handle 30 cm, your hand (the controller grip point) 14 cm below the top of the handle; sweet spot 17 cm up from the toe. | Real bats are ≤ 96.5 cm / 10.8 cm wide; slightly short overall length is easier to swing one-handed. |

## Bowling machine

| # | Decision | Why |
|---|----------|-----|
| M1 | Machine **solves** for the launch direction (2-D Newton on elevation/azimuth with the full physics) so the ball pitches exactly on the requested length/line point, swing included. | "Good length" then means what it says; the test (6–8 m at 140 km/h) checks the full integrator, not a formula. |
| M2 | Line = where the straight line from the release point would reach the batter's stumps; the pitch point lies on that line. Swing is compensated so the ball still pitches on it. | Matches how players describe deliveries ("pitched on off, moved away"). |
| M3 | Release at 2.15 m high, 0.42 m to the off side (right-arm over the wicket), z = -18.75; "around the wicket" mirrors x. | Typical seamer release point. |
| M4 | Pace slider range is **70–150 km/h** (spec says 110–150). | Spin options need spinner pace; a 110 km/h off-break is not a thing. Seamer presets stay in 110–150. |
| M5 | Seamers get 10 rps backspin, spinners up to 30 rps with a 0.8 side / 0.5 top / 0.15 drift axis mix. | Realistic spin axes; off-spin drifts away from the RH batter in the air then turns in, leg-spin the reverse. |

## XR, input, calibration

| # | Decision | Why |
|---|----------|-----|
| X1 | Player rig = a `Group` holding the camera and both controller spaces; it maps `local-floor` reference space → world (`world = Ry(yaw)·ref + T`). Teleport/recenter only changes the rig. | Standard three.js "dolly"; WebXRManager composes the camera's parent transform. Keeps physics in pitch coordinates regardless of where the player stands in their room. |
| X2 | **Recenter on every mode start** from the head pose (position + horizontal look direction): batting puts your head at x = guard − 0.35 m, z = −1.05 facing −Z; bowling puts it at (0.75, −19.6) facing +Z. Hold left grip 1 s to recenter any time. | No artificial locomotion, yet the pitch is always in front of you wherever you started. |
| X3 | Bat calibration defines "now" = bat vertical, face toward where you're looking. Stored as a grip-space quaternion (`localStorage`, try/catch) plus a user tilt (±30°) adjusted with the left stick. Default (uncalibrated) assumes bat axis = grip −Z, face = grip −X. | Grip-space offsets survive recenters/sessions. Calibration makes the WebXR grip-space convention irrelevant. |
| X4 | Bat point velocity = `v_lin + ω × r` using `XRPose.linearVelocity/angularVelocity` when the runtime provides them (`bat.velocitySource: 'auto'`), otherwise finite differences of the grip pose (lightly smoothed). | Spec requirement; Quest Browser should provide pose velocities but the fallback keeps everything working (IWER, other browsers). Settings page shows which one is active. |
| X5 | Frame rate: pick the highest `supportedFrameRates` value ≤ `xr.maxFrameRate` (120) and call `updateTargetFrameRate`; failures are caught. Fixed foveation 0.5, framebuffer scale 1.0. | Spec; 0.5 foveation keeps the ball crisp near the centre while saving fill rate. |
| X6 | Right controller = bat; left = laser pointer. X = next ball, Y = menu, left stick = aim marker / bat tilt, left grip hold = recenter. Right A/B = out/in-swing when bowling. | Right trigger can be squeezed accidentally while gripping a bat, so nothing batting-critical is on it. |
| X7 | Menus are canvas-texture panels hit-tested via raycast UV; steppers ( − value + ) instead of sliders. | Easy to hit with a laser at arm's length; redraw only when dirty (cheap on Quest). |
| X8 | Desktop debug mode drives the **same** controller objects as XR (virtual right controller from the mouse), so batting/bowling code paths are identical. | Spec: "everything testable in a normal browser". |
| X9 | XR smoke-tested headlessly with Meta's IWER emulator + Playwright (enter VR, safety, calibration A-button capture, laser click, nets, MR placement). Not committed (needs npm deps); harness lives outside the repo. | Catches XR-path runtime errors without a headset. |

## Bowling (player)

| # | Decision | Why |
|---|----------|-----|
| P1 | Pace = **peak-window** hand speed × `paceMultiplier` (2.6), capped at 150 km/h, floor 50. The release velocity is the sample at trigger-up unless the hand clearly peaked (>12%) within the previous 90 ms, then that peak sample is used. | Home overarm swings with a controller reach ~10–15 m/s hand speed. Using a just-passed peak forgives slightly late trigger releases. |
| P2 | **Line** from release azimuth compressed by `lineGain` 0.6 around "straight at the stumps"; **length** from release elevation vs. a neutral angle (−8°) at 0.15 m/°, clamped to 0.3–13 m (no beamers/full tosses). | Raw physics would make a 16 ms trigger-timing error worth ~5 m of length. Compression keeps it skill-based but controllable. |
| P3 | **Aim assist** (default on): with the marker shown, release errors are scaled by (1 − 0.65) around the marker instead of around a good-length default. Toggle in Settings. | Spec: "aim marker … can be toggled as an assist". |
| P4 | "Calibrate bowling release": averages your elevation over 3 balls → personal neutral angle (saved). | Everyone's natural release angle differs; this is the most likely thing to need tuning. |
| P5 | Wrist roll = controller angular velocity projected on the travel direction; beyond a 2.5 rad/s dead-zone, × 4 → spin rate (cap 30 rps). Positive = off-break for a RH batter. Spin replaces swing. | Physically meaningful (spin axis along travel = side-spin). |
| P6 | The mapped pitch point is fed to the same launch solver as the machine, from your actual hand position (clamped to a sane release box). | One physics path for every delivery. |
| P7 | Wides (|x| > 0.89 m at the popping crease, unhit) count only in innings modes. No no-balls. | Simple and fair for a standing delivery. |

## AI batter / bowler

| # | Decision | Why |
|---|----------|-----|
| A1 | The AI batter **is a bat provider** for the physics world (analytic pose + velocities at any substep time), not a scripted outcome. | Spec: "uses the same physics: can edge, miss, or be bowled". |
| A2 | Reading the ball: it simulates the delivery with seam/spin scaled by `readFactor` (easy 0.25 → hard 0.8), adds Gaussian timing (30/18/10 ms) and position (7/4.5/2.8 cm) error, then gets one late partial correction after the bounce (`adjust` 0.35/0.6/0.85). | Movement off the pitch and late swing beat weaker batters, as in real cricket. |
| A3 | Shot choice by line/length/height/stumps with aggression (raised by required run rate in chases) and a difficulty "mistake" rate (poking at wide ones → edges). Shots: leave/duck, forward & back defence (soft hands: bat gives backwards), drive (angle from line), pull, cut, flick. | Spec list plus duck/flick for completeness. |
| A4 | Swing generator: pick the face normal from the shot direction, bat axis from a per-shot "hands" offset (vertical bat for drives, horizontal for pull/cut), rotate about the axis that moves the sweet spot along the face normal. The player's bat-speed multiplier is **not** applied to AI bats (per-bat speed scale). | Produces correct shot directions with the generic contact model. |
| A5 | No LBW (optional in spec). The batter has no body collider, so a ball that would hit the pads goes on to the stumps and is "bowled". | Time; avoids a half-baked LBW. |
| A6 | AI bowler: odd overs seam (difficulty pace bands 112–126 / 124–138 / 134–148 km/h), even overs spin; death overs favour yorkers; accuracy/variation by difficulty. Visual run-up (2.3 s) is the timing cue in matches (the machine lights are for nets). | Variety in short chases; natural cue. |

## Fielding & scoring

| # | Decision | Why |
|---|----------|-----|
| F1 | 10 fielders (keeper, slip, point, cover, mid-off, mid-on, midwicket, square leg, fine leg, third man) + the bowler fields straight hits when the AI bowls. Boundary 65 m from the pitch centre. | Spec: fielders + keeper, ~65 m. |
| F2 | Interception: predict the hit, find each fielder's earliest reachable sample (reaction 0.4 s, 6.5 m/s, 7.5 m/s² accel; keeper/slip 0.15 s), send the fastest. Catch chance = skill (by difficulty) × hard-hit penalty × diving penalty. Drops are possible. | Simple, deterministic-ish, readable. Softened from 0.32 s / 6.8 m/s after tests showed singles into gaps were impossible. |
| F3 | Running is automatic: runs = completed runs (3.4 s first, 2.9 s each after, 0.35 s margin) before the throw arrives (pickup 0.5 s (+0.45 s after a stretch) + distance / 27 m/s). Max 3; no run-outs. | No locomotion for the player; keeps the game about batting/bowling. |
| F4 | Run Chase target = 1.7 / 2.2 / 2.75 runs per ball (easy/medium/hard) × balls; wickets = overs + 1 (min 2). Bowl an Over = defend 13 / 11 / 9. Match = you bat N overs (Settings → Overs, default 2), then defend. | "e.g. 30 off 2 overs" ≈ hard. |
| F5 | In nets there are no fielders; the HUD reports exit speed, launch angle, bat speed, sweet-spot %, carry and FOUR/SIX if it crosses the rope. | Fast practice loop + tuning data. |

## Rendering / performance

| # | Decision | Why |
|---|----------|-----|
| R1 | ~28–35 draw calls in a typical frame (desktop measurement): merged static geometry with vertex colours, one `InstancedMesh` crowd (~900 people, cheer animation in the vertex shader), Lambert/Basic materials, two lights, no shadows (blob shadow under the ball). | Quest 3S budget. |
| R2 | Humans are original low-poly figures: one merged body mesh + 2 arm meshes each; arms IK-free "reach" (aim + stretch) to the bat handle. | Cheap, readable, original. |
| R3 | Ball render position is extrapolated by the sub-step remainder (≤ 2 ms) so it's drawn at frame time. | Removes up to ~8 cm of visual lag at 150 km/h. |
| R4 | HUD is world-locked beside the pitch and scaled so 30 px text ≈ 1°; big stadium scoreboard for match state. | Readable on Quest 3S optics without head-locked UI. |
| R5 | Game name "Crease VR"; all art/figures/sounds original (IB Cricket used only as a reference for genre conventions: nets machine, aim marker, modes). | Spec. |

## Audio

| # | Decision | Why |
|---|----------|-----|
| S1 | All sounds synthesised in WebAudio from one shared noise buffer + oscillators: bat crack (brightness/ring scale with contact quality; thin click for edges), bounce thud by surface, stumps clatter, release beeps, crowd bed with slow LFO + cheer swells. AudioContext created on the first user gesture. | No asset pipeline; quality-dependent crack per spec. |

## Mixed reality

| # | Decision | Why |
|---|----------|-----|
| MR1 | `immersive-ar` with `hit-test` optional; reticle from the left controller's hit-test source, falling back to intersecting the controller ray with the local-floor plane (y = 0). Trigger places the **stumps**; the pitch runs the way you're facing. Stadium/sky hidden, clear alpha 0. | Spec. Fallback keeps it usable if hit-test isn't granted. |
| MR2 | In MR the batting end stays anchored to the placed stumps (no recenter); bowling re-anchors the bowler's end at your feet (you can't walk 20 m indoors). | Practical. |
| MR3 | Entering MR needs the page button (a new XR session needs a DOM user gesture); the in-VR menu explains this instead of trying. | Browsers reject `requestSession` without user activation. |
