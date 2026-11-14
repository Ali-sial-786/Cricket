// Converts Courtside's Athlete.glb (MakeHuman-derived, CC0; ~115k triangles,
// 15-joint skin, morph targets) into the cricket figure used by the game:
//   assets/models/athlete.json  (parts, joints, landmarks, counts)
//   assets/models/athlete.bin   (typed arrays, see below)
// Usage: node tools/build_athlete.mjs <path/to/Athlete.glb> [node_modules dir with meshoptimizer]
//
// What it does to the source (all offline, so the game only loads the result):
//  * Proportions: undoes Courtside's enlarged cartoon head (the exact inverse
//    of its `playful_head` warp, keeping the friendlier face), then gives the
//    head back a mild sporty enlargement; lengthens the upper arm and forearm
//    (joints and skin together) to adult proportions.
//  * Hands: a relaxed, slightly curled hand from the source's grip morphs.
//  * Cricket kit: the polo becomes a collared cricket shirt (collar + cuffs in
//    the trim colour, side piping, shoulder panels, a two-digit back number
//    whose segments the shader switches on per player); the shorts are cut at
//    the thigh and continued as loose straight-cut trousers (lofted rings that
//    hide the leg anatomy, a pressed front crease, side stripes and a hem that
//    breaks over the boot); bare leg skin and socks are removed.
//  * Fidelity: source normals are kept (only welded where they agree), each
//    part is simplified with meshoptimizer using normals as attributes, 4
//    skin weights per vertex, and ambient occlusion is ray-traced into the
//    vertices (armpits, collar, crotch, ears, between fingers, ...).
// Per-vertex data: position f32x3, normal i8x3 + kit i8, colour u8x3 + AO u8,
// joints u8x4, weights u8x4; indices u16.
// Kit slots: 0 fixed colour, 1 shirt, 2 trim, 3 headgear, 4 trousers, 5 skin,
// 6 hair, 7 shirt panel, 8 lips (a darker skin), 10..23 back-number segments (trim when lit, else shirt).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const src = process.argv[2];
const modDir = process.argv[3] || path.resolve('node_modules');
const require = createRequire(path.join(modDir, 'x.js'));
const { MeshoptSimplifier } = require('meshoptimizer');
await MeshoptSimplifier.ready;

// ------------------------------------------------------------------ glTF
const buf = fs.readFileSync(src);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const bin = buf.subarray(20 + jsonLen + 8);
const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GET = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };
function acc(i) {
  const a = gltf.accessors[i], n = NC[a.type], T = CT[a.componentType];
  const out = new Float64Array(a.count * n);
  if (a.bufferView != null) {
    const bv = gltf.bufferViews[a.bufferView];
    const stride = bv.byteStride || n * T.BYTES_PER_ELEMENT;
    const dv = new DataView(bin.buffer, bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0));
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[GET[a.componentType]](k * stride + c * T.BYTES_PER_ELEMENT, true);
    if (a.normalized) { const s = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType]; for (let k = 0; k < out.length; k++) out[k] /= s; }
  }
  if (a.sparse) {
    const s = a.sparse, ib = gltf.bufferViews[s.indices.bufferView], vb = gltf.bufferViews[s.values.bufferView];
    const di = new DataView(bin.buffer, bin.byteOffset + (ib.byteOffset || 0) + (s.indices.byteOffset || 0));
    const dvv = new DataView(bin.buffer, bin.byteOffset + (vb.byteOffset || 0) + (s.values.byteOffset || 0));
    const IB = CT[s.indices.componentType].BYTES_PER_ELEMENT;
    for (let k = 0; k < s.count; k++) { const id = di[GET[s.indices.componentType]](k * IB, true); for (let c = 0; c < n; c++) out[id * n + c] = dvv.getFloat32((k * n + c) * 4, true); }
  }
  return out;
}

// ------------------------------------------------------------------ math
const V = (x = 0, y = 0, z = 0) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ joints
const parentOf = {};
gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => { parentOf[c] = i; }));
const world = (i) => { let p = [0, 0, 0]; for (let k = i; k != null; k = parentOf[k]) p = add(p, gltf.nodes[k].translation || [0, 0, 0]); return p; };
const skin = gltf.skins[0];
const SRC = skin.joints.map((i) => gltf.nodes[i].name);            // 15 source joints
const NS = SRC.length;
const SJ = {}; skin.joints.forEach((i) => { SJ[gltf.nodes[i].name] = world(i); });
const si = Object.fromEntries(SRC.map((n, i) => [n, i]));

// ------------------------------------------------------------------ tunables
const HEAD_ANCHOR = SJ.head.slice();           // Courtside's playful_head pivot (neck01 joint)
const HEAD_K = 1.03;                           // sporty head, ~1.2x life once the body is life size
const ARM_UPPER = 1.22, ARM_FORE = 1.04;       // adult limb proportions (MakeHuman's upper arm is short)
const RELAX = 0.34;                            // grip morph amount for a relaxed, curled hand
const CUT = 0.84;                              // where the shorts become trouser legs
const HEM_FRONT = 0.138, HEM_BACK = 0.08;     // trouser hem breaks over the boot

// Inverse of Courtside's playful_head scale (Blender Z-up -> glTF Y-up:
// bx = x, by = -z, bz = y). Forward: t = smooth((pz - 1.49)/0.10) * w,
// q = a + (p - a) * (1 + [.93, .65, .57] t) for (x, y, -z).
function headT(y, w) { const t = clamp((y - 1.49) / 0.1, 0, 1); return t * t * (3 - 2 * t) * w; }
function unHead(q, w) {
  if (w < 1e-4) return { p: q.slice(), s: [1, 1, 1] };
  const a = HEAD_ANCHOR;
  const f = (y) => a[1] + (y - a[1]) * (1 + 0.65 * headT(y, w));
  let lo = q[1] - 1, hi = q[1] + 0.2;
  for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (f(m) < q[1]) lo = m; else hi = m; }
  const y = (lo + hi) / 2, t = headT(y, w);
  const s = [1 / (1 + 0.93 * t), 1 / (1 + 0.65 * t), 1 / (1 + 0.57 * t)];
  return { p: [a[0] + (q[0] - a[0]) * s[0], y, a[2] + (q[2] - a[2]) * s[2]], s };
}
// Then a mild uniform enlargement, blended in over the same neck band.
function reHead(p, w) {
  const t = headT(p[1], w), k = 1 + (HEAD_K - 1) * t, a = HEAD_ANCHOR;
  return [a[0] + (p[0] - a[0]) * k, a[1] + (p[1] - a[1]) * k, a[2] + (p[2] - a[2]) * k];
}

