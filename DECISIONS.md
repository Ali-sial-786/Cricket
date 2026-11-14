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

## Later additions

| # | Decision | Why |
|---|----------|-----|
| L1 | **Ball visibility boost** (Settings, default on): the ball is *drawn* at least 0.34° across (up to 2.2× size at 19 m), shrinking to true size as it approaches. Physics radius unchanged. | A real 7.2 cm ball at the bowler's end is ~4 px on Quest 3S optics — too hard to pick up at release. |
| L2 | Head pose read from `XRFrame.getViewerPose()` each frame, not the XR camera matrix. | three updates the XR camera inside `render()`, so it is a frame late (and wrong for a frame after a rig move). |
| L3 | No multiview: three r180's `WebGLRenderer` has no multiview stereo path (only the WebGPU renderer does), so draw calls are ×2 per frame (~60). | Still within Quest 3S budget; switching renderers wasn't worth the risk overnight. |
| L4 | "Guard" stepper in Settings shifts where recentering puts you (leg / middle-leg / middle / middle-off), applied on the next recenter/mode start. | Stance position preferences vary. |
| L5 | Independent review pass of headset-only paths (no headset available). Fixed: menus placed from a stale head pose after rig moves (could end up behind you, invisible), laser drawn backwards, no handling of Quest system recenter (`reset` event → auto-recenter / MR re-place), no pause on `visibilitychange`, menu unreachable without a left controller (right stick-click fallback; right A = next ball), XR-end handled before three's teardown (now `sessionend`, camera fov restored), failed `setSession` left an immersive session open, MR dynamic import, frame-counted grip-hold, buttons stuck after disconnect, untracked controllers keeping stale velocity. | Everything the emulator can't exercise. |
| L6 | Frame rate: still request the highest supported (≤120 Hz) per spec, but **step down automatically** (120 → 90 → 80…) if measured fps stays below 88% of target for 4 consecutive visible seconds. | "Fall back cleanly": a stable 90 beats a juddering 120 if the 3S can't hold it. |
| L7 | Y with no session to resume re-places the open menu in front of you instead of doing nothing. | Recovery path if a panel ever ends up out of view. |

## Quality / animation upgrade (second pass)

| # | Decision | Why |
|---|----------|-----|
| Q1 | Characters are procedural **rigid-skinned SkinnedMeshes** (17 bones, ~2.7k triangles, one draw call each) built from capsules/rounded boxes with joint caps. No external models. | Articulated limbs + GPU skinning at Quest cost; stays original and asset-free. |
| Q2 | Team kits are shader uniforms on a shared program (vertex attribute `kit` selects fixed colour / primary / trim / headgear). The player's team is always blue & gold ("home"), the AI red & white. | Swap teams per mode without rebuilding meshes. |
| Q3 | Animation is procedural: a walk↔run blend whose cadence is derived from ground speed (stride = 1.25 + 0.3·v m), keyframed actions (throw, dive, pick-up, celebrate, bowling delivery), and **two-bone IK** for hands (bat grip, catches, pick-ups) and feet (planted stances). | No foot sliding, hands actually on the bat, poses react to the real ball/bat — impossible with canned clips. |
| Q4 | The bowler's arm is IK'd along a circular arc so the hand passes *exactly* through the physics release point at the release instant; the bowler's size (0.95–1.18×) and run-up path are solved backwards from that point. | The ball visibly leaves the hand — the visual cue matches the physics. |
| Q5 | Fielders walk in with the run-up, crouch at release, chase (pick up → wind up → throw, with the ball in the hand), dive for wide chances, jog back between balls (the next ball waits ≤ 4 s for them); the keeper gathers anything that passes the bat. When you bowl, a slow ball dying near your end is fielded by you. | "Movement better": no teleporting, readable fielding. |
| Q6 | Batters run between the wickets (both figures, opposite lanes), turn back from aborted runs, and swap roles after odd runs; when you bat, a runner in your kit runs for you. | Visible running instead of a silent counter. |
| Q7 | Desktop default camera is a broadcast-style view behind the stumps with the player's own body (IK'd to the mouse bat); `C` still cycles to batter's eye etc. Hidden in VR. | Desktop testers can see the animation. |
| Q8 | Stadium rebuilt: two-tier stepped stands with coloured seat-back sectors, concourse, roof canopies on pillars, pavilion, big screen on a frame, two rings of scrolling LED boards (original fake brands), floodlights with additive halos, cloud-painted sky dome, distant skyline, chequer-mown turf with a worn rim, cracked/footmarked pitch, ACES tone mapping + distance fog. | "Much higher quality" while staying within budget (merged meshes, canvas textures). |
| Q9 | Shaped bat (extruded cross-section: flat face, spine, rounded edges, toe bevel), ribbed grip, sticker decals; glossy leather ball with a stitched seam. | Props are what you look at most in VR. |
| Q10 | Particles: one pooled `Points` draw call for pitch dust, grass flecks, stump splinters and six fireworks. | Cheap feedback. |
| Q11 | Budget after the pass (measured headless, both eyes): ~60–80 draw calls, ~300k triangles; contact shadows are one InstancedMesh, the crowd is 4 culled quadrants (3000 people, `render.crowdMax`), distant fielders skip IK (`render.animLodDistance`). | Keep 90–120 Hz plausible on Quest 3S; knobs exposed in config if it isn't. |

