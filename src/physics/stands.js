// The stands as the ball meets them: the height of the bowl's surface (the
// front wall, the raked tiers, the box level, the pavilion, the grass bank)
// at a distance r from the middle of the pitch and a bearing, and the roofs
// over it. Analytic, from the same plan the stadium is built from
// (src/render/stadium.js BOWL / ROOF / the bank, pavilion and roof arcs; a
// test holds the two together), so a six can land where its flight meets the
// seats without a ray cast against the mesh. Pure JS, nothing allocated.
//
// Frame: the stadium's, with the middle of the pitch at the origin -- x as
// the world's, z = world z - PITCH.centerZ. Bearings in degrees, atan2(x, z),
// 0..360.
import { CONFIG } from '../config.js';

const R0 = CONFIG.field.groundRadius + 4;             // front wall (84 m)
export const STAND = {
  wallR: R0 - 0.3, wallTop: 2.2,
  low: { r0: R0, y0: 1.32, rows: 15, depth: 0.82, rise: 0.42 },
  fasciaR: 97.4, fasciaTop: 12.2,
  up: { r0: 97.75, y0: 11.35, rows: 14, depth: 0.85, rise: 0.55 },
  backR: 109.65, top: 22.1, outerR: 110.85,
  roof: { rF: 91.6, rB: 111.4, yB: 26.9, yF: 28.9, t: 0.6 },
};
const L = STAND.low, U = STAND.up, RF = STAND.roof;
const lowEndR = L.r0 + L.rows * L.depth, lowEndY = L.y0 + (L.rows - 1) * L.rise;
const BANK = [20, 50], PAV = [80, 100];
const ROOFS = [[322, 20], [50, 80], [100, 130], [140, 220], [252, 310]];
const inArc = (a, a0, a1) => (a0 <= a1 ? a >= a0 && a < a1 : a >= a0 || a < a1);
// (by half degree, as the stadium builds them: 0 stand, 1 bank, 2 pavilion; roofed or not)
const TYPE = new Uint8Array(720), ROOFED = new Uint8Array(720);
for (let i = 0; i < 720; i++) {
  const a = i / 2 + 0.25;
  TYPE[i] = inArc(a, BANK[0], BANK[1]) ? 1 : inArc(a, PAV[0], PAV[1]) ? 2 : 0;
  for (let k = 0; k < ROOFS.length; k++) if (inArc(a, ROOFS[k][0], ROOFS[k][1])) ROOFED[i] = 1;
}
const bucket = (a) => Math.floor((a < 0 ? a + 360 : a) * 2) % 720;

// Height (m) of the stand's surface at r (m) on bearing a (deg); -1: nothing
// there (the field side of the front wall, or outside the ground).
export function standHeightAt(r, a) {
  const type = TYPE[bucket(a)];
  if (type === 1) return r < 84 ? -1 : r < 101 ? 0.5 + (r - 84) * 0.41 : r < 108.5 ? 7.5 : r < 112 ? 7.5 - (r - 108.5) * 2 : -1;
  if (r < STAND.wallR) return -1;
  if (r < L.r0) return STAND.wallTop;
  if (r < lowEndR) return L.y0 + Math.floor((r - L.r0) / L.depth) * L.rise;
  if (type === 2) return r < 97 ? lowEndY : r < 111.4 ? 20.6 + Math.max(0, 5 - Math.abs(r - 104) * 0.7) : -1;
  if (r < STAND.fasciaR) return lowEndY;
  if (r < U.r0) return STAND.fasciaTop;
  if (r < STAND.backR) return U.y0 + Math.floor((r - U.r0) / U.depth) * U.rise;
  if (r < STAND.outerR) return STAND.top;
  return -1;
}

// Does the stand on bearing a (deg) rise from a front wall (STAND.wallR, wallTop high)? Not the grass bank.
export function frontWallAt(a) { return TYPE[bucket(a)] !== 1; }
// Is there a roof over bearing a (deg)?
export function roofedAt(a) { return ROOFED[bucket(a)] === 1; }
// Height (m) of the roof's underside at r (m) where there is a roof; -1: none at this r.
export function roofUnderAt(r, a) {
  if (r < RF.rF || r > RF.rB || ROOFED[bucket(a)] !== 1) return -1;
  return RF.yB + ((RF.rB - r) / (RF.rB - RF.rF)) * (RF.yF - RF.yB);
}
// Bearing (deg, 0..360) of a stadium-frame point.
export function bearing(x, z) { const a = Math.atan2(x, z) * (180 / Math.PI); return a < 0 ? a + 360 : a; }
