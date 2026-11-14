// How you see yourself: first person (optionally from behind a helmet grille)
// or from just behind your player. Plus the pieces that need:
//   buildHelmetGrille()   head-locked peak + grille bars, placed at the eyes each frame
//   PlayerBowlerActor     a body for you when you bowl (arms follow the controllers)
//   NearCull              hides any body (or bat) that would be inside your head
import * as THREE from 'three';
import { Actor } from './actors.js';
import { poseIdle, poseLocomotion, plantFeet, clamp } from './anim.js';

// ---------------------------------------------------------------- helmet
// Built in eye space: x right, y up, -z forward, metres from the point
// between the eyes. Bars sit below the eye line, the peak above it, so the
// view straight ahead stays clear (as through a real helmet).
export function buildHelmetGrille() {
  const g = new THREE.Group();
  g.name = 'helmetGrille';
  // Titanium grille: smooth round bars, lit, with a soft highlight.
  const steel = new THREE.MeshPhongMaterial({ color: 0x5d646d, specular: 0xe8eef5, shininess: 70 });
  const weld = new THREE.MeshPhongMaterial({ color: 0x3b4048, specular: 0x9aa4ae, shininess: 40 });
  // Shell: glossy navy outside, dark padded lining inside.
  const shell = new THREE.MeshPhongMaterial({ color: 0x172d63, specular: 0x5a6f9e, shininess: 55, side: THREE.DoubleSide });
  const lining = new THREE.MeshLambertMaterial({ map: liningTexture(), color: 0xffffff, side: THREE.DoubleSide });
  const R = 0.12;                                    // grille radius around the face
  const arc = 2.0;                                   // radians of wrap
  // Torus arcs start on +X and turn toward +Z once laid flat; this yaw puts
  // the middle of the arc straight ahead (-Z).
  const AHEAD = arc / 2 + Math.PI / 2;
  const levels = [[-0.042, R], [-0.074, R + 0.004], [-0.106, R + 0.008]];
  for (const [y, r] of levels) {
    const t = new THREE.TorusGeometry(r, 0.0028, 10, 72, arc);
    t.rotateX(Math.PI / 2);
    t.rotateY(AHEAD);
    const m = new THREE.Mesh(t, steel);
    m.position.y = y;
    g.add(m);
  }
  // Vertical bars, and a small weld where each crosses a horizontal one.
  for (const a of [0, -0.6, 0.6]) {
    const r = R + 0.004;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.072, 10), steel);
    m.position.set(Math.sin(a) * r, -0.075, -Math.cos(a) * r);
    g.add(m);
    for (const [y, rr] of levels) {
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 10, 8), weld);
      w.position.set(Math.sin(a) * rr, y, -Math.cos(a) * rr);
      g.add(w);
    }
  }
  // The grille's side mounts where it bolts to the shell (at the edge of vision).
  for (const sx of [-1, 1]) {
    const a = sx * (arc / 2 - 0.05);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.07, 0.012), shell);
    m.position.set(Math.sin(a) * (R + 0.004), -0.07, -Math.cos(a) * (R + 0.004));
    m.rotation.y = -a;
    g.add(m);
  }
  // Peak: smooth shell edge, the brim, and the padded lining just above the eyes.
  const rim = new THREE.CylinderGeometry(R + 0.01, R + 0.012, 0.016, 64, 1, true, Math.PI - 1.15, 2.3);
  const rimM = new THREE.Mesh(rim, shell);
  rimM.position.y = 0.1;
  g.add(rimM);
  const pad = new THREE.CylinderGeometry(R - 0.002, R - 0.002, 0.022, 64, 1, true, Math.PI - 1.1, 2.2);
  const padM = new THREE.Mesh(pad, lining);
  padM.position.y = 0.088;
  g.add(padM);
  const brim = new THREE.RingGeometry(R + 0.008, R + 0.034, 64, 1, Math.PI + Math.PI / 2 - 0.95, 1.9);
  brim.rotateX(-Math.PI / 2 + 0.2);
  const brimM = new THREE.Mesh(brim, shell);
  brimM.position.y = 0.094;
  g.add(brimM);
  g.traverse((o) => { if (o.isMesh) { o.renderOrder = 10; o.frustumCulled = false; } });
  g.visible = false;
  return g;
}

