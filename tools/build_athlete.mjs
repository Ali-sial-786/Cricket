// Converts Courtside's Athlete.glb (MakeHuman-derived, CC0; ~115k triangles,
// 15-joint skin, no clips) into a compact two-LOD asset for the web game:
//   assets/models/athlete.json  (parts, joints, counts)
//   assets/models/athlete.bin   (interleaved-free typed arrays)
// Usage: node tools/build_athlete.mjs <path/to/Athlete.glb> [node_modules dir with meshoptimizer]
// Per-vertex data: position f32x3, normal i8x3, kit u8 (0 fixed colour, 1 shirt,
// 2 trim, 4 trousers, 5 skin, 6 hair), colour u8x3, joints u8x4, weights u8x4.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = process.argv[2];
const modDir = process.argv[3] || path.resolve('node_modules');
const require = createRequire(path.join(modDir, 'x.js'));
const { MeshoptSimplifier } = require('meshoptimizer');
await MeshoptSimplifier.ready;

const buf = fs.readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const bin = buf.subarray(20 + jsonLen + 8);
const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function acc(i) {
  const a = gltf.accessors[i], n = NC[a.type], T = CT[a.componentType];
  const out = new T(a.count * n);
  if (a.bufferView != null) {
    const bv = gltf.bufferViews[a.bufferView];
    const stride = bv.byteStride || n * T.BYTES_PER_ELEMENT;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const dv = new DataView(bin.buffer, bin.byteOffset + base);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](k * stride + c * T.BYTES_PER_ELEMENT, true);
  }
  if (a.sparse) {
    const s = a.sparse, ib = gltf.bufferViews[s.indices.bufferView], vb = gltf.bufferViews[s.values.bufferView];
    const IT = CT[s.indices.componentType];
    const idx = new IT(bin.buffer.slice(bin.byteOffset + (ib.byteOffset || 0) + (s.indices.byteOffset || 0), bin.byteOffset + (ib.byteOffset || 0) + (s.indices.byteOffset || 0) + s.count * IT.BYTES_PER_ELEMENT));
    const val = new T(bin.buffer.slice(bin.byteOffset + (vb.byteOffset || 0) + (s.values.byteOffset || 0), bin.byteOffset + (vb.byteOffset || 0) + (s.values.byteOffset || 0) + s.count * n * T.BYTES_PER_ELEMENT));
    for (let k = 0; k < s.count; k++) for (let c = 0; c < n; c++) out[idx[k] * n + c] = val[k * n + c];
  }
  return out;
}

// ---- joints (bind pose, world) ----
const parentOf = {};
gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => { parentOf[c] = i; }));
const world = (i) => { let p = [0, 0, 0]; for (let k = i; k != null; k = parentOf[k]) { const t = gltf.nodes[k].translation || [0, 0, 0]; p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]]; } return p; };
const skin = gltf.skins[0];
const jointNames = skin.joints.map((i) => gltf.nodes[i].name);
const J = {}; skin.joints.forEach((i) => { J[gltf.nodes[i].name] = world(i); });
// Target skeleton (17 bones, the game's names).
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const MAP = { hips: 'hips', spine: 'spine', head: 'head', 'arm.L': 'shoulderL', 'forearm.L': 'elbowL', 'hand.L': 'handL', 'arm.R': 'shoulderR', 'forearm.R': 'elbowR', 'hand.R': 'handR', 'thigh.L': 'hipL', 'shin.L': 'kneeL', 'foot.L': 'ankleL', 'thigh.R': 'hipR', 'shin.R': 'kneeR', 'foot.R': 'ankleR' };
const chestY = J.spine[1] + 0.6 * (J['arm.L'][1] - J.spine[1]);
const joints = {};
for (const [g, b] of Object.entries(MAP)) joints[b] = J[g];
joints.chest = [0, chestY, J.spine[2]];
joints.neck = J.head.slice();
joints.head = [J.head[0], J.head[1] + 0.07, J.head[2]];
const bIndex = Object.fromEntries(BONES.map((b, i) => [b, i]));
const srcToBone = jointNames.map((n) => bIndex[MAP[n]]);

