// Bat geometry, continuous (swept) collision and contact response. Pure JS.
//
// Collision approach (no tunnelling):
//   For each physics substep [t0, t1] we know the ball centre at both ends
//   (p0, p1) and the bat pose at both ends (pose0, pose1 — interpolated from
//   frame poses with lerp/slerp by the caller). We express the ball centre in
//   bat-local coordinates at each end: l0 = pose0^-1 p0, l1 = pose1^-1 p1. The
//   segment l0→l1 is the ball's path *relative to the bat* over the substep.
//   We then sphere-trace that segment against the bat's signed distance field
//   (rounded box blade + capsule handle) with conservative advancement: the
//   SDF is 1-Lipschitz, so stepping by (sdf - r) can never skip the surface.
//   At 480 Hz the relative motion per substep is a few cm, so the linear
//   approximation of the relative path is accurate even for a fast-rotating
//   bat meeting a 150 km/h ball.

import { Vec3, smoothstep, DEG } from './math.js';
import { CONFIG } from '../config.js';

export class BatGeometry {
  constructor(c = CONFIG.bat) {
    this.handleTopY = c.gripFromHandleTop;
    this.shoulderY = c.gripFromHandleTop - c.handleLength;
    this.toeY = this.shoulderY - c.bladeLength;
    this.bladeCenter = new Vec3(0, (this.shoulderY + this.toeY) / 2, 0);
    this.bladeHalf = new Vec3(c.bladeWidth / 2, c.bladeLength / 2, c.bladeThickness / 2);
    this.edgeRadius = Math.min(c.edgeRadius, c.bladeThickness / 2 - 1e-4);
    this.handleRadius = c.handleRadius;
    this.sweetY = this.toeY + c.sweetSpotFromToe;
    this.faceZ = c.bladeThickness / 2;
    this.cfg = c;
  }

  // Signed distance to the blade (rounded box).
  bladeSdf(p) {
    const r = this.edgeRadius;
    const qx = Math.abs(p.x - this.bladeCenter.x) - (this.bladeHalf.x - r);
    const qy = Math.abs(p.y - this.bladeCenter.y) - (this.bladeHalf.y - r);
    const qz = Math.abs(p.z - this.bladeCenter.z) - (this.bladeHalf.z - r);
    const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
    return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }

  handleSdf(p) {
    const y = Math.min(Math.max(p.y, this.shoulderY), this.handleTopY);
    const dy = p.y - y;
    return Math.sqrt(p.x * p.x + dy * dy + p.z * p.z) - this.handleRadius;
  }

  sdf(p) { return Math.min(this.bladeSdf(p), this.handleSdf(p)); }

  // Outward surface normal at (or near) local point p, plus which part.
  normalAt(out, p) {
    const db = this.bladeSdf(p), dh = this.handleSdf(p);
    if (dh < db) {
      const y = Math.min(Math.max(p.y, this.shoulderY), this.handleTopY);
      out.set(p.x, p.y - y, p.z);
      if (out.lengthSq() < 1e-12) out.set(0, 0, 1);
      out.normalize();
      return 'handle';
    }
    const r = this.edgeRadius;
    const dx = p.x - this.bladeCenter.x, dy = p.y - this.bladeCenter.y, dz = p.z - this.bladeCenter.z;
    const qx = Math.abs(dx) - (this.bladeHalf.x - r);
    const qy = Math.abs(dy) - (this.bladeHalf.y - r);
    const qz = Math.abs(dz) - (this.bladeHalf.z - r);
    if (qx > 0 || qy > 0 || qz > 0) {
      out.set(Math.max(qx, 0) * Math.sign(dx), Math.max(qy, 0) * Math.sign(dy), Math.max(qz, 0) * Math.sign(dz));
      out.normalize();
    } else {
      // Deep inside: push out through the nearest face.
      if (qx >= qy && qx >= qz) out.set(Math.sign(dx) || 1, 0, 0);
      else if (qy >= qz) out.set(0, Math.sign(dy) || 1, 0);
      else out.set(0, 0, Math.sign(dz) || 1);
    }
    return 'blade';
  }

  // Sphere-trace the local segment a→b for a sphere of radius R.
  // Returns contact fraction in [0,1] or -1 if no contact.
  sweep(a, b, R) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let s = 0;
    for (let i = 0; i < 96; i++) {
      _sp.set(a.x + dx * s, a.y + dy * s, a.z + dz * s);
      const d = this.sdf(_sp) - R;
      if (d <= 1e-5) return s;
      if (len < 1e-9) return -1;
      s += d / len;
      if (s > 1) return -1;
    }
    return -1; // grazing pass that never closed within the iteration budget
  }
}
const _sp = new Vec3();