// Arm lengthening as a rest-pose edit (linear blend of per-bone affine maps,
// so skin follows its weights exactly as the bones move).
const NJ = {};                                    // new joint positions
for (const n of SRC) NJ[n] = SJ[n].slice();
const ARMS = {};
for (const s of ['L', 'R']) {
  const S = SJ['arm.' + s], E = SJ['forearm.' + s], H = SJ['hand.' + s];
  const uu = norm(sub(E, S)), Lu = len(sub(E, S)), uf = norm(sub(H, E)), Lf = len(sub(H, E));
  const E2 = add(S, mul(uu, Lu * ARM_UPPER)), H2 = add(E2, mul(uf, Lf * ARM_FORE));
  NJ['forearm.' + s] = E2; NJ['hand.' + s] = H2;
  ARMS[s] = { S, E, H, uu, Lu, uf, Lf, dE: sub(E2, E), dH: sub(H2, H) };
}
function armMove(p, w) {        // w: Float32Array(NS) weights
  let out = [0, 0, 0], tot = 0;
  for (const s of ['L', 'R']) {
    const A = ARMS[s];
    const wa = w[si['arm.' + s]], wf = w[si['forearm.' + s]], wh = w[si['hand.' + s]];
    if (wa > 0) { const al = clamp(dot(sub(p, A.S), A.uu), 0, A.Lu); out = add(out, mul(add(p, mul(A.uu, al * (ARM_UPPER - 1))), wa)); tot += wa; }
    if (wf > 0) { const al = clamp(dot(sub(p, A.E), A.uf), 0, A.Lf); out = add(out, mul(add(add(p, A.dE), mul(A.uf, al * (ARM_FORE - 1))), wf)); tot += wf; }
    if (wh > 0) { out = add(out, mul(add(p, A.dH), wh)); tot += wh; }
  }
  if (tot < 1e-6) return p;
  return add(out, mul(p, Math.max(0, 1 - tot)));
}

// ------------------------------------------------------------------ parts
// A part: { name, pos[], nrm[], w Float32Array(V*NS), kit[], col[], idx[] }
const KIT = { fixed: 0, shirt: 1, trim: 2, headgear: 3, trousers: 4, skin: 5, hair: 6, panel: 7, lips: 8, number: 10 };
const matColor = (m) => gltf.materials[m].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((c) => Math.pow(c, 1 / 2.2));
const MORPH = { HandGrip: RELAX, SupportGrip: RELAX };

function newPart(name) { return { name, pos: [], nrm: [], w: [], kit: [], col: [], idx: [] }; }
function loadMesh(meshName, kitFn, triKeep = null, dropBones = null) {
  const mesh = gltf.meshes.find((m) => m.name === meshName);
  const names = (mesh.extras && mesh.extras.targetNames) || [];
  const part = newPart(meshName);
  for (const prim of mesh.primitives) {
    const pos = acc(prim.attributes.POSITION), nrm = acc(prim.attributes.NORMAL);
    const jn = acc(prim.attributes.JOINTS_0), jw = acc(prim.attributes.WEIGHTS_0), idx = acc(prim.indices);
    const morph = new Float64Array(pos.length);
    (prim.targets || []).forEach((t, ti) => { const a = MORPH[names[ti]]; if (!a || t.POSITION == null) return; const d = acc(t.POSITION); for (let k = 0; k < pos.length; k++) morph[k] += d[k] * a; });
    const base = part.pos.length / 3, col = matColor(prim.material), mat = gltf.materials[prim.material].name;
    const nv = pos.length / 3;
    for (let v = 0; v < nv; v++) {
      const w = new Float32Array(NS);
      let sum = 0; for (let c = 0; c < 4; c++) { w[jn[v * 4 + c]] += jw[v * 4 + c]; sum += jw[v * 4 + c]; }
      for (let c = 0; c < NS; c++) w[c] /= sum || 1;
      if (dropBones) {
        // Cloth that must not follow these bones (MakeHuman's weights bleed a
        // little hand / forearm into the shirt hem and the trousers, which
        // drags slivers of cloth along when the hands move far from the hips).
        let kept = 0;
        for (const b of dropBones) w[si[b]] = 0;
        for (let c = 0; c < NS; c++) kept += w[c];
        if (kept > 1e-6) for (let c = 0; c < NS; c++) w[c] /= kept; else w[si.spine] = 1;
      }
      let p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], n = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
      const wh = w[si.head];
      const u = unHead(p, wh);
      p = reHead(u.p, wh);
      n = norm([n[0] / u.s[0], n[1] / u.s[1], n[2] / u.s[2]]);   // inverse-transpose of the (diagonal) scale
      p = add(p, [morph[v * 3], morph[v * 3 + 1], morph[v * 3 + 2]]);
      p = armMove(p, w);
      part.pos.push(...p); part.nrm.push(...n); part.w.push(w);
      const k = kitFn(p, mat, w);
      part.kit.push(k); part.col.push(...col);
    }
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] + base, b = idx[k + 1] + base, c = idx[k + 2] + base;
      if (triKeep) {
        const cen = mul(add(add(part.pos.slice(a * 3, a * 3 + 3), part.pos.slice(b * 3, b * 3 + 3)), part.pos.slice(c * 3, c * 3 + 3)), 1 / 3);
        if (!triKeep(cen, mat, part, a, b, c)) continue;
      }
      part.idx.push(a, b, c);
    }
  }
  return compact(part);
}
function compact(part) {
  const used = new Map(), out = newPart(part.name);
  Object.assign(out, { ...part, pos: [], nrm: [], w: [], kit: [], col: [], idx: [] });
  for (const v of part.idx) {
    let id = used.get(v);
    if (id === undefined) {
      id = used.size; used.set(v, id);
      out.pos.push(part.pos[v * 3], part.pos[v * 3 + 1], part.pos[v * 3 + 2]);
      out.nrm.push(part.nrm[v * 3], part.nrm[v * 3 + 1], part.nrm[v * 3 + 2]);
      out.w.push(part.w[v]); out.kit.push(part.kit[v]); out.col.push(part.col[v * 3], part.col[v * 3 + 1], part.col[v * 3 + 2]);
    }
    out.idx.push(id);
  }
  return out;
}
const P3 = (part, v) => [part.pos[v * 3], part.pos[v * 3 + 1], part.pos[v * 3 + 2]];
const N3 = (part, v) => [part.nrm[v * 3], part.nrm[v * 3 + 1], part.nrm[v * 3 + 2]];
function pushV(part, p, n, w, kit, col = [1, 1, 1]) { part.pos.push(...p); part.nrm.push(...n); part.w.push(w); part.kit.push(kit); part.col.push(...col); return part.pos.length / 3 - 1; }
function wOf(map) { const w = new Float32Array(NS); let s = 0; for (const [k, v] of Object.entries(map)) { w[si[k]] += v; s += v; } for (let i = 0; i < NS; i++) w[i] /= s || 1; return w; }
function smoothNormals(part, from = 0) {
  const n = new Float64Array(part.pos.length);
  for (let k = 0; k < part.idx.length; k += 3) {
    const a = part.idx[k], b = part.idx[k + 1], c = part.idx[k + 2];
    if (a < from && b < from && c < from) continue;
    const fn = cross(sub(P3(part, b), P3(part, a)), sub(P3(part, c), P3(part, a)));
    for (const v of [a, b, c]) for (let j = 0; j < 3; j++) n[v * 3 + j] += fn[j];
  }
  for (let v = from; v < part.pos.length / 3; v++) { const m = norm([n[v * 3], n[v * 3 + 1], n[v * 3 + 2]]); part.nrm[v * 3] = m[0]; part.nrm[v * 3 + 1] = m[1]; part.nrm[v * 3 + 2] = m[2]; }
}

