// Wicket (stumps + bails) collision. Pure JS.
// Treated as one box per end (three stumps + bails), swept with the same
// conservative-advancement trick as the bat so fast balls can't skip through.

import { Vec3 } from './math.js';
import { PITCH } from './pitch.js';

export class Wicket {
  constructor(end, z) {
    this.end = end;            // 'batting' | 'bowling'
    this.z = z;
    this.broken = false;
    this.enabled = true;
    this.half = new Vec3(PITCH.wicketHalfWidth, (PITCH.stumpHeight + PITCH.bailRise) / 2, PITCH.stumpRadius);
    this.center = new Vec3(0, this.half.y, z);
  }
  sdf(p) {
    const qx = Math.abs(p.x - this.center.x) - this.half.x;
    const qy = Math.abs(p.y - this.center.y) - this.half.y;
    const qz = Math.abs(p.z - this.center.z) - this.half.z;
    const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0);
  }
  // Fraction along a→b where a sphere of radius R first touches, or -1.
  sweep(a, b, R) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Cheap reject: segment's bounding box far from the wicket.
    const pad = R + 0.05;
    if (Math.max(a.z, b.z) < this.z - pad || Math.min(a.z, b.z) > this.z + pad) return -1;
    if (Math.min(a.y, b.y) > this.half.y * 2 + pad) return -1;
    let s = 0;
    for (let i = 0; i < 64; i++) {
      _p.set(a.x + dx * s, a.y + dy * s, a.z + dz * s);
      const d = this.sdf(_p) - R;
      if (d <= 1e-5) return s;
      if (len < 1e-9) return -1;
      s += d / len;
      if (s > 1) return -1;
    }
    return -1;
  }
  // Which stump (0 = leg … 2 = off for a RH batter, by x) is nearest a point.
  stumpIndexAt(x) {
    if (x < -0.04) return 0;
    if (x > 0.04) return 2;
    return 1;
  }
}
const _p = new Vec3();
