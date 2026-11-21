// Finding the ball after it's hit:
//   * an arrow at the edge of your view pointing toward the ball when it is
//     out of sight (behind you, high above, off to the side)
//   * a halo of constant size round the ball once it's far away
//   * a ring on the ground where it will come down (while it's in the air)
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
// Broadcast style shared by all three: an amber body, a white inner rule, a
// near-black outline (readable on sky, stands and grass alike).
const AMBER = '#ffc531', INK = 'rgba(12,14,18,0.72)';

export class BallFinder {
  constructor(scene) {
    // Arrow: a chevron in the view plane, pointing along local +Y; the outline is
    // the same shape offset outward (even width all round), behind it.
    const pts = [[0, 0.019], [0.017, 0.001], [0.0085, 0.001], [0.0085, -0.015], [-0.0085, -0.015], [-0.0085, 0.001], [-0.017, 0.001]];
    const mk = (p) => { const s = new THREE.Shape(); s.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) s.lineTo(p[i][0], p[i][1]); s.closePath(); return new THREE.ShapeGeometry(s); };
    const flat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.arrow = new THREE.Mesh(mk(pts), flat(0xffc531, 0.97));
    const edge = new THREE.Mesh(mk(offsetPoly(pts, 0.0028)), flat(0x0c0e12, 0.72));
    edge.position.z = -0.0005; edge.renderOrder = 29;
    const inner = new THREE.Mesh(mk(offsetPoly(pts, -0.0042)), flat(0xfff3cf, 0.9));
    inner.position.z = 0.0005; inner.renderOrder = 31;
    this.arrow.add(edge, inner);
    this.arrow.renderOrder = 30;
    this.arrowRoot = new THREE.Group();
    this.arrowRoot.add(this.arrow);
    this.arrowRoot.visible = false;
    scene.add(this.arrowRoot);
    // Halo round the ball: a reticle ring with four ticks.
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.halo.renderOrder = 28;
    this.halo.visible = false;
    scene.add(this.halo);
    // Landing ring on the grass: one textured quad (mipmapped: no shimmer far off).
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), new THREE.MeshBasicMaterial({ map: landingTexture(), transparent: true, depthWrite: false, toneMapped: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 3;
    ring.visible = false;
    this.ring = ring;
    scene.add(ring);
    this.t = 0;
  }

  hide() { this.arrowRoot.visible = false; this.halo.visible = false; this.ring.visible = false; }

  // eye: {p, q}; ball: Vector3 or null; landing: {x, z} or null.
  update(dt, eye, ball, landing) {
    this.t += dt;
    if (!ball) { this.hide(); return; }
    // Direction to the ball in eye space (looking down -Z).
    _q.copy(eye.q); _qi.copy(_q).invert();
    _d.copy(ball).sub(eye.p);
    const dist = _d.length();
    _d.applyQuaternion(_qi).normalize();
    const off = Math.acos(Math.max(-1, Math.min(1, -_d.z)));       // angle from straight ahead
    // Arrow when the ball is more than ~24° away from where you look.
    if (off > 0.42) {
      const a = Math.atan2(_d.y, _d.x);
      const D = 0.6, r = Math.tan(0.3) * D;                         // ~17° out from the centre
      _p.set(Math.cos(a) * r, Math.sin(a) * r, -D);
      this.arrowRoot.position.copy(_p.applyQuaternion(_q).add(eye.p));
      this.arrowRoot.quaternion.copy(_q);
      this.arrow.rotation.set(0, 0, a - Math.PI / 2);
      const pulse = 1 + 0.12 * Math.sin(this.t * 9);
      this.arrow.scale.setScalar(2.1 * pulse * (off > 1.6 ? 1.25 : 1));   // ~7° across; bigger when it's behind you
      this.arrowRoot.visible = true;
    } else this.arrowRoot.visible = false;
    // Halo: about 2.6° across, from 12 m away.
    this.halo.visible = dist > 12;
    if (this.halo.visible) {
      this.halo.position.copy(ball);
      this.halo.scale.setScalar(dist * Math.tan(2.6 * Math.PI / 180));
      this.halo.material.opacity = Math.min(1, (dist - 12) / 8);
    }
    this.ring.visible = !!landing;
    if (landing) {
      this.ring.position.set(landing.x, 0.03, landing.z);
      const far = Math.hypot(landing.x - eye.p.x, landing.z - eye.p.z);
      this.ring.scale.setScalar(Math.max(1, far / 12) * (1 + 0.08 * Math.sin(this.t * 6)));   // stays visible far away
    }
  }
}