// ------------------------------------------------------------------ ray casting (BVH)
function buildBVH(tris) {          // tris: Float64Array(n*9)
  const n = tris.length / 9, order = new Int32Array(n).map((_, i) => i);
  const cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) cen[i * 3 + c] = (tris[i * 9 + c] + tris[i * 9 + 3 + c] + tris[i * 9 + 6 + c]) / 3;
  const nodes = [];
  function bounds(s, e) {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) { const t = order[i]; for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) { const x = tris[t * 9 + k * 3 + c]; if (x < b[c]) b[c] = x; if (x > b[3 + c]) b[3 + c] = x; } }
    return b;
  }
  function make(s, e) {
    const id = nodes.length, b = bounds(s, e); nodes.push({ b, s, e, l: -1, r: -1 });
    if (e - s <= 6) return id;
    const ax = [b[3] - b[0], b[4] - b[1], b[5] - b[2]].reduce((m, v, i, a) => (v > a[m] ? i : m), 0);
    const sl = Array.from(order.subarray(s, e)).sort((x, y) => cen[x * 3 + ax] - cen[y * 3 + ax]);
    order.set(sl, s);
    const m = (s + e) >> 1;
    nodes[id].l = make(s, m); nodes[id].r = make(m, e);
    return id;
  }
  make(0, n);
  return { tris, order, nodes };
}
function rayHit(bvh, o, d, tmax) {      // nearest hit distance or -1
  const { tris, order, nodes } = bvh;
  const inv = [1 / d[0], 1 / d[1], 1 / d[2]];
  let best = tmax, hitT = -1, hitTri = -1;
  const stack = [0];
  while (stack.length) {
    const nd = nodes[stack.pop()], b = nd.b;
    let t0 = 0, t1 = best;
    for (let c = 0; c < 3; c++) {
      let ta = (b[c] - o[c]) * inv[c], tb = (b[3 + c] - o[c]) * inv[c];
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) break;
    }
    if (t0 > t1) continue;
    if (nd.l < 0) {
      for (let i = nd.s; i < nd.e; i++) {
        const t = order[i] * 9;
        const e1 = [tris[t + 3] - tris[t], tris[t + 4] - tris[t + 1], tris[t + 5] - tris[t + 2]];
        const e2 = [tris[t + 6] - tris[t], tris[t + 7] - tris[t + 1], tris[t + 8] - tris[t + 2]];
        const p = cross(d, e2), det = dot(e1, p);
        if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det, s = [o[0] - tris[t], o[1] - tris[t + 1], o[2] - tris[t + 2]];
        const u = dot(s, p) * id; if (u < 0 || u > 1) continue;
        const q = cross(s, e1), vv = dot(d, q) * id; if (vv < 0 || u + vv > 1) continue;
        const tt = dot(e2, q) * id;
        if (tt > 1e-5 && tt < best) { best = tt; hitT = tt; hitTri = order[i]; }
      }
    } else stack.push(nd.l, nd.r);
  }
  return hitT < 0 ? null : { t: hitT, tri: hitTri };
}
function bvhOf(parts) {
  const all = []; const owner = [];
  for (const p of parts) for (let k = 0; k < p.idx.length; k += 3) { for (let j = 0; j < 3; j++) all.push(...P3(p, p.idx[k + j])); owner.push([p, k]); }
  const b = buildBVH(Float64Array.from(all)); b.owner = owner; return b;
}

// ------------------------------------------------------------------ source parts
const legW = (w) => w[si['thigh.L']] + w[si['thigh.R']] + w[si['shin.L']] + w[si['shin.R']];
const body = loadMesh('Athlete_Body', (p, mat) => (mat === 'Lips' ? KIT.lips : KIT.skin),
  (c) => c[1] > CUT - 0.04);                                                     // leg skin is inside the trousers
// Shoes: drop the socks (inside the trousers), the eye glints, and the tennis
// chest band / rear badge (the cricket shirt gets its own trim).
const shoes = loadMesh('Details_Shoe', () => KIT.fixed, (c) => c[1] < 0.142);
const sole = loadMesh('Details_Sole', () => KIT.fixed);
const CLOTH_DROP = ['forearm.L', 'forearm.R', 'hand.L', 'hand.R'];
const polo = loadMesh('Performance_Polo', () => KIT.shirt, null, CLOTH_DROP);
// Collar (trim), placket (shirt); the shoe tongues in this mesh go white.
const shirtBits = loadMesh('Details_Shirt', (p) => (p[1] < 0.5 ? KIT.fixed : (Math.abs(p[0]) < 0.014 && p[1] < 1.446 ? KIT.shirt : KIT.trim)));
for (let v = 0; v < shirtBits.kit.length; v++) if (shirtBits.kit[v] === KIT.fixed) shirtBits.col.splice(v * 3, 3, 0.93, 0.93, 0.92);
// Accents: only the boot flashes (trim) are kept; the tennis shoulder blocks,
// cuffs, crest and shorts insets are replaced by panels painted into the cloth.
const accents = loadMesh('Details_Accent', () => KIT.trim, (c) => c[1] < 0.5);
const brows = loadMesh('Details_Hair', () => KIT.hair);
const sclera = loadMesh('Details_Sclera', () => KIT.fixed);
const iris = loadMesh('Details_Iris', () => KIT.fixed);
const pupil = loadMesh('Details_Pupil', () => KIT.fixed);
const mouth = loadMesh('Details_Mouth', () => KIT.fixed);
const hairCap = loadMesh('HairCap', () => KIT.hair);
// (The source shorts mesh also carries Courtside's tennis wristbands, out at
// the hands: drop them, they would show as dark bands under the gloves.)
const shorts = loadMesh('Tailored_Shorts', () => KIT.trousers, (c) => !(Math.abs(c[0]) > 0.33 && c[1] > 0.95));
// Sleeve cuffs: the polo's cuff block sits on the sleeve; keep.

