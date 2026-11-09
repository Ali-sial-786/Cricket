// Procedural low-poly athletes: one SkinnedMesh per person (one draw call,
// GPU skinning), a 17-bone skeleton, rigid skinning with joint caps, team kit
// colours swappable at runtime through shader uniforms, and two-bone IK so
// hands grip bats / catch balls and feet stay planted.
//
// Rest pose: standing, arms hanging, facing +Z, feet at y = 0, ~1.80 m tall.
// Every bone's rest rotation is identity and limbs point down -Y, so poses are
// plain local Euler rotations (x = forward/back swing, z = sideways).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const BONES = [
  ['hips', null, [0, 0.96, 0]],
  ['spine', 'hips', [0, 0.10, 0]],
  ['chest', 'spine', [0, 0.20, 0]],
  ['neck', 'chest', [0, 0.235, 0]],
  ['head', 'neck', [0, 0.085, 0]],
  ['shoulderL', 'chest', [0.175, 0.185, 0]],
  ['elbowL', 'shoulderL', [0, -0.29, 0]],
  ['handL', 'elbowL', [0, -0.26, 0]],
  ['shoulderR', 'chest', [-0.175, 0.185, 0]],
  ['elbowR', 'shoulderR', [0, -0.29, 0]],
  ['handR', 'elbowR', [0, -0.26, 0]],
  ['hipL', 'hips', [0.095, -0.05, 0]],
  ['kneeL', 'hipL', [0, -0.43, 0]],
  ['ankleL', 'kneeL', [0, -0.41, 0]],
  ['hipR', 'hips', [-0.095, -0.05, 0]],
  ['kneeR', 'hipR', [0, -0.43, 0]],
  ['ankleR', 'kneeR', [0, -0.41, 0]],
];
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b[0], i]));
const REST = {};
for (const [name, parent, off] of BONES) {
  const p = parent ? REST[parent] : [0, 0, 0];
  REST[name] = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
}

// Kit slots: 0 = fixed vertex colour, 1 = primary, 2 = secondary/trim, 3 = headgear.
const KIT1 = 1, KIT2 = 2, KIT3 = 3;

export const SKIN_TONES = [0xf1c8a5, 0xd9a77c, 0xb57a52, 0x8d5a3b, 0x613d28];
export const HAIR = [0x1d1510, 0x3b2a1c, 0x5a4330, 0x0e0e0e, 0x8a6a40];

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();

function addPart(list, geom, bone, color, pos = [0, 0, 0], rot = null, scale = null) {
  let g = geom.index ? geom.toNonIndexed() : geom.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  _q.identity();
  if (rot) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _s.set(...(scale || [1, 1, 1]));
  const r = REST[bone];
  _m.compose(new THREE.Vector3(pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]), _q, _s);
  g.applyMatrix4(_m);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), kit = new Float32Array(n);
  const skinI = new Uint16Array(n * 4), skinW = new Float32Array(n * 4);
  const c = new THREE.Color(typeof color === 'number' && color > 3 ? color : 0xffffff);
  const slot = typeof color === 'number' && color <= 3 ? color : 0;
  const bi = BONE_INDEX[bone];
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    kit[i] = slot;
    skinI[i * 4] = bi; skinW[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('kit', new THREE.BufferAttribute(kit, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinW, 4));
  list.push(g);
}

const capsule = (r, len, rs = 7) => new THREE.CapsuleGeometry(r, len, 2, rs);
const sphere = (r, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt, rb, h, rs = 10) => new THREE.CylinderGeometry(rt, rb, h, rs);

// Rounded box via a scaled sphere-capsule hybrid (soft torso shapes).
function softBox(w, h, d) {
  const g = new THREE.CapsuleGeometry(0.5, 0.6, 3, 9);
  g.scale(w, h / 1.6, d);
  return g;
}

