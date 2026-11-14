// Athletes: the Courtside athlete model (MakeHuman-derived, CC0; converted by
// tools/build_athlete.mjs into a two-LOD, life-size cricket figure: ~23k / ~2.8k
// triangles before gear) on a 17-bone skeleton, one SkinnedMesh / draw call per
// person, with cricket gear (gear.js: helmet, cap, hat, pads, gloves) merged
// into the same mesh, team kit + skin + hair colours and a back number as
// shader uniforms, baked ambient occlusion, and two-bone IK for hands and feet.
//
// Canonical pose used by all animation code: standing, arms hanging straight
// down, facing +Z, every bone's local rotation = identity, limbs along -Y.
// The model's bind pose is an A-pose; the skeleton's inverse bind matrices
// carry the difference, so animation never needs to know.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGear } from './gear.js';

const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR',
};
export const BASE_SCALE = 1.0;             // the model is a life-size 1.80 m athlete

export const SKIN_TONES = [0xf3cfae, 0xe0b088, 0xc68e62, 0x9a6a46, 0x6b4630];
export const HAIR = [0x1d1510, 0x3b2a1c, 0x5a4330, 0x0e0e0e, 0x8a6a40];
export const KITS = {     // kit1 shirt, kit2 accents, kit3 headgear, kit4 trousers, panel = shirt panels
  home: { kit1: 0x1f4fa8, kit2: 0xf2c12e, kit3: 0x14285a, kit4: 0x17336e, panel: 0x173f8c },     // royal blue / gold
  away: { kit1: 0xb3221c, kit2: 0xf4f4f4, kit3: 0x5e0f0c, kit4: 0x7a1712, panel: 0x931914 },     // crimson / white
  umpire: { kit1: 0xf4f1e6, kit2: 0x2a2d36, kit3: 0xf2eedd, kit4: 0x2b3040, panel: 0xe4e0d2 },   // white coat, dark trousers
};

let RIG = null;      // { bones[], joints{}, canon{}, bindQ{}, inverses[], lods[], headCentre }

// Load + prepare the athlete asset (call once before creating any Humanoid).
export async function loadAthlete(base = './assets/models/') {
  if (RIG) return RIG;
  const [meta, bin] = await Promise.all([
    fetch(base + 'athlete.json').then((r) => { if (!r.ok) throw new Error('athlete.json ' + r.status); return r.json(); }),
    fetch(base + 'athlete.bin').then((r) => { if (!r.ok) throw new Error('athlete.bin ' + r.status); return r.arrayBuffer(); }),
  ]);
  RIG = prepareRig(meta, bin);
  return RIG;
}

function prepareRig(meta, bin) {
  const J = {}; for (const [k, v] of Object.entries(meta.joints)) J[k] = new THREE.Vector3(...v);
  const down = new THREE.Vector3(0, -1, 0), d = new THREE.Vector3();
  const bindQ = {}, canon = {};
  for (const b of meta.bones) { bindQ[b] = new THREE.Quaternion(); canon[b] = J[b].clone(); }
  const limb = (a, b2, c) => {
    bindQ[a].setFromUnitVectors(down, d.subVectors(J[b2], J[a]).normalize());
    bindQ[b2].setFromUnitVectors(down, d.subVectors(J[c], J[b2]).normalize());
    canon[b2].copy(canon[a]).add(new THREE.Vector3(0, -J[a].distanceTo(J[b2]), 0));
    canon[c].copy(canon[b2]).add(new THREE.Vector3(0, -J[b2].distanceTo(J[c]), 0));
  };
  for (const s of ['L', 'R']) {
    limb('shoulder' + s, 'elbow' + s, 'hand' + s);
    bindQ['hand' + s].copy(bindQ['elbow' + s]);
    limb('hip' + s, 'knee' + s, 'ankle' + s);            // feet keep their bind (flat) orientation
  }
  const inverses = meta.bones.map((b) => new THREE.Matrix4().compose(J[b], bindQ[b], new THREE.Vector3(1, 1, 1)).invert());
  const lods = meta.lods.map((lod) => lod.parts.map((p) => {
    const g = new THREE.BufferGeometry();
    const nk = new Int8Array(bin, p.nrmKit, p.vCount * 4), cb = new Uint8Array(bin, p.col, p.vCount * 4), wb = new Uint8Array(bin, p.weights, p.vCount * 4);
    const nrm = new Float32Array(p.vCount * 3), col = new Float32Array(p.vCount * 3), kit = new Float32Array(p.vCount * 2), w = new Float32Array(p.vCount * 4);
    const c = new THREE.Color();
    for (let v = 0; v < p.vCount; v++) {
      for (let k = 0; k < 3; k++) nrm[v * 3 + k] = nk[v * 4 + k] / 127;
      c.setRGB(cb[v * 4] / 255, cb[v * 4 + 1] / 255, cb[v * 4 + 2] / 255, THREE.SRGBColorSpace);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      kit[v * 2] = nk[v * 4 + 3];               // kit slot
      kit[v * 2 + 1] = cb[v * 4 + 3] / 255;     // baked ambient occlusion
      for (let k = 0; k < 4; k++) w[v * 4 + k] = wb[v * 4 + k] / 255;
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin.slice(p.pos, p.pos + p.vCount * 12)), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('kit', new THREE.BufferAttribute(kit, 2));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(new Uint8Array(bin, p.joints, p.vCount * 4)), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(bin.slice(p.idx, p.idx + p.iCount * 2)), 1));
    return { name: p.name, optional: !!p.optional, geo: g };
  }));
  return { bones: meta.bones, index: Object.fromEntries(meta.bones.map((b, i) => [b, i])), J, canon, bindQ, inverses, lods, headCentre: new THREE.Vector3(...meta.headCentre), headSize: new THREE.Vector3(...(meta.headSize || [0.1, 0.14, 0.125])), skull: meta.skull, geoCache: new Map() };
}

