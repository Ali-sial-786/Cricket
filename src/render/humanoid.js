// Athletes: the Courtside athlete model (MakeHuman-derived, CC0; converted by
// tools/build_athlete.mjs into a compact two-LOD asset) on a 17-bone skeleton,
// one SkinnedMesh / draw call per person, with cricket gear (helmet, cap, hat,
// pads, gloves) merged into the same mesh, team kit + skin + hair colours as
// shader uniforms, and two-bone IK for hands and feet.
//
// Canonical pose used by all animation code: standing, arms hanging straight
// down, facing +Z, every bone's local rotation = identity, limbs along -Y.
// The model's bind pose is an A-pose; the skeleton's inverse bind matrices
// carry the difference, so animation never needs to know.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR',
};
const KIT1 = 1, KIT2 = 2, KIT3 = 3, KIT4 = 4, KSKIN = 5, KHAIR = 6;
export const BASE_SCALE = 0.93;            // the model is a stylised 2.0 m; bring it to ~1.87 m

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
    const nrm = new Float32Array(p.vCount * 3), col = new Float32Array(p.vCount * 3), kit = new Float32Array(p.vCount), w = new Float32Array(p.vCount * 4);
    const c = new THREE.Color();
    for (let v = 0; v < p.vCount; v++) {
      for (let k = 0; k < 3; k++) nrm[v * 3 + k] = nk[v * 4 + k] / 127;
      c.setRGB(cb[v * 4] / 255, cb[v * 4 + 1] / 255, cb[v * 4 + 2] / 255, THREE.SRGBColorSpace);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      kit[v] = nk[v * 4 + 3];
      // The polo's accent panels get their own slot (7): a subtle tone-on-tone
      // panel, so the gear's bright accents (slot 2) don't splash across the shirt.
      if (kit[v] === 2 && /accent/i.test(p.name)) kit[v] = 7;
      for (let k = 0; k < 4; k++) w[v * 4 + k] = wb[v * 4 + k] / 255;
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin.slice(p.pos, p.pos + p.vCount * 12)), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('kit', new THREE.BufferAttribute(kit, 1));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(new Uint8Array(bin, p.joints, p.vCount * 4)), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(bin.slice(p.idx, p.idx + p.iCount * 2)), 1));
    return { name: p.name, optional: p.optional, geo: g };
  }));
  return { bones: meta.bones, index: Object.fromEntries(meta.bones.map((b, i) => [b, i])), J, canon, bindQ, inverses, lods, headCentre: new THREE.Vector3(...meta.headCentre), geoCache: new Map() };
}

// ---- gear: rigid pieces authored in a bone's canonical local frame ----
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _t = new THREE.Vector3();
function gearPart(list, geom, bone, color, pos = [0, 0, 0], rot = null, scale = null) {
  let g = geom.index ? geom : geom;
  g = g.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  _q.identity(); if (rot) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _s.set(...(scale || [1, 1, 1]));
  g.applyMatrix4(_m.compose(_t.set(...pos), _q, _s));                       // into bone-local (canonical)
  g.applyMatrix4(_m.compose(RIG.J[bone], RIG.bindQ[bone], _s.set(1, 1, 1)));  // into bind space
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), kit = new Float32Array(n), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const c = new THREE.Color(color > 6 ? color : 0xffffff), slot = color <= 6 ? color : 0, bi = RIG.index[bone];
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; kit[i] = slot; si[i * 4] = bi; sw[i * 4] = 1; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('kit', new THREE.BufferAttribute(kit, 1));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  list.push(g);
}
const sphere = (r, w = 10, h = 7, ...a) => new THREE.SphereGeometry(r, w, h, ...a);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt, rb, h, rs = 10) => new THREE.CylinderGeometry(rt, rb, h, rs);

