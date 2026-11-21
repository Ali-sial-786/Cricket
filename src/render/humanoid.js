// Athletes: the Courtside athlete model (MakeHuman-derived, CC0; converted by
// tools/build_athlete.mjs into a two-LOD, life-size cricket figure: ~23k / ~2.8k
// triangles before gear) on a 17-bone skeleton, one SkinnedMesh / draw call per
// person, with cricket gear (gear.js: helmet, cap, hat, pads, gloves, sunglasses)
// merged into the same mesh, the look (playerLook.js: team kit, skin, hair,
// face, name and number, per-player variation) as shader uniforms and two
// shared detail textures, baked ambient occlusion, and two-bone IK for hands and feet.
//
// Canonical pose used by all animation code: standing, arms hanging straight
// down, facing +Z, every bone's local rotation = identity, limbs along -Y.
// The model's bind pose is an A-pose; the skeleton's inverse bind matrices
// carry the difference, so animation never needs to know.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGear } from './gear.js';
import { TEAMS, SKIN_TONES, HAIR, lookFor, lookTextures, ATLAS, glyphOf } from './playerLook.js';

const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  shoulderL: 'chest', elbowL: 'shoulderL', handL: 'elbowL', shoulderR: 'chest', elbowR: 'shoulderR', handR: 'elbowR',
  hipL: 'hips', kneeL: 'hipL', ankleL: 'kneeL', hipR: 'hips', kneeR: 'hipR', ankleR: 'kneeR',
};
export const BASE_SCALE = 1.0;             // the model is a life-size 1.80 m athlete

// Kit colours, skin tones and hair live with the rest of the look (playerLook.js).
export { SKIN_TONES, HAIR };
export const KITS = TEAMS;

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
  adultFace(lods, meta);
  // The shoe soles: how far below the ankle joint the lowest sole vertex is
  // (the feet keep their bind orientation, so this holds in the canonical
  // pose too), and so how high the soles sit above the root in the canonical
  // standing pose (legs straight down). The mesh is lowered by that much so a
  // figure standing on y = 0 stands ON the turf, not 2-3 cm above it, and
  // ankleHeight (foot IK) is the real ankle-to-sole distance.
  const base = lods[0].filter((p) => !p.optional).map((p) => p.geo);
  let soleY = Infinity;
  const ia = meta.bones.indexOf('ankleL'), ib = meta.bones.indexOf('ankleR');
  for (const g of base) {
    const P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    for (let v = 0; v < P.count; v++) {
      let w = 0;
      for (let k = 0; k < 4; k++) { const b = SI.getComponent(v, k); if (b === ia || b === ib) w += SW.getComponent(v, k); }
      if (w > 0.5 && P.getY(v) < soleY) soleY = P.getY(v);
    }
  }
  const sole = J.ankleL.y - soleY;
  // ... and how far ahead of the ankle the toe of the sole reaches (the pivot when the heel comes up).
  let toe = 0;
  for (const g of base) {
    const P = g.attributes.position, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
    for (let v = 0; v < P.count; v++) {
      if (P.getY(v) > soleY + 0.02) continue;
      let w = 0;
      for (let k = 0; k < 4; k++) { const b = SI.getComponent(v, k); if (b === ia) w += SW.getComponent(v, k); }
      if (w > 0.5) toe = Math.max(toe, P.getZ(v) - J.ankleL.z);
    }
  }
  const floor = canon.ankleL.y - sole;
  const face = faceLandmarks(lods[0], meta);
  lods.forEach((L, i) => L.forEach((p) => refinePart(p, i)));
  return { sole, toe, floor, bones: meta.bones, index: Object.fromEntries(meta.bones.map((b, i) => [b, i])), J, canon, bindQ, inverses, lods, headCentre: new THREE.Vector3(...meta.headCentre), headSize: new THREE.Vector3(...(meta.headSize || [0.1, 0.14, 0.125])), skull: meta.skull, face, geoCache: new Map() };
}

// The source face is a friendly cartoon's: round cheeks, a short chin, huge
// irises. In bind space, before anything else reads the mesh: the cheeks and
// jaw slimmed, the chin longer and a touch forward, the irises smaller (the
// eye white shows round them), the neck a little thicker above the collar.
function adultFace(lods, meta) {
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const eyeY = meta.eyeY || 1.655, chinY = meta.chinY || 1.52, mouthY = 1.5805;
  const irisC = [0, 0];
  { const ir = lods[0].find((p) => p.name === 'Details_Iris'), P = ir ? ir.geo.attributes.position : null; let n = 0;
    if (P) for (let v = 0; v < P.count; v++) if (P.getX(v) > 0) { irisC[0] += P.getX(v); irisC[1] += P.getY(v); n++; }
    if (n) { irisC[0] /= n; irisC[1] /= n; } }
  for (const L of lods) for (const p of L) {
    const P = p.geo.attributes.position;
    if (p.name === 'Details_Iris' || p.name === 'Details_Pupil') {
      for (let v = 0; v < P.count; v++) {
        const sx = Math.sign(P.getX(v)), x = Math.abs(P.getX(v));
        P.setXY(v, sx * (irisC[0] + (x - irisC[0]) * 0.84), irisC[1] + (P.getY(v) - irisC[1]) * 0.84);
      }
      continue;
    }
    if (p.name !== 'Athlete_Body' && p.name !== 'Details_Mouth') continue;
    for (let v = 0; v < P.count; v++) {
      let x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      if (y < 1.44 || y > eyeY) continue;
      const front = ss(-0.01, 0.07, z), face = ss(eyeY - 0.004, eyeY - 0.035, y) * ss(1.495, 1.53, y);
      x *= 1 - 0.065 * face * front;
      const chin = ss(mouthY + 0.004, chinY - 0.004, y) * front * ss(1.485, 1.515, y);
      y -= 0.0075 * chin; z += 0.0035 * chin;
      // the mouth: the cartoon's is very wide
      const mw = Math.exp(-Math.pow((y - mouthY) / 0.013, 2)) * ss(0.065, 0.035, Math.abs(x)) * ss(0.1, 0.13, z);
      x *= 1 - 0.12 * mw;
      // neck: a little thicker between the collar and the jaw
      const neck = ss(1.455, 1.485, y) * ss(1.54, 1.51, y) * (1 - face);
      x *= 1 + 0.05 * neck;
      P.setXYZ(v, x, y, z);
    }
  }
}

// Where the face's features are on this model (bind space), for the painted face map.
function faceLandmarks(parts, meta) {
  const box = (name, f = null) => {
    const p = parts.find((q) => q.name === name);
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    if (!p) return null;
    const P = p.geo.attributes.position;
    for (let v = 0; v < P.count; v++) {
      const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      if (f && !f(x, y, z)) continue;
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z);
    }
    return b;
  };
  const iris = box('Details_Iris', (x) => x > 0) || [0.023, 1.643, 0.159, 0.045, 1.663, 0.161];
  const mouth = box('Details_Mouth') || [-0.038, 1.577, 0.153, 0.038, 1.584, 0.156];
  const brow = box('Details_Hair') || [0, 1.675, 0, 0.062, 1.685, 0];
  const eye = [(iris[0] + iris[3]) / 2, (iris[1] + iris[4]) / 2], my = (mouth[1] + mouth[4]) / 2;
  return {
    eye, irisR: (iris[4] - iris[1]) / 2, openR: (iris[4] - iris[1]) / 2 / 0.84, mouth: [mouth[3], my], brow: (brow[1] + brow[4]) / 2 + 0.001,
    nose: my + 0.42 * (eye[1] - my), chin: meta.chinY || 1.52, front: (iris[2] + iris[5]) / 2,
    rect: { x0: -0.1, y0: 1.49, w: 0.2, h: 0.3 },
  };
}