// ---- gear: pieces authored in a bone's canonical local frame ----
// o.blend = { to, y0, y1 }: skin the part across two bones along the bone's
// local Y (y <= y0: all `bone`, y >= y1: all `to`), so e.g. a glove cuff
// bends with the wrist instead of sliding off the forearm.
// o.ao: a number or (x, y, z) => occlusion (local coordinates) for cheap
// baked shading (crevices, the inside of a pad).
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _t = new THREE.Vector3(), _lp = new THREE.Vector3();
function gearPart(list, geom, bone, color, pos = [0, 0, 0], rot = null, scale = null, o = null) {
  const g = geom.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  _q.identity(); if (rot) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _s.set(...(scale || [1, 1, 1]));
  g.applyMatrix4(_m.compose(_t.set(...pos), _q, _s));                       // into bone-local (canonical)
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count, lp = g.attributes.position.array.slice();
  g.applyMatrix4(_m.compose(RIG.J[bone], RIG.bindQ[bone], _s.set(1, 1, 1)));  // into bind space
  if (!g.index) g.setIndex([...Array(n).keys()]);
  const col = new Float32Array(n * 3), kit = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const c = new THREE.Color(color > 23 ? color : 0xffffff), slot = color <= 23 ? color : 0, bi = RIG.index[bone];
  const bl = o && o.blend, b2 = bl ? RIG.index[bl.to] : 0, aoF = o && o.ao;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    kit[i * 2] = slot;
    const x = lp[i * 3], y = lp[i * 3 + 1], z = lp[i * 3 + 2];
    kit[i * 2 + 1] = aoF == null ? 1 : typeof aoF === 'number' ? aoF : aoF(x, y, z);
    si[i * 4] = bi; sw[i * 4] = 1;
    if (bl) {
      const t = Math.min(1, Math.max(0, (y - bl.y0) / (bl.y1 - bl.y0))), u = t * t * (3 - 2 * t);
      sw[i * 4] = 1 - u; si[i * 4 + 1] = b2; sw[i * 4 + 1] = u;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('kit', new THREE.BufferAttribute(kit, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  list.push(g);
}
function geometryFor(o, lod) {
  const key = `${lod}|${o.headgear}|${o.pads ? 1 : 0}|${o.gloves ? 1 : 0}|${o.keeper ? 1 : 0}`;
  let g = RIG.geoCache.get(key);
  if (!g) {
    const parts = RIG.lods[lod].filter((p) => !p.optional).map((p) => p.geo);
    g = mergeGeometries([...parts, ...buildGear(RIG, gearPart, o, lod)], false);
    RIG.geoCache.set(key, g);
  }
  return g;
}

// Shared kit shader: the `kit` vertex attribute (slot, baked AO) picks a
// per-figure uniform colour. Lighting stays Lambert (cheap on Quest) with:
// baked ambient occlusion, a soft fresnel rim (cooler sheen on cloth, warm
// scatter on skin), skin a touch warmer in shadow, and a back number whose
// seven-segment digits are lit from a per-figure bit mask.
function kitMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = {
    uKit1: { value: new THREE.Color(0x1f4fa8) }, uKit2: { value: new THREE.Color(0xf2c12e) }, uKit3: { value: new THREE.Color(0x14285a) },
    uKit4: { value: new THREE.Color(0x17336e) }, uSkin: { value: new THREE.Color(0xc68e62) }, uHair: { value: new THREE.Color(0x1d1510) },
    uPanel: { value: new THREE.Color(0x173f8c) },
    uNumber: { value: 0 },         // lit back-number segments (bit i = segment i)
    uNoHead: { value: 0 },         // 1: the head and neck are not drawn (your own see-through body)
    uHeadBones: { value: new THREE.Vector2(RIG.index.neck, RIG.index.head) },
    uLegBones: { value: new THREE.Vector2(Math.min(RIG.index.hipL, RIG.index.hipR), Math.max(RIG.index.ankleL, RIG.index.ankleR)) },
    uHandBones: { value: new THREE.Vector2(RIG.index.handL, RIG.index.handR) },
    uGloved: { value: 0 },         // 1: bare hands are not drawn (they are inside gloves)
    uTrunkAlpha: { value: 1 },     // opacity of everything above the legs (x the material's opacity)
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 kit;
        uniform vec2 uHeadBones; uniform vec2 uLegBones; uniform vec2 uHandBones; uniform float uGloved; uniform int uNumber;
        uniform vec3 uKit1; uniform vec3 uKit2; uniform vec3 uKit3; uniform vec3 uKit4; uniform vec3 uSkin; uniform vec3 uHair; uniform vec3 uPanel;
        varying float vHeadW; varying float vLegW; varying vec2 vKA;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
          float k = kit.x;
          if (k > 9.5) { int seg = int(k - 10.0 + 0.5); vColor.rgb = ((uNumber >> seg) & 1) == 1 ? uKit2 : uKit1; }
          else if (k > 7.5) vColor.rgb = uSkin * vec3(0.78, 0.6, 0.58);
          else if (k > 6.5) vColor.rgb = uPanel; else if (k > 5.5) vColor.rgb = uHair; else if (k > 4.5) vColor.rgb = uSkin; else if (k > 3.5) vColor.rgb = uKit4;
          else if (k > 2.5) vColor.rgb = uKit3; else if (k > 1.5) vColor.rgb = uKit2; else if (k > 0.5) vColor.rgb = uKit1;
        #endif
        vKA = kit;
        vHeadW = 0.0; vLegW = 0.0;
        #ifdef USE_SKINNING
          for (int i = 0; i < 4; i++) {
            float b = skinIndex[i];
            if (abs(b - uHeadBones.x) < 0.5 || abs(b - uHeadBones.y) < 0.5) vHeadW += skinWeight[i];
            if (b > uLegBones.x - 0.5 && b < uLegBones.y + 0.5) vLegW += skinWeight[i];
            // Skin on a gloved hand: fold it into the 'hidden' weight.
            if (uGloved > 0.5 && kit.x > 4.5 && kit.x < 5.5 && (abs(b - uHandBones.x) < 0.5 || abs(b - uHandBones.y) < 0.5)) vHeadW += 2.0 * skinWeight[i];
          }
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNoHead;\nuniform float uTrunkAlpha;\nvarying float vHeadW;\nvarying float vLegW;\nvarying vec2 vKA;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= mix(uTrunkAlpha, 1.0, clamp(vLegW, 0.0, 1.0));')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if ((uNoHead > 0.5 && vHeadW > 0.35 && vHeadW < 1.5) || vHeadW > 1.5) discard;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float ao = clamp(vKA.y, 0.0, 1.0);
          float skin = step(4.5, vKA.x) * step(vKA.x, 5.5) + step(7.5, vKA.x) * step(vKA.x, 8.5);
          reflectedLight.indirectDiffuse *= ao * mix(vec3(0.96, 0.98, 1.03), vec3(1.07, 0.95, 0.88), skin);
          reflectedLight.directDiffuse *= mix(1.0, ao, 0.55);
          float fres = pow(1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0), 2.5);
          vec3 rim = mix(diffuseColor.rgb * 0.6 + vec3(0.04, 0.05, 0.06), diffuseColor.rgb * vec3(1.15, 0.75, 0.6) + vec3(0.05, 0.02, 0.0), skin);
          reflectedLight.indirectDiffuse += rim * fres * ao * 0.5;
        }`);
  };
  mat.customProgramCacheKey = () => 'cricket-kit-v7';
  mat.userData.uniforms = uniforms;
  return mat;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Vector3(),
  _T = new THREE.Vector3(), _dir = new THREE.Vector3(), _pv = new THREE.Vector3(), _end = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _eul = new THREE.Euler(), _bq = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Humanoid {
  constructor({ team = 'home', skin = null, hair = null, headgear = 'cap', pads = false, gloves = false, keeper = false, scale = 1, seed = 0 } = {}) {
    if (!RIG) throw new Error('loadAthlete() must finish before creating players');
    const rnd = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    this.opts = { headgear, pads, gloves, keeper };
    this.material = kitMaterial();
    const u = this.material.userData.uniforms;
    u.uSkin.value.setHex(skin ?? SKIN_TONES[Math.floor(rnd(1) * SKIN_TONES.length)]);
    u.uHair.value.setHex(hair ?? HAIR[Math.floor(rnd(2) * HAIR.length)]);
    const bones = [];
    this.bones = {};
    for (const name of RIG.bones) {
      const b = new THREE.Bone();
      b.name = name;
      const parent = PARENT[name];
      b.position.copy(RIG.canon[name]);
      if (parent) { b.position.sub(RIG.canon[parent]); this.bones[parent].add(b); }
      this.bones[name] = b;
      bones.push(b);
    }
    this.lod = 0;
    this.mesh = new THREE.SkinnedMesh(geometryFor(this.opts, 0), this.material);
    this.mesh.add(bones[0]);
    this.mesh.bind(new THREE.Skeleton(bones, RIG.inverses.map((m) => m.clone())), new THREE.Matrix4());
    // Generous fixed culling sphere (covers raised arms, dives and a bat).
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.1);
    this.mesh.frustumCulled = true;
    this.boneList = bones;
    this.root = new THREE.Group();
    this.root.add(this.mesh);
    this.baseScale = BASE_SCALE * scale;
    this.root.scale.setScalar(this.baseScale);
    this.hipsRest = this.bones.hips.position.clone();
    this.ankleHeight = RIG.J.ankleL.y;            // sole to ankle joint (model units)
    this.armLength = RIG.J.shoulderL.distanceTo(RIG.J.elbowL) + RIG.J.elbowL.distanceTo(RIG.J.handL);
    u.uGloved.value = gloves ? 1 : 0;
    this.setNumber(team === 'umpire' ? 0 : 1 + Math.floor(rnd(3) * 98));
    this.setTeam(team);
    // Contact shadow: a slot in the shared instanced shadow mesh.
    this.shadowSlot = ShadowPool.alloc();
    Humanoid.all.push(this);
  }

  // Pick the level of detail for every visible figure from the viewer's position.
  static updateLods(viewer, nearDist = 13) {
    for (const h of Humanoid.all) {
      if (!h.root.visible) continue;
      const p = h.root.position;
      const d = Math.hypot(p.x - viewer.x, p.z - viewer.z);
      h.setLod(d > nearDist * (h.lod === 0 ? 1.15 : 1) ? 1 : 0);
    }
  }

  // Shirt number on the back (0 = none).
  setNumber(n) {
    const D = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];   // abcdefg bits
    n = Math.max(0, Math.min(99, n | 0));
    this.number = n;
    this.material.userData.uniforms.uNumber.value = n === 0 ? 0 : (n >= 10 ? D[Math.floor(n / 10)] : 0) | (D[n % 10] << 7);
  }

  setTeam(team) {
    const k = KITS[team] || KITS.home;
    const u = this.material.userData.uniforms;
    u.uKit1.value.setHex(k.kit1); u.uKit2.value.setHex(k.kit2); u.uKit3.value.setHex(k.kit3); u.uKit4.value.setHex(k.kit4);
    u.uPanel.value.setHex(k.panel ?? k.kit1);
    this.team = team;
  }

  // 0 = full detail, 1 = distant.
  setLod(lod) {
    if (lod === this.lod) return;
    this.lod = lod;
    this.mesh.geometry = geometryFor(this.opts, lod);
  }

  // See-through body: what you see of yourself when you look down. No head
  // or neck; the trunk and arms are faint so that the legs and feet (drawn
  // more solidly) show through them.
  setGhost(on, legs = 0.34, trunk = 0.08) {
    if (!!this.ghost === on) return;
    this.ghost = on;
    const m = this.material, u = m.userData.uniforms;
    m.transparent = on; m.opacity = on ? legs : 1; m.depthWrite = !on; m.needsUpdate = true;
    u.uNoHead.value = on ? 1 : 0;
    u.uTrunkAlpha.value = on ? trunk : 1;
    this.mesh.renderOrder = on ? 3 : 0;
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
Humanoid.all = [];