function buildGear(o) {
  const P = [];
  const hc = RIG.headCentre.clone().sub(RIG.J.head);     // head centre in head-bone space
  const hx = hc.x, hy = hc.y, hz = hc.z;
  if (o.headgear === 'helmet') {
    gearPart(P, sphere(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), 'head', KIT3, [hx, hy + 0.02, hz - 0.02], null, [0.225, 0.262, 0.262]);
    gearPart(P, box(0.36, 0.022, 0.13), 'head', KIT3, [hx, hy + 0.075, hz + 0.24], [0.22, 0, 0]);          // peak
    for (let i = 0; i < 4; i++) gearPart(P, box(0.33, 0.011, 0.011), 'head', 0xc3c9d1, [hx, hy - 0.15 + i * 0.05, hz + 0.275]);
    for (const sx of [-1, 1]) gearPart(P, box(0.011, 0.2, 0.011), 'head', 0xc3c9d1, [hx + sx * 0.165, hy - 0.07, hz + 0.275]);
    gearPart(P, box(0.011, 0.2, 0.011), 'head', 0xc3c9d1, [hx, hy - 0.07, hz + 0.277]);
    for (const sx of [-1, 1]) gearPart(P, box(0.03, 0.2, 0.2), 'head', KIT3, [hx + sx * 0.212, hy - 0.06, hz + 0.02]);   // ear guards
    gearPart(P, box(0.1, 0.05, 0.012), 'head', KIT2, [hx, hy + 0.13, hz + 0.228], [-0.35, 0, 0]);          // badge
  } else if (o.headgear === 'cap' || o.headgear === 'bare') {
    gearPart(P, sphere(1, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.47), 'head', KIT3, [hx, hy + 0.045, hz - 0.015], null, [0.212, 0.225, 0.25]);
    gearPart(P, cyl(0.15, 0.15, 0.016, 14), 'head', KIT3, [hx, hy + 0.09, hz + 0.23], [0.12, 0, 0], [1, 1, 0.85]);
    gearPart(P, sphere(0.02, 6, 4), 'head', KIT2, [hx, hy + 0.268, hz - 0.015]);
  } else if (o.headgear === 'hat') {
    gearPart(P, cyl(0.37, 0.37, 0.016, 18), 'head', 0xf2eedd, [hx, hy + 0.11, hz]);
    gearPart(P, cyl(0.2, 0.215, 0.13, 14), 'head', 0xf2eedd, [hx, hy + 0.175, hz]);
    gearPart(P, cyl(0.217, 0.217, 0.03, 14), 'head', KIT1, [hx, hy + 0.135, hz]);
  }
  if (o.gloves) {
    const keeper = o.keeper;
    for (const s of ['L', 'R']) {
      const sx = s === 'L' ? 1 : -1;                  // the outside of this hand (back of the glove)
      const hand = 'hand' + s;
      if (keeper) {
        // Keeping gloves: a big padded mitt with a webbed thumb and a long cuff.
        gearPart(P, sphere(1, 12, 9), hand, 0xf4f4f2, [0, -0.1, 0.012], null, [0.072, 0.118, 0.052]);
        gearPart(P, sphere(1, 10, 7), hand, KIT2, [sx * 0.034, -0.098, 0.012], null, [0.03, 0.1, 0.046]);     // coloured back
        for (const fy of [-0.13, -0.1, -0.07]) gearPart(P, cyl(0.009, 0.009, 0.1, 6), hand, 0xdcdcd8, [sx * 0.05, fy, 0.012], [Math.PI / 2, 0, 0]); // finger rolls
        gearPart(P, sphere(1, 8, 6), hand, 0xf4f4f2, [-sx * 0.012, -0.062, 0.06], [0.4, 0, 0], [0.024, 0.052, 0.024]);  // thumb
        gearPart(P, box(0.006, 0.05, 0.04), hand, KIT2, [-sx * 0.01, -0.07, 0.045]);                          // webbing
        gearPart(P, cyl(0.052, 0.06, 0.09, 10), hand, 0xf4f4f2, [0, -0.005, 0.01]);                            // cuff
        gearPart(P, cyl(0.061, 0.061, 0.02, 10), hand, KIT2, [0, 0.03, 0.01]);
      } else {
        // Batting gloves as a closed fist. In the hand's frame the wrist is at
        // the origin, the knuckles lie along -Y and a held handle runs along Z
        // through the palm at y = -GRIP. Four padded fingers curl right round
        // that line from the back of the hand (the +sx side) to the palm; the
        // thumb closes the other end; a slim cuff covers the wrist.
        const GRIP = 0.075, R = 0.031, WHITE = 0xf7f7f4, LEATHER = 0xdedbd2;
        for (const fz of [-0.0325, -0.0108, 0.0108, 0.0325]) {
          const f = new THREE.TorusGeometry(R, 0.0108, 7, 12, Math.PI * 1.38);
          f.rotateZ(sx > 0 ? -Math.PI * 1.2 : Math.PI * 0.82);          // from the knuckle, over the far side, back to the palm
          gearPart(P, f, hand, WHITE, [0, -GRIP, fz]);
          gearPart(P, sphere(0.0112, 7, 5), hand, WHITE, [-sx * R * 0.81, -GRIP + R * 0.59, fz]);     // fingertip
        }
        gearPart(P, sphere(1, 10, 8), hand, LEATHER, [0, -GRIP, 0], null, [R - 0.004, R - 0.004, 0.047]);   // the palm inside the fist
        gearPart(P, box(0.02, 0.066, 0.088), hand, WHITE, [sx * 0.03, -0.03, 0], [0, 0, sx * 0.1]);          // padded back of the hand
        for (const fz of [-0.022, 0, 0.022]) gearPart(P, box(0.004, 0.058, 0.004), hand, 0xcfd3d6, [sx * 0.0415, -0.03, fz], [0, 0, sx * 0.1]);   // seams
        gearPart(P, box(0.005, 0.014, 0.08), hand, KIT2, [sx * 0.0425, -0.012, 0], [0, 0, sx * 0.1]);          // team stripe
        gearPart(P, box(0.02, 0.05, 0.078), hand, LEATHER, [-sx * 0.024, -0.03, 0], [0, 0, -sx * 0.12]);       // heel of the palm
        gearPart(P, sphere(1, 8, 6), hand, WHITE, [-sx * 0.014, -GRIP + 0.016, 0.05], [0.5, 0, 0], [0.017, 0.02, 0.03]);   // thumb, along the handle
        gearPart(P, cyl(0.033, 0.036, 0.05, 10), hand, WHITE, [0, 0.0, 0]);                                    // cuff
        gearPart(P, cyl(0.0375, 0.0375, 0.014, 10), hand, KIT2, [0, 0.012, 0]);                                // strap
        gearPart(P, cyl(0.04, 0.037, 0.055, 8), 'elbow' + s, 0xf5f5f5, [0, -0.2, 0]);                          // forearm guard
      }
    }
  }
  if (o.pads) {
    const keeper = o.keeper;
    const H = keeper ? 0.36 : 0.43, yc = keeper ? -0.21 : -0.2;
    for (const s of ['L', 'R']) {
      const knee = 'knee' + s;
      // Vertical bolsters (three rounded canes) with grooves between them.
      for (const ox of [-0.058, 0, 0.058]) gearPart(P, cyl(0.032, 0.029, H, 8), knee, 0xf7f7f5, [ox, yc, 0.088]);
      for (const ox of [-0.029, 0.029]) gearPart(P, box(0.006, H * 0.95, 0.012), knee, 0xd9d9d5, [ox, yc, 0.118]);
      // Side wings wrapping round the leg.
      for (const sx of [-1, 1]) gearPart(P, box(0.018, H * 0.95, 0.085), knee, keeper ? KIT2 : 0xefefeb, [sx * 0.098, yc, 0.055], [0, sx * 0.4, 0]);
      // Knee roll and instep.
      const kr = keeper ? 0.062 : 0.074;
      gearPart(P, cyl(kr, kr, 0.2, 12), knee, 0xf7f7f5, [0, 0.035, 0.1], [0, 0, Math.PI / 2]);
      gearPart(P, cyl(kr * 0.55, kr * 0.55, 0.205, 10), knee, KIT2, [0, 0.035, 0.1], [0, 0, Math.PI / 2], [1, 1, 0.3]);
      gearPart(P, box(0.15, 0.05, 0.06), knee, 0xf0f0ec, [0, yc - H / 2 - 0.01, 0.105], [0.35, 0, 0]);
      // Thigh flap above the knee (batting pads only).
      if (!keeper) gearPart(P, box(0.19, 0.13, 0.05), knee, 0xf7f7f5, [0, 0.14, 0.095], [-0.12, 0, 0]);
      // Straps round the back of the leg.
      for (const oy of [yc + H * 0.28, yc - H * 0.25]) gearPart(P, box(0.18, 0.022, 0.02), knee, KIT2, [0, oy, -0.055]);
    }
  }
  return P;
}

