// The Quest's Roomscale play area (WebXR 'bounded-floor' boundsGeometry), in
// the local-floor space the game uses. Pure JS. The Quest draws its boundary
// lines when your head or hands come near the edge; a full swing reaches about
// a metre from you, so where you stand decides whether you see them: the game
// finds the spot furthest from every edge and shows it on the floor.

// Distance from (x, z) to the nearest edge of the polygon (m): negative outside it.
export function edgeDistance(poly, x, z) {
  let d = Infinity, inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-9;
    const u = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / L2));
    d = Math.min(d, Math.hypot(x - a.x - u * ex, z - a.z - u * ez));
    if ((a.z > z) !== (b.z > z) && x < a.x + (z - a.z) / (b.z - a.z) * ex) inside = !inside;
  }
  return inside ? d : -d;
}

// The spot with the most room round it (furthest from every edge), on a
// 10 cm grid and then 2.5 cm round the best of it, and how much room that is.
export function bestSpot(poly, step = 0.1) {
  if (!poly || poly.length < 3) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  if (!(x1 - x0 < 50 && z1 - z0 < 50)) return null;         // (no sane play area)
  const pts = [];
  let most = -Infinity;
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let z = z0 + step / 2; z < z1; z += step) { const d = edgeDistance(poly, x, z); pts.push({ x, z, room: d }); most = Math.max(most, d); }
  }
  if (!(most > 0)) return null;
  // (as good as the best to 2 cm: the one nearest the middle -- a long room's centre, not one end of its ridge)
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let best = null;
  for (const p of pts) if (p.room > most - 0.02 && (!best || Math.hypot(p.x - cx, p.z - cz) < Math.hypot(best.x - cx, best.z - cz))) best = p;
  const fine = step / 4, bx = best.x, bz = best.z;
  for (let x = bx - step; x <= bx + step + 1e-9; x += fine) {
    for (let z = bz - step; z <= bz + step + 1e-9; z += fine) { const d = edgeDistance(poly, x, z); if (d > best.room + 0.005) best = { x, z, room: d }; }
  }
  return best;
}

// boundsGeometry (points in the bounded-floor space) -> the polygon in the
// local-floor space, given the bounded space's pose there (a column-major 4x4).
export function toLocal(points, m) {
  return Array.from(points, (p) => ({ x: m[0] * p.x + m[8] * p.z + m[12], z: m[2] * p.x + m[10] * p.z + m[14] }));
}
