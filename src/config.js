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
      restitution: 0.52,     // vertical COR of the ball on the pitch
      friction: 0.25,        // Coulomb friction during bounce
    },
    outfield: {
      restitution: 0.40,
      friction: 0.40,
      rollingDecel: 1.3,     // m/s^2 rolling resistance on grass
    },
    rollVerticalSpeed: 0.7,  // m/s: below this vertical rebound, the ball rolls
    spinTurnScale: 1.6,      // >1 exaggerates spin turn (energy neutral) — game feel
    seamMaxDeg: 3.0,         // seam slider at ±1 deflects this much off the pitch
    seamRandomDeg: 0.6,      // natural random seam wobble (1 sigma)
  },

  bat: {
    // Geometry (bat local frame: origin = controller grip point, +Y toward
    // handle top, +Z = hitting face normal, +X across the face).
    bladeLength: 0.61,       // a little longer than a real blade (0.56) so low balls don't sneak under the toe
    bladeWidth: 0.14,        // wider than a real bat (10.8 cm) so contact is easier in VR
    bladeThickness: 0.050,
    edgeRadius: 0.012,       // rounding of the blade edges (affects edge deflection)
    handleLength: 0.30,
    handleRadius: 0.017,
    gripFromHandleTop: 0.12, // where your hand (controller) sits below the handle top
    sweetSpotFromToe: 0.17,

    // Response
    speedMultiplier: 1.25,   // amplifies controller bat speed (home swings are gentle)
    restitutionSweet: 0.42,  // apparent COR at the sweet spot (relative restitution)
    restitutionMin: 0.12,    // COR far from the sweet spot (toe / shoulder)
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
    sweepSpeedGain: 1.15,    // sweep exit speed = bat speed x this + a share of the ball's pace
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
    paceMaxKmh: 150,
    seamerBackspinRps: 10,
    spinMaxRps: 30,
  },

  bowling: {
    paceMultiplier: 2.6,     // hand speed × this = ball speed
    paceCapKmh: 150,
    paceFloorKmh: 50,
    minReleaseHandSpeed: 3.0,// m/s: slower trigger releases are treated as drops
    peakWindowMs: 90,        // look back this far for the peak hand speed at release
    neutralElevationDeg: -8, // release elevation (at peak hand speed) that maps to a good length
    neutralLength: 6.5,      // m from batter's stumps at the neutral elevation
    lengthPerDeg: 0.15,      // m of length change per degree of elevation error
    lineGain: 0.6,           // 1 = fully geometric line from your release direction
    lengthRange: [-2.5, 13.5], // early release = full (negative = full toss), late = short
    fullTossHeight: [0.35, 1.25], // m at the batter for a full toss (waist-high no-balls not allowed)
    spinnerPaceKmh: 105,     // below this, wrist action gives a spin delivery; above, a cutter
    palmDot: 0.15,           // palm toward the batter above this, back of the hand below -this
    assistStrength: 0.65,    // 0..1, how strongly the aim marker pulls deliveries
    spinMultiplier: 4.0,     // wrist roll rad/s × this = ball spin rad/s
    spinDeadzone: 2.5,       // rad/s of wrist roll ignored
    swingAmount: 0.75,       // swing value when inswing/outswing is chosen
    naturalSeamDeg: 0.8,
    ballHoldOffset: [0, -0.02, -0.06], // ball position in grip space while held
  },

  view: {
    // Settings -> View 'behind the player': where the headset camera sits
    // relative to you (world metres: x across, y up, z along the pitch).
    behindBatting: [-0.6, 0.35, 2.1],    // behind and to the leg side of the batter
    behindBowling: [0.55, 0.4, -2.4],    // behind the bowler, over the left shoulder
  },

  render: {
    ballMinAngleDeg: 0.34,   // visibility assist: ball is drawn at least this big (physics unchanged)
    crowdMax: 3000,          // instanced spectators (36 triangles each)
    animLodDistance: 32,     // fielders farther than this skip foot IK / head tracking
  },

  xr: {
    maxFrameRate: 120,       // highest rate we will ask for (Quest 3S: 72/80/90/120)
    foveation: 0.5,          // fixed foveation 0..1
    framebufferScale: 1.0,
  },

  field: {
    boundaryRadius: 65,      // m from the centre of the pitch
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
    releaseHeight: 1.98,
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
    hard:   { timeScale: 1.00, batAssist: 1.00, paceScale: 1.00, fieldScale: 1.00, chase: 2.4, lbwAgainstPlayer: true },
  },

  catching: {
    slowMo: 0.22,            // time scale during a catching chance
    leadTime: 0.75,          // s (game time) before the ball arrives that the chance starts
    handRadius: 0.24,        // m: ball centre within this of either hand = caught
    standOff: 0.42,          // m you stand behind the catch point
  },

  match: {
    overs: 5, wickets: 5, reviews: 1,
    noBallChance: { easy: 0.045, medium: 0.03, hard: 0.02 },   // AI bowler oversteps (per ball) -> free hit
    overstep: 0.3,           // m your head may be past the popping crease at release before it is a no-ball
    beamerHeight: 1.15,      // m: a full toss above this at the batter is a no-ball
    thirdUmpire: 0.55,       // m: run-outs / stumpings closer than this go upstairs
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
