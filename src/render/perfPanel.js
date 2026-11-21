// The performance panel (Settings -> View -> Performance panel): a small
// board that hangs below your line of sight and follows your head lazily
// (it stays put until you turn more than ~35 degrees away, then glides
// back), so you can glance down at it while you play. Redrawn twice a
// second (a 512 x 192 canvas: a small upload), never every frame.
import * as THREE from 'three';

const W = 512, H = 192;
const _f = new THREE.Vector3(), _t = new THREE.Vector3();

export class PerfPanel {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5 * H / W), mat);
    this.mesh.name = 'perfPanel';
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.yaw = null;          // the yaw it is placed at (lazy follow)
  }

  // eye: { p: Vector3, q: Quaternion } (the drawn eye); dt: s.
  place(eye, dt) {
    _f.set(0, 0, -1).applyQuaternion(eye.q);
    const yaw = Math.atan2(-_f.x, -_f.z);
    if (this.yaw == null) this.yaw = yaw;
    let d = yaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.6) this.chase = true;
    if (this.chase) { this.yaw += d * Math.min(1, dt * 4); if (Math.abs(d) < 0.05) this.chase = false; }
    const sx = -Math.sin(this.yaw), sz = -Math.cos(this.yaw);
    _t.set(eye.p.x + sx * 0.9, eye.p.y - 0.52, eye.p.z + sz * 0.9);     // (~30 degrees down: under the menus too)
    this.mesh.position.copy(_t);
    this.mesh.lookAt(eye.p);
  }

  // lines: up to 5 strings; warn: highlight the first line (frames are being missed)
  draw(lines, warn = false) {
    const g = this.ctx;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(8,13,22,0.86)';
    g.beginPath(); g.roundRect ? g.roundRect(0, 0, W, H, 18) : g.rect(0, 0, W, H); g.fill();
    g.fillStyle = warn ? '#ff4d5e' : '#1db978'; g.fillRect(0, 0, 8, H);
    g.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      g.font = i === 0 ? '700 30px system-ui, sans-serif' : '500 23px system-ui, sans-serif';
      g.fillStyle = i === 0 ? (warn ? '#ffd0d4' : '#f3f6fb') : '#c3cfdd';
      g.fillText(lines[i], 22, i === 0 ? 14 : 22 + i * 34, W - 34);
    }
    this.tex.needsUpdate = true;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.tex.dispose(); }
}
