// Minimal vector / quaternion math for the physics layer.
// Pure JS: no three.js imports, so physics runs (and is unit tested) in node.
// Conventions match three.js: Y up, right-handed, quaternions {x,y,z,w}.

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  scale(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  addScaled(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() {
    const l = this.length();
    if (l > 1e-12) { this.x /= l; this.y /= l; this.z /= l; }
    return this;
  }
  distanceTo(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // this = a x b (safe when this aliases a or b)
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
  cross(v) { return this.crossVectors(this, v); }
  lerp(v, t) {
    this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t;
    return this;
  }
  lerpVectors(a, b, t) {
    this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t;
    return this;
  }
  // Rotate by unit quaternion q.
  applyQuat(q) {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }
  // Rotate by the inverse (conjugate) of unit quaternion q.
  applyQuatInv(q) {
    _qi.set(-q.x, -q.y, -q.z, q.w);
    return this.applyQuat(_qi);
  }
  toArray() { return [this.x, this.y, this.z]; }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat(this.x, this.y, this.z, this.w); }
  identity() { return this.set(0, 0, 0, 1); }
  dot(q) { return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w; }
  normalize() {
    let l = Math.sqrt(this.dot(this));
    if (l < 1e-12) return this.identity();
    l = 1 / l;
    this.x *= l; this.y *= l; this.z *= l; this.w *= l;
    return this;
  }
  conjugate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  // this = a * b
  multiplyQuats(a, b) {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  multiply(q) { return this.multiplyQuats(this, q); }
  premultiply(q) { return this.multiplyQuats(q, this); }
  setFromAxisAngle(axis, angle) {
    const h = angle / 2, s = Math.sin(h);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(h);
    return this;
  }
  // Build from an orthonormal basis (columns of the rotation matrix).
  setFromBasis(xa, ya, za) {
    const m11 = xa.x, m12 = ya.x, m13 = za.x;
    const m21 = xa.y, m22 = ya.y, m23 = za.y;
    const m31 = xa.z, m32 = ya.z, m33 = za.z;
    const trace = m11 + m22 + m33;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      this.w = 0.25 / s;
      this.x = (m32 - m23) * s;
      this.y = (m13 - m31) * s;
      this.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
      this.w = (m32 - m23) / s;
      this.x = 0.25 * s;
      this.y = (m12 + m21) / s;
      this.z = (m13 + m31) / s;
    } else if (m22 > m33) {
      const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
      this.w = (m13 - m31) / s;
      this.x = (m12 + m21) / s;
      this.y = 0.25 * s;
      this.z = (m23 + m32) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = (m13 + m31) / s;
      this.y = (m23 + m32) / s;
      this.z = 0.25 * s;
    }
    return this.normalize();
  }
  slerpQuats(a, b, t) {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let k0, k1;
    if (cos > 0.9995) {
      k0 = 1 - t; k1 = t; // nlerp for tiny angles
    } else {
      const theta = Math.acos(cos);
      const sin = Math.sin(theta);
      k0 = Math.sin((1 - t) * theta) / sin;
      k1 = Math.sin(t * theta) / sin;
    }
    this.x = a.x * k0 + bx * k1;
    this.y = a.y * k0 + by * k1;
    this.z = a.z * k0 + bz * k1;
    this.w = a.w * k0 + bw * k1;
    return this.normalize();
  }
  slerp(q, t) { return this.slerpQuats(this.clone(), q, t); }
  angleTo(q) {
    const d = Math.min(1, Math.abs(this.dot(q)));
    return 2 * Math.acos(d);
  }
}

const _qi = new Quat();

// A rigid pose: position + orientation.
export class Pose {
  constructor(p = new Vec3(), q = new Quat()) { this.p = p; this.q = q; }
  copy(o) { this.p.copy(o.p); this.q.copy(o.q); return this; }
  clone() { return new Pose(this.p.clone(), this.q.clone()); }
  lerpPoses(a, b, t) {
    this.p.lerpVectors(a.p, b.p, t);
    this.q.slerpQuats(a.q, b.q, t);
    return this;
  }
  // local -> world
  toWorld(out, local) { return out.copy(local).applyQuat(this.q).add(this.p); }
  // world -> local
  toLocal(out, world) { return out.copy(world).sub(this.p).applyQuatInv(this.q); }
  dirToWorld(out, local) { return out.copy(local).applyQuat(this.q); }
  dirToLocal(out, world) { return out.copy(world).applyQuatInv(this.q); }
}

// Angular velocity (world, rad/s) that rotates qa into qb over dt.
export function angularVelocityFromQuats(out, qa, qb, dt) {
  // dq = qb * qa^-1
  const dq = _dq.multiplyQuats(qb, _qa.copy(qa).conjugate());
  if (dq.w < 0) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
  const s = Math.sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
  if (s < 1e-9 || dt <= 0) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(s, dq.w);
  const k = angle / (s * dt);
  return out.set(dq.x * k, dq.y * k, dq.z * k);
}
const _dq = new Quat();
const _qa = new Quat();

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const DEG = Math.PI / 180;
export const kmhToMs = (k) => k / 3.6;
export const msToKmh = (m) => m * 3.6;

// Deterministic PRNG (mulberry32) so tests and replays are reproducible.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Standard normal via Box-Muller.
  rng.gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  return rng;
}