// Quilted foam with a stitched seam, for the inside of the peak.
function liningTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = '#1d2026'; x.fillRect(0, 0, 256, 32);
  for (let i = 0; i < 256; i += 16) {
    const gr = x.createLinearGradient(i, 0, i + 16, 0);
    gr.addColorStop(0, '#16181d'); gr.addColorStop(0.5, '#2a2e36'); gr.addColorStop(1, '#16181d');
    x.fillStyle = gr; x.fillRect(i, 4, 16, 24);
  }
  x.strokeStyle = '#5a6170'; x.setLineDash([3, 3]); x.lineWidth = 1;
  x.beginPath(); x.moveTo(0, 5.5); x.lineTo(256, 5.5); x.moveTo(0, 26.5); x.lineTo(256, 26.5); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- your bowler
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler();
export class PlayerBowlerActor extends Actor {
  constructor(scene) {
    super(scene, { team: 'home', seed: 9, headgear: 'bare' });
    this.visible = false;
    this.prev = null;
  }
  // head: {p, q} world; hands: world positions (or null); t: seconds.
  update(dt, t, head, right, left, look) {
    const h = this.h;
    // Where the body is: under the head, a little behind the eyes.
    _q.set(head.q.x, head.q.y, head.q.z, head.q.w);
    _e.setFromQuaternion(_q, 'YXZ');
    const yaw = _e.y + Math.PI;                       // headset looks down -Z; the figure faces +Z at heading 0
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const x = head.p.x - fx * 0.1, z = head.p.z - fz * 0.1;
    if (this.prev && dt > 0) {
      const v = Math.hypot(x - this.prev.x, z - this.prev.z) / dt;
      this.speed += (Math.min(7, v) - this.speed) * Math.min(1, dt * 8);
    }
    this.prev = { x, z };
    this.pos.set(x, 0, z);
    this.turnToward(yaw, dt, 9);
    this.gait(dt);
    h.reset();
    if (this.speed > 0.35) poseLocomotion(h, this.phase, this.speed);
    else poseIdle(h, t, 1);
    // Crouch with the player.
    const drop = clamp(1.62 - head.p.y, 0, 0.5);
    h.bones.hips.position.y = h.hipsRest.y - drop / h.root.scale.y * 0.9;
    if (drop > 0.05) h.rot('spine', 0.2 + drop * 0.8, 0, 0);
    this.apply();
    if (this.speed <= 0.35) {
      this.footWorld(_a, 0.14, 0.04); this.footWorld(_b, -0.14, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6));
    }
    h.update();
    const fw = this.forward(_d);
    if (right) h.ikArm('R', _a.set(right.x, right.y, right.z), h.worldPos('shoulderR', _b).addScaledVector(fw, -0.4).add(_c.set(0, -0.5, 0)));
    if (left) { h.update(); h.ikArm('L', _a.set(left.x, left.y, left.z), h.worldPos('shoulderL', _b).addScaledVector(fw, -0.4).add(_c.set(0, -0.5, 0))); }
    if (look) h.lookAt(look, 0.8);
    h.syncShadow();
  }
}

// ---------------------------------------------------------------- near cull
// Anything within `radius` of your eyes is moved to a camera layer nobody
// renders, so you never see the inside of a helmet (or of yourself). The
// objects keep their own `visible` flags, so game logic is unaffected.
const HIDDEN_LAYER = 7;
export class NearCull {
  constructor() { this.hidden = new Map(); }
  // humans: Humanoid list; extras(h) -> extra objects that go with a figure (its bat).
  // keepExtras: leave the bats drawn (replays through a batter's eyes).
  update(eye, humans, radius = 0.6, keepExtras = false) {
    for (const h of humans) {
      let near = false;
      if (h.root.visible && eye) {
        h.bones.neck.getWorldPosition(_a);
        const dx = _a.x - eye.x, dz = _a.z - eye.z, dy = _a.y - eye.y;
        near = Math.hypot(dx, dz) < radius && dy > -0.9 && dy < 0.5;
      }
      const key = near ? (keepExtras ? 1 : 2) : 0;
      if (key !== (this.hidden.get(h) || 0)) {
        h.root.traverse((o) => o.layers.set(near ? HIDDEN_LAYER : 0));
        for (const x of h.extras || []) x.traverse((o) => o.layers.set(key === 2 ? HIDDEN_LAYER : 0));
        if (near) this.hidden.set(h, key); else this.hidden.delete(h);
      }
    }
  }
  clear(humans) { this.update(null, humans); }
}
