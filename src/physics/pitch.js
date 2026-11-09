// Real-scale pitch geometry (Laws of Cricket), in metres. World frame: see config.js.

export const PITCH = {
  length: 20.12,               // stump to stump
  battingStumpsZ: 0,
  bowlingStumpsZ: -20.12,
  poppingOffset: 1.22,         // popping crease in front of each set of stumps
  returnCreaseX: 1.32,         // return creases either side of middle stump
  poppingHalfLength: 1.83,     // popping crease extends at least this far each side
  halfWidth: 1.525,            // pitch is 3.05 m wide
  stumpHeight: 0.711,
  stumpRadius: 0.019,
  wicketHalfWidth: 0.1143,     // 22.86 cm across the three stumps
  bailRise: 0.013,             // bails sit up to ~1.3 cm above the stumps
  wideLineX: 0.89,             // limited-overs wide guideline from middle stump
  centerZ: -10.06,             // middle of the pitch = middle of the ground
  stripHalfWidth: 1.6,         // prepared strip (surface = 'pitch' for bounces)
  stripMinZ: -22.0,
  stripMaxZ: 1.9,
};

// Positions of the three stumps (x) at a given end.
export const STUMP_X = [
  -(PITCH.wicketHalfWidth - PITCH.stumpRadius),
  0,
  PITCH.wicketHalfWidth - PITCH.stumpRadius,
];

export const battingPoppingZ = PITCH.battingStumpsZ - PITCH.poppingOffset;   // -1.22
export const bowlingPoppingZ = PITCH.bowlingStumpsZ + PITCH.poppingOffset;   // -18.90

export function surfaceAt(x, z) {
  if (Math.abs(x) <= PITCH.stripHalfWidth && z >= PITCH.stripMinZ && z <= PITCH.stripMaxZ) return 'pitch';
  return 'outfield';
}

// Distance from the centre of the ground (for the boundary).
export function groundDistance(x, z) {
  const dz = z - PITCH.centerZ;
  return Math.sqrt(x * x + dz * dz);
}

// Length of a delivery = distance of the bounce point from the batter's stumps.
export function lengthName(len) {
  if (len < 0) return 'full toss';
  if (len < 2.0) return 'yorker';
  if (len < 4.5) return 'full';
  if (len < 8.0) return 'good';
  if (len < 10.5) return 'short of a length';
  return 'short';
}

export function lineName(x) {
  if (x < -0.30) return 'down leg';
  if (x < -0.075) return 'leg stump';
  if (x < 0.075) return 'middle';
  if (x < 0.17) return 'off stump';
  if (x < 0.40) return 'outside off';
  return 'wide outside off';
}