// Compute contact quality and restitution from the local contact.
// cLocal = ball centre (local) at contact, nLocal = outward surface normal.
export function contactQuality(geom, cLocal, nLocal, part) {
  const c = geom.cfg;
  if (part === 'handle') {
    return { quality: 0.05, e: c.restitutionHandle, isEdge: false, face: 'handle', across: 0, along: 0 };
  }
  // Surface point under the ball.
  const sx = cLocal.x, sy = cLocal.y;
  const across = Math.min(1.2, Math.abs(sx) / geom.bladeHalf.x);
  const alongDist = sy - geom.sweetY;
  const along = Math.exp(-(alongDist * alongDist) / (c.sweetSpotSigma * c.sweetSpotSigma));
  let face;
  if (nLocal.z > 0.45) face = 'front';
  else if (nLocal.z < -0.45) face = 'back';
  else if (nLocal.y < -0.7) face = 'toe';
  else if (nLocal.y > 0.7) face = 'shoulder';
  else face = 'side';

  let quality, e, isEdge = false;
  if (face === 'front') {
    const edgeFactor = 1 - 0.85 * smoothstep(c.edgeStart, 1.0, across);
    quality = along * edgeFactor;
    e = c.restitutionMin + (c.restitutionSweet - c.restitutionMin) * quality;
    isEdge = across > 0.78;
  } else if (face === 'back') {
    quality = 0.08 * along;
    e = c.restitutionBack;
  } else {
    // Hit the thin side (edge) or the toe/shoulder.
    quality = 0.06;
    e = c.restitutionMin * 0.8;
    isEdge = face === 'side';
  }
  return { quality, e, isEdge, face, across, along };
}

const _n = new Vec3(), _nw = new Vec3(), _cw = new Vec3(), _r = new Vec3(), _vb = new Vec3(),
  _vrel = new Vec3(), _tmp = new Vec3(), _xw = new Vec3(), _vin = new Vec3();

// Apply the bat-ball contact. Mutates ball.vel / ball.pos / ball.spin.
//  ball:      BallState (pos = ball centre at contact, vel = incoming velocity)
//  pose:      bat pose at the contact time
//  cLocal:    ball centre in bat-local coords at contact
//  batLinVel, batAngVel: controller (grip) velocities at contact (world)
//  gripPos:   world position the angular velocity is about
// Returns contact info or null if the bodies were separating.
export function resolveBatContact(geom, ball, pose, cLocal, batLinVel, batAngVel, gripPos, R, cfg = CONFIG) {
  const c = cfg.bat;
  const part = geom.normalAt(_n, cLocal);
  const q = contactQuality(geom, cLocal, _n, part);

  // Thick-edge deflection: tilt the face normal toward the nearer edge.
  if (q.face === 'front' && q.across > c.edgeStart) {
    const tilt = c.edgeDeflectDeg * DEG * smoothstep(c.edgeStart, 1.0, q.across);
    const sgn = Math.sign(cLocal.x) || 1;
    // rotate n toward ±X by `tilt` in the n–X plane
    const cs = Math.cos(tilt), sn = Math.sin(tilt);
    _tmp.set(sgn, 0, 0);
    const nx = _n.x * cs + _tmp.x * sn, ny = _n.y * cs, nz = _n.z * cs;
    _n.set(nx, ny, nz).normalize();
  }

  pose.dirToWorld(_nw, _n);
  // World contact point on the bat surface.
  pose.toWorld(_cw, cLocal).addScaled(_nw, -R);
  // Bat surface velocity at the contact point.
  _r.subVectors(_cw, gripPos);
  _vb.crossVectors(batAngVel, _r).add(batLinVel).scale(c.speedMultiplier);

  _vrel.subVectors(ball.vel, _vb);
  const vn = _vrel.dot(_nw);
  // Always push the ball out of the bat surface.
  ball.pos.copy(_cw).addScaled(_nw, R + 0.002);
  if (vn >= 0) return null; // separating already

  const speedIn = ball.vel.length();
  _vin.copy(ball.vel);
  // v_rel' = -e vn n + retain * v_t
  _tmp.copy(_nw).scale(vn);          // normal part
  _vrel.sub(_tmp).scale(c.tangentialRetain); // tangential part kept
  _vrel.addScaled(_nw, -q.e * vn);
  ball.vel.addVectors(_vb, _vrel);

  // Thin edges: the ball mostly carries on along its path (to the keeper /
  // slips) instead of reflecting square off the curved edge.
  const thin = (q.face === 'front' || q.face === 'side') ? smoothstep(c.thinEdgeStart, c.thinEdgeFull, q.across) : 0;
  if (thin > 0) {
    pose.dirToWorld(_xw, _tmp.set(Math.sign(cLocal.x) || 1, 0, 0));
    _tmp.copy(_vin).scale(c.thinEdgeRetain).addScaled(_vb, 0.15).addScaled(_xw, speedIn * c.thinEdgeSidePush);
    ball.vel.lerp(_tmp, thin);
    q.isEdge = true;
  }
  ball.spin.scale(cfg.ball.hitSpinRetain);

  return {
    ...q,
    part,
    speedIn,
    speedOut: ball.vel.length(),
    batSpeed: _vb.length(),
    normal: _nw.clone(),
    point: _cw.clone(),
    local: cLocal.clone(),
  };
}