// ------------------------------------------------------------------ trousers
// Leg skin (all of it, before removal) for the envelope.
const NA = 36;
const legSkin = loadMesh('Athlete_Body', () => KIT.skin, (c) => c[1] < CUT + 0.02 && c[1] > 0.25);
// Clip the shorts at y = CUT (exact boundary, interpolated attributes).
function clipAbove(part, y0) {
  const out = newPart(part.name);
  const cache = new Map();
  const interp = (a, b) => {
    const key = a < b ? a + '_' + b : b + '_' + a;
    if (cache.has(key)) return cache.get(key);
    const pa = P3(part, a), pb = P3(part, b), t = (y0 - pa[1]) / (pb[1] - pa[1]);
    const w = new Float32Array(NS); for (let i = 0; i < NS; i++) w[i] = part.w[a][i] * (1 - t) + part.w[b][i] * t;
    const id = pushV(out, lerp(pa, pb, t), norm(lerp(N3(part, a), N3(part, b), t)), w, part.kit[a], part.col.slice(a * 3, a * 3 + 3));
    out.pos[id * 3 + 1] = y0;
    cache.set(key, id); return id;
  };
  const keep = new Map();
  const own = (v) => { if (!keep.has(v)) keep.set(v, pushV(out, P3(part, v), N3(part, v), part.w[v], part.kit[v], part.col.slice(v * 3, v * 3 + 3))); return keep.get(v); };
  for (let k = 0; k < part.idx.length; k += 3) {
    const tri = [part.idx[k], part.idx[k + 1], part.idx[k + 2]];
    const inside = tri.map((v) => part.pos[v * 3 + 1] >= y0);
    const nIn = inside.filter(Boolean).length;
    if (nIn === 0) continue;
    if (nIn === 3) { out.idx.push(own(tri[0]), own(tri[1]), own(tri[2])); continue; }
    const poly = [];
    for (let j = 0; j < 3; j++) {
      const a = tri[j], b = tri[(j + 1) % 3];
      if (inside[j]) poly.push(own(a));
      if (inside[j] !== inside[(j + 1) % 3]) poly.push(interp(a, b));
    }
    for (let j = 1; j + 1 < poly.length; j++) out.idx.push(poly[0], poly[j], poly[j + 1]);
  }
  return out;
}
// Slim the baggy tennis shorts below the seat into trouser thighs: pull each
// vertex toward its leg's hanging line, never inside the leg skin + ease.
const envL = legEnvelope(1), envR = legEnvelope(-1);
// The seat and waist come in too, so the shirt hangs over the trousers.
for (let v = 0; v < shorts.pos.length / 3; v++) {
  const y = shorts.pos[v * 3 + 1], k = sstep(0.84, 0.99, y), z = shorts.pos[v * 3 + 2];
  shorts.pos[v * 3] *= 1 - 0.12 * k;
  const seat = Math.exp(-Math.pow((y - 0.93) / 0.11, 2));       // the seat: less bulge behind
  shorts.pos[v * 3 + 2] = -0.02 + (z + 0.02) * (1 - 0.08 * k - (z < -0.02 ? 0.12 * seat : 0));
}
for (let v = 0; v < shorts.pos.length / 3; v++) {
  const p = P3(shorts, v), k = sstep(1.02, 0.86, p[1]);
  if (k <= 0) continue;
  const w = shorts.w[v], sx = w[si['thigh.L']] >= w[si['thigh.R']] ? 1 : -1, env = sx > 0 ? envL : envR;
  const c = env.ax(p[1]), d = [p[0] - c[0], 0, p[2] - c[2]], r = Math.hypot(d[0], d[2]), a = Math.atan2(d[2], d[0]);
  let m = 0; const b = ((Math.round(a / (2 * Math.PI) * NA) % NA) + NA) % NA;
  for (const row of env.rows) m = Math.max(m, row.r[b]);
  const want = Math.max(m + 0.018, 0.08);
  if (r > want) { const r2 = mix(r, want, k * 0.95); shorts.pos[v * 3] = c[0] + d[0] / r * r2; shorts.pos[v * 3 + 2] = c[2] + d[2] / r * r2; }
}
const trousers = clipAbove(shorts, CUT);
trousers.name = 'Trousers';
// Boundary loops at the cut (weld by position first).
function boundaryLoops(part, pred) {
  const key = (v) => P3(part, v).map((x) => Math.round(x * 1e5)).join(',');
  const canon = new Map(), rep = [];
  for (let v = 0; v < part.pos.length / 3; v++) { const k = key(v); if (!canon.has(k)) canon.set(k, v); rep.push(canon.get(k)); }
  const ec = new Map();
  for (let k = 0; k < part.idx.length; k += 3) for (let j = 0; j < 3; j++) {
    const a = rep[part.idx[k + j]], b = rep[part.idx[k + (j + 1) % 3]];
    const kk = a < b ? a + '_' + b : b + '_' + a; ec.set(kk, (ec.get(kk) || 0) + 1);
  }
  const adj = new Map();
  for (const [kk, c] of ec) if (c === 1) { const [a, b] = kk.split('_').map(Number); if (!pred(a) || !pred(b)) continue; (adj.get(a) || adj.set(a, []).get(a)).push(b); (adj.get(b) || adj.set(b, []).get(b)).push(a); }
  const seen = new Set(), loops = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const loop = [s]; seen.add(s); let prev = -1, cur = s;
    for (;;) { const nx = adj.get(cur).find((x) => x !== prev && !seen.has(x)); if (nx === undefined) break; seen.add(nx); loop.push(nx); prev = cur; cur = nx; }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}