function buildGeometry(o) {
  const P = [];
  const skin = o.skin, shoe = 0xf3f3f3, sole = 0x30343a;
  const longSleeve = !!o.longSleeve;
  // --- Torso ---
  addPart(P, softBox(0.35, 0.26, 0.235), 'hips', KIT1, [0, -0.01, 0]);
  addPart(P, softBox(0.335, 0.27, 0.215), 'spine', KIT1, [0, 0.11, 0.008]);
  addPart(P, softBox(0.43, 0.35, 0.25), 'chest', KIT1, [0, 0.13, 0.004]);
  addPart(P, softBox(0.3, 0.16, 0.08), 'chest', KIT1, [0, 0.12, 0.09]);               // pecs
  addPart(P, cyl(0.078, 0.085, 0.04, 12), 'chest', KIT2, [0, 0.25, 0.0]);             // collar
  addPart(P, box(0.03, 0.09, 0.012), 'chest', KIT2, [0, 0.2, 0.123], [0.25, 0, 0]);    // placket
  addPart(P, sphere(0.078), 'chest', KIT1, [0.172, 0.175, 0]);                         // shoulder caps
  addPart(P, sphere(0.078), 'chest', KIT1, [-0.172, 0.175, 0]);
  addPart(P, cyl(0.17, 0.172, 0.035, 14), 'hips', KIT2, [0, 0.085, 0], null, [1, 1, 0.68]); // waistband
  // --- Neck + head ---
  addPart(P, cyl(0.054, 0.06, 0.11, 8), 'neck', skin, [0, 0.03, 0]);
  addPart(P, sphere(0.104, 10, 8), 'head', skin, [0, 0.105, 0.008], null, [0.95, 1.1, 1.04]);
  addPart(P, sphere(0.022, 6, 4), 'head', skin, [0.1, 0.1, -0.005]);                  // ears
  addPart(P, sphere(0.022, 6, 4), 'head', skin, [-0.1, 0.1, -0.005]);
  addPart(P, box(0.026, 0.04, 0.03), 'head', skin, [0, 0.085, 0.108]);                // nose
  addPart(P, sphere(0.012, 6, 4), 'head', 0x1a1a1a, [0.035, 0.122, 0.096]);            // eyes
  addPart(P, sphere(0.012, 6, 4), 'head', 0x1a1a1a, [-0.035, 0.122, 0.096]);
  addPart(P, box(0.03, 0.007, 0.01), 'head', o.hair, [0.036, 0.145, 0.1]);             // brows
  addPart(P, box(0.03, 0.007, 0.01), 'head', o.hair, [-0.036, 0.145, 0.1]);
  if (o.headgear === 'helmet') {
    addPart(P, new THREE.SphereGeometry(0.128, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.58), 'head', KIT3, [0, 0.12, -0.005], null, [1, 1.05, 1.08]);
    addPart(P, box(0.2, 0.015, 0.08), 'head', KIT3, [0, 0.165, 0.12], [0.25, 0, 0]);  // peak
    for (let i = 0; i < 4; i++) addPart(P, box(0.2, 0.008, 0.008), 'head', 0xb8bec6, [0, 0.03 + i * 0.03, 0.135]); // grille
    addPart(P, box(0.008, 0.11, 0.008), 'head', 0xb8bec6, [0, 0.075, 0.137]);
    addPart(P, box(0.02, 0.08, 0.06), 'head', KIT3, [0.115, 0.07, 0.04]);              // side flaps
    addPart(P, box(0.02, 0.08, 0.06), 'head', KIT3, [-0.115, 0.07, 0.04]);
  } else if (o.headgear === 'cap') {
    addPart(P, new THREE.SphereGeometry(0.112, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 'head', KIT3, [0, 0.13, 0], null, [1, 0.9, 1.06]);
    addPart(P, cyl(0.075, 0.075, 0.012, 12), 'head', KIT3, [0, 0.135, 0.12], null, [1, 1, 0.75]);
  } else if (o.headgear === 'hat') {
    addPart(P, cyl(0.21, 0.21, 0.012, 16), 'head', 0xf2eedd, [0, 0.16, 0]);
    addPart(P, cyl(0.105, 0.115, 0.09, 12), 'head', 0xf2eedd, [0, 0.2, 0]);
    addPart(P, cyl(0.116, 0.116, 0.02, 12), 'head', KIT1, [0, 0.175, 0]);
  } else {
    addPart(P, new THREE.SphereGeometry(0.11, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42), 'head', o.hair, [0, 0.118, -0.008], null, [1, 1, 1.04]);
  }
  // --- Arms ---
  for (const s of ['L', 'R']) {
    const sx = s === 'L' ? 1 : -1;
    addPart(P, capsule(0.066, 0.12), 'shoulder' + s, KIT1, [0, -0.07, 0]);                   // sleeve
    addPart(P, cyl(0.067, 0.067, 0.025, 10), 'shoulder' + s, KIT2, [0, -0.15, 0]);           // cuff
    addPart(P, capsule(0.056, 0.17), 'shoulder' + s, longSleeve ? KIT1 : skin, [0, -0.165, 0]);
    addPart(P, sphere(0.053, 8, 6), 'elbow' + s, longSleeve ? KIT1 : skin, [0, 0, 0]);
    addPart(P, capsule(0.048, 0.16), 'elbow' + s, longSleeve ? KIT1 : skin, [0, -0.12, 0], null, [1, 1, 0.9]);
    if (o.gloves) {
      addPart(P, box(0.09, 0.11, 0.075), 'hand' + s, 0xf5f5f5, [0, -0.05, 0.005]);
      addPart(P, box(0.092, 0.03, 0.077), 'hand' + s, KIT2, [0, -0.01, 0.005]);
      addPart(P, box(0.03, 0.06, 0.04), 'hand' + s, 0xf5f5f5, [sx * 0.045, -0.04, 0.035]);
    } else {
      addPart(P, box(0.075, 0.1, 0.038), 'hand' + s, skin, [0, -0.052, 0.004]);
      addPart(P, box(0.022, 0.05, 0.022), 'hand' + s, skin, [sx * 0.035, -0.035, 0.022], [0.3, 0, 0]);
    }
  }
  // --- Legs ---
  for (const s of ['L', 'R']) {
    const sx = s === 'L' ? 1 : -1;
    addPart(P, capsule(0.094, 0.28), 'hip' + s, KIT1, [0, -0.21, 0]);
    addPart(P, box(0.012, 0.34, 0.045), 'hip' + s, KIT2, [sx * 0.092, -0.21, 0]);            // trouser stripe
    addPart(P, sphere(0.072, 8, 6), 'knee' + s, KIT1, [0, 0, 0]);
    addPart(P, capsule(0.068, 0.27), 'knee' + s, KIT1, [0, -0.2, 0.005]);
    addPart(P, capsule(0.058, 0.12), 'knee' + s, KIT1, [0, -0.13, -0.025]);                  // calf
    if (o.pads) {
      addPart(P, box(0.17, 0.47, 0.085), 'knee' + s, 0xf7f7f7, [0, -0.18, 0.065]);
      addPart(P, cyl(0.07, 0.07, 0.15, 10), 'knee' + s, 0xf7f7f7, [0, 0.03, 0.065], [0, 0, Math.PI / 2]);
      for (const ox of [-0.05, 0, 0.05]) addPart(P, box(0.028, 0.42, 0.02), 'knee' + s, 0xe9e9e9, [ox, -0.19, 0.11]);
      addPart(P, box(0.175, 0.025, 0.09), 'knee' + s, KIT2, [0, -0.06, 0.065]);             // straps
      addPart(P, box(0.175, 0.025, 0.09), 'knee' + s, KIT2, [0, -0.3, 0.065]);
    }
    addPart(P, box(0.108, 0.08, 0.27), 'ankle' + s, shoe, [0, -0.03, 0.055]);
    addPart(P, box(0.112, 0.02, 0.28), 'ankle' + s, sole, [0, -0.07, 0.055]);
    addPart(P, box(0.012, 0.03, 0.12), 'ankle' + s, KIT2, [sx * 0.051, -0.02, 0.06]);      // shoe flash
  }
  return mergeGeometries(P, false);
}

// Shared kit shader injection (vertex colour replaced by per-figure uniforms).
function kitMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = {
    uKit1: { value: new THREE.Color(0x1f4fa8) },
    uKit2: { value: new THREE.Color(0xf2c12e) },
    uKit3: { value: new THREE.Color(0x14285a) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float kit;\nuniform vec3 uKit1;\nuniform vec3 uKit2;\nuniform vec3 uKit3;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
          if (kit > 0.5) vColor.rgb = kit < 1.5 ? uKit1 : (kit < 2.5 ? uKit2 : uKit3);
        #endif`);
  };
  mat.customProgramCacheKey = () => 'cricket-kit';
  mat.userData.uniforms = uniforms;
  return mat;
}

export const KITS = {
  home: { kit1: 0x1f4fa8, kit2: 0xf2c12e, kit3: 0x14285a },     // royal blue / gold
  away: { kit1: 0xb3221c, kit2: 0xf4f4f4, kit3: 0x5e0f0c },     // crimson / white
};

const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Vector3(),
  _T = new THREE.Vector3(), _dir = new THREE.Vector3(), _pv = new THREE.Vector3(), _end = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _eul = new THREE.Euler(), _bq = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Humanoid {
  constructor({ team = 'home', skin = null, hair = null, headgear = 'cap', pads = false, gloves = false, longSleeve = false, scale = 1, seed = 0 } = {}) {
    const rnd = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    const skinC = skin ?? SKIN_TONES[Math.floor(rnd(1) * SKIN_TONES.length)];
    const hairC = hair ?? HAIR[Math.floor(rnd(2) * HAIR.length)];
    const geo = buildGeometry({ skin: skinC, hair: hairC, headgear, pads, gloves, longSleeve });
    this.material = kitMaterial();
    const bones = [];
    this.bones = {};
    for (const [name, parent, off] of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(...off);
      if (parent) this.bones[parent].add(b);
      this.bones[name] = b;
      bones.push(b);
    }
    this.mesh = new THREE.SkinnedMesh(geo, this.material);
    this.mesh.add(bones[0]);
    this.mesh.bind(new THREE.Skeleton(bones));
    // Generous fixed culling sphere (covers raised arms, dives and a bat).
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.9);
    this.mesh.frustumCulled = true;
    this.boneList = bones;
    this.root = new THREE.Group();
    this.root.add(this.mesh);
    this.root.scale.setScalar(scale);
    this.hipsRest = this.bones.hips.position.clone();
    this.setTeam(team);
    // Contact shadow: a slot in the shared instanced shadow mesh.
    this.shadowSlot = ShadowPool.alloc();
  }

  setTeam(team) {
    const k = KITS[team] || KITS.home;
    const u = this.material.userData.uniforms;
    u.uKit1.value.setHex(k.kit1); u.uKit2.value.setHex(k.kit2); u.uKit3.value.setHex(k.kit3);
    this.team = team;
  }

  get visible() { return this.root.visible; }
  set visible(v) { this.root.visible = v; if (!v) ShadowPool.set(this.shadowSlot, 0, 0, false); }

  // Called after the root is placed for the frame.
  syncShadow() {
    if (!this.root.visible) return;
    this.bones.hips.getWorldPosition(_v);
    ShadowPool.set(this.shadowSlot, _v.x, _v.z, true, this.root.scale.x * (0.8 + 0.4 * Math.min(1, (_v.y - this.root.position.y) / 1.0)));
  }

  reset() {
    for (const b of Object.values(this.bones)) b.quaternion.identity();
    this.bones.hips.position.copy(this.hipsRest);
  }

  // Local Euler rotation (relative to rest) for a bone.
  rot(name, x = 0, y = 0, z = 0, order = 'XYZ') {
    this.bones[name].quaternion.setFromEuler(_eul.set(x, y, z, order));
  }

  // Apply an extra local rotation on top of the current one.
  addRot(name, x = 0, y = 0, z = 0) {
    _pq.setFromEuler(_eul.set(x, y, z, 'XYZ'));
    this.bones[name].quaternion.multiply(_pq);
  }

  update() { this.root.updateMatrixWorld(true); }

  // Capture the current pose so a new one can be blended from it.
  snapshot(out = { q: [], hipsY: 0, hipsP: new THREE.Vector3() }) {
    this.boneList.forEach((b, i) => { (out.q[i] ||= new THREE.Quaternion()).copy(b.quaternion); });
    out.hipsP.copy(this.bones.hips.position);
    return out;
  }
  // current = lerp(snapshot, current, w)
  blendFrom(snap, w) {
    if (w >= 1) return;
    this.boneList.forEach((b, i) => { _bq.copy(b.quaternion); b.quaternion.slerpQuaternions(snap.q[i], _bq, w); });
    this.bones.hips.position.lerpVectors(snap.hipsP, this.bones.hips.position, w);
  }

  // Turn neck + head toward a world point (after the body is posed).
  lookAt(target, amount = 1, maxYaw = 1.4) {
    this.update();
    const neck = this.bones.neck;
    neck.parent.getWorldQuaternion(_pq).invert();
    neck.getWorldPosition(_v);
    _v2.subVectors(target, _v).applyQuaternion(_pq);
    const yaw = clamp(Math.atan2(_v2.x, _v2.z), -maxYaw, maxYaw) * amount;
    const pitch = clamp(Math.atan2(-_v2.y, Math.hypot(_v2.x, _v2.z)), -0.7, 0.8) * amount;
    this.rot('neck', pitch * 0.4, yaw * 0.45, 0, 'YXZ');
    this.rot('head', pitch * 0.6, yaw * 0.55, 0, 'YXZ');
  }

  worldPos(name, out) { return this.bones[name].getWorldPosition(out); }

  // Two-bone IK: limb = 'L' | 'R' arm, or 'legL' | 'legR'.
  ikArm(side, target, pole) {
    const b = this.bones;
    solveTwoBone(b['shoulder' + side], b['elbow' + side], b['hand' + side], target, pole);
  }
  ikLeg(side, target, pole) {
    const b = this.bones;
    solveTwoBone(b['hip' + side], b['knee' + side], b['ankle' + side], target, pole);
  }

  // Set a bone's world orientation.
  setWorldQuat(name, q) {
    const bone = this.bones[name];
    bone.parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq).multiply(q);
    bone.updateMatrixWorld(true);
  }
}

