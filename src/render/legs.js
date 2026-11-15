// Knees that behave as knees: shared by your own batting body
// (src/render/playerBody.js) and the AI striker (src/render/actors.js).
//
//   liftPole     the knee kept above a height, continuously (no iteration
//                that settles one way one frame and the other the next)
//   kneeWay      a knee bend direction kept on its foot's forward side
//   legsNow / legsBlend   two bodies blended without wringing the legs
//   steadyKnees  the last pass over a posed figure's legs: each knee's bend
//                direction turns no faster than a rate from the last frame's
//                (a nearly straight leg has no clear bend direction, and a
//                capture's or a blend's can swing round in a frame or two:
//                the pads wring round the leg), no knee in the turf, and a
//                kneeling pad resting on it, not through it.
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _ax = new THREE.Vector3(), _p = new THREE.Vector3(), _x = new THREE.Vector3(), _kp = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

// Of the places a knee can be with its hip and ankle where they are (a circle
// about the line between them), the one nearest the way `pole` bends it that
// is at least minY above the turf. Moves `pole` there and returns true if it
// had to (false: the knee is already high enough). Continuous in its inputs,
// so a knee near the limit never flips between two answers.
const _la = new THREE.Vector3(), _ln = new THREE.Vector3(), _lu = new THREE.Vector3(), _lv = new THREE.Vector3(), _lc = new THREE.Vector3();
export function liftPole(h, sd, T, pole, minY) {
  const sc = h.root.scale.x;
  h.update();
  const hip = h.worldPos('hip' + sd, _la);
  const l1 = h.bones['knee' + sd].position.length() * sc, l2 = h.bones['ankle' + sd].position.length() * sc;
  const n = _ln.subVectors(T, hip);
  let d = n.length();
  if (d < 1e-5) return false;
  n.divideScalar(d);
  d = clamp(d, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-4);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d), r = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const C = _lc.copy(hip).addScaledVector(n, x);
  const u = _lu.subVectors(pole, C); u.addScaledVector(n, -u.dot(n));
  if (u.lengthSq() < 1e-10) return false;
  u.normalize();
  const v = _lv.crossVectors(n, u);
  const a = r * u.y, b = r * v.y, c = minY - C.y;
  if (a >= c) return false;                         // (y at the wanted angle: C.y + a)
  const R = Math.hypot(a, b), phi = Math.atan2(b, a);
  let th;
  if (R < 1e-6) return false;
  if (c >= R) th = phi;                              // (as high as it goes)
  else {
    const dl = Math.acos(c / R), t1 = angDiff(0, phi - dl), t2 = angDiff(0, phi + dl);
    th = Math.abs(t1) <= Math.abs(t2) ? t1 : t2;
  }
  pole.copy(C).addScaledVector(u, Math.cos(th) * 0.6).addScaledVector(v, Math.sin(th) * 0.6);
  return true;
}
// The way a knee bends, made safe: a knee only bends the way its foot points
// (a straight leg, or a rough capture, can say otherwise), so the direction is
// kept on that side. Two such directions can always be turned one into the other.
// p: the bend direction (changed in place, unit on return); yaw: the foot's (world, about +Y).
export function kneeWay(p, yaw, bias = 0.05) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  p.x += fx * bias; p.z += fz * bias;
  p.normalize();
  const d = p.x * fx + p.z * fz;
  if (d < 0.25) { p.x += fx * (0.25 - d) * 1.2; p.z += fz * (0.25 - d) * 1.2; p.normalize(); }
  return p;
}
// The yaw a foot points (its +Z along the ground) from its world orientation.
export function footYaw(q) { _p.set(0, 0, 1).applyQuaternion(q); return Math.atan2(_p.x, _p.z); }