const hemLoops = boundaryLoops(trousers, (v) => Math.abs(trousers.pos[v * 3 + 1] - CUT) < 1e-6).sort((a, b) => b.length - a.length).slice(0, 2);
if (hemLoops.length !== 2) throw new Error('expected two trouser-leg loops, got ' + hemLoops.length);
// Skin radius envelope per leg: angular bins around the leg's hanging line.
function legEnvelope(sx) {
  const rows = [];
  const ax = (y) => { const c0 = SJ[sx > 0 ? 'thigh.L' : 'thigh.R'], c1 = SJ[sx > 0 ? 'foot.L' : 'foot.R']; return lerp(c1, c0, (y - c1[1]) / (c0[1] - c1[1])); };
  for (let y = 0.2; y <= CUT + 0.001; y += 0.02) {
    const r = new Float64Array(NA), c = ax(y);
    for (let v = 0; v < legSkin.pos.length / 3; v++) {
      const p = P3(legSkin, v); if (Math.sign(p[0]) !== sx || Math.abs(p[1] - y) > 0.03) continue;
      const d = sub(p, c), a = Math.atan2(d[2], d[0]), rr = Math.hypot(d[0], d[2]);
      const b = ((Math.round(a / (2 * Math.PI) * NA) % NA) + NA) % NA;
      for (const bb of [b - 1, b, b + 1]) { const i = (bb + NA) % NA; r[i] = Math.max(r[i], rr); }
    }
    rows.push({ y, c, r });
  }
  return { rows, ax };
}
function buildLeg(loop, sx) {
  const side = sx > 0 ? 'L' : 'R';
  const env = legEnvelope(sx);
  const c0 = loop.reduce((s, v) => add(s, P3(trousers, v)), [0, 0, 0]).map((x) => x / loop.length);
  // order the loop by angle (counter-clockwise seen from above)
  const ang = (v) => { const d = sub(P3(trousers, v), c0); return Math.atan2(d[2], d[0]); };
  const L = loop.slice().sort((a, b) => ang(a) - ang(b));
  const M = L.length;
  const foot = SJ['foot.' + side], knee = SJ['shin.' + side];
  const hemC = [foot[0] + sx * 0.004, 0, foot[2] - 0.012];
  const rowsY = [];
  const top = CUT, NR = 26;
  for (let j = 1; j <= NR; j++) rowsY.push(top - (top - 0.1) * Math.pow(j / NR, 0.92));
  const envAt = (y, a) => {        // monotone (straight-hanging) envelope: max of the skin at or below y
    let m = 0;
    for (const row of env.rows) if (row.y <= y + 0.001) { const b = ((Math.round(a / (2 * Math.PI) * NA) % NA) + NA) % NA; m = Math.max(m, row.r[b]); }
    return m;
  };
  const base = trousers.pos.length / 3;
  const ids = [L];
  const angles = L.map((v) => ang(v));
  const r0 = L.map((v) => { const d = sub(P3(trousers, v), c0); return Math.hypot(d[0], d[2]); });
  for (let j = 0; j < NR; j++) {
    const y = rowsY[j], u = (top - y) / (top - 0.1);           // 0 at the cut, 1 at the hem
    const ring = [];
    for (let i = 0; i < M; i++) {
      const a = angles[i], ca = Math.cos(a), sa = Math.sin(a);   // x = cos, z = sin  (front = +z)
      const front = Math.max(0, sa);
      // hem height: front breaks lower onto the boot
      const hemY = mix(HEM_BACK, HEM_FRONT, (sa + 1) / 2) + 0.012 * front * front;
      const k = sstep(0.82, 1, u);
      const yy = mix(y, hemY, k * 1.0) + (u >= 1 ? 0 : 0);
      const yv = j === NR - 1 ? hemY : Math.max(yy, hemY + (1 - u) * 0.02);
      const c = lerp(c0, hemC, sstep(0, 1, u)); c[1] = yv;
      // straight-cut leg: a gentle taper, never tighter than the skin + ease
      const straight = mix(mix(0.088, 0.083, Math.abs(ca)), mix(0.072, 0.07, Math.abs(ca)), u);
      const sk = envAt(yv, a) + 0.016;
      let r = Math.max(straight, sk);
      if (yv < 0.2) r = Math.max(r, mix(0.075, 0.084, front) + 0.004);   // room for the boot at the hem
      r = mix(r0[i], r, sstep(0, 0.16, u));
      // pressed front crease
      const crease = Math.exp(-Math.pow((a - Math.PI / 2) / 0.11, 2)) * 0.004 * sstep(0.1, 0.3, u);
      r += crease;
      const p = [c[0] + ca * r, yv, c[2] + sa * r];
      // weights: hips/thigh at the top (from the loop), thigh->shin across the knee, a little foot at the hem
      const wl = trousers.w[L[i]];
      const kn = sstep(knee[1] + 0.07, knee[1] - 0.08, yv);
      const wb = wOf({ ['thigh.' + side]: 1 - kn, ['shin.' + side]: kn * (1 - 0.25 * sstep(0.2, 0.1, yv)), ['foot.' + side]: kn * 0.25 * sstep(0.2, 0.1, yv) });
      const t = sstep(0, 0.12, u), w = new Float32Array(NS);
      for (let q = 0; q < NS; q++) w[q] = wl[q] * (1 - t) + wb[q] * t;
      ring.push(pushV(trousers, p, [ca, 0, sa], w, KIT.trousers, trousers.col.slice(L[i] * 3, L[i] * 3 + 3)));
    }
    ids.push(ring);
  }
  for (let j = 0; j < ids.length - 1; j++) for (let i = 0; i < M; i++) {
    const a = ids[j][i], b = ids[j][(i + 1) % M], c = ids[j + 1][i], d = ids[j + 1][(i + 1) % M];
    trousers.idx.push(a, c, b, b, c, d);
  }
  // fix winding against the outward direction
  // inner turn-up: a short lining inside the hem so the opening has depth
  const hem = ids[ids.length - 1], lin = [];
  for (let i = 0; i < M; i++) {
    const p = P3(trousers, hem[i]), d = norm([p[0] - hemC[0], 0, p[2] - hemC[2]]);
    lin.push(pushV(trousers, [p[0] - d[0] * 0.004, p[1] + 0.035, p[2] - d[2] * 0.004], mul(d, -1), trousers.w[hem[i]], KIT.trousers, [0.8, 0.8, 0.8]));
  }
  const hem2 = [];
  for (let i = 0; i < M; i++) { const p = P3(trousers, hem[i]), d = norm([p[0] - hemC[0], 0, p[2] - hemC[2]]); hem2.push(pushV(trousers, [p[0] - d[0] * 0.003, p[1] + 0.001, p[2] - d[2] * 0.003], mul(d, -1), trousers.w[hem[i]], KIT.trousers, [0.8, 0.8, 0.8])); }
  for (let i = 0; i < M; i++) {
    const a = hem2[i], b = hem2[(i + 1) % M], c = lin[i], d = lin[(i + 1) % M];
    trousers.idx.push(a, b, c, b, d, c);
    // close the cloth edge between outside and lining
    const e = hem[i], f = hem[(i + 1) % M];
    trousers.idx.push(e, hem2[i], f, f, hem2[i], hem2[(i + 1) % M]);
  }
  return { base, M, hemC, c0 };
}
const legs = hemLoops.map((loop) => { const sx = Math.sign(trousers.pos[loop[0] * 3]); return buildLeg(loop, sx); });
// Orient leg faces outward (the loop direction decides the winding).
function fixWinding(part, from, centreFn) {
  for (let k = 0; k < part.idx.length; k += 3) {
    const a = part.idx[k], b = part.idx[k + 1], c = part.idx[k + 2];
    if (a < from && b < from && c < from) continue;
    if (part.kit[a] !== KIT.trousers) continue;
    const fn = cross(sub(P3(part, b), P3(part, a)), sub(P3(part, c), P3(part, a)));
    const cen = mul(add(add(P3(part, a), P3(part, b)), P3(part, c)), 1 / 3);
    const want = dot(N3(part, a), fn) >= 0;
    if (!want) { part.idx[k + 1] = c; part.idx[k + 2] = b; }
  }
}
const legStart = Math.min(...legs.map((l) => l.base));
fixWinding(trousers, legStart);
smoothNormals(trousers, legStart);
// Smooth the normals across the cut so the seam is invisible.
{
  const key = (v) => P3(trousers, v).map((x) => Math.round(x * 1e5)).join(',');
  const groups = new Map();
  for (let v = 0; v < trousers.pos.length / 3; v++) if (Math.abs(trousers.pos[v * 3 + 1] - CUT) < 0.02) { const k = key(v); (groups.get(k) || groups.set(k, []).get(k)).push(v); }
  for (const g of groups.values()) { let n = [0, 0, 0]; for (const v of g) n = add(n, N3(trousers, v)); n = norm(n); for (const v of g) trousers.nrm.splice(v * 3, 3, ...n); }
}
// Recompute the lofted part's normals including the clipped-shorts neighbours at the seam.

