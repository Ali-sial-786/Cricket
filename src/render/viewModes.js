// How you see yourself: first person (optionally from behind a helmet grille)
// or from just behind your player. Plus the pieces that need:
//   buildHelmetGrille()   head-locked peak + grille bars, placed at the eyes each frame
//   PlayerBowlerActor     a body for you when you bowl (arms follow the controllers)
//   NearCull              hides any body (or bat) that would be inside your head
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Actor } from './actors.js';
import { plantFeet, heelFor, clamp, mix } from './anim.js';

// ---------------------------------------------------------------- helmet
// Built in eye space: x right, y up, -z forward, metres from the point
// between the eyes. Bars sit below the eye line, the peak above it, so the
// view straight ahead stays clear (as through a real helmet).
export function buildHelmetGrille() {
  const g = new THREE.Group();
  g.name = 'helmetGrille';
  // Titanium grille: smooth round bars, lit, with a soft highlight; welds a shade darker.
  const steel = new THREE.MeshPhongMaterial({ color: 0x5d646d, specular: 0xe8eef5, shininess: 70, vertexColors: true });
  // Shell: glossy navy outside, dark padded lining inside.
  const shell = new THREE.MeshPhongMaterial({ color: 0x172d63, specular: 0x5a6f9e, shininess: 55, side: THREE.DoubleSide });
  const lining = new THREE.MeshLambertMaterial({ map: liningTexture(), color: 0xffffff, side: THREE.DoubleSide });
  // Parts are collected per material and merged: three draws for the whole helmet.
  const S = [], SH = [], LI = [];
  const put = (list, geo, pos = [0, 0, 0], rotY = 0, tint = 1) => {
    geo.rotateY(rotY); geo.translate(...pos);
    const g2 = geo.index ? geo.toNonIndexed() : geo;
    if (list === S) { const n = g2.attributes.position.count; g2.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(tint), 3)); }
    list.push(g2);
  };
  const R = 0.12;                                    // grille radius around the face
  const arc = 2.0;                                   // radians of wrap
  // Torus arcs start on +X and turn toward +Z once laid flat; this yaw puts
  // the middle of the arc straight ahead (-Z).
  const AHEAD = arc / 2 + Math.PI / 2;
  const levels = [[-0.042, R], [-0.074, R + 0.004], [-0.106, R + 0.008]];
  for (const [y, r] of levels) {
    const t = new THREE.TorusGeometry(r, 0.0028, 8, 64, arc);
    t.rotateX(Math.PI / 2);
    put(S, t, [0, y, 0], AHEAD);
  }
  // Vertical bars, and a small weld where each crosses a horizontal one.
  for (const a of [0, -0.6, 0.6]) {
    const r = R + 0.004;
    put(S, new THREE.CylinderGeometry(0.0028, 0.0028, 0.072, 8), [Math.sin(a) * r, -0.075, -Math.cos(a) * r]);
    for (const [y, rr] of levels) put(S, new THREE.SphereGeometry(0.0042, 8, 6), [Math.sin(a) * rr, y, -Math.cos(a) * rr], 0, 0.62);
  }
  // The grille's side mounts where it bolts to the shell (at the edge of vision).
  for (const sx of [-1, 1]) {
    const a = sx * (arc / 2 - 0.05);
    put(SH, new THREE.BoxGeometry(0.006, 0.07, 0.012), [Math.sin(a) * (R + 0.004), -0.07, -Math.cos(a) * (R + 0.004)], -a);
  }
  // Peak: smooth shell edge, the brim, and the padded lining just above the eyes.
  put(SH, new THREE.CylinderGeometry(R + 0.01, R + 0.012, 0.016, 64, 1, true, Math.PI - 1.15, 2.3), [0, 0.1, 0]);
  put(LI, new THREE.CylinderGeometry(R - 0.002, R - 0.002, 0.022, 64, 1, true, Math.PI - 1.1, 2.2), [0, 0.088, 0]);
  const brim = new THREE.RingGeometry(R + 0.008, R + 0.034, 64, 1, Math.PI + Math.PI / 2 - 0.95, 1.9);
  brim.rotateX(-Math.PI / 2 + 0.2);
  put(SH, brim, [0, 0.094, 0]);
  const clean = (list, keep) => list.map((x) => { for (const k of Object.keys(x.attributes)) if (!keep.includes(k)) x.deleteAttribute(k); return x; });
  g.add(new THREE.Mesh(mergeGeometries(clean(S, ['position', 'normal', 'color'])), steel));
  g.add(new THREE.Mesh(mergeGeometries(clean(SH, ['position', 'normal'])), shell));
  g.add(new THREE.Mesh(mergeGeometries(clean(LI, ['position', 'normal', 'uv'])), lining));
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
    // Through your own eyes the ghost body's arms are all but invisible, so the
    // ball you hold gets a hand of its own: a faint see-through hand (and wrist)
    // in the controller's grip space, fingers round the ball.
    this.hand = buildHeldHand();
    scene.add(this.hand);
  }
  // pose: {p, q} grip pose in the world (null hides it); alpha: 0..1 (x the hand's own faintness);
  // dz: m to add along the pitch (the run-up moved the rig after the controllers were read).
  showHand(pose, alpha = 1, dz = 0) {
    const m = this.hand;
    m.visible = !!pose && alpha > 0.02;
    if (!m.visible) return;
    m.position.set(pose.p.x, pose.p.y, pose.p.z + dz);
    m.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
    m.userData.mat.opacity = HAND_ALPHA * Math.min(1, alpha);
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
    if (this.speed > 0.35) this.locomote(t);
    else this.idle(t);
    // Crouch with the player.
    // (on the move the body only crouches so far: legs that run can't fold
    // much further, and a deeper drop would put the knees in the turf)
    const drop = clamp(1.62 - head.p.y, 0, this.speed > 0.35 ? mix(0.5, 0.16, clamp((this.speed - 0.35) / 1.5, 0, 1)) : 0.5);
    h.bones.hips.position.y -= drop / h.root.scale.y * 0.9;
    if (drop > 0.05) h.rot('spine', 0.2 + drop * 0.8, 0, 0);
    this.apply();
    if (this.speed <= 0.35) {                      // (feet stay down when you crouch: up on the toes when it is deep)
      this.footWorld(_a, 0.14, 0.04); this.footWorld(_b, -0.14, 0);
      plantFeet(h, _a, _b, this.forward(_c).multiplyScalar(0.6), heelFor(h));
    } else if (drop > 0.01) {                       // moving and crouching: the knees bend, the feet stay on the turf
      h.update(); h.clearFoot('L'); h.clearFoot('R');
    }
    h.update();
    const fw = this.forward(_d);
    // (a controller down at the floor: the hand stops on the turf, not in it)
    const hy = HAND_MIN_Y * h.root.scale.y;
    if (right) h.ikArm('R', _a.set(right.x, Math.max(hy, right.y), right.z), h.worldPos('shoulderR', _b).addScaledVector(fw, -0.4).add(_c.set(0, -0.5, 0)));
    if (left) { h.update(); h.ikArm('L', _a.set(left.x, Math.max(hy, left.y), left.z), h.worldPos('shoulderL', _b).addScaledVector(fw, -0.4).add(_c.set(0, -0.5, 0))); }
    if (look) h.lookAt(look, 0.8);
    h.syncShadow();
  }
}