// Load-time touches to a model part:
//  * kit slots for the parts the build left at a fixed colour (eyes, boots),
//    so the shader can give them their own materials;
//  * the hair cap: each vertex's distance from its edge (into colour.r), for
//    a soft hairline and cropped cuts;
//  * the distant model: smooth normals recomputed from its own (simplified)
//    surface, welded across seams with a crease limit. The source normals it
//    kept no longer match its few large triangles (the faceted look at range).
const SLOT_OF = { Details_Sclera: 24, Details_Iris: 25, Details_Pupil: 26, Details_Mouth: 26, Details_Shoe: 33 };
function refinePart(p, lod) {
  const g = p.geo, K = g.attributes.kit, P = g.attributes.position, C = g.attributes.color;
  const s = SLOT_OF[p.name];
  if (s != null) for (let v = 0; v < K.count; v++) K.setX(v, s);
  if (p.name === 'Details_Shirt') for (let v = 0; v < K.count; v++) if (K.getX(v) === 0 && P.getY(v) < 0.5) K.setX(v, 33);   // the boots' tongues
  if (p.name === 'HairCap') hairEdge(g);
  if (p.name === 'Details_Hair') for (let v = 0; v < C.count; v++) C.setX(v, 1);
  // (the build kept vertices whose normals differ by a little split, so the skin showed creases: weld them)
  if (lod > 0) weldNormals(g, 0.5, true, 1);
  else if (p.name === 'Athlete_Body' || p.name === 'Details_Mouth') weldNormals(g, 0.5, false, 1);
}
const pkey = (P, v) => `${Math.round(P.getX(v) * 1e4)},${Math.round(P.getY(v) * 1e4)},${Math.round(P.getZ(v) * 1e4)}`;
function hairEdge(g) {
  const P = g.attributes.position, I = g.index.array, C = g.attributes.color;
  const id = new Map(), rep = [];
  for (let v = 0; v < P.count; v++) { const k = pkey(P, v); if (!id.has(k)) id.set(k, v); rep.push(id.get(k)); }
  const ec = new Map();
  for (let t = 0; t < I.length; t += 3) for (let j = 0; j < 3; j++) {
    const a = rep[I[t + j]], b = rep[I[t + (j + 1) % 3]], k = a < b ? a + '_' + b : b + '_' + a;
    ec.set(k, (ec.get(k) || 0) + 1);
  }
  const edge = new Set();
  for (const [k, n] of ec) if (n === 1) for (const v of k.split('_')) edge.add(+v);
  const E = [...edge];
  for (let v = 0; v < P.count; v++) {
    let d = Infinity;
    for (const e of E) d = Math.min(d, Math.hypot(P.getX(v) - P.getX(e), P.getY(v) - P.getY(e), P.getZ(v) - P.getZ(e)));
    C.setX(v, Math.min(1, (E.length ? d : 1) / 0.03));
  }
}
// recompute: from the part's own triangles (else the stored normals of the vertices
// at one place averaged: splits closed, the source's smoothness kept);
// smooth: passes of averaging with the neighbours (rounds a coarse surface).
function weldNormals(g, cosMin, recompute = true, smooth = 0) {
  const P = g.attributes.position, N = g.attributes.normal, I = g.index.array;
  const groups = new Map(), gid = new Int32Array(P.count);
  for (let v = 0; v < P.count; v++) { const k = pkey(P, v); if (!groups.has(k)) groups.set(k, groups.size); gid[v] = groups.get(k); }
  const G = groups.size, src = [];                // per welded vertex: candidate normals (area-weighted face normals, or stored normals)
  for (let i = 0; i < G; i++) src.push([]);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  if (recompute) {
    for (let t = 0; t < I.length; t += 3) {
      a.fromBufferAttribute(P, I[t]); b.fromBufferAttribute(P, I[t + 1]); c.fromBufferAttribute(P, I[t + 2]);
      const n = c.sub(b).cross(a.sub(b)).clone();
      if (n.lengthSq() < 1e-14) continue;
      for (let j = 0; j < 3; j++) src[gid[I[t + j]]].push(n);
    }
  } else for (let v = 0; v < P.count; v++) src[gid[v]].push(new THREE.Vector3().fromBufferAttribute(N, v).normalize());
  const out = new Float32Array(P.count * 3);
  const o = new THREE.Vector3(), s = new THREE.Vector3();
  for (let v = 0; v < P.count; v++) {
    o.fromBufferAttribute(N, v).normalize();
    s.set(0, 0, 0);
    for (const n of src[gid[v]]) { const l = n.length(); if (n.dot(o) > cosMin * l) s.add(n); }
    if (s.lengthSq() < 1e-14) s.copy(o);
    s.normalize(); out[v * 3] = s.x; out[v * 3 + 1] = s.y; out[v * 3 + 2] = s.z;
  }
  if (smooth) {
    const nb = [];                                  // vertex neighbours (by index, through the triangles)
    for (let v = 0; v < P.count; v++) nb.push([]);
    for (let t = 0; t < I.length; t += 3) for (let j = 0; j < 3; j++) { nb[I[t + j]].push(I[t + (j + 1) % 3], I[t + (j + 2) % 3]); }
    for (let it = 0; it < smooth; it++) {
      const prev = out.slice();
      for (let v = 0; v < P.count; v++) {
        let x = prev[v * 3] * 2, y = prev[v * 3 + 1] * 2, z = prev[v * 3 + 2] * 2;
        for (const w of nb[v]) { const d = prev[v * 3] * prev[w * 3] + prev[v * 3 + 1] * prev[w * 3 + 1] + prev[v * 3 + 2] * prev[w * 3 + 2]; if (d > cosMin) { x += prev[w * 3]; y += prev[w * 3 + 1]; z += prev[w * 3 + 2]; } }
        const l = Math.hypot(x, y, z) || 1; out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
      }
      // (vertices at one place keep one normal)
      const acc = new Float32Array(G * 3);
      for (let v = 0; v < P.count; v++) for (let k = 0; k < 3; k++) acc[gid[v] * 3 + k] += out[v * 3 + k];
      for (let v = 0; v < P.count; v++) {
        const q = gid[v] * 3, l = Math.hypot(acc[q], acc[q + 1], acc[q + 2]) || 1;
        const d = (acc[q] * out[v * 3] + acc[q + 1] * out[v * 3 + 1] + acc[q + 2] * out[v * 3 + 2]) / l;
        if (d > cosMin) for (let k = 0; k < 3; k++) out[v * 3 + k] = acc[q + k] / l;
      }
    }
  }
  N.array.set(out); N.needsUpdate = true;
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
  // (colour: a kit slot (< 64) or a fixed colour, whose material o.m picks: see kitMaterial)
  const c = new THREE.Color(color > 63 ? color : 0xffffff), slot = color <= 63 ? color : (o && o.m) || 0, bi = RIG.index[bone];
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
  const key = `${lod}|${o.headgear}|${o.pads ? 1 : 0}|${o.gloves ? 1 : 0}|${o.keeper ? 1 : 0}|${o.playerGrip ? 1 : 0}|${o.shades ? 1 : 0}`;
  let g = RIG.geoCache.get(key);
  if (!g) {
    const parts = RIG.lods[lod].filter((p) => !p.optional).map((p) => p.geo);
    g = mergeGeometries([...parts, ...buildGear(RIG, gearPart, o, lod)], false);
    RIG.geoCache.set(key, g);
  }
  return g;
}

// Per geometry and bone: the bind-space vertices the bone carries most of,
// reduced to their extremes along 124 directions (a hull), plus the
// largest distance of any from the bone's joint (r, model units). Humanoid.lowest()
// carries them with the bone, so gear (pads, gloves, helmet) counts too.
const HULLS = new WeakMap();
const DIRS = [];
for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) if (x || y || z) DIRS.push(new THREE.Vector3(x, y, z).normalize());
function hullFor(geo) {
  let H = HULLS.get(geo);
  if (H) return H;
  const P = geo.attributes.position, SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight;
  const best = RIG.bones.map(() => DIRS.map(() => ({ d: -Infinity, i: -1 })));
  const rad = RIG.bones.map(() => 0);
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    let b = -1, bw = 0;                           // (the bone with the most weight: every vertex counts)
    for (let k = 0; k < 4; k++) { const w = SW.getComponent(i, k); if (w > bw) { bw = w; b = SI.getComponent(i, k); } }
    if (b < 0) continue;
    v.fromBufferAttribute(P, i).sub(RIG.J[RIG.bones[b]]);
    rad[b] = Math.max(rad[b], v.length());
    const B = best[b];
    for (let k = 0; k < DIRS.length; k++) { const d = v.dot(DIRS[k]); if (d > B[k].d) { B[k].d = d; B[k].i = i; } }
  }
  H = best.map((B, b) => {
    const ids = [...new Set(B.filter((x) => x.i >= 0).map((x) => x.i))];
    if (!ids.length) return null;
    const p = new Float32Array(ids.length * 3), si = new Uint8Array(ids.length * 4), sw = new Float32Array(ids.length * 4);
    ids.forEach((i, k) => {
      p[k * 3] = P.getX(i); p[k * 3 + 1] = P.getY(i); p[k * 3 + 2] = P.getZ(i);
      for (let j = 0; j < 4; j++) { si[k * 4 + j] = SI.getComponent(i, j); sw[k * 4 + j] = SW.getComponent(i, j); }
    });
    return { p, si, sw, r: rad[b] + 0.12 };
  });
  HULLS.set(geo, H);
  return H;
}