// ------------------------------------------------------------------ painted panels
// Kit panels are painted into the cloth itself: every triangle is split
// exactly along the region boundaries (fields >= 0 inside), and the pieces
// inside a region get its kit slot. No layered decals, so nothing to z-fight
// once the cloth is simplified, and the edges stay crisp.
// regions: [{ kit, f: [(v) => number, ...] }]  (v = { p, n, w })
function paint(part, regions) {
  const out = newPart(part.name);
  const cache = new Map();
  const vtx = (i) => ({ p: P3(part, i), n: N3(part, i), w: part.w[i], c: part.col.slice(i * 3, i * 3 + 3), k: part.kit[i] });
  const mixV = (A, B, t) => { const w = new Float32Array(NS); for (let i = 0; i < NS; i++) w[i] = A.w[i] * (1 - t) + B.w[i] * t; return { p: lerp(A.p, B.p, t), n: norm(lerp(A.n, B.n, t)), w, c: lerp(A.c, B.c, t), k: A.k }; };
  const emit = (poly, kit) => {
    const ids = poly.map((q) => {
      const key = q.p.map((x) => Math.round(x * 1e6)).join(',') + '|' + q.n.map((x) => Math.round(x * 100)).join(',') + '|' + kit;
      let id = cache.get(key);
      if (id === undefined) { id = pushV(out, q.p, q.n, q.w, kit, q.c); cache.set(key, id); }
      return id;
    });
    for (let j = 1; j + 1 < ids.length; j++) out.idx.push(ids[0], ids[j], ids[j + 1]);
  };
  const split = (poly, f) => {      // -> [inside, outside]
    const val = poly.map(f), inn = [], outp = [];
    for (let j = 0; j < poly.length; j++) {
      const A = poly[j], B = poly[(j + 1) % poly.length], a = val[j], b = val[(j + 1) % poly.length];
      if (a >= 0) inn.push(A); else outp.push(A);
      if ((a >= 0) !== (b >= 0)) { const m = mixV(A, B, a / (a - b)); inn.push(m); outp.push(m); }
    }
    return [inn.length >= 3 ? inn : null, outp.length >= 3 ? outp : null];
  };
  const process = (poly, kit, r) => {
    if (r === regions.length) { emit(poly, kit); return; }
    let rest = poly;
    for (const f of regions[r].f) {
      const [inn, outp] = split(rest, f);
      if (outp) process(outp, kit, r + 1);
      rest = inn; if (!rest) return;
    }
    process(rest, regions[r].kit, r + 1);
  };
  for (let k = 0; k < part.idx.length; k += 3) {
    const poly = [vtx(part.idx[k]), vtx(part.idx[k + 1]), vtx(part.idx[k + 2])];
    process(poly, poly[0].k, 0);
  }
  Object.assign(part, { pos: out.pos, nrm: out.nrm, w: out.w, kit: out.kit, col: out.col, idx: out.idx });
}
// Shirt: shoulder yoke (panel), sleeve cuffs (trim), side piping (trim), and a
// two-digit seven-segment number on the back (segments 0..6 = left digit as
// read, 7..13 = right; lit ones are drawn in trim, the rest in shirt colour).
{
  const R = [];
  for (const sx of [-1, 1]) R.push({ kit: KIT.panel, f: [(v) => v.p[1] - (1.418 - 0.05 * Math.max(0, sx * v.p[0] - 0.2)), (v) => sx * v.p[0] - 0.072] });
  for (const sx of [-1, 1]) {
    const side = sx > 0 ? 'L' : 'R', S = NJ['arm.' + side], u = norm(sub(NJ['forearm.' + side], S));
    let amax = 0;
    for (let v = 0; v < polo.pos.length / 3; v++) { const q = P3(polo, v); if (sx * q[0] > 0.22) amax = Math.max(amax, dot(sub(q, S), u)); }
    R.push({ kit: KIT.trim, f: [(v) => dot(sub(v.p, S), u) - (amax - 0.026), (v) => sx * v.p[0] - 0.2] });
  }
  const armW = (v) => v.w[si['arm.L']] + v.w[si['arm.R']] + v.w[si['forearm.L']] + v.w[si['forearm.R']];
  for (const sx of [-1, 1]) R.push({ kit: KIT.trim, f: [(v) => v.p[2] - 0.026, (v) => 0.04 - v.p[2], (v) => sx * v.p[0] - 0.12, (v) => 1.315 - v.p[1], (v) => 0.25 - armW(v)] });
  const H = 0.135, Wd = 0.074, T = 0.0095, gap = 0.026, cy = 1.262, slant = 0.07;
  const segs = [[0.14, 1, 0.86, 1], [1, 0.93, 1, 0.57], [1, 0.43, 1, 0.07], [0.14, 0, 0.86, 0], [0, 0.43, 0, 0.07], [0, 0.93, 0, 0.57], [0.14, 0.5, 0.86, 0.5]];
  for (let dgt = 0; dgt < 2; dgt++) {
    const x0 = (dgt === 0 ? 1 : -1) * (gap / 2 + Wd / 2);          // seen from behind, +x is the viewer's left
    segs.forEach((sg, k) => {
      const P = (sxx, syy) => [x0 + (0.5 - sxx) * Wd - (syy - 0.5) * slant * H, cy - H / 2 + syy * H];
      const A = P(sg[0], sg[1]), B = P(sg[2], sg[3]);
      const d = norm([B[0] - A[0], B[1] - A[1], 0]), nn = [-d[1], d[0]];
      const along = (v) => (v.p[0] - A[0]) * d[0] + (v.p[1] - A[1]) * d[1], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const across = (v) => (v.p[0] - A[0]) * nn[0] + (v.p[1] - A[1]) * nn[1];
      R.push({ kit: KIT.number + dgt * 7 + k, f: [(v) => -v.p[2], (v) => -v.n[2], (v) => along(v) + T * 0.6, (v) => L + T * 0.6 - along(v), (v) => T - across(v), (v) => across(v) + T] });
    });
  }
  paint(polo, R);
}
// Trousers: a stripe down the outside of each leg, waist to hem.
{
  const R = [];
  for (const leg of legs) {
    const sx = Math.sign(leg.hemC[0]);
    const zc = (y) => (y >= CUT ? leg.c0[2] : mix(leg.c0[2], leg.hemC[2], sstep(0, 1, (CUT - y) / (CUT - 0.1))));
    R.push({ kit: KIT.trim, f: [(v) => sx * v.p[0] - 0.05, (v) => sx * v.n[0], (v) => v.p[2] - (zc(v.p[1]) - 0.0085), (v) => zc(v.p[1]) + 0.0085 - v.p[2], (v) => 1.05 - v.p[1]] });
  }
  paint(trousers, R);
}