// ---- parts ----
const KIT = { fixed: 0, shirt: 1, trim: 2, trousers: 4, skin: 5, hair: 6 };
const matName = (p) => gltf.materials[p.material].name;
const matColor = (p) => gltf.materials[p.material].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((c) => Math.pow(c, 1 / 2.2)); // linear -> sRGB
const PLAN = [ // mesh, kit, hi target tris, lo target tris, optional part name
  ['Athlete_Body', null, 5200, 1500], ['Performance_Polo', KIT.shirt, 1500, 420], ['Tailored_Shorts', KIT.trousers, 520, 200],
  ['Details_Accent', KIT.trim, 520, 0], ['Details_Shirt', KIT.shirt, 260, 0], ['Details_Shoe', KIT.fixed, 800, 260], ['Details_Sole', KIT.fixed, 160, 60],
  ['Details_Sclera', KIT.fixed, 300, 120], ['Details_Iris', KIT.fixed, 260, 100], ['Details_Pupil', KIT.fixed, 160, 0], ['Details_Lids', KIT.skin, 240, 0],
  ['Details_Mouth', KIT.fixed, 120, 0], ['Details_Hair', KIT.hair, 120, 60], ['HairCap', KIT.hair, 420, 160, 'hair'],
];
const MORPH = { HandGrip: 0.75 };          // bake a relaxed fist (holds a bat / ball)

function buildPart(meshName, kit, target) {
  const mesh = gltf.meshes.find((m) => m.name === meshName);
  const names = (mesh.extras && mesh.extras.targetNames) || [];
  const P = [], C = [], K = [], JI = [], JW = [], I = [];
  for (const prim of mesh.primitives) {
    const pos = acc(prim.attributes.POSITION), jn = acc(prim.attributes.JOINTS_0), jw = acc(prim.attributes.WEIGHTS_0), idx = acc(prim.indices);
    (prim.targets || []).forEach((t, ti) => { const w = MORPH[names[ti]]; if (!w || t.POSITION == null) return; const d = acc(t.POSITION); for (let k = 0; k < pos.length; k++) pos[k] += d[k] * w; });
    const wScale = gltf.accessors[prim.attributes.WEIGHTS_0].componentType === 5126 ? 1 : (gltf.accessors[prim.attributes.WEIGHTS_0].componentType === 5121 ? 1 / 255 : 1 / 65535);
    const base = P.length / 3, col = matColor(prim), mn = matName(prim);
    for (let v = 0; v < pos.length / 3; v++) {
      P.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      // joint weights -> target bones, spine split into spine/chest by height
      const w = new Float32Array(BONES.length);
      for (let c = 0; c < 4; c++) { const ww = jw[v * 4 + c] * wScale; if (ww > 0) w[srcToBone[jn[v * 4 + c]]] += ww; }
      const y = pos[v * 3 + 1];
      const t = Math.min(1, Math.max(0, (y - (chestY - 0.07)) / 0.14)), ts = t * t * (3 - 2 * t);
      const ws = w[bIndex.spine]; w[bIndex.chest] += ws * ts; w[bIndex.spine] = ws * (1 - ts);
      const top = [...w.keys()].sort((a, b) => w[b] - w[a]).slice(0, 4);
      const sum = top.reduce((s, b) => s + w[b], 0) || 1;
      for (let c = 0; c < 4; c++) { JI.push(top[c]); JW.push(w[top[c]] / sum); }
      // kit slot + colour
      let k = kit, cc = col;
      if (k == null) { // body: skin, lips; legs become trousers
        const leg = w[bIndex.hipL] + w[bIndex.hipR] + w[bIndex.kneeL] + w[bIndex.kneeR] + w[bIndex.hips];
        k = mn === 'Lips' ? KIT.fixed : leg > 0.5 && y < J.hips[1] + 0.12 ? KIT.trousers : KIT.skin;
      }
      if (meshName === 'Details_Shoe' && y > 1.0) { k = KIT.hair; }   // lashes live in this mesh
      K.push(k); C.push(cc[0], cc[1], cc[2]);
    }
    for (let k = 0; k < idx.length; k++) I.push(idx[k] + base);
  }
  // weld by position (drops UV / normal seams)
  const map = new Map(), remap = new Uint32Array(P.length / 3); let n = 0;
  const wp = [], wc = [], wk = [], wji = [], wjw = [];
  for (let v = 0; v < P.length / 3; v++) {
    const key = `${Math.round(P[v * 3] * 2e4)},${Math.round(P[v * 3 + 1] * 2e4)},${Math.round(P[v * 3 + 2] * 2e4)},${K[v]}`;
    let id = map.get(key);
    if (id === undefined) { id = n++; map.set(key, id); wp.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); wc.push(C[v * 3], C[v * 3 + 1], C[v * 3 + 2]); wk.push(K[v]); for (let c = 0; c < 4; c++) { wji.push(JI[v * 4 + c]); wjw.push(JW[v * 4 + c]); } }
    remap[v] = id;
  }
  let idx = new Uint32Array(I.length); for (let k = 0; k < I.length; k++) idx[k] = remap[I[k]];
  idx = idx.filter((_, k) => { const t = k - (k % 3); return idx[t] !== idx[t + 1] && idx[t + 1] !== idx[t + 2] && idx[t] !== idx[t + 2]; });
  const pos32 = new Float32Array(wp);
  if (target > 0 && idx.length / 3 > target) {
    const [out] = MeshoptSimplifier.simplify(idx, pos32, 3, target * 3, 0.05, []);
    idx = out;
  }
  // compact
  const used = new Map(); const cp = [], ccol = [], ck = [], cji = [], cjw = []; const ci = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) { let id = used.get(idx[k]); if (id === undefined) { id = used.size; used.set(idx[k], id); const v = idx[k]; cp.push(wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]); ccol.push(wc[v * 3], wc[v * 3 + 1], wc[v * 3 + 2]); ck.push(wk[v]); for (let c = 0; c < 4; c++) { cji.push(wji[v * 4 + c]); cjw.push(wjw[v * 4 + c]); } } ci[k] = id; }
  // trousers sit slightly proud of the leg skin
  const nrm = new Float32Array(cp.length);
  for (let k = 0; k < ci.length; k += 3) {
    const a = ci[k] * 3, b = ci[k + 1] * 3, c = ci[k + 2] * 3;
    const ux = cp[b] - cp[a], uy = cp[b + 1] - cp[a + 1], uz = cp[b + 2] - cp[a + 2], vx = cp[c] - cp[a], vy = cp[c + 1] - cp[a + 1], vz = cp[c + 2] - cp[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
  }
  for (let v = 0; v < nrm.length; v += 3) { const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]) || 1; nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l; if (ck[v / 3] === KIT.trousers && meshName === 'Athlete_Body') { cp[v] += nrm[v] * 0.006; cp[v + 1] += nrm[v + 1] * 0.006; cp[v + 2] += nrm[v + 2] * 0.006; } }
  return { pos: cp, nrm, col: ccol, kit: ck, ji: cji, jw: cjw, idx: ci };
}

