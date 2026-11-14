// Finding the ball after it's hit:
//   * an arrow at the edge of your view pointing toward the ball when it is
//     out of sight (behind you, high above, off to the side)
//   * a halo of constant size round the ball once it's far away
//   * a ring on the ground where it will come down (while it's in the air)
import * as THREE from 'three';

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
const YELLOW = 0xffd34d;

export class BallFinder {
  constructor(scene) {
    // Arrow: a chevron in the view plane, pointing along local +Y.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.018); shape.lineTo(0.016, -0.004); shape.lineTo(0.007, -0.004);
    shape.lineTo(0.007, -0.016); shape.lineTo(-0.007, -0.016); shape.lineTo(-0.007, -0.004);
    shape.lineTo(-0.016, -0.004); shape.closePath();
    const mat = new THREE.MeshBasicMaterial({ color: YELLOW, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    const edge = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    edge.scale.setScalar(1.25); edge.position.z = -0.0005; edge.renderOrder = 29;
    this.arrow.add(edge);
    this.arrow.renderOrder = 30;
    this.arrowRoot = new THREE.Group();
    this.arrowRoot.add(this.arrow);
    this.arrowRoot.visible = false;
    scene.add(this.arrowRoot);
    // Halo round the ball.
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: YELLOW, transparent: true, depthTest: false, depthWrite: false }));
    this.halo.renderOrder = 28;
    this.halo.visible = false;
    scene.add(this.halo);
    // Landing ring on the grass.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 40), new THREE.MeshBasicMaterial({ color: YELLOW, transparent: true, opacity: 0.75, depthWrite: false }));
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

function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(0,0,0,0.55)'; x.lineWidth = 14;
  x.beginPath(); x.arc(64, 64, 50, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = '#ffffff'; x.lineWidth = 8;
  x.beginPath(); x.arc(64, 64, 50, 0, Math.PI * 2); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