// ------------------------------------------------------------------ assemble
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'elbowL', 'handL', 'shoulderR', 'elbowR', 'handR', 'hipL', 'kneeL', 'ankleL', 'hipR', 'kneeR', 'ankleR'];
const MAP = { hips: 'hips', spine: 'spine', head: 'head', 'arm.L': 'shoulderL', 'forearm.L': 'elbowL', 'hand.L': 'handL', 'arm.R': 'shoulderR', 'forearm.R': 'elbowR', 'hand.R': 'handR', 'thigh.L': 'hipL', 'shin.L': 'kneeL', 'foot.L': 'ankleL', 'thigh.R': 'hipR', 'shin.R': 'kneeR', 'foot.R': 'ankleR' };
const bIndex = Object.fromEntries(BONES.map((b, i) => [b, i]));
const chestY = NJ.spine[1] + 0.6 * (NJ['arm.L'][1] - NJ.spine[1]);
const joints = {};
for (const [g, b] of Object.entries(MAP)) joints[b] = NJ[g];
joints.chest = [0, chestY, NJ.spine[2]];
joints.neck = NJ.head.slice();
joints.head = [NJ.head[0], NJ.head[1] + 0.07, NJ.head[2]];
function toBones(w, y) {
  const b = new Float64Array(BONES.length);
  for (let i = 0; i < NS; i++) if (w[i] > 0) b[bIndex[MAP[SRC[i]]]] += w[i];
  const ts = sstep(chestY - 0.07, chestY + 0.07, y);
  const ws = b[bIndex.spine]; b[bIndex.chest] += ws * ts; b[bIndex.spine] = ws * (1 - ts);
  const th = sstep(joints.neck[1] - 0.02, joints.neck[1] + 0.05, y);         // the neck bends gradually
  const wh = b[bIndex.head]; b[bIndex.neck] += wh * (1 - th); b[bIndex.head] = wh * th;
  const top = [...b.keys()].sort((x, z) => b[z] - b[x]).slice(0, 4);
  const sum = top.reduce((s, k) => s + b[k], 0) || 1;
  return { j: top, w: top.map((k) => b[k] / sum) };
}

// Weld (position + normal + kit + colour) and simplify with normals as attributes.
function weld(part) {
  const map = new Map(), rm = new Uint32Array(part.pos.length / 3), out = newPart(part.name);
  for (let v = 0; v < part.pos.length / 3; v++) {
    const k = [...P3(part, v).map((x) => Math.round(x * 2e4)), ...N3(part, v).map((x) => Math.round(x * 40)), part.kit[v], ...part.col.slice(v * 3, v * 3 + 3).map((x) => Math.round(x * 50))].join(',');
    let id = map.get(k);
    if (id === undefined) { id = pushV(out, P3(part, v), N3(part, v), part.w[v], part.kit[v], part.col.slice(v * 3, v * 3 + 3)); map.set(k, id); }
    rm[v] = id;
  }
  for (const i of part.idx) out.idx.push(rm[i]);
  const keep = [];
  for (let k = 0; k < out.idx.length; k += 3) { const a = out.idx[k], b = out.idx[k + 1], c = out.idx[k + 2]; if (a !== b && b !== c && a !== c) keep.push(a, b, c); }
  out.idx = keep;
  return out;
}
function simplify(part, target, opts = {}) {
  const w = weld(part);
  if (!target || w.idx.length / 3 <= target) return compact(w);
  const pos = Float32Array.from(w.pos), at = new Float32Array(w.pos.length / 3 * 4);
  for (let v = 0; v < w.pos.length / 3; v++) { at[v * 4] = w.nrm[v * 3]; at[v * 4 + 1] = w.nrm[v * 3 + 1]; at[v * 4 + 2] = w.nrm[v * 3 + 2]; at[v * 4 + 3] = w.kit[v] / 4; }
  const flags = opts.lockBorder ? ['LockBorder'] : [];
  const [idx] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(w.idx), pos, 3, at, 4, [0.35, 0.35, 0.35, 1], null, target * 3, opts.err ?? 0.02, flags);
  let out = Array.from(idx);
  if (out.length / 3 > target * 1.15 && !opts.noSloppy) {   // borders held it back: allow more error
    const [idx2] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(w.idx), pos, 3, at, 4, [0.2, 0.2, 0.2, 1], null, target * 3, 0.08, flags);
    out = Array.from(idx2);
  }
  if (out.length / 3 > target * 1.15 && opts.permissive) {   // distant LOD: seams may collapse too
    const [idx3] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(w.idx), pos, 3, at, 4, [0.2, 0.2, 0.2, 0.5], null, target * 3, 0.1, ['Permissive']);
    out = Array.from(idx3);
  }
  w.idx = out;
  return compact(w);
}

// ------------------------------------------------------------------ plan
const PLAN = [ // part, LOD0 tris, LOD1 tris (0 = dropped), opts
  [body, 10200, 1250, { lockBorder: true }],
  [polo, 3900, 520, { lockBorder: true }],
  [trousers, 3000, 450, {}],
  [shoes, 2200, 260, {}],
  [sole, 600, 60, {}],
  [shirtBits, 800, 70, {}],
  [accents, 450, 0, {}],
  [hairCap, 900, 140, {}],
  [brows, 200, 0, {}],
  [sclera, 360, 0, {}],
  [iris, 260, 0, {}],
  [pupil, 140, 0, {}],
  [mouth, 140, 0, {}],
];
const lod0 = PLAN.map(([p, t0, , o]) => simplify(p, t0, o));
const lod1 = PLAN.filter(([, , t1]) => t1 > 0).map(([p, , t1, o]) => simplify(p, t1, { ...o, lockBorder: false, err: 0.05, permissive: true }));