const chunks = []; let offset = 0;
const push = (typed) => { const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength); const pad = (4 - (b.length % 4)) % 4; chunks.push(b, Buffer.alloc(pad)); const o = offset; offset += b.length + pad; return o; };
const lods = [];
for (const lod of [0, 1]) {
  const parts = [];
  for (const [mesh, kit, hi, lo, opt] of PLAN) {
    const target = lod === 0 ? hi : lo;
    if (target === 0) continue;
    const p = buildPart(mesh, kit, target);
    const vc = p.pos.length / 3;
    const nb = new Int8Array(vc * 4), cb = new Uint8Array(vc * 4), jb = new Uint8Array(p.ji), wb = new Uint8Array(vc * 4);
    for (let v = 0; v < vc; v++) {
      for (let c = 0; c < 3; c++) { nb[v * 4 + c] = Math.round(p.nrm[v * 3 + c] * 127); cb[v * 4 + c] = Math.round(Math.min(1, p.col[v * 3 + c]) * 255); }
      nb[v * 4 + 3] = p.kit[v];
      let acc8 = 0; for (let c = 0; c < 4; c++) { wb[v * 4 + c] = Math.round(p.jw[v * 4 + c] * 255); acc8 += wb[v * 4 + c]; }
      wb[v * 4] += 255 - acc8;
    }
    parts.push({ name: opt || mesh, optional: !!opt, vCount: vc, iCount: p.idx.length,
      pos: push(new Float32Array(p.pos)), nrmKit: push(nb), col: push(cb), joints: push(jb), weights: push(wb), idx: push(new Uint16Array(p.idx)) });
  }
  lods.push({ parts, tris: parts.reduce((s, p) => s + p.iCount / 3, 0) });
}
const outDir = path.resolve('assets/models');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'athlete.bin'), Buffer.concat(chunks));
const round = (a) => a.map((x) => Math.round(x * 1e5) / 1e5);
fs.writeFileSync(path.join(outDir, 'athlete.json'), JSON.stringify({
  source: 'Courtside Athlete.glb (MakeHuman HM08 derived, CC0-1.0)', bones: BONES,
  joints: Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, round(v)])),
  headCentre: [0, 1.76, 0.06], headTop: 2.014, eyeY: 1.744, kit: KIT, lods,
}));
console.log('athlete:', lods.map((l) => `${l.tris} tris`).join(' / '), `${(offset / 1024).toFixed(0)} KB`);