// A polygon's outline moved out (d > 0) or in (d < 0) by d, mitred corners.
function offsetPoly(p, d) {
  const n = p.length, out = [];
  let area = 0;
  for (let i = 0; i < n; i++) { const a = p[i], b = p[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) d = -d;                                             // (clockwise: the right-hand normals point in)
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const e1 = norm(b[0] - a[0], b[1] - a[1]), e2 = norm(c[0] - b[0], c[1] - b[1]);
    const n1 = [e1[1], -e1[0]], n2 = [e2[1], -e2[0]];               // right-hand normals
    const m = norm(n1[0] + n2[0], n1[1] + n2[1]), k = d / Math.max(0.3, m[0] * n1[0] + m[1] * n1[1]);
    out.push([b[0] + m[0] * k, b[1] + m[1] * k]);
  }
  return out;
}
const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

function haloTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), m = S / 2, r = 46;
  const ring = (w, style) => { x.lineWidth = w; x.strokeStyle = style; x.beginPath(); x.arc(m, m, r, 0, Math.PI * 2); x.stroke(); };
  ring(13, INK); ring(7.5, AMBER); ring(1.6, 'rgba(255,255,255,0.85)');
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4, c0 = Math.cos(a), s0 = Math.sin(a);
    x.lineCap = 'round';
    x.lineWidth = 9; x.strokeStyle = INK; x.beginPath(); x.moveTo(m + c0 * (r + 4), m + s0 * (r + 4)); x.lineTo(m + c0 * (r + 14), m + s0 * (r + 14)); x.stroke();
    x.lineWidth = 4.5; x.strokeStyle = AMBER; x.beginPath(); x.moveTo(m + c0 * (r + 4), m + s0 * (r + 4)); x.lineTo(m + c0 * (r + 14), m + s0 * (r + 14)); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The landing ring: amber band with a dark outline, a faint fill, a centre dot
// and four ticks pointing in (inner radius ~0.55 m, outer ~0.75 m at scale 1).
function landingTexture() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d'), m = S / 2, px = S / 1.6;            // px per metre
  x.fillStyle = 'rgba(255,197,49,0.12)'; x.beginPath(); x.arc(m, m, 0.55 * px, 0, Math.PI * 2); x.fill();
  const ring = (rad, w, style) => { x.lineWidth = w; x.strokeStyle = style; x.beginPath(); x.arc(m, m, rad, 0, Math.PI * 2); x.stroke(); };
  ring(0.65 * px, 0.26 * px, INK); ring(0.65 * px, 0.18 * px, AMBER); ring(0.585 * px, 0.02 * px, 'rgba(255,255,255,0.9)');
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2, c0 = Math.cos(a), s0 = Math.sin(a);
    x.lineWidth = 0.07 * px; x.strokeStyle = AMBER; x.lineCap = 'round';
    x.beginPath(); x.moveTo(m + c0 * 0.5 * px, m + s0 * 0.5 * px); x.lineTo(m + c0 * 0.36 * px, m + s0 * 0.36 * px); x.stroke();
  }
  x.fillStyle = INK; x.beginPath(); x.arc(m, m, 0.09 * px, 0, Math.PI * 2); x.fill();
  x.fillStyle = AMBER; x.beginPath(); x.arc(m, m, 0.06 * px, 0, Math.PI * 2); x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