// All actor contact shadows in one InstancedMesh (one draw call).
export const ShadowPool = {
  mesh: null, n: 0, max: 24,
  init(scene) {
    if (this.mesh) return;
    const g = new THREE.PlaneGeometry(0.84, 0.84);
    g.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(g, _shadowMat, this.max);
    this.mesh.count = this.max;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const m = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.max; i++) this.mesh.setMatrixAt(i, m);
    scene.add(this.mesh);
  },
  alloc() { return this.n < this.max ? this.n++ : -1; },
  set(slot, x, z, visible, scale = 1) {
    if (!this.mesh || slot < 0) return;
    _sm.makeScale(visible ? scale : 0, 1, visible ? scale : 0).setPosition(x, 0.012, z);
    this.mesh.setMatrixAt(slot, _sm);
    this.mesh.instanceMatrix.needsUpdate = true;
  },
};
const _sm = new THREE.Matrix4();
const _shadowMat = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
})();

// Aim a bone's -Y axis along a world direction.
function aimBone(bone, dirWorld) {
  bone.parent.getWorldQuaternion(_pq).invert();
  _v2.copy(dirWorld).applyQuaternion(_pq).normalize();
  bone.quaternion.setFromUnitVectors(DOWN, _v2);
  bone.updateMatrixWorld(true);
}