// Shared kit shader. One program for every figure (a Lambert material whose
// lighting and colour are rewritten here), one draw call per figure.
//  * Colour: the `kit` attribute (slot, baked AO) picks a per-figure uniform
//    colour (shirt, trim, headgear, trousers, skin, hair, panel, iris) or keeps
//    the vertex colour (gear), and a per-slot material: cloth, skin, hair,
//    eyes, hard gloss (helmet shell, steel), padding / leather, lenses.
//  * Lighting (per pixel): wrapped diffuse, Blinn specular sized per material,
//    a red subsurface bleed at skin's terminator, cloth sheen and a readable
//    rim, a cheap sky / grass reflection on glossy things, baked AO.
//  * Detail without geometry: procedural fabric weave and wrinkle bumps
//    (faded out before they can alias), the painted face map (lids, lashes,
//    brows, nostrils, lips, stubble / beards, zinc), the crest, sponsor and
//    maker's mark on the chest, name and number lettered on the back, the
//    crest on caps and helmets, long sleeves / sweatbands painted on the arms,
//    a soft hairline. At most one texture fetch per fragment.
//  * Shape variation in the vertex shader: build (girth of cloth and arms),
//    hair standing off the scalp below the headgear.
// depth: the see-through body's depth pre-pass (setGhost), sharing `shared` (the figure's uniforms).
let SHARED = null;      // uniforms that are the same for every figure (textures, landmarks)
function sharedUniforms() {
  if (SHARED) return SHARED;
  const F = RIG.face, T = lookTextures(F), J = RIG.J, V4 = (x, y, z, w) => ({ value: new THREE.Vector4(x, y, z, w) });
  const arm = (s) => { const d = J['hand' + s].clone().sub(J['shoulder' + s]); return { value: new THREE.Vector4(d.x, d.y, d.z, d.length()) }; };
  const sk = RIG.skull || { c: [0, 1.675, 0.058], r: [0.095, 0.112, 0.122] };
  SHARED = {
    uFaceMap: { value: T.face }, uDecal: { value: T.decal },
    uFaceRect: V4(F.rect.x0, F.rect.y0, F.rect.w, F.rect.h),
    uFaceMisc: V4(0.055, F.nose, F.front, F.mouth[1]),            // z where the face starts, nose y, eye z, mouth y
    uEye: V4(F.eye[0], F.eye[1], F.openR, F.front),
    uKneeL: { value: J.kneeL.clone() }, uAnkleL: { value: J.ankleL.clone() }, uLegAxis: V4(0, 0, 0, J.kneeL.y),
    uShoulderL: { value: J.shoulderL.clone() }, uShoulderR: { value: J.shoulderR.clone() },
    uArmL: arm('L'), uArmR: arm('R'),
    uSkull: V4(sk.c[0], sk.c[1], sk.c[2], sk.r[1]),
    // decals: centre x, y and half sizes (bind metres)
    uCrestAt: V4(0.088, 1.352, 0.03, 0.03), uSponsorAt: V4(0, 1.252, 0.105, 0.028), uMakerAt: V4(-0.088, 1.367, 0.017, 0.0085),
    uNumberAt: V4(0, 1.262, 0.094, 0.07), uCapAt: V4(0, sk.c[1] + 0.062, 0.021, 0.021),
    uGlyph: { value: ATLAS.glyph.clone() }, uMakerUV: { value: ATLAS.maker.clone() },
  };
  return SHARED;
}
const KIT_GLSL_COMMON = /* glsl */`
  uniform vec3 uKit1; uniform vec3 uKit2; uniform vec3 uKit3; uniform vec3 uKit4; uniform vec3 uSkin; uniform vec3 uHair; uniform vec3 uPanel; uniform vec3 uIris;
  uniform vec4 uLook;       // build (m), hair volume (m), long sleeves, sweatband
  uniform vec4 uLook2;      // beard, stubble, hair cut, zinc
  uniform vec4 uArmL; uniform vec4 uArmR; uniform vec3 uShoulderL; uniform vec3 uShoulderR;
  uniform vec4 uSkull;
  varying vec3 vBind; varying float vArmW;
  flat varying float vSlot; flat varying vec4 vMat;
  // position along the arm (0 shoulder .. 1 wrist) of a bind-space point, and its distance off the arm's line
  vec2 armAt(vec3 p) {
    bool l = p.x > 0.0;
    vec3 d = p - (l ? uShoulderL : uShoulderR); vec4 a = l ? uArmL : uArmR;
    float t = dot(d, a.xyz) / (a.w * a.w);
    return vec2(t, length(d - a.xyz * t));
  }
`;
function kitMaterial(shared = null, depth = false) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  if (depth) mat.defines = { GHOST_DEPTH: 1 };
  const uniforms = shared || {
    ...sharedUniforms(),
    uKit1: { value: new THREE.Color(0x1f4fa8) }, uKit2: { value: new THREE.Color(0xf2c12e) }, uKit3: { value: new THREE.Color(0x14285a) },
    uKit4: { value: new THREE.Color(0x17336e) }, uSkin: { value: new THREE.Color(0xc68e62) }, uHair: { value: new THREE.Color(0x1d1510) },
    uPanel: { value: new THREE.Color(0x173f8c) }, uIris: { value: new THREE.Color(0x3b2414) },
    uLook: { value: new THREE.Vector4(0, 0, 0, 0) }, uLook2: { value: new THREE.Vector4(0, 0, 1, 0) },
    uCrestUV: { value: new THREE.Vector4() }, uSponsorUV: { value: new THREE.Vector4() },
    uTeamIx: { value: 0 },         // 0/1 the teams (sponsor, name, number), 2 officials (crest only)
    uNum: { value: new THREE.Vector2(-1, -1) },        // back number: glyphs of the tens and units (-1 none)
    uName: { value: new Array(12).fill(-1) }, uNameLen: { value: 0 },
    uLod: { value: 0 },
    uBrim: { value: new THREE.Vector3(0, 0, 0) },
    uNoHead: { value: 0 },         // 1: the head and neck are not drawn (your own see-through body)
    uHeadBones: { value: new THREE.Vector2(RIG.index.neck, RIG.index.head) },
    uLegBones: { value: new THREE.Vector2(Math.min(RIG.index.hipL, RIG.index.hipR), Math.max(RIG.index.ankleL, RIG.index.ankleR)) },
    uHandBones: { value: new THREE.Vector2(RIG.index.handL, RIG.index.handR) },
    uTrunkBones: { value: new THREE.Vector4(RIG.index.spine, RIG.index.chest, RIG.index.shoulderL, RIG.index.shoulderR) },
    uArmBones: { value: new THREE.Vector2(RIG.index.elbowL, RIG.index.elbowR) },
    uGloved: { value: 0 },         // 1: bare hands are not drawn (they are inside gloves)
    uTrunkAlpha: { value: 1 },     // opacity of everything above the legs (x the material's opacity)
    // See-through body (setGhost): opacity of trunk+arms, thighs, shins (pads), feet (boots), and of the outline.
    uGhost: { value: new THREE.Vector4(0, 0, 0, 0) },
    uGhostEdge: { value: 0 },
    uGhostHands: { value: 0 },     // the gloves (on your bat's handle)
    uLegIdx: { value: new THREE.Vector3(RIG.index.hipL, RIG.index.kneeL, RIG.index.ankleL) },
    uLegIdxR: { value: new THREE.Vector3(RIG.index.hipR, RIG.index.kneeR, RIG.index.ankleR) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 kit;
        uniform vec2 uHeadBones; uniform vec2 uLegBones; uniform vec2 uHandBones; uniform float uGloved;
        uniform vec4 uTrunkBones; uniform vec2 uArmBones;
        uniform vec3 uLegIdx; uniform vec3 uLegIdxR;
        varying float vHeadW; varying float vLegW; varying vec3 vSeg; varying float vHandW; varying vec2 vKA; varying float vHairE;
        ${KIT_GLSL_COMMON}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        float k = kit.x;
        float trunkW = 0.0, upperW = 0.0, foreW = 0.0;
        vKA = kit;
        vHeadW = 0.0; vLegW = 0.0; vSeg = vec3(0.0); vHandW = 0.0;
        #ifdef USE_SKINNING
          for (int i = 0; i < 4; i++) {
            float b = skinIndex[i], w = skinWeight[i];
            vec3 m = step(abs(vec3(b) - uLegIdx), vec3(0.5)) + step(abs(vec3(b) - uLegIdxR), vec3(0.5));
            vSeg += m * w;
            if (abs(b - uHandBones.x) < 0.5 || abs(b - uHandBones.y) < 0.5) vHandW += w;
            if (abs(b - uHeadBones.x) < 0.5 || abs(b - uHeadBones.y) < 0.5) vHeadW += w;
            if (b > uLegBones.x - 0.5 && b < uLegBones.y + 0.5) vLegW += w;
            if (abs(b - uTrunkBones.x) < 0.5 || abs(b - uTrunkBones.y) < 0.5) trunkW += w;
            if (abs(b - uTrunkBones.z) < 0.5 || abs(b - uTrunkBones.w) < 0.5) upperW += w;
            if (abs(b - uArmBones.x) < 0.5 || abs(b - uArmBones.y) < 0.5) foreW += w;
            // Skin on a gloved hand: fold it into the 'hidden' weight.
            if (uGloved > 0.5 && kit.x > 4.5 && kit.x < 5.5 && (abs(b - uHandBones.x) < 0.5 || abs(b - uHandBones.y) < 0.5)) vHeadW += 2.0 * skinWeight[i];
          }
        #endif
        vArmW = upperW + foreW;
        vBind = position;
        vHairE = color.r;
        // colour and material per slot. vMat: wrap, specular, shininess, kind
        // (kind 0 cloth, 1 skin, 2 hard gloss, 3 hair, 4 eye, 5 padding / leather, 6 lens)
        vec3 kc = vec3(1.0);
        #ifdef USE_COLOR
          kc = vColor.rgb;
        #endif
        vec4 mt = vec4(0.25, 0.035, 10.0, 0.0);
        float push = 0.0;
        if (k < 0.5) mt = vec4(0.2, 0.06, 16.0, 5.0);
        else if (k < 1.5 || (k > 9.5 && k < 23.5)) { kc = uKit1; push = uLook.x * (trunkW + 0.6 * upperW); }
        else if (k < 2.5) { kc = uKit2; push = uLook.x * trunkW; }
        else if (k < 3.5) kc = uKit3;
        else if (k < 4.5) { kc = uKit4; push = uLook.x * 0.45 * vSeg.x; }
        else if (k < 5.5) {
          kc = uSkin; mt = vec4(0.5, 0.13, 14.0, 1.0);
          vec2 at = armAt(position);
          float arm = step(0.5, vArmW) * step(at.x, 0.97);
          push = uLook.x * 0.5 * upperW + arm * (uLook.z * 0.0035 * step(0.1, at.x) + uLook.w * 0.003 * step(0.82, at.x) * step(at.x, 0.95));
        }
        else if (k < 6.5) {
          kc = uHair; mt = vec4(0.3, 0.16, 34.0, 3.0);
          // hair standing off the scalp, only where the headgear does not cover it (below its rim)
          vec3 q = position - uSkull.xyz;
          float rimY = uSkull.y + 0.012 - 0.09 * (1.0 - normalize(q.xz + vec2(0.0, 1e-4)).y) * 0.5;
          push = uLook.y * smoothstep(0.0, 0.6, color.r) * smoothstep(rimY, rimY - 0.025, position.y);
        }
        else if (k < 7.5) { kc = uPanel; push = uLook.x * (trunkW + 0.6 * upperW); }
        else if (k < 8.5) { kc = uSkin * vec3(0.8, 0.62, 0.6); mt = vec4(0.45, 0.32, 30.0, 1.0); }
        else if (k > 23.5 && k < 24.5) mt = vec4(0.3, 0.7, 90.0, 4.0);
        else if (k < 25.5) { kc = uIris; mt = vec4(0.3, 0.7, 90.0, 4.0); }
        else if (k < 26.5) mt = vec4(0.2, 0.5, 60.0, 4.0);
        else if (k > 29.5 && k < 30.5) mt = vec4(0.0, 0.6, 70.0, 2.0);
        else if (k < 31.5) mt = vec4(0.3, 0.07, 14.0, 5.0);
        else if (k < 32.5) mt = vec4(0.0, 1.4, 140.0, 6.0);
        else if (k < 33.5) mt = vec4(0.15, 0.3, 36.0, 5.0);
        else if (k < 34.5) { kc = uKit3; mt = vec4(0.1, 0.2, 60.0, 2.0); }
        else if (k < 35.5) { kc = uKit2; mt = vec4(0.1, 0.25, 45.0, 2.0); }
        else if (k < 36.5) { kc = mix(vec3(0.9), uKit1, 0.6); mt = vec4(0.3, 0.07, 14.0, 5.0); }
        #ifdef USE_COLOR
          vColor.rgb = kc;
        #endif
        vSlot = k; vMat = mt;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n        transformed += objectNormal * push;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNoHead; uniform float uTrunkAlpha; uniform vec4 uGhost; uniform float uGhostEdge; uniform float uGhostHands;
        varying float vHeadW; varying float vLegW; varying vec3 vSeg; varying float vHandW; varying vec2 vKA; varying float vHairE;
        uniform sampler2D uFaceMap; uniform sampler2D uDecal;
        uniform vec4 uFaceRect; uniform vec4 uFaceMisc; uniform vec4 uEye; uniform vec3 uKneeL; uniform vec3 uAnkleL; uniform vec4 uLegAxis;
        uniform vec4 uCrestAt; uniform vec4 uSponsorAt; uniform vec4 uMakerAt; uniform vec4 uNumberAt; uniform vec4 uCapAt;
        uniform vec4 uCrestUV; uniform vec4 uSponsorUV; uniform vec4 uMakerUV; uniform vec4 uGlyph;
        uniform float uTeamIx; uniform vec2 uNum; uniform float uName[12]; uniform float uNameLen; uniform float uLod;
        ${KIT_GLSL_COMMON}
        float gWrap = 0.25, gSpec = 0.04, gShin = 10.0, gKind = 0.0, gSSS = 0.0, gShade = 0.0;
        uniform vec3 uBrim;              // the shade of a cap's peak / hat's brim: edge y, how far below it falls, all round (1) or front only (0)
        vec3 gBX, gBY;                     // screen derivatives of the bind position
        // a decal: r = centre, half size (bind metres), uvr = its atlas rect; flip: mirrored (read from behind)
        vec4 decalAt(vec2 p, vec4 r, vec4 uvr, float flip) {
          vec2 q = (p - r.xy) / (2.0 * r.zw) + 0.5;
          if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 || uvr.z <= 0.0) return vec4(0.0);
          q.x = mix(q.x, 1.0 - q.x, flip);
          vec2 s = uvr.zw / (2.0 * r.zw);
          return textureGrad(uDecal, uvr.xy + q * uvr.zw, gBX.xy * s, gBY.xy * s);
        }
        // one lettering glyph (index g) at local q (0..1); cell scale s (uv per metre)
        vec4 glyphAt(float g, vec2 q, vec2 s) {
          if (g < -0.5) return vec4(0.0);
          vec2 cell = vec2(mod(g, uGlyph.z), floor(g / uGlyph.z));
          vec2 uv = vec2((cell.x + clamp(q.x, 0.02, 0.98)) * uGlyph.x, 1.0 - (cell.y + 1.0 - clamp(q.y, 0.02, 0.98)) * uGlyph.y);
          return textureGrad(uDecal, uv, gBX.xy * s, gBY.xy * s);
        }
        vec3 lettering(vec3 base, vec4 t, vec3 fillC, vec3 lineC) {
          return mix(base, mix(lineC, fillC, clamp(t.r / max(t.g, 1e-3), 0.0, 1.0)), clamp(t.g, 0.0, 1.0));
        }`)
      .replace('#include <lights_lambert_pars_fragment>', `
        varying vec3 vViewPosition;
        struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
        void RE_Direct_Kit( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
          float nl = dot( geometryNormal, directLight.direction );
          float w = gWrap;
          float lit = 1.0 - gShade;
          vec3 irr = directLight.color * max( 0.0, ( nl + w ) / ( ( 1.0 + w ) * ( 1.0 + w ) ) );
          // skin: light scattered under the surface reddens the terminator
          irr += directLight.color * gSSS * vec3( 0.2, 0.06, 0.025 ) * max( 0.0, 1.0 - abs( nl * 2.2 - 0.25 ) );
          reflectedLight.directDiffuse += irr * lit * BRDF_Lambert( material.diffuseColor );
          vec3 H = normalize( directLight.direction + geometryViewDir );
          float nh = max( dot( geometryNormal, H ), 0.0 );
          float sp = gSpec * pow( nh, gShin ) * ( gShin + 8.0 ) * 0.04 * smoothstep( -0.05, 0.25, nl );
          reflectedLight.directSpecular += directLight.color * sp * lit;
        }
        void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
          reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
        }
        #define RE_Direct RE_Direct_Kit
        #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.a *= mix(uTrunkAlpha, 1.0, clamp(vLegW, 0.0, 1.0));
  if (uGhost.w > 0.0) {
    vec3 sg = clamp(vSeg, 0.0, 1.0);
    float hw = clamp(vHandW, 0.0, 1.0);
    // (the gloves fade out close to your eyes: a bat brought up to your face is not hidden behind them)
    float near = smoothstep(0.14, 0.32, length(vViewPosition));
    diffuseColor.a = uGhost.x * clamp(1.0 - sg.x - sg.y - sg.z - hw, 0.0, 1.0) + uGhost.y * sg.x + uGhost.z * sg.y + uGhost.w * sg.z + uGhostHands * hw * near;
    #ifdef GHOST_DEPTH
      // (only the pads, boots and gloves: the faint trunk, arms and thighs never hide what is behind them)
      if (sg.y + sg.z + hw < 0.5 || diffuseColor.a < 0.2) discard;
    #endif
  }
  float kitH = 0.0;                           // procedural bump height (m)
  gBX = dFdx(vBind); gBY = dFdy(vBind);
  gWrap = vMat.x; gSpec = vMat.y; gShin = vMat.z; gKind = vMat.w;
  if (vHeadW > 0.5 && uBrim.y > 0.0 && (gKind > 0.5 && gKind < 1.5 || gKind > 3.5 || gKind > 2.5 && gKind < 3.5 && vBind.y < uBrim.x)) {
    // the peak / brim shades the face (the sun is high): eyes and brow in shadow, as on any sunny day
    float front = mix(smoothstep(uSkull.z - 0.01, uSkull.z + 0.05, vBind.z), 1.0, uBrim.z);
    float edge = uBrim.x - uBrim.y;
    gShade = 0.82 * smoothstep(edge - 0.012, edge + 0.012, vBind.y) * front * step(vBind.y, uBrim.x + 0.01);
  }
  #ifndef GHOST_DEPTH
  {
    float s = vSlot;
    vec3 c = diffuseColor.rgb;
    float fw = max(length(gBX), length(gBY));          // metres per pixel here
    bool shirt = s > 0.5 && s < 1.5 || s > 6.5 && s < 7.5 || s > 9.5 && s < 23.5;
    bool skin = s > 4.5 && s < 5.5 || s > 7.5 && s < 8.5;
    if (gKind < 0.5) {
      // ---- cloth: weave and wrinkles (heights in metres), faded out before they alias
      float wv = 1.0 - smoothstep(0.00035, 0.0007, fw);       // (the weave's period is ~2.5 mm: only very close)
      vec2 cp = vec2(vBind.x + vBind.z, vBind.y);
      if (s > 3.5 && s < 4.5) {
        // trousers: a twill and folds at the knee, the hem's break and the crotch
        kitH += wv * 0.00005 * sin((cp.x + cp.y) * 2400.0);
        float ax = abs(vBind.x);
        float wob = sin(vBind.x * 53.0 + vBind.z * 41.0) * 1.6 + sin(vBind.x * 23.0 - vBind.z * 67.0);
        kitH += 0.0011 * sin(vBind.y * 150.0 + wob) * exp(-pow((vBind.y - 0.5) / 0.055, 2.0));
        kitH += 0.0012 * sin(vBind.y * 190.0 + wob * 1.3) * exp(-pow((vBind.y - 0.17) / 0.045, 2.0));
        kitH += 0.0009 * sin(vBind.y * 110.0 - ax * 140.0 + wob * 0.5) * exp(-pow((vBind.y - 0.8) / 0.06, 2.0)) * smoothstep(0.02, 0.07, ax);
        // pocket seam and its shadow
        float pk = abs(abs(vBind.x) - (0.135 - (vBind.y - 0.98) * 0.35));
        c *= 1.0 - 0.35 * smoothstep(0.0025, 0.0, pk) * step(0.92, vBind.y) * step(vBind.y, 1.04) * step(0.02, vBind.z) * (1.0 - smoothstep(0.0, 0.004, fw * 0.6));
      } else if (shirt || s > 1.5 && s < 2.5) {
        // shirt: a pique knit; folds from the armpits, round the waist and in the sleeves
        kitH += wv * 0.00007 * sin(cp.x * 2600.0) * sin(cp.y * 2600.0);
        vec2 ap = vec2(abs(vBind.x) - 0.17, vBind.y - 1.3);
        float an = atan(ap.y, ap.x);
        kitH += 0.0011 * sin(an * 9.0) * exp(-dot(ap, ap) / 0.004) * step(0.0, -ap.x + 0.04) * smoothstep(0.012, 0.04, length(ap));
        kitH += 0.0013 * sin(vBind.y * 150.0 + vBind.x * 25.0) * exp(-pow((vBind.y - 1.12) / 0.045, 2.0));
        kitH += 0.0009 * sin(vBind.y * 210.0 - abs(vBind.x) * 90.0) * smoothstep(0.2, 0.26, abs(vBind.x));
        if (s > 6.5 && s < 7.5) {
          // the yoke panel: sublimated pinstripes
          float st = abs(fract((abs(vBind.x) * 0.7 + vBind.y) * 90.0) - 0.5);
          c = mix(c, c * 0.84, smoothstep(0.36, 0.44, st) * (1.0 - smoothstep(0.0008, 0.0016, fw)));
        }
        if (shirt && vBind.y > 1.15 && vBind.y < 1.45) {
          float side = abs(vBind.x);
          if (vBind.z > 0.06) {
            // front: crest (wearer's left), maker's mark (right), sponsor across the chest
            vec4 t = decalAt(vBind.xy, uCrestAt, uCrestUV, 0.0);
            t += decalAt(vBind.xy, uMakerAt, uMakerUV, 0.0) * vec4(uKit2, 1.0) * step(uTeamIx, 1.5);
            if (uTeamIx < 1.5) { vec4 sp = decalAt(vBind.xy, uSponsorAt, uSponsorUV, 0.0); t = sp.a > t.a ? sp : t; }
            c = mix(c, t.rgb, t.a);
            // placket buttons
            float bt = length(vec2(vBind.x, mod(vBind.y - 1.405, 0.025) - 0.0125));
            c *= 1.0 - 0.25 * smoothstep(0.0032, 0.0022, bt) * step(1.40, vBind.y) * step(vBind.y, 1.452) * step(side, 0.006);
          } else if (vBind.z < -0.03 && uTeamIx < 1.5) {
            // back: name over the number, printed in trim with a dark outline
            vec4 r = uNumberAt; float nd = uNum.x < -0.5 ? 1.0 : 2.0;
            r.z *= nd * 0.5;
            vec2 q = (vBind.xy - r.xy) / (2.0 * r.zw) + 0.5;
            vec4 t = vec4(0.0);
            if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
              q.x = 1.0 - q.x;
              float cx = q.x * nd, ci = floor(cx);
              t = glyphAt(nd > 1.5 && ci < 0.5 ? uNum.x : uNum.y, vec2(fract(cx), q.y), vec2(uGlyph.x * nd / (2.0 * r.z), uGlyph.y / (2.0 * r.w)));
            }
            vec4 nr = vec4(0.0, 1.398, uNameLen * 0.0118, 0.019);
            q = (vBind.xy - nr.xy) / (2.0 * nr.zw) + 0.5;
            if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
              q.x = 1.0 - q.x;
              float cx = q.x * uNameLen; int ci = int(min(floor(cx), 11.0));
              t = glyphAt(uName[ci], vec2(fract(cx), q.y), vec2(uGlyph.x * uNameLen / (2.0 * nr.z), uGlyph.y / (2.0 * nr.w)));
            }
            c = lettering(c, t, uKit2, uKit3 * 0.6);
          }
        }
      } else if (s > 2.5 && s < 3.5) {
        kitH += wv * 0.00006 * sin(cp.x * 2200.0) * sin(cp.y * 2200.0);
      }
      // headgear crest (cap, hat band)
      if ((s > 1.5 && s < 3.5) && vHeadW > 0.5 && vBind.z > 0.1) { vec4 t = decalAt(vBind.xy, uCapAt, uCrestUV, 0.0); c = mix(c, t.rgb, t.a); }
      c *= 1.0 + 18.0 * kitH;                  // folds: a little darker in their hollows
    } else if (skin) {
      gSSS = 1.0;
      // ---- arms: long sleeves (the shirt's colour, a cuff) or a sweatband
      vec2 at = armAt(vBind);
      if (vArmW > 0.5 && at.x < 0.97) {
        float sl = uLook.z * step(0.08, at.x) * step(at.x, 0.935);
        float band = (1.0 - uLook.z) * uLook.w * step(0.82, at.x) * step(at.x, 0.95);
        if (sl > 0.5) {
          c = at.x > 0.875 ? uKit2 : uKit1; gWrap = 0.25; gSpec = 0.035; gShin = 10.0; gSSS = 0.0;
          kitH += 0.0012 * sin(at.x * 70.0 + vBind.y * 30.0) * smoothstep(0.35, 0.5, at.x) * smoothstep(0.85, 0.7, at.x);
        }
        if (band > 0.5) { c = uKit2; gWrap = 0.3; gSpec = 0.02; gShin = 6.0; gSSS = 0.0; kitH += 0.00008 * sin(at.x * 900.0) * (1.0 - smoothstep(0.001, 0.002, fw)); }
      }
      // ---- hair below the cap's edge at the back and in front of the ears (the hair cap stops high)
      if (vHeadW > 0.5) {
        vec3 q = vBind - uSkull.xyz;
        float side = abs(q.x);
        float back = smoothstep(0.02, -0.02, q.z) * smoothstep(0.088, 0.078, side);
        float burn = smoothstep(0.072, 0.08, side) * smoothstep(0.075, 0.06, q.z) * smoothstep(0.035, 0.045, q.z) * smoothstep(-0.05, -0.035, q.y);
        float y0 = uSkull.y - 0.078 + 0.022 * smoothstep(0.02, 0.07, side) - 0.002 * sin(q.x * 220.0);
        float hairA = max(back * smoothstep(y0, y0 + 0.016, vBind.y), burn * 0.85) * (0.4 + 0.55 * uLook2.z);
        if (hairA > 0.0) {
          float st = 0.85 + 0.15 * sin(atan(q.x, q.z) * 260.0) * (1.0 - smoothstep(0.0006, 0.0013, fw));
          c = mix(c, uHair * st, hairA); gSSS *= 1.0 - hairA; gSpec = mix(gSpec, 0.08, hairA);
        }
      }
      // ---- the face: painted map projected from the front of the head
      if (vBind.y > uFaceRect.y && vBind.z > uFaceMisc.x && vHeadW > 0.3) {
        vec2 fu = (vBind.xy - uFaceRect.xy) / uFaceRect.zw;
        vec4 f = textureGrad(uFaceMap, fu, gBX.xy / uFaceRect.zw, gBY.xy / uFaceRect.zw);
        float m = 0.35 + 1.3 * f.r;
        c *= m;
        float liner = clamp(1.0 - 2.0 * f.b, 0.0, 1.0), white = clamp(2.0 * f.b - 1.0, 0.0, 1.0) * step(0.5, uLod);
        float lip = f.a * step(4.5, s);
        c = mix(c, c * vec3(0.78, 0.6, 0.62) + vec3(0.012, 0.0, 0.0), lip * (1.0 - step(7.5, s)));
        gSpec += lip * 0.15; gShin = mix(gShin, 34.0, lip);
        // beard: stubble shadow, then hair where the beard reaches
        float bf = f.g;
        float stub = uLook2.y * smoothstep(0.15, 0.55, bf);
        c = mix(c, c * 0.72 + uHair * 0.06, stub * 0.6);
        float beard = smoothstep(1.0 - uLook2.x, 1.0 - uLook2.x + 0.22, bf) * step(0.01, uLook2.x);
        float strands = 0.8 + 0.2 * sin(vBind.x * 1900.0 + sin(vBind.y * 700.0) * 3.0) * (1.0 - smoothstep(0.0008, 0.0016, fw));
        c = mix(c, mix(uHair, c * 0.45, 0.3) * strands, beard * 0.92);
        gSSS *= 1.0 - beard; gSpec = mix(gSpec, 0.1, beard); gShin = mix(gShin, 12.0, beard);
        kitH += beard * 0.00012 * sin(vBind.x * 1500.0 + vBind.y * 900.0) * (1.0 - smoothstep(0.0008, 0.0016, fw));
        c = mix(c, uHair * 0.35, liner * 0.92);
        c = mix(c, vec3(0.78, 0.76, 0.72), white);
        // forehead, nose and cheekbones are a little shinier
        gSpec *= 1.0 + 0.6 * smoothstep(0.03, 0.0, abs(vBind.y - uFaceMisc.y - 0.035)) * smoothstep(0.035, 0.0, abs(vBind.x));
        // zinc cream on the nose
        float zn = length((vBind.xy - vec2(0.0, uFaceMisc.y + 0.008)) / vec2(0.017, 0.03));
        float zc = uLook2.w * smoothstep(1.0, 0.85, zn) * step(uFaceMisc.z - 0.01, vBind.z);
        c = mix(c, vec3(0.86, 0.87, 0.88), zc); gSSS *= 1.0 - zc; gSpec = mix(gSpec, 0.05, zc);
      }
    } else if (gKind > 2.5 && gKind < 3.5) {
      // ---- hair: a soft hairline (cropped cuts thin out toward the edge), strands
      float cover = smoothstep(0.0, 0.4 - 0.25 * uLook2.z, vHairE);
      vec2 hq = vBind.xz - uSkull.xz;
      float an = atan(hq.x, hq.y);
      float strands = sin(an * 260.0 + sin(vBind.y * 120.0) * 3.0) * (1.0 - smoothstep(0.0006, 0.0013, fw));
      bool brow = vBind.z > uEye.w - 0.01;            // (the brows, not the scalp)
      if (brow) { c = mix(c, uSkin * 0.5, 0.3); gSpec = 0.03; }
      else {
        c = mix(uSkin * 0.82, c * (0.85 + 0.15 * strands), cover * (0.55 + 0.45 * uLook2.z));
        kitH += 0.00008 * strands * uLook2.z;
        gSpec *= cover * uLook2.z;
      }
    } else if (gKind > 3.5 && gKind < 4.5) {
      // ---- eyes: lids painted over the top and bottom of the eyeball (the source's
      // wide-open stare), a lash line on the upper lid, the white shaded under it
      vec2 e = vec2(abs(vBind.x) - uEye.x, vBind.y - uEye.y);
      float r = uEye.z, u = clamp(e.x / (r * 1.75), -1.0, 1.0);
      float up = r * (0.5 - 0.34 * u * u) + 0.14 * r * u, lo = -r * (0.68 - 0.36 * u * u) + 0.1 * r * u;
      float px = max(fw, 0.0003);
      c *= vec3(0.94, 0.91, 0.87) * mix(1.0, 0.62, smoothstep(up - 0.0045, up, e.y)) * mix(1.0, 0.85, smoothstep(lo + 0.002, lo, e.y));
      float lid = max(smoothstep(up - px, up + px, e.y), smoothstep(lo + px, lo - px, e.y));
      c = mix(c, uSkin * 0.86, lid);
      float lash = exp(-pow((e.y - up - 0.0005) / 0.0012, 2.0)) * (1.0 - smoothstep(0.8, 1.05, abs(u)));
      c = mix(c, uHair * 0.22, clamp(lash, 0.0, 1.0) * 0.95);
      c = mix(c, uSkin * 0.55, exp(-pow((e.y - lo + 0.0004) / 0.0007, 2.0)) * 0.5);
      gSpec = mix(gSpec, 0.1, lid); gShin = mix(gShin, 16.0, lid); gSSS = lid;
    } else if (gKind > 4.5 && gKind < 5.5) {
      // padding / leather / boots: a fine grain
      kitH += 0.00003 * sin(vBind.x * 2100.0 + vBind.y * 1700.0) * sin(vBind.z * 1900.0 - vBind.y * 1300.0) * (1.0 - smoothstep(0.0008, 0.0016, fw));
      if (vSeg.z > 0.5 && vBind.y < 0.17) {
        // boots: a stitched toe cap, a heel tab in the team colour, a rubber sole
        vec3 aj = vBind.x > 0.0 ? uAnkleL : uAnkleL * vec3(-1.0, 1.0, 1.0);
        vec2 f = vec2(vBind.z - aj.z, vBind.y);
        float sx = (abs(vBind.x) - abs(aj.x)) / 0.05;
        if (s < 0.5) c *= 0.78;
        else if (s > 32.5) {
          float toe = abs(f.x - 0.17 + 0.035 * sx * sx);
          c *= 1.0 - 0.3 * smoothstep(0.003, 0.001, toe) * (1.0 - smoothstep(0.0015, 0.003, fw));
          c = mix(c, uKit1, smoothstep(-0.055, -0.065, f.x) * smoothstep(0.07, 0.08, f.y));
        }
      }
      if (vSeg.y > 0.4 && vBind.y < uLegAxis.w + 0.25) {
        // batting / keeping pads: the canes down the front, stitched between, the knee roll's seams
        bool l = vBind.x > 0.0;
        vec3 kj = l ? uKneeL : uKneeL * vec3(-1.0, 1.0, 1.0), aj = l ? uAnkleL : uAnkleL * vec3(-1.0, 1.0, 1.0);
        vec3 ax = mix(aj, kj, clamp((vBind.y - aj.y) / (kj.y - aj.y), -0.5, 1.5));
        float a = atan(vBind.x - ax.x, vBind.z - ax.z + 0.008);
        float front = 1.0 - smoothstep(0.95, 1.2, abs(a));
        float ky = vBind.y - kj.y;
        float roll = exp(-pow((ky - 0.035) / 0.05, 2.0));
        float ph = 0.5 + 0.5 * cos(6.2832 * a / 0.4);
        float fade = 1.0 - smoothstep(0.0012, 0.0024, fw);
        float inPad = smoothstep(0.4, 0.65, vSeg.y) * smoothstep(uLegAxis.w + 0.25, uLegAxis.w + 0.2, vBind.y);
        kitH += 0.0016 * pow(ph, 0.6) * front * (1.0 - roll) * inPad;
        float seam = smoothstep(0.05, 0.0, ph) * front * (1.0 - roll) + exp(-pow((ky + 0.03) / 0.0025, 2.0)) * front + exp(-pow((ky - 0.105) / 0.0025, 2.0)) * front;
        c *= 1.0 - 0.22 * clamp(seam, 0.0, 1.0) * fade;
        c *= vec3(1.0, 0.99, 0.965);
      }
    } else if (gKind > 1.5 && gKind < 2.5) {
      // helmet shell / hard plastic: the crest on its front
      if (vHeadW > 0.5 && vBind.z > 0.1) { vec4 t = decalAt(vBind.xy, uCapAt, uCrestUV, 0.0); c = mix(c, t.rgb, t.a); gSpec *= 1.0 - 0.3 * t.a; }
    }
    diffuseColor.rgb = c;
  }
  #endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    // bump from the procedural height (screen-space derivatives: no tangents needed)
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float dhx = dFdx(kitH), dhy = dFdy(kitH);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 gr = sign(det) * (dhx * r1 + dhy * r2);
    vec3 bn = normalize(abs(det) * normal - gr);
    normal = abs(det) > 1e-14 ? bn : normal;
  }`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if ((uNoHead > 0.5 && vHeadW > 0.35 && vHeadW < 1.5) || vHeadW > 1.5) discard;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float ao = clamp(vKA.y, 0.0, 1.0);
          float skinK = step(0.5, gKind) * step(gKind, 1.5) * step(0.5, gSSS);
          reflectedLight.indirectDiffuse *= ao * mix(vec3(0.97, 0.99, 1.03), vec3(1.06, 0.97, 0.92), skinK);
          reflectedLight.directDiffuse *= mix(1.0, ao, 0.5);
          reflectedLight.directSpecular *= ao;
          float nv = clamp(dot(normal, geometryViewDir), 0.0, 1.0);
          float fres = pow(1.0 - nv, 3.0);
          // cloth: a pale sheen at grazing angles; skin: a warm, then sky-cool edge; all: a readable rim
          vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float sky = smoothstep(-0.3, 0.6, dot(normal, up));
          vec3 rim = gKind < 0.5 ? diffuseColor.rgb * 0.55 + vec3(0.05, 0.055, 0.06) : skinK > 0.5 ? diffuseColor.rgb * vec3(1.1, 0.8, 0.7) + vec3(0.05, 0.06, 0.07) * sky : diffuseColor.rgb * 0.4 + 0.03;
          reflectedLight.indirectDiffuse += rim * fres * ao * (0.45 + 0.25 * sky);
          // glossy things (helmet, steel, lenses, eyes, boots) reflect the sky above and the grass below
          if (gKind > 1.5 && gKind != 3.0 && gKind != 5.0 || gKind > 3.5) {
            vec3 rv = reflect(-geometryViewDir, normal);
            float t = dot(rv, up);
            vec3 env = mix(vec3(0.16, 0.2, 0.11), vec3(0.62, 0.74, 0.92), smoothstep(-0.15, 0.35, t));
            float refl = gKind > 5.5 ? 0.55 : gKind > 4.5 ? 0.06 : gKind > 3.5 ? 0.1 : 0.22;
            totalEmissiveRadiance += env * ao * refl * mix(0.25, 1.0, fres) * (gKind > 1.5 && gKind < 2.5 ? gSpec : 1.0);
          }
          if (uGhostEdge > 0.0) {
            // see-through body: a dark, solid outline where the surface turns away (pads and boots most)
            float e = smoothstep(0.35, 0.85, 1.0 - clamp(dot(geometryNormal, geometryViewDir), 0.0, 1.0));
            float lw = clamp(vSeg.x * 0.35 + vSeg.y + vSeg.z, 0.0, 1.0);
            diffuseColor.a = max(diffuseColor.a, e * uGhostEdge * mix(0.02, 1.0, lw));
            reflectedLight.directDiffuse *= 1.0 - 0.75 * e * lw;
            reflectedLight.indirectDiffuse *= 1.0 - 0.75 * e * lw;
            reflectedLight.directSpecular *= 0.3;
          }
        }`)
      .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;');
  };
  mat.customProgramCacheKey = () => (depth ? 'cricket-kit-v10-depth' : 'cricket-kit-v10');
  mat.userData.uniforms = uniforms;
  return mat;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Vector3(),
  _T = new THREE.Vector3(), _dir = new THREE.Vector3(), _pv = new THREE.Vector3(), _end = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _eul = new THREE.Euler(), _bq = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FOOT_ONLY = {}, HAND_ONLY = {};