// ------------------------------------------------------------------ ambient occlusion
// Cosine-weighted hemisphere rays against the whole LOD0 figure (bind pose).
const AO_RAYS = 40, AO_DIST = 0.22;
const occluders = lod0;
const aoBVH = bvhOf(occluders);
function bakeAO(part) {
  part.ao = new Float64Array(part.pos.length / 3);
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let v = 0; v < part.pos.length / 3; v++) {
    const n = N3(part, v), p = add(P3(part, v), mul(n, 0.0015));
    const t1 = norm(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0])), t2 = cross(n, t1);
    let occ = 0;
    for (let r = 0; r < AO_RAYS; r++) {
      const u1 = (r + rnd()) / AO_RAYS, u2 = rnd();
      const rr = Math.sqrt(u1), ph = 2 * Math.PI * u2;
      const d = norm(add(add(mul(t1, rr * Math.cos(ph)), mul(t2, rr * Math.sin(ph))), mul(n, Math.sqrt(1 - u1))));
      const h = rayHit(aoBVH, p, d, AO_DIST);
      if (h) occ += 1 - Math.pow(h.t / AO_DIST, 0.7) * 0.6;
    }
    part.ao[v] = 1 - occ / AO_RAYS;
  }
}
for (const p of lod0) bakeAO(p);
// LOD1: copy from the nearest LOD0 vertex of the same part (grid lookup).
function transferAO(dst, srcPart) {
  const cell = 0.03, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  for (let v = 0; v < srcPart.pos.length / 3; v++) { const p = P3(srcPart, v), k = key(...p.map((x) => Math.floor(x / cell))); (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  dst.ao = new Float64Array(dst.pos.length / 3);
  for (let v = 0; v < dst.pos.length / 3; v++) {
    const p = P3(dst, v), c = p.map((x) => Math.floor(x / cell));
    let best = Infinity, ao = 1;
    for (let r = 1; r <= 3 && best === Infinity; r++)
      for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) for (let z = -r; z <= r; z++)
        for (const s of grid.get(key(c[0] + x, c[1] + y, c[2] + z)) || []) { const d = len(sub(P3(srcPart, s), p)); if (d < best) { best = d; ao = srcPart.ao[s]; } }
    dst.ao[v] = ao;
  }
}
lod1.forEach((p) => transferAO(p, lod0.find((q) => q.name === p.name)));

// ------------------------------------------------------------------ write
const chunks = []; let offset = 0;
const push = (typed) => { const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength); const pad = (4 - (b.length % 4)) % 4; chunks.push(b, Buffer.alloc(pad)); const o = offset; offset += b.length + pad; return o; };
const lods = [];
for (const L of [lod0, lod1]) {
  const parts = [];
  for (const p of L) {
    const vc = p.pos.length / 3;
    if (vc > 65535) throw new Error(p.name + ' has too many vertices');
    const nb = new Int8Array(vc * 4), cb = new Uint8Array(vc * 4), jb = new Uint8Array(vc * 4), wb = new Uint8Array(vc * 4);
    for (let v = 0; v < vc; v++) {
      for (let c = 0; c < 3; c++) { nb[v * 4 + c] = Math.round(p.nrm[v * 3 + c] * 127); cb[v * 4 + c] = Math.round(clamp(p.col[v * 3 + c], 0, 1) * 255); }
      nb[v * 4 + 3] = p.kit[v];
      cb[v * 4 + 3] = Math.round(clamp(p.ao[v], 0, 1) * 255);
      const t = toBones(p.w[v], p.pos[v * 3 + 1]);
      let s8 = 0;
      for (let c = 0; c < 4; c++) { jb[v * 4 + c] = t.j[c]; wb[v * 4 + c] = Math.round(t.w[c] * 255); s8 += wb[v * 4 + c]; }
      wb[v * 4] += 255 - s8;
    }
    parts.push({ name: p.name, vCount: vc, iCount: p.idx.length,
      pos: push(Float32Array.from(p.pos)), nrmKit: push(nb), col: push(cb), joints: push(jb), weights: push(wb), idx: push(Uint16Array.from(p.idx)) });
  }
  lods.push({ parts, tris: parts.reduce((s, p) => s + p.iCount / 3, 0) });
}

// Landmarks for gear: the skull (hair cap + forehead), eyes, head top.
const bb = (parts, f) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (const p of parts) for (let v = 0; v < p.pos.length / 3; v++) { const q = P3(p, v); if (f && !f(q)) continue; for (let c = 0; c < 3; c++) { b[c] = Math.min(b[c], q[c]); b[c + 3] = Math.max(b[c + 3], q[c]); } } return b; };
const capB = bb([hairCap]);
const eyeB = bb([sclera]);
const faceB = bb([body], (q) => q[1] > eyeB[4] - 0.01 && q[1] < capB[4] && Math.abs(q[0]) < 0.03);
const chinB = bb([body], (q) => q[1] > joints.neck[1] && q[2] > eyeB[2] - 0.02 && Math.abs(q[0]) < 0.02);
const headCentre = [0, (capB[4] + chinB[1]) / 2 + 0.01, (capB[2] + faceB[5]) / 2];
const eyeY = (eyeB[1] + eyeB[4]) / 2;
const foreZ = bb([body], (q) => q[1] > eyeY + 0.03 && q[1] < eyeY + 0.06 && Math.abs(q[0]) < 0.03)[5];
const skullC = [0, eyeY + 0.02, (capB[2] + foreZ) / 2], skullR = [capB[3], capB[4] - eyeY - 0.02, (foreZ - capB[2]) / 2];
const headSize = [(capB[3] - capB[0]) / 2, (capB[4] - chinB[1]) / 2, (faceB[5] - capB[2]) / 2];
const outDir = path.resolve('assets/models');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'athlete.bin'), Buffer.concat(chunks));
const round = (a) => a.map((x) => Math.round(x * 1e5) / 1e5);
fs.writeFileSync(path.join(outDir, 'athlete.json'), JSON.stringify({
  source: 'Courtside Athlete.glb (MakeHuman HM08 derived, CC0-1.0)', bones: BONES,
  joints: Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, round(v)])),
  headCentre: round(headCentre), headSize: round(headSize), skull: { c: round(skullC), r: round(skullR) }, headTop: Math.round(capB[4] * 1e4) / 1e4,
  eyeY: Math.round((eyeB[1] + eyeB[4]) / 2 * 1e4) / 1e4, chinY: Math.round(chinB[1] * 1e4) / 1e4, kit: KIT, lods,
}));
console.log('athlete:', lods.map((l) => `${l.tris} tris`).join(' / '), `${(offset / 1024).toFixed(0)} KB`);
console.log(lods.map((l) => l.parts.map((p) => `${p.name}:${p.iCount / 3}`).join(' ')).join('\n'));
console.log('skull', round(skullC), round(skullR), 'head centre', round(headCentre), 'size', round(headSize), 'top', capB[4].toFixed(3), 'chin', chinB[1].toFixed(3), 'eyes', ((eyeB[1] + eyeB[4]) / 2).toFixed(3));
console.log('joints', JSON.stringify(Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, round(v)]))));