// Analytic two-bone IK in world space. `pole` is a world point the middle
// joint bends toward.
export function solveTwoBone(upper, lower, end, target, pole) {
  upper.parent.updateWorldMatrix(true, false);
  upper.updateMatrixWorld(true);
  upper.getWorldPosition(_S);
  lower.getWorldPosition(_E);
  end.getWorldPosition(_end);
  const a = _S.distanceTo(_E), b = _E.distanceTo(_end);
  _dir.subVectors(target, _S);
  let d = _dir.length();
  if (d < 1e-5 || a < 1e-5 || b < 1e-5) return;
  _dir.divideScalar(d);
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-3), a + b - 1e-4);
  _pv.subVectors(pole, _S);
  _pv.addScaledVector(_dir, -_pv.dot(_dir));
  if (_pv.lengthSq() < 1e-10) {
    _pv.set(0, 0, 1).addScaledVector(_dir, -_dir.z);
    if (_pv.lengthSq() < 1e-10) _pv.set(1, 0, 0);
  }
  _pv.normalize();
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  _E.copy(_S).addScaledVector(_dir, a * cosA).addScaledVector(_pv, a * sinA);
  _T.copy(_S).addScaledVector(_dir, d);
  aimBone(upper, _v.subVectors(_E, _S));
  aimBone(lower, _v.subVectors(_T, _E));
}

export { BONES, REST };