export class Humanoid {
  // vary: let this figure's height differ from the standard (fielders, umpires: not
  // the figures whose bodies the game measures, e.g. your own).
  constructor({ team = 'home', skin = null, hair = null, headgear = 'cap', pads = false, gloves = false, keeper = false, playerGrip = false, scale = 1, seed = 0, vary = false } = {}) {
    if (!RIG) throw new Error('loadAthlete() must finish before creating players');
    const rnd = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    const look = this.look = lookFor(seed, team, team === 'umpire' ? 'umpire' : playerGrip ? 'self' : 'player');
    this.opts = { headgear, pads, gloves, keeper, playerGrip, shades: look.shades && (headgear === 'cap' || headgear === 'bare' || headgear === 'hat') };
    this.material = kitMaterial();
    const u = this.material.userData.uniforms;
    u.uSkin.value.setHex(skin ?? look.skin);
    u.uHair.value.setHex(hair ?? look.hair);
    u.uIris.value.setHex(look.iris);
    u.uLook.value.set(look.build, look.hairVol, look.sleeves, look.sweatband);
    u.uLook2.value.set(look.beard, look.stubble, look.hairCut, look.zinc);
    if (vary) scale *= look.scale;
    { const sk = RIG.skull || { c: [0, 1.675, 0.058] }, cy = sk.c[1];   // (gear.js: the cap's front edge, the hat's base, the helmet's peak)
      if (headgear === 'cap' || headgear === 'bare') u.uBrim.value.set(cy + 0.028, 0.055, 0);
      else if (headgear === 'hat') u.uBrim.value.set(cy + 0.03, 0.085, 1);
      else if (headgear === 'helmet') u.uBrim.value.set(cy + 0.01, 0.04, 0); }
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
    this.mesh.position.y = -RIG.floor;            // soles on the ground in the canonical pose (see prepareRig)
    this.mesh.bind(new THREE.Skeleton(bones, RIG.inverses.map((m) => m.clone())), new THREE.Matrix4());
    // Generous fixed culling sphere (covers raised arms, dives and a bat).
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.1);
    this.mesh.frustumCulled = true;
    this.boneList = bones;
    this._mw = bones.map(() => new THREE.Matrix4());
    this.root = new THREE.Group();
    this.root.add(this.mesh);
    this.baseScale = BASE_SCALE * scale;
    this.root.scale.setScalar(this.baseScale);
    this.hipsRest = this.bones.hips.position.clone();
    this.ankleHeight = RIG.sole;                  // sole to ankle joint (model units)
    this.toeLength = RIG.toe;                     // ankle to the tip of the sole, along the foot (model units)
    this.lowY = 0;                                // the lowest point of the body last frame (world y, after groundGuard)
    this.armLength = RIG.J.shoulderL.distanceTo(RIG.J.elbowL) + RIG.J.elbowL.distanceTo(RIG.J.handL);
    u.uGloved.value = gloves ? 1 : 0;
    this.setNumber(team === 'umpire' ? 0 : 1 + Math.floor(rnd(3) * 98));
    this.setName(look.name);
    this.setTeam(team);
    // Contact shadow: a slot in the shared instanced shadow mesh.
    this.shadowSlot = ShadowPool.alloc();
    Humanoid.all.push(this);
  }

  // Pick the level of detail for every visible figure from the viewer's position
  // (h.lodNear: a figure the player watches closely keeps full detail further out).
  static updateLods(viewer, nearDist = 13) {
    for (const h of Humanoid.all) {
      if (!h.root.visible) continue;
      const p = h.root.position;
      const d = Math.hypot(p.x - viewer.x, p.z - viewer.z);
      h.setLod(d > (h.lodNear || nearDist) * (h.lod === 0 ? 1.15 : 1) ? 1 : 0);
    }
  }

  // Shirt number on the back (0 = none), printed from the lettering glyphs.
  setNumber(n) {
    n = Math.max(0, Math.min(99, n | 0));
    this.number = n;
    this.material.userData.uniforms.uNum.value.set(n >= 10 ? Math.floor(n / 10) : -1, n === 0 ? -1 : n % 10);
  }

  // Name over the number (up to 12 letters).
  setName(name) {
    const u = this.material.userData.uniforms, s = String(name || '').toUpperCase().slice(0, 12);
    this.name = s;
    for (let i = 0; i < 12; i++) u.uName.value[i] = i < s.length ? glyphOf(s[i]) : -1;
    u.uNameLen.value = s.length;
  }

  setTeam(team) {
    const k = KITS[team] || KITS.home;
    const u = this.material.userData.uniforms;
    u.uKit1.value.setHex(k.kit1); u.uKit2.value.setHex(k.kit2); u.uKit3.value.setHex(k.kit3); u.uKit4.value.setHex(k.kit4);
    u.uPanel.value.setHex(k.panel ?? k.kit1);
    u.uCrestUV.value.copy(ATLAS.crest[k.crest] || ATLAS.crest[0]);
    if (k.sponsor >= 0) u.uSponsorUV.value.copy(ATLAS.sponsor[k.sponsor]); else u.uSponsorUV.value.set(0, 0, 0, 0);
    u.uTeamIx.value = team === 'umpire' ? 2 : team === 'away' ? 1 : 0;
    this.team = team;
  }

  // Look like another figure (skin, hair, face, build, shirt name and number): the two figures that draw the same man.
  copyLook(o) {
    const u = this.material.userData.uniforms, v = o.material.userData.uniforms;
    for (const k of ['uSkin', 'uHair', 'uIris', 'uLook', 'uLook2']) u[k].value.copy(v[k].value);
    this.setNumber(o.number);
    this.setName(o.name);
    if (this.opts.shades !== o.opts.shades) { this.opts.shades = o.opts.shades; this.mesh.geometry = geometryFor(this.opts, this.lod); }
  }

  // 0 = full detail, 1 = distant.
  setLod(lod) {
    if (lod === this.lod) return;
    this.lod = lod;
    this.mesh.geometry = geometryFor(this.opts, lod);
    this.material.userData.uniforms.uLod.value = lod;
  }

  // See-through body: what you see of yourself when you look down. No head
  // or neck; the trunk and arms very faint, so that you see through them to
  // your legs and feet, which are clearly drawn to judge them against the
  // crease: thighs half see-through, pads more solid, boots most, all with a
  // dark outline; the gloves all but solid on your bat (fading out right in
  // front of your eyes). legs: the pads' opacity (thighs a little less, boots more).
  // Each part is drawn as one clean layer, the nearest surface only: a
  // depth pre-pass (a twin of the mesh on the same skeleton that only writes
  // depth, for everything but the faint trunk) goes just before it, so the
  // back of a pad, the inside of a glove or the other leg behind never show
  // through as layers of grey smoke.
  setGhost(on, legs = 0.55, trunk = 0.035) {
    if (!!this.ghost === on) return;
    this.ghost = on;
    const m = this.material, u = m.userData.uniforms;
    m.transparent = on; m.opacity = 1; m.depthWrite = !on; m.needsUpdate = true;
    this.fade = 1;
    u.uNoHead.value = on ? 1 : 0;
    u.uTrunkAlpha.value = 1;
    u.uGhost.value.set(on ? trunk : 0, on ? legs * 0.7 : 0, on ? legs : 0, on ? Math.min(1, legs + 0.3) : 0);
    u.uGhostEdge.value = on ? 0.9 : 0;
    u.uGhostHands.value = on ? 0.92 : 0;
    this.mesh.renderOrder = on ? 3 : 0;
    if (on && !this.ghostDepth) {
      const dm = kitMaterial(u, true);
      dm.transparent = true; dm.colorWrite = false; dm.depthWrite = true;
      const g = this.ghostDepth = new THREE.SkinnedMesh(this.mesh.geometry, dm);
      g.bind(this.mesh.skeleton, this.mesh.bindMatrix);
      g.position.copy(this.mesh.position);
      g.boundingSphere = this.mesh.boundingSphere; g.frustumCulled = this.mesh.frustumCulled;
      g.renderOrder = 2.9;
      g.layers.mask = this.mesh.layers.mask;
      g.onBeforeRender = () => { g.geometry = this.mesh.geometry; };      // (the level of detail drawn)
      this.root.add(g);
    }
    if (this.ghostDepth) this.ghostDepth.visible = on;
  }

  // Fade the whole figure (and its bat) in or out: a = 0..1. Nobody appears
  // or disappears in one frame while he can be seen: a figure that has to
  // come or go (your runner leaving / rejoining you, a batter at the
  // pavilion gate) is faded. 1 = solid again (opaque material, depth written).
  setFade(a) {
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    if (a === (this.fade ?? 1)) return;
    this.fade = a;
    if (this.ghost) return;                       // (your see-through body has its own opacities)
    const m = this.material;
    const tr = a < 1;
    if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
    m.opacity = a;
    for (const x of this.extras || []) x.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.fadeMat) { o.material = o.material.clone(); o.userData.fadeMat = true; }
      if (o.material.transparent !== tr && !o.userData.wasTransparent) { if (o.userData.wasTransparent == null) o.userData.wasTransparent = o.material.transparent; if (!o.userData.wasTransparent) { o.material.transparent = tr; o.material.needsUpdate = true; } }
      o.material.opacity = a * (o.userData.baseOpacity ?? (o.userData.baseOpacity = o.material.opacity || 1));
    });
  }

  get visible() { return this.root.visible; }
  set visible(v) { this.root.visible = v; if (!v) ShadowPool.set(this.shadowSlot, 0, 0, false); }

  // Called after the root is placed for the frame: nothing may be below the
  // turf (see groundGuard), and the contact shadow follows the hips.
  syncShadow() {
    this.groundGuard();                           // (hidden too: replays record the pose)
    if (!this.root.visible) return;
    this.bones.hips.getWorldPosition(_v);
    ShadowPool.set(this.shadowSlot, _v.x, _v.z, true, this.root.scale.x * (0.8 + 0.4 * Math.min(1, (_v.y - this.root.position.y) / 1.0)) * (this.ghost ? 1 : this.fade ?? 1));
  }

  // Lowest point of the posed body (world y): every bone's hull points
  // (vertex extremes, gear included; see hullFor) carried rigidly by the bone.
  // Bones whose joint is higher above the ground than their hull reaches are skipped.
  lowest(only = null) {
    this.root.updateMatrixWorld(true);
    const H = hullFor(geometryFor(this.opts, 0)), sc = this.root.scale.y;     // (the full-detail mesh, whatever LOD is drawn)
    const M = this._mw;
    for (let b = 0; b < M.length; b++) M[b].multiplyMatrices(this.boneList[b].matrixWorld, RIG.inverses[b]);
    let low = Infinity;
    for (let b = 0; b < H.length; b++) {
      const hb = H[b];
      if (!hb || (only && !only.includes(b)) || M[b].elements[13] - hb.r * sc > low) continue;
      const { p, si, sw } = hb;
      for (let i = 0, n = p.length / 3; i < n; i++) {
        const x = p[i * 3], y0 = p[i * 3 + 1], z = p[i * 3 + 2];
        let y = 0;
        for (let k = 0; k < 4; k++) {                 // linear blend skinning, height only
          const w = sw[i * 4 + k];
          if (!w) continue;
          const m = M[si[i * 4 + k]].elements;
          y += w * (m[1] * x + m[5] * y0 + m[9] * z + m[13]);
        }
        if (y < low) { low = y; this.lowBone = b; }
      }
    }
    return low;
  }

  // A swinging (not planted) foot that dips into the turf: bend that leg
  // (IK, same knee direction, same foot orientation) so the sole clears it.
  // pole: the knee's IK pole to keep (default: out along the knee's current direction).
  clearFoot(side, pole = null) {
    const ia = RIG.index['ankle' + side], ik = RIG.index['knee' + side];
    const low = this.lowest(FOOT_ONLY[side] || (FOOT_ONLY[side] = [ia, ik]));
    if (low >= 0) return 0;
    const ank = this.bones['ankle' + side];
    ank.getWorldQuaternion(_bq);
    ank.getWorldPosition(_T); _T.y -= low;
    this.bones['knee' + side].getWorldPosition(_v);
    this.bones['hip' + side].getWorldPosition(_v2);
    _v.add(_v.clone().sub(_v2).setY(0).multiplyScalar(2));       // pole: out along the knee's current direction
    this.ikLeg(side, _T, pole || _v);
    this.setWorldQuat('ankle' + side, _bq);
    return -low;
  }

  // The same for an arm (a dive's leading arm stretched along the turf):
  // bend it so the hand and forearm stay on top of the turf.
  clearHand(side) {
    const ih = RIG.index['hand' + side], ie = RIG.index['elbow' + side];
    const low = this.lowest(HAND_ONLY[side] || (HAND_ONLY[side] = [ih, ie]));
    if (low >= 0) return 0;
    const hand = this.bones['hand' + side];
    hand.getWorldQuaternion(_bq);
    hand.getWorldPosition(_T); _T.y -= low;
    this.bones['elbow' + side].getWorldPosition(_v); _v.y -= 0.3;
    this.ikArm(side, _T, _v);
    this.setWorldQuat('hand' + side, _bq);
    return -low;
  }

  // Last line of defence: if any part of the body is below the turf (a pose
  // or a blend the animation code did not foresee), lift the whole figure so
  // its lowest point is on it. tol: what may go under (soles / pads press in).
  groundGuard(tol = 0.002) {
    const low = this.lowest();
    this.lowY = low;
    this.guardLift = low < -tol ? -(low + tol) : 0;
    if (low < -tol) {
      this.root.position.y -= low + tol;
      this.root.updateMatrixWorld(true);
      this.lowY = -tol;
    }
    return low;
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
    solveTwoBone(b['shoulder' + side], b['elbow' + side], b['hand' + side], target, pole, 1);
  }
  ikLeg(side, target, pole) {
    const b = this.bones;
    solveTwoBone(b['hip' + side], b['knee' + side], b['ankle' + side], target, pole, -1);
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
// joint bends toward. `flex` says which way the joint is a hinge in the
// canonical pose: +1 for an elbow (the forearm folds toward the upper arm's
// +Z), -1 for a knee (the shin folds toward the thigh's -Z). Both bones are
// then turned about their own axes so that the bend happens about that hinge
// (the upper bone's local X), the way a real elbow or knee bends: no sideways
// kinks in the skin, and the joint's crease always faces into the bend.
// flex = 0 keeps the old minimal-rotation aim.
export function solveTwoBone(upper, lower, end, target, pole, flex = 0) {
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
  if (!flex) {
    aimBone(upper, _v.subVectors(_E, _S));
    aimBone(lower, _v.subVectors(_T, _E));
    return;
  }
  // Hinge frames. u, l: the two bones' directions; the lower bone folds
  // toward `fold` (perpendicular to u). Upper: -Y along u, +Z = flex * fold.
  _hu.subVectors(_E, _S).normalize();
  _hl.subVectors(_T, _E).normalize();
  _hf.copy(_hl).addScaledVector(_hu, -_hl.dot(_hu));
  if (_hf.lengthSq() < 1e-8) _hf.copy(_pv).negate().addScaledVector(_hu, _pv.dot(_hu));   // straight: fold away from the pole side
  _hf.normalize().multiplyScalar(flex);
  _hy.copy(_hu).negate();
  _hx.crossVectors(_hy, _hf).normalize();
  setBoneWorld(upper, _hx, _hy, _hf);
  _hy.copy(_hl).negate();
  _hf.crossVectors(_hx, _hy).normalize();
  setBoneWorld(lower, _hx, _hy, _hf);
}
const _hu = new THREE.Vector3(), _hl = new THREE.Vector3(), _hf = new THREE.Vector3(), _hx = new THREE.Vector3(), _hy = new THREE.Vector3();
const _hm = new THREE.Matrix4(), _hq = new THREE.Quaternion();
function setBoneWorld(bone, x, y, z) {
  _hq.setFromRotationMatrix(_hm.makeBasis(x, y, z));
  bone.parent.getWorldQuaternion(_pq).invert();
  bone.quaternion.copy(_pq).multiply(_hq);
  bone.updateMatrixWorld(true);
}
Humanoid.all = [];