## Gameplay overhaul (third pass)

| # | Decision | Why |
|---|----------|-----|
| G1 | Characters use Courtside's `Athlete.glb`, converted offline (`tools/build_athlete.mjs`) to a compact JSON + binary and **re-bound to this game's own 17-bone arms-down rig**, so all the existing procedural animation and IK keeps working. Kit colours stay shader uniforms; gear (helmet, cap, hat, pads, gloves) is generated. Two LODs (10.5k / ~3k triangles). | "Use better models" without throwing away the animation system or loading a GLTF runtime. |
| G2 | Difficulty is mostly a **time scale on the ball in flight**: easy 0.70, medium 0.85, hard 1. Your bat stays in real time. Easy/medium also enlarge the sweet spot and blade (×1.55 / ×1.25 assist), slow the bowlers a little, slow the fielders, lower the target; easy turns off LBW against you. | "Even fast balls feel 30% slower" is literally a 0.7 time scale; it keeps the true trajectory, so what you learn carries to hard. |
| G3 | Launch elevation is **led by the bat face** (`bat.faceLed` 0.75): the exit direction is blended toward the face normal's elevation, so a straight face keeps the ball down and an open face lofts it. | "Bat angle at contact should control that." The pure impulse model lofted nearly everything because the swing path rises. |
| G4 | Blade width 12.5 cm (law: 10.8 cm). | "Slightly wider so they're easier to hit." |
| G5 | **Stride out** = hold the right trigger before the ball: the rig glides 1.6 m down the pitch at 3.6 m/s and back when released. While out: sweet spot −40%, power up to +32%, extra loft. Miss and the keeper stumps you (0.3 s off a spinner, 0.85 s off pace). | Risk and reward as asked. A held button with a smooth short glide is the least sickening way to move 1.6 m. |
| G6 | **Sweeps** = right grip held at contact. Hand moving toward the off side (> 0.6 m/s) = reverse sweep; with the trigger (or while stepped out) = slog sweep, aerial and in front of square. The sweep replaces the exit direction but keeps speed from bat speed and contact quality; edges stay edges. | A real sweep is hard to perform with a controller-length "bat"; a dedicated button with real timing is the IB-Cricket-style compromise the brief asked for. |
| G7 | **Crease movement:** real steps always work (the rig is fixed to the pitch); the left stick also slides you ±0.9 m across and ±0.55 m along. Seeing your room when you step is the Quest boundary, so the docs ask for a room-scale boundary. | The game cannot switch off the system boundary. |
| G8 | **Running is manual:** X calls one run at a time; the batters stop when it is completed. Left trigger turns back, Y dives in the last 30% of a run (0.9 m more reach and 45% faster over the line). AI batters decide from the estimated return time and a boldness factor. Run-outs are judged at the end the throw goes to, against that runner's progress. | As asked: "run should stop after run is completed unless I press again." |
| G9 | **Throws:** fielders default to the nearer end; while you are the fielding side, **A** sends the throw to the keeper and **B** to the bowler's end. | Keeps your hands free and gives you the tactical choice without having to mime a 60 m throw. |
| G10 | **Catching:** when a catch is on while you bowl, the game moves you under the ball as that fielder, slows time to 22% and you catch it by getting either controller within 24 cm of the ball. No button. Miss it and it is a drop; play continues. | "More appropriate for VR… slow mo during a catching opportunity." |
| G11 | **Bowling by action.** Pace = hand speed. Length = release elevation relative to your calibrated neutral, widened to a full toss at one extreme and a bouncer at the other. Wrist roll about the forearm + which way the palm faces at release picks the delivery: clockwise + palm forward = off-break, clockwise + back of hand = doosra (turns like a leg-break), anticlockwise = leg-break, anticlockwise + back of hand = googly (turns like an off-break). Above 105 km/h a roll becomes a cutter. | Mirrors how those balls are actually bowled: the doosra and googly are the "wrong 'uns" delivered from the back of the hand with a similar-looking action. |
| G12 | Palm direction comes from the calibrated bat-face axis of the controller. | It is the one hand-relative direction the game has already measured for you. Unverified on a headset; flagged in TESTING.md. |
| G13 | **LBW:** pads are the only body collider. Law: not pitched outside leg, impact in line (or outside off with no shot offered), going on to hit. The on-field umpire is wrong sometimes (more often on marginal balls); each side has 1 review per innings, lost if it fails, kept on umpire's call. The DRS board and ball tracking are ported from Courtside and re-laid as a world-space panel. While it shows, the HUD is hidden. | "Add DRS similar to the Courtside repo." |
| G14 | **Commentary** is Courtside's engine and recorded clips (two fictional voices), loaded lazily after the first user gesture. (Captions were removed in the sixth pass at your request.) Recorded bat / crowd / stumps samples play when loaded, else the synthesised ones. | "Use the commentary from it." Lazy loading keeps start-up fast (22 MB of clips). |
| G15 | **Umpires** stand at the bowler's end and square leg and signal four, six, out, wide, not out and the review. | Asked. |
| G16 | Default match: **5 overs, 5 wickets**; the over count is still adjustable. Five AI bowlers bowl one over each. | Asked. |
| G17 | The menu button moved from Y to the **left stick click** while a ball is live (Y still opens it between balls), because Y is the dive. | Asked: "diving with the Y button." |
| G18 | **VR → MR from the menu:** the game ends the VR session and requests `immersive-ar` from inside the controller's XR `select` event, which counts as a user gesture. If the browser refuses, the message tells you to use the page button. Supersedes MR3. | The old button only showed a hint, which looked like "didn't do anything". Unverified on a headset. |
| G19 | The Pages workflow now publishes `assets/` as well as `src/`. | The model and audio live there. |