function geometryFor(o, lod) {
  const key = `${lod}|${o.headgear}|${o.pads ? 1 : 0}|${o.gloves ? 1 : 0}|${o.keeper ? 1 : 0}`;
  let g = RIG.geoCache.get(key);
  if (!g) {
    const parts = RIG.lods[lod].filter((p) => !p.optional).map((p) => p.geo);
    g = mergeGeometries([...parts, ...buildGear(o)], false);
    RIG.geoCache.set(key, g);
  }
  return g;
}

// Shared kit shader: the `kit` vertex attribute picks a per-figure uniform.
function kitMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = {
    uKit1: { value: new THREE.Color(0x1f4fa8) }, uKit2: { value: new THREE.Color(0xf2c12e) }, uKit3: { value: new THREE.Color(0x14285a) },
    uKit4: { value: new THREE.Color(0x17336e) }, uSkin: { value: new THREE.Color(0xc68e62) }, uHair: { value: new THREE.Color(0x1d1510) },
    uPanel: { value: new THREE.Color(0x173f8c) },
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
      .replace('#include <common>', '#include <common>\nattribute float kit;\nuniform vec2 uHeadBones;\nuniform vec2 uLegBones;\nuniform vec2 uHandBones;\nuniform float uGloved;\nvarying float vHeadW;\nvarying float vLegW;\nuniform vec3 uKit1;\nuniform vec3 uKit2;\nuniform vec3 uKit3;\nuniform vec3 uKit4;\nuniform vec3 uSkin;\nuniform vec3 uHair;\nuniform vec3 uPanel;')
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef USE_COLOR
          if (kit > 6.5) vColor.rgb = uPanel; else if (kit > 5.5) vColor.rgb = uHair; else if (kit > 4.5) vColor.rgb = uSkin; else if (kit > 3.5) vColor.rgb = uKit4;
          else if (kit > 2.5) vColor.rgb = uKit3; else if (kit > 1.5) vColor.rgb = uKit2; else if (kit > 0.5) vColor.rgb = uKit1;
        #endif
        vHeadW = 0.0; vLegW = 0.0;
        #ifdef USE_SKINNING
          for (int i = 0; i < 4; i++) {
            float b = skinIndex[i];
            if (abs(b - uHeadBones.x) < 0.5 || abs(b - uHeadBones.y) < 0.5) vHeadW += skinWeight[i];
            if (b > uLegBones.x - 0.5 && b < uLegBones.y + 0.5) vLegW += skinWeight[i];
            // Skin on a gloved hand: fold it into the 'hidden' weight.
            if (uGloved > 0.5 && kit > 4.5 && kit < 5.5 && (abs(b - uHandBones.x) < 0.5 || abs(b - uHandBones.y) < 0.5)) vHeadW += 2.0 * skinWeight[i];
          }
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNoHead;\nuniform float uTrunkAlpha;\nvarying float vHeadW;\nvarying float vLegW;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= mix(uTrunkAlpha, 1.0, clamp(vLegW, 0.0, 1.0));')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if ((uNoHead > 0.5 && vHeadW > 0.35 && vHeadW < 1.5) || vHeadW > 1.5) discard;');
  };
  mat.customProgramCacheKey = () => 'cricket-kit-v6';
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
    // A touch less cartoon: a smaller head on athletic shoulders (gear scales with it).
    this.bones.head.scale.setScalar(0.88);
    this.ankleHeight = RIG.J.ankleL.y;            // sole to ankle joint (model units)
    this.armLength = RIG.J.shoulderL.distanceTo(RIG.J.elbowL) + RIG.J.elbowL.distanceTo(RIG.J.handL);
    u.uGloved.value = gloves ? 1 : 0;
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
