// ============================================================================
// TUNING CONSTANTS — every number you are likely to tweak after a headset
// session lives here. Pure data (no three.js), shared by physics, game and
// render code. Units: metres, seconds, kilograms, radians unless the name says
// otherwise (…Kmh, …Deg, …Ms, …Rps).
//
// Coordinate frame (world):
//   +Y up. Batting-end stumps at the origin. Pitch runs along -Z: bowler's
//   stumps at z = -20.12. A right-handed batter at the origin faces the bowler
//   along -Z, so their OFF side is +X and LEG side is -X.
// ============================================================================

export const CONFIG = {
  physics: {
    substepHz: 480,          // fixed physics rate (>= 240 required)
    gravity: 9.81,
    airDensity: 1.2,         // kg/m^3
    maxFrameDt: 0.05,        // clamp long frames (hitches) to this
  },

  ball: {
    radius: 0.036,           // ~7.2 cm diameter
    mass: 0.160,             // 160 g
    inertiaFactor: 0.4,      // I = k m r^2 (solid sphere)
    dragCoeff: 0.40,         // quadratic drag Cd
    swingCoeff: 0.20,        // lateral force coefficient at |swing| = 1
    swingSpeedLow: 15,       // m/s: no swing below this…
    swingSpeedHigh: 30,      // …full swing above this
    magnusSlope: 0.40,       // lift coeff CL = slope * spin parameter (r*w/v)
    magnusMaxCL: 0.25,
    spinDecayPerSec: 0.05,   // fractional air spin decay
    hitSpinRetain: 0.0,      // fraction of incoming spin kept after bat contact
  },

  surfaces: {
    pitch: {
      restitution: 0.62,     // vertical COR of the ball on the pitch (a good length at 140 km/h arrives at bail height, 10-11 m at chest height)
      friction: 0.2,         // Coulomb friction during bounce
    },
    outfield: {
      restitution: 0.40,
      friction: 0.40,
      rollingDecel: 3.5,     // m/s^2 rolling resistance on grass (+ drag): a 90 km/h ground shot stops ~55 m out, 115+ km/h races to the rope
    },
    rollVerticalSpeed: 0.7,  // m/s: below this vertical rebound, the ball rolls
    spinTurnScale: 1.6,      // >1 exaggerates spin turn (energy neutral) — game feel
    seamMaxDeg: 3.0,         // seam slider at ±1 deflects this much off the pitch
    seamRandomDeg: 0.6,      // natural random seam wobble (1 sigma)
  },

  bat: {
    // Geometry (bat local frame: origin = controller grip point, +Y toward
    // handle top, +Z = hitting face normal, +X across the face).
    bladeLength: 0.67,       // longer than a real blade (0.56): the toe reaches the turf in a tall player's stance, so low balls don't sneak under it
    bladeWidth: 0.15,        // wider than a real bat (10.8 cm) so contact is easier in VR
    bladeThickness: 0.056,
    edgeRadius: 0.012,       // rounding of the blade edges (affects edge deflection)
    handleLength: 0.30,
    handleRadius: 0.017,
    gripFromHandleTop: 0.12, // where your hand (controller) sits below the handle top
    sweetSpotFromToe: 0.23,  // (as far from your hands as on the 61 cm blade: the longer one is all reach)

    // Response
    speedMultiplier: 1.25,   // amplifies controller bat speed (home swings are gentle); Settings -> Bat power
    restitutionSweet: 0.42,  // apparent COR at the sweet spot (relative restitution)
    restitutionMin: 0.24,    // COR on the face far from the sweet spot: an off-centre hit loses some power, not most of it
    restitutionEnd: 0.10,    // COR off the toe, the shoulder or the side of the blade
    restitutionBack: 0.10,   // ball hits the back of the bat
    restitutionHandle: 0.08,
    sweetSpotSigma: 0.13,    // m: Gaussian falloff of contact quality along the blade
    edgeStart: 0.62,         // fraction of half-width where edge effects begin
    edgeDeflectDeg: 15,      // extra face-normal tilt for thick edges
    thinEdgeStart: 0.85,     // across-face fraction where thin-edge behaviour starts…
    thinEdgeFull: 1.15,      // …and is total (ball centre beyond the edge)
    thinEdgeRetain: 0.72,    // thin edge: ball keeps this much of its incoming velocity
    thinEdgeSidePush: 0.16,  // …plus this much sideways deflection (fraction of speed)
    tangentialRetain: 0.70,  // fraction of tangential relative velocity kept
    cooldown: 0.15,          // s: ignore further contacts with the same bat
    faceLed: 0.75,           // 0..1: how much the bat FACE angle (not the swing path) sets the launch angle
    loftGain: 1.0,           // launch elevation per unit of face elevation
    advanceDistance: 1.6,    // m you come down the pitch while the trigger is held
    advanceSpeed: 3.6,       // m/s
    advancePower: 0.32,      // extra bat power at full advance (x1.32), more for lofted shots
    advanceSweetShrink: 0.4, // sweet spot shrinks by this fraction at full advance (harder to time)
    // YOUR shot's power (src/physics/swingLoad.js, resolveBatContact). Exit speed off the face:
    //   exit = e x H x ball + (1 + e x H) x bat x P
    // bat: your bat's real speed into the ball x speedMultiplier; e: the bat's restitution where it
    // hit (restitutionSweet .. restitutionMin); P = loadFloor + (1 - loadFloor) x load, load 0..1 =
    // how far back and high you took the bat and how far it travelled to the ball; H = soft +
    // (1 - soft) x smoothstep(hands, bat's real speed): a bat pushed gently is held softly and
    // takes the pace off the ball (a dead bat), a swung one is firm.
    power: { loadFloor: 0.6, soft: 0.5, hands: [1.5, 10] },
    sweepLift: [0.42, 0.62], // rad: a slog sweep goes up between these (a sweep is kept down: sweepShot.js)
    creaseMoveSpeed: 1.3,    // m/s with the left thumbstick
    creaseBox: [0.9, 0.55],  // how far (x, z) the stick can move you in the crease
    velocitySource: 'auto',  // 'auto' | 'xr' | 'pose' — where controller velocity comes from
  },

  haptics: {
    contactMin: 0.25,        // intensity for a poor contact
    contactMax: 1.0,         // intensity at the sweet spot
    durationMinMs: 18,
    durationMaxMs: 70,
    edgeIntensity: 0.35,
    edgeDurationMs: 22,
    releaseIntensity: 0.3,   // bowling release
    releaseDurationMs: 25,
    uiTickIntensity: 0.08,
  },

  machine: {
    releaseHeight: 2.15,     // m — like a tall seamer's release
    releaseX: 0.42,          // + = over the wicket for a right-arm bowler (off side)
    releaseZ: -18.75,        // just behind the bowler's popping crease
    countdownSec: 1.5,       // red → amber → green; ball leaves on green
    autoFeedDelay: 2.2,      // s after a ball is dead before the next one (auto feed)
    paceMinKmh: 70,
    paceMaxKmh: 160,
    seamerBackspinRps: 10,
    spinMaxRps: 30,
  },

  bowling: {
    paceMultiplier: 2.6,     // hand speed × this = ball speed
    paceCapKmh: 150,
    paceFloorKmh: 50,
    minPaceFrac: 0.62,       // with a bowler type: no delivery leaves the hand slower than this x the bottom of its pace range
    minReleaseHandSpeed: 3.0,// m/s: slower trigger releases are treated as drops
    peakWindowMs: 250,       // pace = the fastest the hand moved in this window before release (the downswing)
    effortHandSpeed: [4.5, 14.0], // m/s of downswing -> the bottom / top of your bowler's pace range
    releaseBlend: 0.75,      // release height: this much the bowler's typical height, the rest your real hand
    seamFromAngleDeg: 1.6,   // an angled seam also nips off the pitch this much (x bowler's seam factor)
    neutralElevationDeg: -8, // release elevation (at peak hand speed) that maps to a good length
    neutralLength: 6.5,      // m from batter's stumps at the neutral elevation
    lengthPerDeg: 0.15,      // m of length change per degree of elevation error
    lineGain: 0.6,           // 1 = fully geometric line from your release direction
    lengthRange: [-2.5, 13.5], // early release = full (negative = full toss), late = short
    fullTossHeight: [0.35, 1.25], // m at the batter for a full toss (waist-high no-balls not allowed)
    spinnerPaceKmh: 105,     // below this, wrist action gives a spin delivery; above, a cutter
    palmDot: 0.15,           // palm toward the batter above this, back of the hand below -this
    assistStrength: 0.97,    // 0..1, how strongly the aim marker pulls deliveries (the marker is where the ball goes; a wild release
                             // moves it a hand's width, no more: at 0.8 a 15 degree arm error was 0.6 m, which read as "still physical")
    spinMultiplier: 4.0,     // wrist roll rad/s × this = ball spin rad/s
    spinDeadzone: 2.5,       // rad/s of wrist roll ignored
    swingAmount: 0.75,       // swing value when inswing/outswing is chosen
    naturalSeamDeg: 0.8,
    ballHoldOffset: [0, -0.02, -0.06], // ball position in grip space while held
    heldBallFade: [0.2, 0.34], // m from the eyes: the ball in your hand is hidden nearer than [0], fully drawn beyond [1]
    nonStriker: [-2.4, -19.4], // x, z where the non-striker stands while YOU bowl: wide and level with you, so
                               // backing up (1.6 m) keeps him ~58° to your right at the crease, out of the way
    pickedSpinFloor: 0.7,    // a picked delivery always gets this much of its spin / cut; wrist roll adds the rest (x 0.3)

    // Run-up (see src/game/runup.js). Hold right GRIP or left TRIGGER to run.
    //   length   m from your mark to the crease     top    m/s top speed
    //   accel    m/s^2 while the button is held      commit m from the crease: inside this you are committed
    //   stand    pace factor bowling from a standstill (best run speed / top speed scales it up to x1.0)
    runUp: {
      fast:    { length: 11.0, top: 5.6, accel: 4.0, commit: 3.0, stand: 0.86 },
      medium:  { length: 8.0,  top: 4.6, accel: 4.0, commit: 3.0, stand: 0.86 },
      offspin: { length: 3.5,  top: 2.4, accel: 2.6, commit: 1.5, stand: 0.95 },
      legspin: { length: 3.0,  top: 2.2, accel: 2.4, commit: 1.5, stand: 0.95 },
      pullOutBrake: 9.0,     // m/s^2 when you let go before the commit point (you never brake past it)
      resumeWindow: 1.5,     // s after pulling out to press again and carry on; then back to your mark
      strideBrake: 12.0,     // m/s^2: the delivery stride stops you at the crease
      carrySpeed: 1.4,       // m/s: once committed you always reach the crease at least this fast
      creaseWindow: 2.5,     // s at the crease to let the ball go, or it is a dead ball
      minRun: 0.75,          // m: let go before covering this much and it was only a tap (quietly back to the mark, no "pulled out")
      menuGrace: 0.8,        // s after the pause menu closes mid run-up to find the run button again before it counts as a pull-out
      menuStickHold: 0.6,    // s: while running in, the left-stick click must be held this long to open the menu (no accidental pauses)
    },
  },

  view: {
    // Settings -> View 'behind the player': where the headset camera sits
    // relative to you (world metres: x across, y up, z along the pitch).
    behindBatting: [-0.6, 0.35, 2.1],    // behind and to the leg side of the batter
    behindBowling: [0.55, 0.4, -2.4],    // behind the bowler, over the left shoulder
    // Right stick: look around without turning your body (Settings -> Turning).
    snapTurnDeg: 30,         // per flick
    smoothTurnDegPerSec: 110, // full stick
    smoothTurnDeadzone: 0.15,
    smoothTurnEase: 0.08,    // s: how quickly the turn rate follows the stick
  },

  render: {
    ballMinAngleDeg: 0.34,   // visibility assist: ball is drawn at least this big (physics unchanged)
    crowdMax: 26000,         // spectator cards (2 triangles each, merged into 8 sector meshes); lower this if the headset struggles
    animLodDistance: 32,     // fielders farther than this skip foot IK / head tracking
  },

  xr: {
    maxFrameRate: 90,        // highest rate we will ask for (Quest 3S: 72/80/90/120); each quality level has its own (render/quality.js)
    foveation: 0.5,          // fixed foveation 0..1 (the top quality level's; the governor raises it)
    framebufferScale: 1.0,   // (fixed per session: the remembered quality level picks the next session's)
    dynamicViewport: true,   // let the governor scale the drawn viewport (XRView.requestViewportScale, where the browser has it)
    // Quality governor (render/quality.js): drop when this share of frames is late for badS; climb after climbS clean.
    governor: { dropPct: 8, badS: 0.5, climbS: 10, holdS: 2, benchmarkS: 8 },
    driftWarn: 0.6,          // m your head has wandered from where play was centred (between balls): "step back to your spot",
                             // so a few steps forward per ball never add up to walking into the Quest's own boundary
  },

  field: {
    boundaryRadius: 65,      // m from the centre of the pitch
    boardsOffset: 3.2,       // the advertising boards stand this far beyond the rope (m)
    boardsHeight: 0.975,     // top of the boards (m)
    groundRadius: 80,
    fielderSpeed: 6.5,       // m/s top speed
    fielderAccel: 7.5,
    fielderReaction: 0.40,   // s
    keeperReaction: 0.15,
    reach: 1.0,              // m: pick up radius
    diveReach: 1.8,
    catchHeightMax: 2.6,
    throwSpeed: 27,          // m/s
    pickupTime: 0.78,         // gather + wind-up before the throw leaves the hand
    stretchPickupExtra: 0.45,// s extra when the stop was a stretch/dive
    runFirst: 3.4,           // s to complete the first run
    runNext: 2.9,            // s for each additional run
    runSafetyMargin: 0.35,
    diveFrom: 4.2,           // m from the crease at which a held dive launches
    diveSpeed: 7.6,          // m/s through the air…
    diveSlide: 7.0,          // …then slowing by this much a second along the ground (never below 2.5 m/s)
    diveReach: 2.1,          // m the bat reaches ahead of a batter at full stretch (1.0 running)
    getUp: 1.45,             // s on the ground after a dive (lying a moment, then ~1.1 s getting up) before another run can be called
  },

  keeper: {
    // What the wicket-keeper can physically get a glove to as the ball reaches him.
    reach: 0.65,             // m to either side taken on his feet
    standHigh: 2.05,         // m: highest ball taken with his feet on the ground
    jumpHigh: 2.75,          // m: highest ball taken with a leap
    diveReach: 1.9,          // m to either side with a full-length dive…
    diveHigh: 1.5,           // …if the ball is no higher than this
    standBack: 5.0,          // m behind the stumps to the seamers (up at the stumps for spin: 0.75)
    breakTime: 0.3,          // s from the take to the bails coming off, standing up
    shyTime: 0.4,            // s from the take to an under-arm throw at the stumps, standing back
    shySpeed: 16,            // m/s
    shyHit: { easy: 0.35, medium: 0.5, hard: 0.65 },   // chance that throw hits
    diveRecover: 0.7,        // extra s before he can do either after a dive or a leap
  },

  ai: {
    // AI batter skill (when you bowl). Lower sigma = better timing.
    easy:   { timingSigma: 0.030, posSigma: 0.07, readFactor: 0.25, adjust: 0.35, mistakeRate: 0.22, catchSkill: 0.55 },
    medium: { timingSigma: 0.018, posSigma: 0.045, readFactor: 0.55, adjust: 0.6, mistakeRate: 0.12, catchSkill: 0.72 },
    hard:   { timingSigma: 0.010, posSigma: 0.028, readFactor: 0.8, adjust: 0.85, mistakeRate: 0.05, catchSkill: 0.88 },
    charge: { easy: 0.5, medium: 0.42, hard: 0.34 },   // chance (scaled by aggression) of coming down the pitch to a slow ball
    reactionTime: 0.20,      // s after release before the batter commits
    bounceReaction: 0.09,    // s after the bounce before it can adjust
  },

  bowlerAI: {
    // AI bowling quality per difficulty (pace comes from the bowler type x paceScale).
    easy:   { accuracy: 0.6, variation: 0.3 },
    medium: { accuracy: 0.75, variation: 0.5 },
    hard:   { accuracy: 0.88, variation: 0.75 },
    releaseHeight: 1.98,     // spinners
    releaseHeightPace: 2.15, // seamers and quicks
  },

  // What each difficulty changes for the PLAYER.
  // Contact assist for YOUR bat (Settings -> Contact assist). The physics bat is
  // the one you see plus an invisible margin:
  //   capture  m around the blade in which a passing ball still counts as hit
  //   magnet   0..1, how far such a contact is pulled toward the sweet spot
  //   toe      m of invisible blade below the toe (low balls)
  contactAssist: {
    off:    { capture: 0,    magnet: 0,    toe: 0 },
    low:    { capture: 0.05, magnet: 0.15, toe: 0.06 },
    normal: { capture: 0.08, magnet: 0.3,  toe: 0.12 },
    high:   { capture: 0.12, magnet: 0.45, toe: 0.18 },
  },

  difficulty: {
    //         ball flight slowed    bat hit-zone   AI pace    fielders   AI batter aggression
    easy:   { timeScale: 0.70, batAssist: 1.55, paceScale: 0.88, fieldScale: 0.85, chase: 1.7, lbwAgainstPlayer: false },
    medium: { timeScale: 0.85, batAssist: 1.25, paceScale: 0.94, fieldScale: 0.95, chase: 2.0, lbwAgainstPlayer: true },
    hard:   { timeScale: 1.00, batAssist: 1.00, paceScale: 1.02, fieldScale: 1.00, chase: 2.4, lbwAgainstPlayer: true },
  },

  catching: {
    slowMo: 0.22,            // time scale during a catching chance
    leadTime: 0.75,          // s (game time) before the ball arrives that the chance starts
    handRadius: 0.24,        // m: ball centre within this of either hand = caught
    standOff: 0.42,          // m you stand behind the catch point
    minTime: 0.3,            // s (game time) from the bat to your catch point at least (sooner: a point further along its flight)
    minGap: 3.0,             // m from the striker to where you stand at least (nearer, his body fills your view)
  },

  match: {
    overs: 5, wickets: 5, reviews: 2,   // DRS reviews per side per innings (kept when overturned or umpire's call)
    noBallChance: { easy: 0.045, medium: 0.03, hard: 0.02 },   // AI bowler oversteps (per ball) -> free hit
    overstep: 0.3,           // m your head may be past the popping crease at release before it is a no-ball
    beamerHeight: 1.15,      // m: a full toss above this at the batter is a no-ball
    thirdUmpire: 0.55,       // m: run-outs / stumpings closer than this go upstairs
    batterHeight: 1.80,      // m: the AI striker standing upright (a 1.80 m figure), and yours without a headset
    shoulderFrac: 0.82,      // shoulder height / standing height
    bouncersPerOver: 1,      // fast short-pitched balls over the shoulder allowed per over (ICC T20I 41.6); more = no-ball
  },

  audio: {
    master: 0.8,
    crowd: 0.18,
  },
};

// Shallow-merge overrides (e.g. from settings) into CONFIG sections.
export function applyConfigOverrides(overrides) {
  if (!overrides) return;
  for (const [section, values] of Object.entries(overrides)) {
    if (CONFIG[section] && typeof values === 'object') Object.assign(CONFIG[section], values);
  }
}
