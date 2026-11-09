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