## Fourth pass

| # | Decision | Why |
|---|----------|-----|
| H1 | **Batting swing model.** The bat still follows an analytic path that puts the sweet spot on the predicted ball at the predicted time (so the physics decides middle / edge / miss exactly as before), but the path is now: grounded stance with a light tap → backlift when you grip the ball → top of the backswing → a downswing whose angle follows a cubic Hermite curve (at rest at the top, full speed at contact) → a decelerating follow-through → hold → relax. The hands travel from the back hip to the finish position on a curve that leaves the contact velocity unchanged; the wrists roll after contact. Bat velocity for the collision is the numerical derivative of the path. | "A lot more natural and realistic." The old swing turned at constant speed between two hard stops and started from a vertical bat. Measured contact rates are unchanged (cut improved). |
| H2 | Cross-bat shots (pull, cut) blend from an explicit raised-bat pose at the top; the pull meets the ball further in front and the cut later, with the body placed relative to the hands instead of at fixed foot offsets. | The old pull had the hands behind the body. |
| H3 | Body animation follows the plan: trigger movement, the leading foot is lifted and planted before contact, hips shift onto it, torso yaw follows the hands, the trunk bends and the hips follow if the bat would be out of reach, front elbow high, back heel up in the follow-through. | Without it a correct bat path still looks like a puppet. |
| H4 | The flick is played straighter (−0.45 rad instead of −0.7) and a little slower. | It missed 40% of leg-side balls at medium, which produced a stream of LBW appeals. |
| H5 | **Stumpings when you bowl.** Against balls under ~99 km/h the batter may come 0.6–1.5 m down the pitch (chance from `ai.charge` × the batter's own tendency × aggression) and play a lofted drive. If the ball beats him he turns 0.3 s later and returns at 3 m/s; the keeper breaks the wicket 0.3 s after taking it standing up (0.8 s standing back). The keeper stands up once your recent pace averages under 100 km/h. | "Also allow stumping." It rewards flight and turn, which is what a spinner bowls for. |
| H6 | **Third umpire**: run-outs and stumpings decided by less than 0.55 m go upstairs (Courtside's board, hung over the pitch when you are at the far end); a close not-out also breaks the stumps so there is something to check. It is automatic and costs no review. | A feature from Courtside that suits VR: you watch the replay board from where you stand. |
| H7 | **No-balls and free hits.** You: head more than 0.3 m past the popping crease at release (headset only), or a full toss above 1.15 m at the batter. AI bowler: 2–4.5% per ball by difficulty. One run, re-bowled, next ball a free hit; on either only a run-out counts. | From Courtside's rules. The head is the only body position the headset reports, so it stands in for the front foot; the margin is generous and tunable (`match.overstep`). |
| H8 | **Squads and scorecards.** Two fictional XIs (Harbour Kings = you, Summit Stars = AI). When you bat you play each batter in the order in turn. AI batters have a profile by position (error scale 0.85–1.75 of the difficulty's standard, aggression and charge tendency). The card tracks strike, balls, boundaries, dismissal text, bowling figures and fall of wickets. | Makes a match read like a match, and makes the tail easier to bowl at than the top order. |
| H9 | **Toss** before a Match: you call; the winner chooses. The AI chooses at random if it wins. Either side can bat first. | From Courtside. |
| H10 | Everything stays **first person** in the headset on both sides; the only time the viewpoint moves is to put you under a catch. Replays and broadcast cameras from Courtside were not ported. | Asked. |

## Fifth pass: your bowlers

| # | Decision | Why |
|---|----------|-----|
| B1 | You bowl **as one of four bowlers** (fast, medium-fast, off-spin, leg-spin), chosen with the right stick: any time in the nets, only at the start of an over in a match. The same arm speed is scaled into each bowler's pace range. Supersedes the pace threshold in G11. | "Needs to be dependent on bowler type." Real bowlers are one kind; overs are the natural unit for changing. The right stick was unused while bowling. |
| B2 | **Spinners only have their own repertoire.** Off-spinner: off-break (clockwise roll), doosra (back of the hand), arm ball (no roll). Leg-spinner: leg-break (anticlockwise), googly (back of the hand), top-spinner (clockwise roll), slider (no roll). The other bowler's stock roll produces this bowler's straight one, with a note saying why. | "Leg spinners can't bowl off spin or doosra." Giving the wrong roll a legal straight ball is kinder than a no-op and is roughly what happens in real life. |
| B3 | **Swing = seam position, set before the ball.** With the ball gripped, the game integrates how far your wrist has turned about the vertical: left (toward the slips for a right-hander) = out-swing, right = in-swing, with a 10° dead zone and full swing at 31°. It only counts while the hand is slower than 1.5 m/s, so it locks when you start your action. The seam on the ball in your hand, a prompt and a haptic tick show the setting. A / B set full out / in directly. | This is how swing is actually bowled: the grip and seam angle are fixed before the run-up, not at release. It is a slow, deliberate, visible gesture, so it is reliable in a way a wrist angle measured during a 20 m/s arm swing is not. Measuring the turn from the moment you grip (not an absolute angle) makes it independent of how you hold the controller. |
| B4 | **Seam movement = cutters, from the wrist at release.** For fast and medium bowlers a clockwise roll is an off-cutter (seams in), anticlockwise a leg-cutter (seams away); the back of the hand is a slower ball (−22% pace). A cutter loses 7% pace and most of its swing. An upright seam with no roll nips about a little at random. | Uses the same gesture the spinners use, so there is one thing to learn: turn before = swing, roll at release = movement off the pitch. |
| B5 | Fast bowlers get full swing and 0.75× seam movement; medium-pacers 0.7× swing and 1.3× seam. | As in Courtside's bowler profiles. |
| B6 | The keeper stands up for your spinners (it used to depend on your recent pace). | Follows from having a bowler type. |

## Sixth pass

| # | Decision | Why |
|---|----------|-----|
| C1 | **Contact was diagnosed, not guessed.** The render and physics bat use the same pose and the physics samples it at the right time, so nothing was "passing through" a bat that was really there. A simulation of swings with human timing / placement error showed misses come from timing (the ball goes under the toe as the bat arcs) and lateral placement. | So the fix targets the real cause. |
| C2 | Bat 14 cm wide (was 12.5), blade 61 cm (was 56), controller held 12 cm below the handle top (was 14): the toe sits 7 cm lower. | "Slightly wider and slightly longer". |
| C3 | **Contact assist** (Settings, default *normal* on every difficulty, hard included): the physics bat also counts a ball passing within `capture` m of it, pulls that contact `magnet` of the way toward the sweet spot, and has `toe` m of invisible blade below the visible toe. Normal = 8 cm / 30% / 12 cm. The ball is not slowed. A capture can move the ball up to ~10 cm at impact, which takes ~3 ms at 130 km/h and isn't visible. | "Don't make the ball slower in hard mode… it just needs to make better contact." |
| C4 | Your pad box (for LBW) is narrower (±15 cm), sits under / behind your head, and is skipped while the bat is within 30 cm of the ball. | It was deflecting balls the bat was about to hit, worst when you leaned your head over the line. |
| V1 | **Views:** the headset camera hangs off a child of the play rig; *behind the player* offsets only the camera (world offset converted into rig space each frame), so the controllers, bat physics and your body stay at the crease. Menus, catches and replays drop back to your eyes. | One change gives third person without touching gameplay. |
| V2 | Anything within 60 cm of your eyes is moved to a camera layer nobody renders (bodies, and the bat they carry). | The runner who runs for you started inside your head. Layers leave the game's own visibility flags untouched. |
| V3 | The helmet grille is head-locked geometry placed from the frame's viewer pose (not a child of the camera, which three updates a frame late). Bars below the eye line, peak above, clear straight ahead. | Crisp and stable in VR. |
| R1 | **Replays** record everything that moves (ball, every figure's bones, bats, stumps, your head) at up to 60 Hz in a 15 s ring buffer (~6 MB) and play it back while the game is frozen. Clip: from 1 s before release to ~3 s after the hit (or ~1 s after the ball is dead). Slow motion around the shot. | "A replay for every ball", without re-simulating anything. |
| R2 | Bowler's view = above the umpire, wide of the bowler's arm; batter's view = your recorded head (or the batter's stance); after a hit the camera chases 4.5 m behind the ball, never past the rope. In the headset you are moved there, the turn is smoothed, the edges dim while moving, and the chase runs at 75%. Any button skips. | As asked, with VR comfort measures. |
| K1 | Held balls follow the holder's right hand; both hands only at the moment of a catch / take. A shared temporary vector made every "hold at the chest" pose aim the hands at the elbow pole (behind the hips): fixed. | "The ball gets stuck in the keeper's nuts or on the head." |
| K2 | Throws are taken over the stumps by the keeper (batting end) or the bowler / a fielder backing up (bowler's end); on a run-out the glove sweeps into the stumps and they break 0.12 s later, when the glove gets there. With nobody there the throw runs on past. Stumpings: the keeper lunges and takes the bails. | "The keeper actually grabs it and hits it into the wicket." |
| H1 | Control hints draw the Touch controller with the button lit (desktop: the key). Shown once per game per control, and continuously while running / choosing a throw / reviewing. | "A small controller visual where the button you need to press is shown." |
| A1 | Crowd: 2-triangle cut-outs from a mask atlas (R shading, G shirt, B skin), per-fan colours, cheering / wave in the vertex shader; 26,000 max, merged into 4 meshes (one per quarter, culled behind you). Instancing 25,000 tiny quads was measured at half the frame rate; merged, the crowd costs almost nothing. Seated fans draw a smaller quad. The Cartesia key you mentioned could not be fetched (a search of your repositories for it was blocked); instead the 25 recorded crowd reactions from Courtside (CC0 / public domain) plus synthesised chants, drums and whistles. | "Packed live environment" within the Quest budget. |
