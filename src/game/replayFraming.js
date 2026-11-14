// Replay camera geometry (no three.js, so it can be tested in node): keeping
// the camera clear of people, and spotting people in the line of sight.
// A body is { a: top of the head, b: hips, c: the ground under the hips },
// points as { x, y, z }; the two segments a–b and b–c stand in for the person.

export const CLEAR = 1.0;     // m: the replay camera never comes closer than this to anybody's head or body
export const SIGHT = 0.42;    // m: a body this close to the line of sight to the batter blocks the view

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Where along a→b (0..1) is nearest p.
export function segParam(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const L = abx * abx + aby * aby + abz * abz;
  if (L < 1e-9) return 0;
  return clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / L, 0, 1);
}
function lerpP(a, b, u, out) { out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u; return out; }
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

// The nearest point of a body to p (written into out).
export function nearestOnBody(p, B, out = { x: 0, y: 0, z: 0 }) {
  lerpP(B.a, B.b, segParam(p, B.a, B.b), out);
  const t = lerpP(B.b, B.c, segParam(p, B.b, B.c), {});
  if (dist(p, t) < dist(p, out)) { out.x = t.x; out.y = t.y; out.z = t.z; }
  return out;
}

// Move p (in place) until it is at least r from every body, and above the grass.
export function keepClear(p, bodies, r = CLEAR) {
  const q = { x: 0, y: 0, z: 0 };
  for (let it = 0; it < 4; it++) {
    let moved = false;
    for (const B of bodies) {
      nearestOnBody(p, B, q);
      const d = dist(p, q);
      if (d >= r - 1e-6) continue;
      let nx = 0, ny = 1, nz = 0;
      if (d > 1e-4) { nx = (p.x - q.x) / d; ny = (p.y - q.y) / d; nz = (p.z - q.z) / d; }
      p.x = q.x + nx * r; p.y = q.y + ny * r; p.z = q.z + nz * r;
      moved = true;
    }
    if (p.y < 0.35) p.y = 0.35;
    if (!moved) break;
  }
  return p;
}

// Does this body stand in the line of sight from pos to at?
export function blocksSight(pos, at, B, sight = SIGHT) {
  const w = {}, x = {};
  for (let i = 0; i <= 4; i++) {
    lerpP(B.a, B.c, i / 4, w);                            // head … ground
    const u = segParam(w, pos, at);
    if (u < 0.04 || u > 0.93) continue;
    if (dist(lerpP(pos, at, u, x), w) < sight) return true;
  }
  return false;
}

// How badly a camera at pos looking at `at` is placed: 3 for each body too
// close, 1 for each body in the way.
export function badness(pos, at, bodies) {
  let bad = 0;
  for (const B of bodies) {
    if (dist(pos, nearestOnBody(pos, B)) < CLEAR) bad += 3;
    if (blocksSight(pos, at, B)) bad += 1;
  }
  return bad;
}
