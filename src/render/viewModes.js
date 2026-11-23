// How you see yourself: first person (optionally from behind a helmet grille)
// or from just behind your player. Plus the pieces that need:
//   buildHelmetGrille()   head-locked peak + grille bars, placed at the eyes each frame
//   PlayerBowlerActor     a body for you when you bowl (arms follow the controllers)
//   NearCull              hides any body (or bat) that would be inside your head
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Actor } from './actors.js';
import { Humanoid } from './humanoid.js';
import { plantFeet, heelFor, clamp, mix, hyp } from './anim.js';

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
    // Through your own eyes the ball you hold is in a hand of its own: a solid
    // hand in the controller's grip space, fingers along the seam and the
    // thumb under the ball, its wrist meeting your figure's forearm (whose own
    // bare hand is not drawn meanwhile: Humanoid uHideHand).
    this.hand = buildHeldHand();
    scene.add(this.hand);
  }
  // pose: {p, q} grip pose in the world (null hides it); alpha: 0..1 (below ~0.5 the hand is not drawn);
  // dz: m to add along the pitch (the run-up moved the rig after the controllers were read).
  showHand(pose, alpha = 1, dz = 0) {
    const m = this.hand, u = this.h.material.userData.uniforms;
    m.visible = !!pose && alpha > 0.5;
    u.uHideHand.value = m.visible && this.h.ghost ? this.h.boneList.indexOf(this.h.bones.handR) : -1;
    if (!m.visible) return;
    m.position.set(pose.p.x, pose.p.y, pose.p.z + dz);
    m.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w);
    m.userData.mat.color.copy(u.uSkin.value);
  }
  // head: {p, q} world; hands: world positions (or null); t: seconds.
  update(dt, t, head, right, left, look) {
    const h = this.h;
    // Where the body is: under the head, a little behind the eyes.
    _q.set(head.q.x, head.q.y, head.q.z, head.q.w);
    _e.setFromQuaternion(_q, 'YXZ');
    const yaw = _e.y + Math.PI;                       // headset looks down -Z; the figure faces +Z at heading 0
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    // (your eyes are in front of your head's joint: the body that far behind them, so you look down at your chest, not down your collar)
    const x = head.p.x - fx * 0.16, z = head.p.z - fz * 0.16;
    if (this.prev && dt > 0) {
      const v = hyp(x - this.prev.x, z - this.prev.z) / dt;
      this.speed += (Math.min(7, v) - this.speed) * Math.min(1, dt * 8);
    }
    this.prev = { x, z };
    this.pos.set(x, 0, z);
    // (the chest does not turn with every look: looking round, it stays put until the head is well
    // off it (it follows a little behind); moving, it turns your way)
    const off = Math.atan2(Math.sin(yaw - this.heading), Math.cos(yaw - this.heading));
    const want = this.speed > 0.6 ? yaw : Math.abs(off) > 0.7 ? yaw - Math.sign(off) * 0.7 : this.heading;
    this.turnToward(want, dt, this.speed > 0.6 ? 9 : 4);
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
// sits at CONFIG.bowling.ballHoldOffset = (0, -0.02, -0.06): the palm behind
// it, index and middle fingers over the top along the seam, the ring and
// little fingers curled at the side, the thumb underneath.
const HAND_MIN_Y = 0.09;           // wrist above the turf with the hand flat on it (model units)
function buildHeldHand() {
  const mat = new THREE.MeshLambertMaterial({ color: 0xc89a7a });
  const C = new THREE.Vector3(0, -0.02, -0.06), RB = 0.036;
  const parts = [];
  // a finger: an arc round the ball at x, from angle a0 to a1 (0 = behind the ball, PI/2 = on top), tapering
  const finger = (x, a0, a1, r0, r1, lift = 0.0095) => {
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const a = a0 + (a1 - a0) * k / 8, R = RB + lift;
      pts.push(new THREE.Vector3(C.x + x, C.y + Math.sin(a) * R, C.z + Math.cos(a) * R));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, 12, (r0 + r1) / 2, 8, false);
    // taper along the finger
    const P = g.attributes.position, N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      const seg = Math.floor(i / 9) / 12, c = curve.getPointAt(Math.min(1, seg)), rr = r0 + (r1 - r0) * seg;
      const d = new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i)).sub(c), l = d.length() || 1;
      d.multiplyScalar(rr / l).add(c); P.setXYZ(i, d.x, d.y, d.z);
    }
    g.computeVertexNormals();
    parts.push(g);
    const tip = new THREE.SphereGeometry(r1, 8, 6); const e = curve.getPointAt(1); tip.translate(e.x, e.y, e.z); parts.push(tip);
    void N;
  };
  finger(-0.011, 0.55, 2.35, 0.0095, 0.0078);       // index
  finger(0.0105, 0.55, 2.45, 0.0098, 0.008);        // middle
  finger(0.029, 0.6, 1.95, 0.009, 0.0074, 0.008);   // ring
  finger(0.045, 0.7, 1.55, 0.0078, 0.0066, 0.004);  // little
  // the palm and the back of the hand, behind and above the ball
  const palm = new THREE.SphereGeometry(1, 14, 10);
  palm.scale(0.043, 0.022, 0.042).rotateX(-0.75).translate(0.012, 0.012, -0.005);
  parts.push(palm);
  // the thumb, from the heel of the hand round under the ball
  const th = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.03, -0.005, 0.0), new THREE.Vector3(-0.038, -0.03, -0.035), new THREE.Vector3(-0.022, -0.058, -0.06), new THREE.Vector3(-0.004, -0.062, -0.075)]);
  parts.push(new THREE.TubeGeometry(th, 10, 0.0105, 8, false));
  const tt = new THREE.SphereGeometry(0.0098, 8, 6); tt.translate(-0.004, -0.062, -0.075); parts.push(tt);
  // the wrist, back to where your figure's forearm takes over
  const wr = new THREE.CylinderGeometry(0.025, 0.027, 0.075, 12, 1, true);
  wr.rotateX(Math.PI / 2 - 0.35).translate(0.006, 0.02, 0.05);
  parts.push(wr);
  const geo = mergeGeometries(parts.map((g) => { const q = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal') q.deleteAttribute(k); return q; }));
  const m = new THREE.Mesh(geo, mat);
  m.name = 'heldHand';
  m.userData.mat = mat;
  m.frustumCulled = false;
  m.visible = false;
  return m;
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
    if (eye) Humanoid.eye = eye;                  // (where your eyes are: the pose LOD's distances)
    for (const h of humans) {
      let near = false;
      if (h.root.visible && eye && !h.ghost) {
        h.bones.neck.getWorldPosition(_a);
        const dx = _a.x - eye.x, dz = _a.z - eye.z, dy = _a.y - eye.y;
        near = dx * dx + dz * dz < radius * radius && dy > -0.9 && dy < 0.5;
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