// A figure's legs as posed now (world): each ankle, its orientation and the way the knee bends (safe).
export function legsNow(h, S) {
  h.update();
  for (const sd of ['L', 'R']) {
    const a = (S['a' + sd] ||= new THREE.Vector3()), q = (S['q' + sd] ||= new THREE.Quaternion()), p = (S['p' + sd] ||= new THREE.Vector3());
    h.worldPos('ankle' + sd, a); h.bones['ankle' + sd].getWorldQuaternion(q);
    p.copy(h.worldPos('knee' + sd, _d)).sub(_e.addVectors(h.worldPos('hip' + sd, _b), a).multiplyScalar(0.5));
    kneeWay(p, footYaw(q));
  }
  return S;
}
// After blending two bodies joint by joint (Humanoid.blendFrom) the legs are put
// back on the blended ankles, each knee turned from the one way to the other (a
// joint-by-joint blend of two legs whose knees bend different ways wrings them
// round). N: the legs at w = 0, M: at w = 1 (legsNow). poles: { L, R } out (Vector3).
export function legsBlend(h, N, M, w, poles) {
  h.update();
  for (const sd of ['L', 'R']) {
    const tgt = _c.lerpVectors(N['a' + sd], M['a' + sd], w);
    const mid = _e.addVectors(h.worldPos('hip' + sd, _b), tgt).multiplyScalar(0.5);
    _q.setFromUnitVectors(N['p' + sd], M['p' + sd]);
    _x.copy(N['p' + sd]).applyQuaternion(_q2.identity().slerp(_q, w));
    const pole = (poles[sd] ||= new THREE.Vector3()).copy(mid).addScaledVector(_x, 0.6);
    h.ikLeg(sd, tgt, pole);
    h.setWorldQuat('ankle' + sd, _q.copy(N['q' + sd]).slerp(M['q' + sd], w));
  }
}

// K: { L, R } the state (each knee's last bend direction, plain arrays; null at first).
// rate: rad/s; minY: knee joint above the turf at least (m); lowY: a knee joint lower than
// this has its pad checked against the turf (m). Returns nothing; the legs are re-posed in place.
export function steadyKnees(h, K, dt, rate, minY, lowY) {
  h.update();
  const shin = h._shinIx || (h._shinIx = { L: [h.boneList.indexOf(h.bones.kneeL)], R: [h.boneList.indexOf(h.bones.kneeR)] });
  for (const sd of ['L', 'R']) {
    const ank = h.worldPos('ankle' + sd, _a), hip = h.worldPos('hip' + sd, _b), mid = _e.addVectors(hip, ank).multiplyScalar(0.5);
    const ax = _ax.subVectors(ank, hip).normalize();
    const d = _c.copy(h.worldPos('knee' + sd, _d)).sub(mid);
    d.addScaledVector(ax, -d.dot(ax));
    const len = d.length();
    let moved = false;
    if (len > 1e-5) {
      d.divideScalar(len);
      const prev = K[sd];
      if (prev && dt > 0 && dt < 0.1) {
        _p.fromArray(prev); _p.addScaledVector(ax, -_p.dot(ax));
        if (_p.lengthSq() > 1e-8) {
          _p.normalize();
          const ang = Math.acos(clamp(_p.dot(d), -1, 1)), m = rate * dt;
          if (ang > m) {
            // turn the last direction toward the new one by m about the leg's line
            const sgn = Math.sign(_x.crossVectors(_p, d).dot(ax)) || 1;
            d.copy(_p).applyAxisAngle(ax, sgn * m);
            moved = true;
          }
        }
      }
    }
    const pole = d.lengthSq() > 0.5 ? _kp.copy(mid).addScaledVector(d, 0.6) : _kp.copy(h.worldPos('knee' + sd, _d)).sub(mid).multiplyScalar(4).add(mid);
    if (liftPole(h, sd, ank, pole, minY)) moved = true;
    h.bones['ankle' + sd].getWorldQuaternion(_q);
    if (moved) { h.ikLeg(sd, ank, pole); h.setWorldQuat('ankle' + sd, _q); h.update(); }
    // (the pad below the knee joint, on a shin that slopes up to a raised foot: up onto it, not into the turf)
    const low = h.worldPos('knee' + sd, _x).y < lowY ? h.lowest(shin[sd]) : 0;
    if (low < 0) {
      h.worldPos('knee' + sd, _d).sub(mid); _d.addScaledVector(ax, -_d.dot(ax)).normalize();
      pole.copy(mid).addScaledVector(_d, 0.6);
      if (liftPole(h, sd, ank, pole, h.worldPos('knee' + sd, _x).y - low + 0.002)) { h.ikLeg(sd, ank, pole); h.setWorldQuat('ankle' + sd, _q); h.update(); }
    }
    // (what it ended as, for the next frame)
    h.worldPos('knee' + sd, _d).sub(mid);
    K[sd] = _d.addScaledVector(ax, -_d.dot(ax)).normalize().toArray();
  }
}