// Grip space (WebXR): x right, y up, -z out along the controller. The ball
// sits at CONFIG.bowling.ballHoldOffset = (0, -0.02, -0.06): palm behind it,
// two fingers over the top along the seam, the thumb underneath.
const HAND_ALPHA = 0.4;
const HAND_MIN_Y = 0.09;           // wrist above the turf with the hand flat on it (model units)
function buildHeldHand() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xc89a7a, transparent: true, opacity: HAND_ALPHA, depthWrite: false });
  const g = new THREE.Group();
  g.name = 'heldHand';
  g.userData.mat = mat;
  const add = (geo, pos, rot = [0, 0, 0]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos); m.rotation.set(...rot);
    m.renderOrder = 12;                      // after the floating panels (they are further away)
    g.add(m);
  };
  // Palm and the back of the hand, behind and above the ball.
  add(new THREE.CapsuleGeometry(0.016, 0.05, 4, 10).scale(1, 1, 2.3).rotateZ(Math.PI / 2), [0, 0.014, -0.012], [0.35, 0, 0]);
  // Fingers over the ball: index and middle along the seam, ring and little to the side.
  const finger = (x, len, tilt) => add(new THREE.CapsuleGeometry(0.0085, len, 3, 8), [x, 0.012, -0.062], [Math.PI / 2 - tilt, 0, 0]);
  finger(-0.011, 0.05, 0.55); finger(0.011, 0.05, 0.55);
  finger(-0.031, 0.036, 0.9); finger(0.031, 0.03, 0.9);
  // Thumb under the ball.
  add(new THREE.CapsuleGeometry(0.009, 0.035, 3, 8), [0.012, -0.052, -0.05], [Math.PI / 2 + 0.3, 0.3, 0]);
  // Just the wrist (a forearm would reach back toward your face).
  add(new THREE.CylinderGeometry(0.024, 0.027, 0.05, 10), [0, 0.005, 0.055], [Math.PI / 2, 0, 0]);
  g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  g.visible = false;
  return g;
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
      if (h.root.visible && eye && !h.ghost) {
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
