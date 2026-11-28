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
import { nm, hyp, hyp3 } from './anim.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildGear } from './gear.js';
import { TEAMS, SKIN_TONES, HAIR, lookFor, lookTextures, ATLAS, glyphOf } from './playerLook.js';
import { buildTrousers } from './trousers.js';
import { replaceHead } from './headMesh.js';

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
  // Proportions (bind space, joints and skin together, before the skeleton is set up from them).
  athleteBuild(lods, J, meta);
  adultFace(lods, meta);
  sculptHead(lods, meta);
  const headL = replaceHead(lods, J, meta);
  fitClothes(lods, J, meta);
  slimBoots(lods, J, meta);
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
  // (the new head's own landmarks: headMesh.js)
  Object.assign(face, { brow: headL.brow - 0.001, nose: headL.nose, chin: headL.C, mouth: [0.0195, headL.mouth], front: headL.zF });
  lods.forEach((L, i) => L.forEach((p) => refinePart(p, i)));
  return { sole, toe, floor, bones: meta.bones, index: Object.fromEntries(meta.bones.map((b, i) => [b, i])), J, canon, bindQ, inverses, lods, headCentre: new THREE.Vector3(...meta.headCentre), headSize: new THREE.Vector3(...(meta.headSize || [0.1, 0.14, 0.125])), skull: meta.skull, face, geoCache: new Map() };
}

// An athlete's proportions from the source's cartoon ones (bind space, before
// the skeleton is built):
//  * broader shoulders: the deltoids and the shirt over them pushed out by up
//    to 1.8 cm a side, by each vertex's upper-arm weight, fading out down the
//    upper arm (the forearms, hands and the gloves on them are not moved);
//  * a smaller head (0.9 about the head joint, by each vertex's head weight):
//    about 1/7.5 of the height instead of 1/6.7. The landmarks gear is fitted
//    to (skull, head centre, chin, eyes) are scaled with it.
// No joint moves and no bone changes length: the clips, IK, foot plants and
// your own body (its head, gloves on the bat, legs and pads) are as before.
const SHOULDER_OUT = 0.005, HEAD_K = 0.9;
function athleteBuild(lods, J, meta) {
  const B = meta.bones, ih = B.indexOf('head'), isL = B.indexOf('shoulderL'), isR = B.indexOf('shoulderR');
  const iT = [B.indexOf('spine'), B.indexOf('chest')];
  const Jh = J.head.clone(), ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (const L of lods) for (const p of L) {
    const P = p.geo.attributes.position, SI = p.geo.attributes.skinIndex, SW = p.geo.attributes.skinWeight;
    for (let v = 0; v < P.count; v++) {
      let wl = 0, wr = 0, wh = 0, wt = 0;
      for (let k = 0; k < 4; k++) {
        const b = SI.getComponent(v, k), w = SW.getComponent(v, k);
        if (b === isL) wl += w; else if (b === isR) wr += w; else if (b === ih) wh += w; else if (b === iT[0] || b === iT[1]) wt += w;
      }
      let x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      // An athlete's trunk, not the cartoon's barrel: the chest and the shirt over it taken in by 6%
      // about the spine above the waist (skin and cloth together, so nothing pokes through), and the
      // deltoids and the sleeves over them 11% toward the upper arm's line (no puffed shoulder domes).
      if (y > 1.05) {
        const k = 0.06 * ss(1.08, 1.22, y) * wt;
        x -= x * k; z -= (z - 0.04) * k;
      }
      if (wl + wr > 0) {
        const s0 = x > 0 ? J.shoulderL : J.shoulderR, e0 = x > 0 ? J.elbowL : J.elbowR;
        const ux = e0.x - s0.x, uy = e0.y - s0.y, uz = e0.z - s0.z, L2 = ux * ux + uy * uy + uz * uz;
        const ta = Math.max(0, ((x - s0.x) * ux + (y - s0.y) * uy + (z - s0.z) * uz) / L2);
        const k = 0.11 * (wl + wr) * (1 - ss(0.45, 0.95, ta));
        x -= (x - s0.x - ux * ta) * k; y -= (y - s0.y - uy * ta) * k; z -= (z - s0.z - uz * ta) * k;
      }
      // (along the upper arm: full at the shoulder, none by the elbow)
      const sd = x > 0 ? J.shoulderL : J.shoulderR, ed = x > 0 ? J.elbowL : J.elbowR;
      const t = ((x - sd.x) * (ed.x - sd.x) + (y - sd.y) * (ed.y - sd.y)) / ((ed.x - sd.x) ** 2 + (ed.y - sd.y) ** 2);
      // (out along the surface's own normal, mostly: a rounded deltoid, not a squared-off pad)
      const k = SHOULDER_OUT * (wl + wr) * (1 - ss(0.25, 0.85, t)), N = p.geo.attributes.normal;
      x += k * (0.35 * Math.sign(wl - wr) + 0.65 * N.getX(v)); y += k * 0.5 * N.getY(v); z += k * 0.65 * N.getZ(v);
      if (wh > 0) { const k = 1 - (1 - HEAD_K) * wh; x = Jh.x + (x - Jh.x) * k; y = Jh.y + (y - Jh.y) * k; z = Jh.z + (z - Jh.z) * k; }
      P.setXYZ(v, x, y, z);
    }
  }
  const hs = (q) => [Jh.x + (q[0] - Jh.x) * HEAD_K, Jh.y + (q[1] - Jh.y) * HEAD_K, Jh.z + (q[2] - Jh.z) * HEAD_K];
  if (meta.skull) meta.skull = { c: hs(meta.skull.c), r: meta.skull.r.map((r) => r * HEAD_K) };
  if (meta.headCentre) meta.headCentre = hs(meta.headCentre);
  if (meta.headSize) meta.headSize = meta.headSize.map((r) => r * HEAD_K);
  for (const k of ['eyeY', 'chinY', 'headTop']) if (meta[k]) meta[k] = Jh.y + (meta[k] - Jh.y) * HEAD_K;
}

// Boots: a smaller toe box (REVIEW7: oversized slippers at 3 m): narrower and lower toward the toe,
// a touch shorter; the heel and the ankle (and the trousers' hem over them) as they were.
function slimBoots(lods, J, meta) {
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const ia = meta.bones.indexOf('ankleL'), ib = meta.bones.indexOf('ankleR');
  let y0 = Infinity;                    // the soles' bottom
  for (const p of lods[0]) { const P = p.geo.attributes.position, SI = p.geo.attributes.skinIndex; if (SI) for (let v = 0; v < P.count; v++) { const b = SI.getComponent(v, 0); if (b === ia || b === ib) y0 = Math.min(y0, P.getY(v)); } }
  const sy = y0 + 0.014;                // (the sole itself keeps its height)
  for (const L of lods) for (const p of L) {
    const P = p.geo.attributes.position, SI = p.geo.attributes.skinIndex, SW = p.geo.attributes.skinWeight;
    if (!SI) continue;
    for (let v = 0; v < P.count; v++) {
      let wl = 0, wr = 0;
      for (let k = 0; k < 4; k++) { const b = SI.getComponent(v, k); if (b === ia) wl += SW.getComponent(v, k); else if (b === ib) wr += SW.getComponent(v, k); }
      if (wl + wr < 0.5) continue;
      const A = wl > wr ? J.ankleL : J.ankleR, x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      const f = ss(0.015, 0.1, z - A.z) * ss(A.y + 0.03, A.y - 0.01, y);
      if (f <= 0) continue;
      const cx = A.x + Math.sign(A.x) * 0.004;
      P.setXYZ(v, cx + (x - cx) * (1 - 0.1 * f), y > sy ? sy + (y - sy) * (1 - 0.18 * f) : y, A.z + (z - A.z) * (1 - 0.07 * f));
    }
  }
}

// Clothes that fit: the trousers rebuilt (trousers.js), the shirt taken in
// at the waist (a fitted cut that still hangs over the trousers' waistband).
function fitClothes(lods, J, meta) {
  lods.forEach((L, lod) => L.forEach((p) => {
    if (p.name === 'Trousers') { p.geo = buildTrousers(J, meta.bones, lod); weldNormals(p.geo, 0.5, true, 1); }
    if (p.name === 'Athlete_Body') {
      // (the source's thigh skin left inside the shorts would poke through the fitted trousers)
      const P = p.geo.attributes.position, I = p.geo.index.array, keep = [];
      const hidden = (v) => P.getY(v) < 0.99 && Math.abs(P.getX(v)) < 0.3;
      for (let t = 0; t < I.length; t += 3) if (!(hidden(I[t]) && hidden(I[t + 1]) && hidden(I[t + 2]))) keep.push(I[t], I[t + 1], I[t + 2]);
      p.geo.setIndex(keep);
    }
    if (p.name !== 'Performance_Polo') return;
    const P = p.geo.attributes.position, SI = p.geo.attributes.skinIndex, SW = p.geo.attributes.skinWeight, B = meta.bones;
    const arms = ['shoulderL', 'elbowL', 'shoulderR', 'elbowR'].map((n) => B.indexOf(n));
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    for (let v = 0; v < P.count; v++) {
      const y = P.getY(v);
      if (y > 1.34) continue;
      let wa = 0;
      for (let k = 0; k < 4; k++) if (arms.includes(SI.getComponent(v, k))) wa += SW.getComponent(v, k);
      const f = 1 - (0.075 * ss(1.34, 1.17, y) - 0.015 * ss(1.14, 1.08, y)) * (1 - wa);
      P.setX(v, P.getX(v) * f); P.setZ(v, 0.052 + (P.getZ(v) - 0.052) * f);
    }
  }));
}

// The source face is a friendly cartoon's: round cheeks, a short chin, huge
// irises. In bind space, before anything else reads the mesh: the cheeks and
// jaw slimmed, the chin longer and a touch forward, the irises smaller (the
// eye white shows round them), the neck a little thicker above the collar.
function adultFace(lods, meta) {
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const eyeY = meta.eyeY || 1.655, chinY = meta.chinY || 1.52;
  let mouthY = 1.5805;
  { const m = lods[0].find((p) => p.name === 'Details_Mouth'); if (m) { const P = m.geo.attributes.position; let y = 0; for (let v = 0; v < P.count; v++) y += P.getY(v); mouthY = y / P.count; } }
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
    const noseY = mouthY + 0.42 * (eyeY - mouthY), g = (t) => Math.exp(-t * t);
    for (let v = 0; v < P.count; v++) {
      let x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      if (y < 1.44 || y > eyeY + 0.05) continue;
      const ax = Math.abs(x), front = ss(-0.01, 0.07, z);
      // cheeks slimmer (the cartoon's round cheek); the jaw keeps its width and squares at the angle
      const cheek = ss(eyeY - 0.004, eyeY - 0.03, y) * ss(mouthY - 0.01, mouthY + 0.012, y) * front;
      const lower = ss(eyeY - 0.004, eyeY - 0.03, y) * ss(chinY - 0.02, chinY + 0.01, y) * front;
      x *= 1 - 0.02 * cheek - 0.025 * lower;
      // flatter cheeks in front, a squarer jaw angle further back (an adult man's lower face, not a child's)
      x *= 1 - 0.075 * g((y - mouthY - 0.008) / 0.026) * ss(0.07, 0.12, z);
      x *= 1 + 0.06 * ss(chinY - 0.01, chinY + 0.015, y) * ss(mouthY + 0.012, mouthY - 0.006, y) * g((z - 0.03) / 0.035);
      // the chin longer, a touch forward and broader at its point
      const chin = ss(mouthY + 0.004, chinY - 0.004, y) * front * ss(chinY - 0.035, chinY - 0.005, y);
      y -= 0.011 * chin; z += 0.005 * chin; x *= 1 + 0.12 * chin * ss(0.035, 0, ax);
      // the mouth: the cartoon's is very wide
      const mw = g((y - mouthY) / 0.013) * ss(0.065, 0.035, ax) * ss(0.1, 0.13, z);
      x *= 1 - 0.12 * mw;
      // a brow ridge over the eyes, a real bridge to the nose, a slightly larger nose
      z += 0.0045 * g((y - eyeY - 0.024) / 0.011) * ss(0.065, 0.04, ax) * ss(0.11, 0.15, z);
      z += 0.005 * g(ax / 0.009) * ss(noseY - 0.005, noseY + 0.01, y) * ss(eyeY + 0.015, eyeY - 0.002, y) * ss(0.13, 0.16, z);
      z += 0.003 * g(hyp(ax / 0.014, (y - noseY - 0.004) / 0.012)) * ss(0.14, 0.165, z);
      // neck: a little thicker between the collar and the jaw
      const neck = ss(1.455, 1.485, y) * ss(1.54, 1.51, y) * (1 - cheek);
      x *= 1 + 0.03 * neck;
      P.setXYZ(v, x, y, z);
    }
  }
}

// A sculpted adult head from the source's round cartoon one, in bind space at load (every LOD,
// skin, lips, brows and hair cap moved alike; no vertex added): a cranium longer front to back than
// wide with flatter temples, a brow ridge over recessed eye sockets, a nose with a bridge, a
// projecting tip and wings, cheekbones over hollows, lips with volume over a philtrum, a chin and a
// jaw with a defined angle, and the sternomastoids running from behind the ears to the collar.
// Each feature is a smooth field (a few Gaussians); the lids round the eyeballs are left exactly
// where they are, so nothing opens up round the eyes. Per-player variation (FIG(17): nose, brow,
// jaw, age) moves these same features further in the vertex shader.
function sculptHead(lods, meta) {
  const eyeY = meta.eyeY, chinY = meta.chinY;
  let mouthY = 1.58, ex = 0.032, ez = 0.15;
  { const m = lods[0].find((p) => p.name === 'Details_Mouth'); if (m) { const P = m.geo.attributes.position; let y = 0; for (let v = 0; v < P.count; v++) y += P.getY(v); mouthY = y / P.count; } }
  { const ir = lods[0].find((p) => p.name === 'Details_Iris'); if (ir) { const P = ir.geo.attributes.position; let x = 0, z = 0, n = 0; for (let v = 0; v < P.count; v++) if (P.getX(v) > 0) { x += P.getX(v); z += P.getZ(v); n++; } if (n) { ex = x / n; ez = z / n; } } }
  const noseY = mouthY + 0.42 * (eyeY - mouthY);
  const G = (t) => Math.exp(-t * t), G2 = (a, b) => Math.exp(-a * a - b * b);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const out = [0, 0, 0];
  // displacement at a bind point (head-local fields); returns out
  const field = (x, y, z, cranOnly) => {
    out[0] = 0; out[1] = 0; out[2] = 0;
    const ax = Math.abs(x), sx = x < 0 ? -1 : 1;
    // cranium: longer front to back, flatter at the temples (above the brows and ears)
    const cr = ss(eyeY + 0.02, eyeY + 0.05, y);
    out[0] -= x * 0.07 * cr * ss(0.04, 0.08, ax) * ss(-0.06, 0.0, z);
    out[2] -= 0.013 * cr * ss(0.02, -0.04, z) * ss(1.795, 1.73, y);
    if (cranOnly) return out;
    const front = ss(0.08, 0.12, z);
    // the lids round the eyeballs stay put
    const lid = 1 - G2((ax - ex) / 0.021, (y - eyeY) / 0.0135);
    // the face narrower below the eyes (the cartoon's broad cheeks and jaw), the ears left where they are
    const lowF = ss(eyeY + 0.005, eyeY - 0.02, y) * ss(chinY - 0.02, chinY + 0.01, y) * ss(-0.01, 0.04, z) * (1 - ss(0.078, 0.088, ax) * ss(0.06, 0.03, z));
    out[0] -= x * 0.09 * lowF;
    // the face a wedge seen from above, not a flat plate: from the nose back to the cheeks and
    // temples (the source's cheeks stand level with its nose); the eyes go back with it (below)
    const wedge = ss(chinY - 0.015, chinY + 0.01, y) * ss(eyeY + 0.07, eyeY + 0.035, y) * ss(0.0, 0.06, z) * (1 - ss(0.078, 0.088, ax) * ss(0.06, 0.03, z));
    const wv = 3.2 * Math.max(0, ax - 0.012) ** 2, we = 3.2 * (ex - 0.012) ** 2;
    out[2] -= (we + (wv - we) * lid) * wedge;          // (round the eyes: as the eyeball goes)
    // the neck slimmer between the jaw and the collar
    out[0] -= x * 0.08 * ss(1.485, 1.505, y) * ss(chinY + 0.005, chinY - 0.02, y) * ss(0.04, -0.02, z - 0.04);
    // brow ridge (glabella to the outer brow), the nasion recessed under it
    out[2] += 0.008 * G((y - eyeY - 0.021) / 0.009) * ss(0.072, 0.045, ax) * front * lid;
    out[2] -= 0.0045 * G2(ax / 0.011, (y - eyeY - 0.004) / 0.008) * front;
    // eye sockets: the hollow between the brow and the lid, and under the lid toward the cheek
    out[2] -= 0.0028 * G2((ax - ex) / 0.018, (y - eyeY - 0.012) / 0.005) * lid * front;
    out[2] -= 0.002 * G2((ax - ex - 0.004) / 0.016, (y - eyeY + 0.016) / 0.005) * lid * front;
    // nose: the bridge rising from the nasion to a projecting tip, the columella back to the lip
    const ny = (y - noseY) / (eyeY - noseY);          // 0 at the nose's base, 1 at the eyes
    const dors = ss(1.05, 0.15, ny) * ss(-0.35, 0.05, ny);
    out[2] += 0.016 * dors * (1 - 0.6 * ny) * G(ax / (0.0065 + 0.004 * (1 - ny))) * front;
    out[2] += 0.004 * G2(ax / 0.009, (y - noseY + 0.004) / 0.004) * front;          // the columella
    out[0] += sx * 0.002 * G2((ax - 0.015) / 0.006, (y - noseY - 0.002) / 0.006) * front;   // the wings
    // cheekbones out and forward, the hollow under them in
    const cb = G2((ax - 0.05) / 0.015, (y - eyeY + 0.024) / 0.009);
    out[0] += sx * 0.004 * cb; out[2] += 0.003 * cb * front;
    const ho = G2((ax - 0.052) / 0.016, (y - noseY + 0.014) / 0.016);
    out[0] -= sx * 0.006 * ho; out[2] -= 0.004 * ho * ss(0.04, 0.09, z);
    // lips with volume, the philtrum's ridge, the fold under the lower lip
    out[2] += 0.0028 * G2(ax / 0.02, (y - mouthY - 0.006) / 0.004) * front;
    out[2] += 0.0032 * G2(ax / 0.019, (y - mouthY + 0.006) / 0.0045) * front;
    out[2] -= 0.0025 * G2(ax / 0.022, (y - mouthY + 0.016) / 0.004) * front;
    // the chin forward and square, the jaw's angle out and its lower edge defined
    out[2] += 0.008 * G2(ax / 0.021, (y - chinY - 0.012) / 0.011) * front;
    out[1] -= 0.004 * G2(ax / 0.022, (y - chinY - 0.006) / 0.008) * front;
    const go = G2((ax - 0.066) / 0.012, (y - chinY - 0.03) / 0.014) * ss(-0.02, 0.02, z) * ss(0.11, 0.07, z);
    out[0] += sx * 0.006 * go; out[1] -= 0.003 * go;
    const sub = ss(chinY + 0.004, chinY - 0.012, y) * ss(1.49, 1.51, y) * ss(0.0, 0.06, z);
    out[2] -= 0.006 * sub;                             // under the jaw: in toward the throat
    // the sternomastoids, from behind the ears down and in to the top of the breastbone
    const t = Math.min(1, Math.max(0, (1.6 - y) / 0.14)), px = 0.058 - 0.046 * t, pz = -0.012 + 0.07 * t;
    const sm = G2((ax - px) / 0.011, (z - pz) / 0.014) * ss(1.455, 1.48, y) * ss(1.61, 1.58, y);
    out[0] += sx * 0.0035 * sm; out[2] += 0.0025 * sm;
    return out;
  };
  // (the eyeballs move as a whole with the lids round them: the field at each eye's centre)
  const eyeD = [field(ex, eyeY, ez, false).slice(), field(-ex, eyeY, ez, false).slice()];
  for (const L of lods) for (const p of L) {
    const name = p.name;
    if (name === 'Details_Sclera' || name === 'Details_Iris' || name === 'Details_Pupil') {
      const P = p.geo.attributes.position;
      for (let v = 0; v < P.count; v++) { const d = eyeD[P.getX(v) > 0 ? 0 : 1]; P.setXYZ(v, P.getX(v) + d[0], P.getY(v) + d[1], P.getZ(v) + d[2]); }
      continue;
    }
    if (name !== 'Athlete_Body' && name !== 'Details_Mouth' && name !== 'Details_Hair' && name !== 'HairCap') continue;
    const P = p.geo.attributes.position, cran = name === 'HairCap';
    for (let v = 0; v < P.count; v++) {
      const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      if (y < 1.44) continue;
      const d = field(x, y, z, cran);
      P.setXYZ(v, x + d[0], y + d[1], z + d[2]);
    }
  }
  // the skull the headgear fits round: narrower at the temples, a little longer behind
  if (meta.skull) { const r = meta.skull.r; meta.skull = { c: [meta.skull.c[0], meta.skull.c[1], meta.skull.c[2] - 0.005], r: [r[0] * 0.96, r[1], r[2] + 0.005] }; }
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
  if (lod > 0) weldNormals(g, 0.3, true, 3);
  else if (p.name === 'Athlete_Body' || p.name === 'Details_Mouth') weldNormals(g, 0.5, false, 2);
  // (the shirt's painted panels split its vertices, and the simplifier left creases on the shoulders,
  // upper arms and collar: one smooth normal per place, then smoothed over its neighbours)
  else if (p.name === 'Performance_Polo' || p.name === 'Details_Shirt') weldNormals(g, 0.35, true, 2);
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
    for (const e of E) d = Math.min(d, hyp3(P.getX(v) - P.getX(e), P.getY(v) - P.getY(e), P.getZ(v) - P.getZ(e)));
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
        const l = hyp3(x, y, z) || 1; out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l;
      }
      // (vertices at one place keep one normal)
      const acc = new Float32Array(G * 3);
      for (let v = 0; v < P.count; v++) for (let k = 0; k < 3; k++) acc[gid[v] * 3 + k] += out[v * 3 + k];
      for (let v = 0; v < P.count; v++) {
        const q = gid[v] * 3, l = hyp3(acc[q], acc[q + 1], acc[q + 2]) || 1;
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
    // (packed for lowest(): per point its influences, each [bone, w x, w y, w z, w], and the bones they use)
    const n = new Uint8Array(ids.length), e = [], u = new Set();
    for (let k = 0; k < ids.length; k++) for (let j = 0; j < 4; j++) {
      const w = sw[k * 4 + j];
      if (!w) continue;
      n[k]++; u.add(si[k * 4 + j]);
      e.push(si[k * 4 + j], w * p[k * 3], w * p[k * 3 + 1], w * p[k * 3 + 2], w);
    }
    return { p, si, sw, r: rad[b] + 0.12, n, e: Float64Array.from(e), u: Int8Array.from(u) };
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
    uTime: { value: 0 },           // s (Humanoid.updateLods): breathing, blinks
    // decals: centre x, y and half sizes (bind metres)
    uCrestAt: V4(0.088, 1.352, 0.03, 0.03), uSponsorAt: V4(0, 1.252, 0.105, 0.028), uMakerAt: V4(-0.088, 1.367, 0.017, 0.0085),
    uNumberAt: V4(0, 1.262, 0.094, 0.07), uCapAt: V4(0, sk.c[1] + 0.062, 0.021, 0.021),
    uGlyph: { value: ATLAS.glyph.clone() }, uMakerUV: { value: ATLAS.maker.clone() },
    uDetail: { value: 1 },        // quality.js: 0 skips the cloth's procedural folds and their bump (every figure)
  };
  return SHARED;
}
const KIT_GLSL_COMMON = /* glsl */`
  // The figure's look, from the tail of its bone texture (Humanoid.writeLook): FIG(0..16) =
  // kit1 + seed, kit2 + lod, kit3 + team, kit4 + no head, skin + gloved, hair + hidden hand,
  // panel + shades, iris + name length, look (build, hair volume, sleeves, sweatband),
  // look2 (beard, stubble, hair cut, zinc), crest rect, sponsor rect, brim + tens, the name's
  // 12 glyphs, units, look3 (age, nose, brow, jaw), look4 (expression). The kit's first two colours and the sleeves / sweatband go on to the
  // fragments as flat varyings (cloth and skin use them); the rest is fetched where it is used.
  #define FIG(i) texelFetch(boneTexture, ivec2((i) & 15, 14 + ((i) >> 4)), 0)
  flat varying vec3 vK1; flat varying vec3 vK2; flat varying vec2 vLookZW;
  uniform vec4 uArmL; uniform vec4 uArmR; uniform vec3 uShoulderL; uniform vec3 uShoulderR;
  uniform vec4 uSkull; uniform float uTime;
  varying vec3 vBind; varying float vArmW; varying vec2 vTro;
  flat varying float vSlot; flat varying vec4 vMat;
  // The hair on the head (headMesh.js: the scalp is skin): how much of it covers a bind point, by
  // haircut st (0 crop, 1 fade at the sides, 2 side part, 3 receding, 4 longer on top, 5 shaved);
  // a soft hairline that dips at the temples, sideburns, a nape. vol: how far it stands (0..1).
  float hairCover(vec3 p, float st, out float vol) {
    vec3 q = p - uSkull.xyz;
    float a = abs(atan(q.x, q.z));
    // (the line: 5.5 cm over the brow in front, down at the temples, curving back ABOVE the ear (the ear
    // is at a = 1.68..2.09, q.y = -0.065..-0.003) and leaving it clear, then down behind it to the nape)
    float yl = 0.059;
    yl = mix(yl, 0.048, smoothstep(0.0, 0.55, a));
    yl = mix(yl, 0.02, smoothstep(0.55, 1.2, a));
    yl = mix(yl, 0.01, smoothstep(1.2, 1.6, a));
    yl = mix(yl, -0.055, smoothstep(2.2, 2.55, a));
    yl = mix(yl, -0.086, smoothstep(2.55, 3.1, a));
    if (abs(st - 3.0) < 0.5) yl += 0.028 * exp(-pow((a - 0.5) / 0.25, 2.0)) + 0.016 * (1.0 - smoothstep(0.0, 0.7, a));   // (receding: deep temples)
    if (abs(st - 4.0) < 0.5) yl -= 0.008 * (1.0 - smoothstep(0.3, 0.7, a));                                              // (a fringe forward)
    float cv = smoothstep(yl - 0.004, yl + 0.005, q.y);
    // sideburns: about 2 cm wide in front of the ear, narrowing down to mid-ear (to the lobe on a longer
    // cut, short on a fade), soft at the end
    float sb = abs(st - 4.0) < 0.5 ? -0.05 : abs(st - 1.0) < 0.5 ? -0.02 : -0.034;
    float sw = 0.06 + 0.07 * smoothstep(sb, yl, q.y);
    cv = max(cv, smoothstep(sw, sw - 0.04, abs(a - 1.5)) * smoothstep(sb - 0.006, sb + 0.006, q.y) * step(q.y, yl + 0.01));
    float sides = smoothstep(0.7, 1.0, a) * smoothstep(0.045, 0.0, q.y);
    // (the hair thickens over two or three centimetres from its line, so the volume rises off the skin
    // as a slope, not a step along the mesh's rows; a sideburn lies flat). The cuts' silhouettes apart:
    // a crop close, a fade bare at the sides, a side part swept over, a longer top standing up.
    vol = smoothstep(yl, yl + 0.028, q.y);
    if (st < 0.5) vol *= 0.6;
    if (abs(st - 1.0) < 0.5) { cv *= 1.0 - 0.75 * sides; vol *= 1.0 - sides; }
    if (abs(st - 2.0) < 0.5) { cv *= 1.0 - 0.6 * smoothstep(0.003, 0.0, abs(q.x - 0.028)) * step(0.05, q.y) * step(a, 1.3);
      vol *= 1.0 + 0.8 * smoothstep(0.03, -0.01, q.x) * smoothstep(0.02, 0.06, q.y); }
    if (abs(st - 4.0) < 0.5) vol *= 1.0 + 1.8 * smoothstep(0.02, 0.07, q.y);
    if (st > 4.5) { cv *= 0.5; vol = 0.0; }
    return cv;
  }
  // position along the arm (0 shoulder .. 1 wrist) of a bind-space point, and its distance off the arm's line
  vec2 armAt(vec3 p) {
    bool l = p.x > 0.0;
    vec3 d = p - (l ? uShoulderL : uShoulderR); vec4 a = l ? uArmL : uArmR;
    float t = dot(d, a.xyz) / (a.w * a.w);
    return vec2(t, length(d - a.xyz * t));
  }
`;
// The kit shader's values that are the same for every figure and never change (the rig's
// landmarks and bone indices, the decals' places, the lettering atlas): written into the
// shader as constants, not uniforms, so nothing of them is uploaded per figure per draw.
// (float32 values printed so they come back as the same float32)
const CONST_UNIFORMS = ['uFaceRect', 'uFaceMisc', 'uEye', 'uKneeL', 'uAnkleL', 'uLegAxis', 'uShoulderL', 'uShoulderR', 'uArmL', 'uArmR', 'uSkull',
  'uCrestAt', 'uSponsorAt', 'uMakerAt', 'uNumberAt', 'uCapAt', 'uGlyph', 'uMakerUV',
  'uHeadBones', 'uLegBones', 'uHandBones', 'uTrunkBones', 'uArmBones', 'uLegIdx', 'uLegIdxR', 'uFpNeck'];
let CONST_GLSL = null;
function constGlsl(u) {
  if (CONST_GLSL) return CONST_GLSL;
  const f = (x) => { const s = Math.fround(x).toPrecision(9); return /[.e]/.test(s) ? s : s + '.0'; };
  CONST_GLSL = CONST_UNIFORMS.map((k) => {
    const v = u[k].value, a = v.isVector4 ? [v.x, v.y, v.z, v.w] : v.isVector3 ? [v.x, v.y, v.z] : [v.x, v.y];
    return `#define ${k} vec${a.length}(${a.map(f).join(', ')})`;
  }).join('\n') + '\n';
  return CONST_GLSL;
}
// A figure's own values (kit, skin, hair, build, face, name and number, LOD, ...): not uniforms
// but a block at the tail of the figure's bone texture (FIG_ROW: two rows of 16 texels, see
// Humanoid.writeLook), read in the shaders with texelFetch. So every figure can be drawn with
// one shared material (no material switch, no uniform upload per figure); your own body and a
// figure fading in or out keep a material of their own (FP_BODY, alpha hash).
function figureValues() {
  return {
    uKit1: { value: new THREE.Color(0x1f4fa8) }, uKit2: { value: new THREE.Color(0xf2c12e) }, uKit3: { value: new THREE.Color(0x14285a) },
    uKit4: { value: new THREE.Color(0x17336e) }, uSkin: { value: new THREE.Color(0xc68e62) }, uHair: { value: new THREE.Color(0x1d1510) },
    uPanel: { value: new THREE.Color(0x173f8c) }, uIris: { value: new THREE.Color(0x3b2414) },
    uLook: { value: new THREE.Vector4(0, 0, 0, 0) }, uLook2: { value: new THREE.Vector4(0, 0, 1, 0) },
    uLook3: { value: new THREE.Vector4(0, 0, 0, 0) },    // age, nose, brow, jaw (FIG(17))
    uLook4: { value: new THREE.Vector4(0, 0, 0, 0) },
    uLook5: { value: new THREE.Vector4(0, 0, 0, 0) },    // face length, face width, cheek fullness, lips (FIG(19))    // expression: 1 focused, 2 smile (FIG(18).x); haircut 0..5 (.y)
    uCrestUV: { value: new THREE.Vector4() }, uSponsorUV: { value: new THREE.Vector4() },
    uTeamIx: { value: 0 },         // 0/1 the teams (sponsor, name, number), 2 officials (crest only)
    uNum: { value: new THREE.Vector2(-1, -1) },        // back number: glyphs of the tens and units (-1 none)
    uName: { value: new Array(12).fill(-1) }, uNameLen: { value: 0 },
    uLod: { value: 0 },
    uSeed: { value: 0 },           // 0..1, this figure's own clock for blinks and breaths
    uShades: { value: 0 },         // 1: sunglasses (geometry near, painted far)
    uBrim: { value: new THREE.Vector3(0, 0, 0) },
    uNoHead: { value: 0 },         // 1: the head and neck are not drawn (your own see-through body)
    uGloved: { value: 0 },         // 1: bare hands are not drawn (they are inside gloves)
    uHideHand: { value: -1 },      // a hand bone whose bare hand is not drawn (your bowling hand: it has its own model, viewModes.js)
    // Your own body (setGhost, FP_BODY): where the ball is (xyz, w = 1 when it counts) and the bat's
    // blade (from its shoulder to its toe), so the body steps aside from them in your view. (uniforms of its own material)
    uFpBall: { value: new THREE.Vector4() },
    uFpB0: { value: new THREE.Vector4() }, uFpB1: { value: new THREE.Vector3() },
    uFpShift: { value: new THREE.Vector3() },   // your upper body drawn this far (object space) behind your eyes (fpShift)
  };
}
let SHARED_MAT = null;
const FIG_TEXEL = 224;          // the figure's look in its bone texture: texels 224.. (rows 14 and 15 of 16)
const sharedMaterial = () => SHARED_MAT || (SHARED_MAT = kitMaterial());
// The constants' values (constGlsl).
function constValues() {
  return {
    ...sharedUniforms(),
    uHeadBones: { value: new THREE.Vector2(RIG.index.neck, RIG.index.head) },
    uLegBones: { value: new THREE.Vector2(Math.min(RIG.index.hipL, RIG.index.hipR), Math.max(RIG.index.ankleL, RIG.index.ankleR)) },
    uHandBones: { value: new THREE.Vector2(RIG.index.handL, RIG.index.handR) },
    uTrunkBones: { value: new THREE.Vector4(RIG.index.spine, RIG.index.chest, RIG.index.shoulderL, RIG.index.shoulderR) },
    uArmBones: { value: new THREE.Vector2(RIG.index.elbowL, RIG.index.elbowR) },
    uFpNeck: { value: new THREE.Vector3(0.03, RIG.J.neck.y - 0.02, RIG.J.neck.z + 0.008) },   // your neck's close: height of its dome, the collar height, its z (bind)
    uLegIdx: { value: new THREE.Vector3(RIG.index.hipL, RIG.index.kneeL, RIG.index.ankleL) },
    uLegIdxR: { value: new THREE.Vector3(RIG.index.hipR, RIG.index.kneeR, RIG.index.ankleR) },
  };
}
// fig: the figure's values when the material is its own (your body's FP uniforms); null: the shared one.
function kitMaterial(fig = null) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false });   // (fog starts far beyond any figure from any camera)
  mat.defines = {};
  const uniforms = { ...sharedUniforms() };
  for (const k of CONST_UNIFORMS) delete uniforms[k];
  if (fig) { uniforms.uFpBall = fig.uFpBall; uniforms.uFpB0 = fig.uFpB0; uniforms.uFpB1 = fig.uFpB1; uniforms.uFpShift = fig.uFpShift; }
  const consts = constGlsl(constValues());
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 kit;
        uniform vec2 uHeadBones; uniform vec2 uLegBones; uniform vec2 uHandBones;
        uniform vec4 uTrunkBones; uniform vec2 uArmBones;
        uniform vec3 uLegIdx; uniform vec3 uLegIdxR;
        varying float vHeadW; varying float vLegW; varying vec3 vSeg; varying float vHandW; varying vec2 vKA; varying float vHairE;
        #ifdef FP_BODY
          varying vec3 vFpW; varying float vUpW; uniform vec3 uFpNeck; uniform vec3 uFpShift;
        #endif
        ${KIT_GLSL_COMMON}`)
      .replace('#include <project_vertex>', `
        #ifdef FP_BODY
          // Your eyes are in front of your head's joint, not on top of it: your upper body is drawn
          // that far behind them (it fades in up the trunk from the hips; the forearms, gloves, legs
          // and feet stay exactly where they are), so looking down you see your chest from the front
          // of your face, not the inside of your collar.
          float fpUp = smoothstep(0.95, 1.3, position.y) * (1.0 - clamp(foreW + vHandW + vSeg.y + vSeg.z, 0.0, 1.0));
          transformed += uFpShift * fpUp;
          // Your neck ends just above the collar in a rounded close of skin (the head above it is
          // not drawn): looking down you never see through the collar into the shirt.
          if (k > 4.5 && k < 5.5 && position.y > uFpNeck.y) {
            float t = smoothstep(uFpNeck.y, uFpNeck.y + 0.045, position.y), fs = 1.0 - t;
            vec2 c = vec2(0.0, uFpNeck.z), r = position.xz - c;
            vec3 dome = vec3(c.x + r.x * fs, uFpNeck.y + uFpNeck.x * sqrt(max(0.0, 1.0 - fs * fs)), c.y + r.y * fs);
            #ifdef USE_SKINNING
              vec4 sp = bindMatrix * vec4(dome, 1.0);
              vec4 sk = vec4(0.0);
              sk += boneMatX * sp * skinWeight.x; sk += boneMatY * sp * skinWeight.y; sk += boneMatZ * sp * skinWeight.z; sk += boneMatW * sp * skinWeight.w;
              transformed = (bindMatrixInverse * sk).xyz + uFpShift;
            #endif
          }
        #endif
        #include <project_vertex>
        #ifdef FP_BODY
          vFpW = (modelMatrix * vec4(transformed, 1.0)).xyz; vUpW = upperW;
        #endif`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        float k = kit.x;
        vec4 uLook = FIG(8);
        vK1 = FIG(0).rgb; vK2 = FIG(1).rgb; vLookZW = uLook.zw;
        float uGloved = 0.0, uHideHand = -1.0;            // (only a skin vertex reads them)
        if (k > 4.5 && k < 5.5) { uGloved = FIG(4).w; uHideHand = FIG(5).w; }
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
            if (kit.x > 4.5 && kit.x < 5.5 && ((uGloved > 0.5 && (abs(b - uHandBones.x) < 0.5 || abs(b - uHandBones.y) < 0.5)) || abs(b - uHideHand) < 0.5)) vHeadW += 2.0 * skinWeight[i];
          }
        #endif
        vArmW = upperW + foreW;
        vBind = position;
        vHairE = color.r; vTro = color.gb;
        // colour and material per slot. vMat: wrap, specular, shininess, kind
        // (kind 0 cloth, 1 skin, 2 hard gloss, 3 hair, 4 eye, 5 padding / leather, 6 lens)
        vec3 kc = vec3(1.0);
        #ifdef USE_COLOR
          kc = vColor.rgb;
        #endif
        vec4 mt = vec4(0.15, 0.035, 10.0, 0.0);      // (cloth: a little wrap, so the folds and the torso keep their form in the sun)
        float push = 0.0;
        if (k < 0.5) mt = vec4(0.2, 0.06, 16.0, 5.0);
        else if (k < 1.5 || (k > 9.5 && k < 23.5)) { kc = vK1; push = uLook.x * (trunkW + 0.6 * upperW); }
        else if (k < 2.5) { kc = vK2; push = uLook.x * trunkW; }
        else if (k < 3.5) kc = FIG(2).rgb;
        else if (k < 4.5) { kc = FIG(3).rgb; push = uLook.x * 0.45 * vSeg.x; }
        else if (k < 5.5) {
          kc = FIG(4).rgb; mt = vec4(vHeadW > 0.5 ? 0.2 : 0.45, 0.05, 6.0, 1.0);   // (the face: little wrap, so its planes show and the far cheek falls into shade)
          vec2 at = armAt(position);
          float arm = step(0.5, vArmW) * step(at.x, 0.97);
          push = uLook.x * 0.5 * upperW + arm * (uLook.z * 0.0035 * step(0.1, at.x) + uLook.w * 0.003 * step(0.82, at.x) * step(at.x, 0.95));
          // the hair stands off the scalp (headMesh.js: colour.g marks the ears, which have none)
          // (5..13 mm, more on a longer top; under a cap, hat or helmet only below its rim)
          if (vHeadW > 0.5 && color.g < 0.5) {
            float hv; hairCover(position, FIG(18).y, hv);
            vec3 q = position - uSkull.xyz;
            float rimY = uSkull.y + 0.012 - 0.045 * (1.0 - normalize(q.xz + vec2(0.0, 1e-4)).y);
            push += (0.005 + 1.3 * uLook.y) * hv * (FIG(18).z > 0.5 ? smoothstep(rimY, rimY - 0.025, position.y) : 1.0);
          }
        }
        else if (k < 6.5) {
          kc = FIG(5).rgb; mt = vec4(0.3, 0.16, 34.0, 3.0);
          // hair standing off the scalp, only where the headgear does not cover it (below its rim)
          vec3 q = position - uSkull.xyz;
          float rimY = uSkull.y + 0.012 - 0.09 * (1.0 - normalize(q.xz + vec2(0.0, 1e-4)).y) * 0.5;
          push = uLook.y * smoothstep(0.0, 0.6, color.r) * smoothstep(rimY, rimY - 0.025, position.y);
        }
        else if (k < 7.5) { kc = FIG(6).rgb; push = uLook.x * (trunkW + 0.6 * upperW); }
        else if (k < 8.5) { kc = FIG(4).rgb * vec3(0.82, 0.66, 0.64); mt = vec4(0.45, 0.12, 16.0, 1.0); }
        else if (k > 23.5 && k < 24.5) mt = vec4(0.3, 1.0, 220.0, 4.0);       // (a small, sharp highlight of the sun: the catch-light)
        else if (k < 25.5) { kc = FIG(7).rgb; mt = vec4(0.3, 1.0, 220.0, 4.0); }
        else if (k < 26.5) mt = vec4(0.2, 0.5, 60.0, 4.0);
        else if (k > 29.5 && k < 30.5) mt = vec4(0.0, 0.6, 70.0, 2.0);
        else if (k < 31.5) mt = vec4(0.12, 0.06, 12.0, 5.0);
        else if (k < 32.5) mt = vec4(0.0, 1.4, 140.0, 6.0);
        else if (k < 33.5) { mt = vec4(0.35, 0.022, 7.0, 5.0); kc = vec3(0.93, 0.92, 0.9); }     // (boots: matte white leather, half the old shine)
        else if (k < 34.5) { kc = FIG(2).rgb; mt = vec4(0.18, 0.022, 260.0, 2.0); }     // (matte painted shell; the clear coat is a small, sharp highlight)
        else if (k < 35.5) { kc = vK2; mt = vec4(0.1, 0.25, 45.0, 2.0); }
        else if (k < 36.5) { kc = mix(vec3(0.9), vK1, 0.6); mt = vec4(0.3, 0.07, 14.0, 5.0); }
        #ifdef USE_COLOR
          vColor.rgb = kc;
        #endif
        vSlot = k; vMat = mt;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // breathing: the chest and upper back rise and fall a few millimetres
        float uSeed = FIG(0).w;
        float br = sin(uTime * (1.45 + 0.4 * uSeed) + uSeed * 40.0);
        push += 0.0022 * br * trunkW * smoothstep(1.12, 1.3, position.y) * smoothstep(1.47, 1.38, position.y) * step(k, 7.5);
        transformed += objectNormal * push;
        // the gaze (FIG(18).w: yaw and pitch, see Humanoid.updateGaze): the eyeballs turn about their centres
        if (k > 23.5 && k < 26.5 && FIG(18).w > 0.5) {
          vec3 d = position - vec3(sign(position.x) * uEye.x, uEye.y, uEye.w - 0.0128);
          if (dot(d, d) < 0.0003) {
            float gw = FIG(18).w, gy = (floor(gw / 128.0) - 64.0) * 0.01, gp = (gw - floor(gw / 128.0) * 128.0 - 64.0) * 0.01;
            vec3 r = vec3(d.x, cos(gp) * d.y + sin(gp) * d.z, cos(gp) * d.z - sin(gp) * d.y);
            r = vec3(cos(gy) * r.x + sin(gy) * r.z, r.y, cos(gy) * r.z - sin(gy) * r.x);
            transformed += r - d; vBind += r - d;
          }
        }
        #ifdef FP_BODY
          // your own shoulders as you see them from above: lower and narrower (the deltoid falls away
          // from the collar), so looking down they are the tops of your arms, not a dome under your chin
          float fpSh = smoothstep(1.28, 1.42, position.y) * smoothstep(0.08, 0.16, abs(position.x)) * (1.0 - clamp(foreW + vHandW, 0.0, 1.0));
          transformed.y -= 0.03 * fpSh; transformed.x -= sign(position.x) * 0.028 * fpSh;
        #endif
        // each man's own face (FIG(17): nose, brow, jaw), on the face's skin only: a longer or flatter
        // nose, a heavier or flatter brow ridge, a squarer or narrower jaw
        if (k > 4.5 && k < 8.5 && vHeadW > 0.3 && position.z > 0.03) {
          vec4 L3 = FIG(17);
          float ax = abs(position.x), dy = position.y - uFaceMisc.y;
          float nose = exp(-(ax * ax) / 0.00018 - (dy - 0.004) * (dy - 0.004) / 0.0005) * smoothstep(0.13, 0.16, position.z);
          transformed.z += 0.0025 * L3.y * nose; transformed.y -= 0.0015 * L3.y * nose;
          float brow = exp(-pow((position.y - uEye.y - 0.024) / 0.01, 2.0)) * smoothstep(0.065, 0.035, ax) * smoothstep(0.11, 0.15, position.z);
          transformed.z += 0.0028 * L3.z * brow;
          float jaw = smoothstep(uFaceMisc.w + 0.006, uFaceMisc.w - 0.02, position.y) * smoothstep(1.47, 1.5, position.y) * smoothstep(0.02, 0.06, ax);
          transformed.x += position.x * 0.06 * L3.w * jaw;
          // (FIG(19): face length and width, cheek fullness, lips; and from hashes of FIG(17) the nose's width
          // and bridge, the jaw's shape (square / tapered), so no two men share a structure)
          if (color.g < 0.5) {
            vec4 L5 = FIG(19);
            float fr = smoothstep(0.03, 0.08, position.z);
            float lo = smoothstep(uEye.y + 0.005, uEye.y - 0.03, position.y);
            transformed.y += (position.y - uEye.y) * 0.05 * L5.x * lo * fr;
            transformed.x += position.x * 0.05 * L5.y * smoothstep(uEye.y + 0.035, uEye.y + 0.005, position.y) * fr;
            float chk = exp(-pow((ax - 0.04) / 0.016, 2.0) - pow((position.y - uFaceMisc.w - 0.016) / 0.018, 2.0)) * fr;
            transformed += objectNormal * 0.0026 * L5.z * chk;
            float lipM = exp(-pow(ax / 0.016, 2.0) - pow((position.y - uFaceMisc.w) / 0.0075, 2.0)) * smoothstep(0.125, 0.14, position.z);
            transformed += objectNormal * 0.0012 * L5.w * lipM;
            float nw = fract(sin(L3.y * 91.7 + 0.3) * 437.5) * 2.0 - 1.0, nbr = fract(sin(L3.y * 53.1 + 1.7) * 251.3) * 2.0 - 1.0;
            float wing = exp(-pow((position.y - uFaceMisc.y + 0.002) / 0.008, 2.0)) * smoothstep(0.024, 0.008, ax) * smoothstep(0.13, 0.145, position.z);
            transformed.x += position.x * 0.13 * nw * wing;
            float bridge = smoothstep(0.009, 0.0, ax) * smoothstep(uEye.y + 0.006, uEye.y - 0.004, position.y) * smoothstep(uFaceMisc.y + 0.004, uFaceMisc.y + 0.016, position.y) * smoothstep(0.135, 0.15, position.z);
            transformed.z += 0.0016 * nbr * bridge;
            float js = fract(sin(L3.w * 77.3 + 2.1) * 311.7) * 2.0 - 1.0;
            float gon = exp(-pow((ax - 0.046) / 0.012, 2.0) - pow((position.y - uFaceMisc.w + 0.03) / 0.016, 2.0)) * smoothstep(0.02, 0.06, position.z);
            transformed.x += sign(position.x) * 0.0035 * js * gon;
          }
          // his expression (FIG(18).x): a slight smile lifts the mouth's corners and the cheeks
          float ex = FIG(18).x;
          if (ex > 1.5 || ex < 0.5) {      // (relaxed: a third of the smile, so a resting face reads friendly)
            float sm = ex > 1.5 ? 1.0 : 0.5;
            float dm = position.y - uFaceMisc.w;
            float corner = exp(-pow((ax - 0.023) / 0.011, 2.0) - dm * dm / 0.00008) * sm;
            transformed.y += 0.0028 * corner; transformed.z -= 0.0012 * corner; transformed.x += sign(position.x) * 0.0012 * corner;
            transformed.y += 0.0015 * sm * exp(-pow((ax - 0.045) / 0.015, 2.0) - pow((position.y - uEye.y + 0.028) / 0.012, 2.0));
          }
        }
        if (k > 4.5 && k < 5.5 && color.g > 0.5) {
          float es = fract(sin(FIG(17).z * 61.3 + 0.7) * 173.1) * 2.0 - 1.0;
          vec3 ec = vec3(sign(position.x) * 0.072, uEye.y - 0.0085, uEye.w - 0.1148);
          transformed += (position - ec) * 0.1 * es;
        }
        // a focused man's brows come down and in (the brow hair, slot 6 in front of the face)
        if (k > 5.5 && k < 6.5 && position.z > uEye.w - 0.012 && FIG(18).x > 0.5 && FIG(18).x < 1.5) {
          transformed.y -= 0.0022 + 0.0018 * smoothstep(0.04, 0.012, abs(position.x));
        }
`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2D boneTexture;
        #define uKit1 vK1
        #define uKit2 vK2
        #ifdef FP_BODY
          uniform vec4 uFpBall; uniform vec4 uFpB0; uniform vec3 uFpB1; varying vec3 vFpW; varying float vUpW;
        #endif
        varying float vHeadW; varying float vLegW; varying vec3 vSeg; varying float vHandW; varying vec2 vKA; varying float vHairE;
        uniform sampler2D uFaceMap; uniform sampler2D uDecal;
        uniform vec4 uFaceRect; uniform vec4 uFaceMisc; uniform vec4 uEye; uniform vec3 uKneeL; uniform vec3 uAnkleL; uniform vec4 uLegAxis;
        uniform vec4 uCrestAt; uniform vec4 uSponsorAt; uniform vec4 uMakerAt; uniform vec4 uNumberAt; uniform vec4 uCapAt;
        uniform vec4 uMakerUV; uniform vec4 uGlyph;
        uniform float uDetail;
        ${KIT_GLSL_COMMON}
        float gWrap = 0.25, gSpec = 0.04, gShin = 10.0, gKind = 0.0, gSSS = 0.0, gShade = 0.0; vec3 gSpecC = vec3(1.0); float gBounce = 0.0;
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
          // skin: light scattered under the surface: a wrapped falloff, tinted red, in the terminator's band only
          irr += directLight.color * gSSS * vec3( 0.42, 0.13, 0.05 ) * max( 0.0, max( 0.0, ( nl + 0.5 ) / 1.5 ) - max( nl, 0.0 ) );
          reflectedLight.directDiffuse += irr * lit * BRDF_Lambert( material.diffuseColor );
          vec3 H = normalize( directLight.direction + geometryViewDir );
          float nh = max( dot( geometryNormal, H ), 0.0 );
          float sp = gSpec * pow( nh, gShin ) * ( gShin + 8.0 ) * 0.04 * smoothstep( -0.05, 0.25, nl );
          reflectedLight.directSpecular += directLight.color * sp * lit * gSpecC;
        }
        void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
          reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
          // (the face: light bounced up from the turf and the shirt, so its features read under a brim)
          if ( gBounce > 0.0 ) { vec3 nW = inverseTransformDirection( geometryNormal, viewMatrix ); reflectedLight.indirectDiffuse += gBounce * vec3( 0.42, 0.4, 0.33 ) * clamp( 0.35 - 0.65 * nW.y, 0.0, 1.0 ) * BRDF_Lambert( material.diffuseColor ); }
        }
        #define RE_Direct RE_Direct_Kit
        #define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  #ifdef FP_BODY
  {
    // Your own body is your whole figure but the head and neck, solid and shaded like everyone
    // else's: looking down you see your shirt front and shoulders, the arms from the shoulders to
    // the gloves, hips, thighs, pads and boots. What would get in the way steps aside, softly:
    //  * anything within ~25 cm of the eye drawing it (cameraPosition is each eye's own in stereo),
    //    so nothing of the collar or shoulders comes up against the lenses;
    //  * a hole along that eye's line of sight to the ball (a cone a little wider than the ball)
    //    and to the bat's blade while the ball is in play.
    // A few dot products and an ordered dither in one opaque draw; no extra pass.
    vec3 E = cameraPosition, d = vFpW - E;
    float dl = length(d);
    vec3 D = d / max(dl, 1e-4);
    // (only the arms and gloves can come right up to your eyes, a bat brought to your face: they fade
    // there. The trunk is never cut: it is a shell, and a hole in it would show its empty inside)
    float cut = (1.0 - smoothstep(0.12, 0.2, dl)) * clamp(vArmW + vHandW, 0.0, 1.0);
    if (uFpBall.w > 0.5) {
      vec3 b = uFpBall.xyz - E; float bl = length(b);
      float c = dot(D, b / bl), ang = sqrt(max(0.0, 1.0 - c * c)) / max(c, 1e-3);   // tan of the angle off the ball
      float rad = 0.075 / bl + 0.012;
      cut = max(cut, (1.0 - smoothstep(rad, rad * 1.5, ang)) * step(dl, bl) * step(0.0, c));
    }
    if (uFpB0.w > 0.0) {
      vec3 a0 = uFpB0.xyz - E, a1 = uFpB1 - E;
      vec3 n = cross(a0, a1); float nl = length(n);
      if (nl > 1e-6) {
        n /= nl;
        float side = abs(dot(D, n));
        float between = step(0.0, dot(cross(a0, D), n)) * step(0.0, dot(cross(D, a1), n));
        float far = min(length(a0), length(a1)), w = uFpB0.w / max(far, 0.2) + 0.01;
        cut = max(cut, (1.0 - smoothstep(w * 0.8, w * 2.2, side)) * between * step(dl, far) * (1.0 - clamp(vArmW + vHandW, 0.0, 1.0)));   // (not the arms and gloves holding it)
      }
    }
    // (4x4 ordered dither: a clean screen-door edge, no blending, no sorting)
    vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
    float bayer = (mod(q.x + q.y * 2.0, 4.0) * 4.0 + mod(q.y * 3.0 + q.x * 2.0, 4.0) + 0.5) / 16.0;
    if (cut > bayer) discard;
  }
  #endif
  float kitH = 0.0;                           // procedural bump height (m)
  gBX = dFdx(vBind); gBY = dFdy(vBind);
  gWrap = vMat.x; gSpec = vMat.y; gShin = vMat.z; gKind = vMat.w;
  // (the shade of a cap's peak / hat's brim: edge y, how far below it falls, all round (1) or front only (0))
  if (vHeadW > 0.5) { vec3 uBrim = FIG(12).xyz; if (uBrim.y > 0.0 && (gKind > 0.5 && gKind < 1.5 || gKind > 3.5 || gKind > 2.5 && gKind < 3.5 && vBind.y < uBrim.x)) {
    // the peak / brim shades the face (the sun is high): eyes and brow in shadow, as on any sunny day
    float front = mix(smoothstep(uSkull.z - 0.01, uSkull.z + 0.05, vBind.z), 1.0, uBrim.z);
    float edge = uBrim.x - uBrim.y;
    gShade = 0.42 * smoothstep(edge - 0.012, edge + 0.012, vBind.y) * front * step(vBind.y, uBrim.x + 0.01);
  } }
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
        if (uDetail > 0.5) {
        kitH += wv * 0.00005 * sin((cp.x + cp.y) * 2400.0);
        float ax = abs(vBind.x);
        float wob = sin(vBind.x * 53.0 + vBind.z * 41.0) * 1.6 + sin(vBind.x * 23.0 - vBind.z * 67.0);
        kitH += 0.0022 * sin(vBind.y * 150.0 + wob) * exp(-pow((vBind.y - 0.5) / 0.055, 2.0));
        kitH += 0.002 * sin(vBind.y * 190.0 + wob * 1.3) * exp(-pow((vBind.y - 0.17) / 0.045, 2.0));
        kitH += 0.0009 * sin(vBind.y * 110.0 - ax * 140.0 + wob * 0.5) * exp(-pow((vBind.y - 0.8) / 0.06, 2.0)) * smoothstep(0.02, 0.07, ax);
        }
        // the side stripe (trousers.js: colour.g = the angle round the leg, .b its radius)
        float sw = 0.0088 / (6.2832 * max(vTro.y, 0.03));
        float sd = abs(vTro.x - 0.5);
        float sfw = max(fwidth(vTro.x), 1e-4);
        c = mix(c, uKit2, smoothstep(sw + sfw, sw - sfw, sd) * step(vBind.y, 1.06));
        // pocket seam and its shadow
        float pk = abs(abs(vBind.x) - (0.135 - (vBind.y - 0.98) * 0.35));
        c *= 1.0 - 0.35 * smoothstep(0.0025, 0.0, pk) * step(0.92, vBind.y) * step(vBind.y, 1.04) * step(0.02, vBind.z) * (1.0 - smoothstep(0.0, 0.004, fw * 0.6));
      } else if (shirt || s > 1.5 && s < 2.5) {
        // shirt: a pique knit; folds from the armpits, round the waist and in the sleeves
        if (uDetail > 0.5) {
        kitH += wv * 0.00007 * sin(cp.x * 2600.0) * sin(cp.y * 2600.0);
        vec2 ap = vec2(abs(vBind.x) - 0.17, vBind.y - 1.3);
        float an = atan(ap.y, ap.x);
        kitH += 0.0011 * sin(an * 9.0) * exp(-dot(ap, ap) / 0.004) * step(0.0, -ap.x + 0.04) * smoothstep(0.012, 0.04, length(ap));
        kitH += 0.0024 * sin(vBind.y * 150.0 + vBind.x * 25.0) * exp(-pow((vBind.y - 1.12) / 0.045, 2.0));
        kitH += 0.0009 * sin(vBind.y * 210.0 - abs(vBind.x) * 90.0) * smoothstep(0.2, 0.26, abs(vBind.x));
        // (the shirt's drape: soft vertical folds from the chest to the waist, pulled in at the
        // tuck, and the sleeve bunched toward its hem; big enough to read at a few metres)
        kitH += 0.003 * sin(vBind.x * 70.0 + sin(vBind.y * 24.0 + vBind.z * 30.0) * 1.8) * smoothstep(1.32, 1.18, vBind.y) * smoothstep(1.06, 1.14, vBind.y) * (1.0 - step(0.5, vArmW));
        { vec2 at = armAt(vBind); kitH += 0.0024 * sin(at.x * 140.0 + vBind.z * 60.0) * step(0.5, vArmW) * smoothstep(0.1, 0.2, at.x) * smoothstep(0.42, 0.3, at.x); }
        }
        if (s > 6.5 && s < 7.5) {
          // the yoke panel: sublimated pinstripes
          float st = abs(fract((abs(vBind.x) * 0.7 + vBind.y) * 90.0) - 0.5);
          c = mix(c, c * 0.84, smoothstep(0.36, 0.44, st) * (1.0 - smoothstep(0.0008, 0.0016, fw)));
        }
        if (shirt && vBind.y > 1.15 && vBind.y < 1.45) {
          float side = abs(vBind.x);
          if (vBind.z > 0.06) {
            vec4 uCrestUV = FIG(10), uSponsorUV = FIG(11); float uTeamIx = FIG(2).w;
            // front: crest (wearer's left), maker's mark (right), sponsor across the chest
            vec4 t = decalAt(vBind.xy, uCrestAt, uCrestUV, 0.0);
            t += decalAt(vBind.xy, uMakerAt, uMakerUV, 0.0) * vec4(uKit2, 1.0) * step(uTeamIx, 1.5);
            if (uTeamIx < 1.5) { vec4 sp = decalAt(vBind.xy, uSponsorAt, uSponsorUV, 0.0); t = sp.a > t.a ? sp : t; }
            c = mix(c, t.rgb, t.a);
            // placket buttons
            float bt = length(vec2(vBind.x, mod(vBind.y - 1.405, 0.025) - 0.0125));
            c *= 1.0 - 0.25 * smoothstep(0.0032, 0.0022, bt) * step(1.40, vBind.y) * step(vBind.y, 1.452) * step(side, 0.006);
          } else if (vBind.z < -0.03 && FIG(2).w < 1.5) {
            vec2 uNum = vec2(FIG(12).w, FIG(16).x); float uNameLen = FIG(7).w; vec3 uKit3 = FIG(2).rgb;
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
              t = glyphAt(FIG(13 + ci / 4)[ci % 4], vec2(fract(cx), q.y), vec2(uGlyph.x * uNameLen / (2.0 * nr.z), uGlyph.y / (2.0 * nr.w)));
            }
            c = lettering(c, t, uKit2, uKit3 * 0.6);
          }
        }
      } else if (s > 2.5 && s < 3.5) {
        kitH += wv * 0.00006 * sin(cp.x * 2200.0) * sin(cp.y * 2200.0);
      }
      // headgear crest (cap, hat band)
      if ((s > 1.5 && s < 3.5) && vHeadW > 0.5 && vBind.z > 0.1) { vec4 t = decalAt(vBind.xy, uCapAt, FIG(10), 0.0); c = mix(c, t.rgb, t.a); }
      c *= 1.0 + 55.0 * clamp(kitH, -0.004, 0.004);   // folds: darker in their hollows, lighter on their crests (readable at a few metres)
    } else if (skin) {
      gSSS = 1.0;
      // ---- arms: long sleeves (the shirt's colour, a cuff) or a sweatband
      vec2 at = armAt(vBind);
      if (vArmW > 0.5 && at.x < 0.97) {
        float sl = vLookZW.x * step(0.08, at.x) * step(at.x, 0.935);
        float band = (1.0 - vLookZW.x) * vLookZW.y * step(0.82, at.x) * step(at.x, 0.95);
        if (sl > 0.5) {
          c = at.x > 0.875 ? uKit2 : uKit1; gWrap = 0.25; gSpec = 0.035; gShin = 10.0; gSSS = 0.0;
          kitH += 0.0005 * sin(at.x * 47.0 + vBind.y * 30.0 + sin(at.x * 23.0) * 2.0) * smoothstep(0.35, 0.5, at.x) * smoothstep(0.85, 0.7, at.x);
        }
        if (band > 0.5) { c = uKit2; gWrap = 0.3; gSpec = 0.02; gShin = 6.0; gSSS = 0.0; kitH += 0.00008 * sin(at.x * 900.0) * (1.0 - smoothstep(0.001, 0.002, fw)); }
      }
      // ---- the hair (headMesh.js: the scalp is skin): the haircut's cover in the hair's colour, its
      // strands faded out by their own screen rate before they can alias, a soft broad sheen
      if (vHeadW > 0.5 && vTro.x > 0.5) c *= vec3(1.08, 0.93, 0.9);      // (the ears a little ruddier)
      if (vHeadW > 0.5 && vTro.x < 0.5) {
        float hv, hcv = hairCover(vBind, FIG(18).y, hv);
        if (hcv > 0.003) {
          vec4 uLook2 = FIG(9); vec3 uHair = FIG(5).rgb;
          vec3 q = vBind - uSkull.xyz;
          float an = atan(q.x, q.z);
          float ph = an * 260.0 + q.y * 90.0 + sin(q.y * 120.0) * 3.0;
          float strands = sin(ph) * (1.0 - smoothstep(0.7, 1.5, fwidth(ph)));
          // (locks of a centimetre or so carry the grain where the strands are gone)
          float lph = an * 38.0 + sin(q.y * 45.0 + an * 3.0) * 2.2;
          float locks = sin(lph) * (1.0 - smoothstep(0.7, 1.5, fwidth(lph)));
          vec3 hcol = uHair * (0.9 + 0.08 * strands + 0.07 * locks);
          // (opaque wherever it grows: only the hairline and a crop's sides thin out into the skin)
          float dens = smoothstep(0.0, 0.6, hcv) * mix(0.85, 1.0, uLook2.z);
          c = mix(c, hcol, dens);
          kitH += 0.00008 * strands * dens;
          gSSS *= 1.0 - dens; gSpec = mix(gSpec, 0.07, dens); gShin = mix(gShin, 26.0, dens);
          gSpecC = mix(vec3(1.0), uHair * 2.0 + 0.06, dens);     // (a narrow sheen in the hair's own colour, not a pale patch) gWrap = mix(gWrap, 0.3, dens);
        }
      }
      // ---- the face: painted map projected from the front of the head
      if (vBind.y > uFaceRect.y && vBind.z > uFaceMisc.x && vHeadW > 0.3) {
        vec4 uLook2 = FIG(9); vec3 uHair = FIG(5).rgb; float uLod = FIG(1).w;
        vec2 fu = (vBind.xy - uFaceRect.xy) / uFaceRect.zw;
        vec4 f = textureGrad(uFaceMap, fu, gBX.xy / uFaceRect.zw, gBY.xy / uFaceRect.zw);
        // (the painted creases a third deeper than before: the mesh's own shading is soft)
        // (the painted and the socket shades scaled down on light skin: the same shade reads twice as
        // strong there, and made the fair players look fifty)
        float shk = mix(1.0, 0.45, smoothstep(0.15, 0.45, dot(FIG(4).rgb, vec3(0.3, 0.55, 0.15))));
        float m = 1.0 + (0.9 * f.r - 0.45) * 0.45 * shk;          // (the head's own geometry carries the form now: the paint only accents it)
        c *= m;
        // skin is not one colour: warmer, redder cheeks, nose and lips, a darker, cooler jaw and upper
        // lip (the beard under the skin), a little paler forehead; and pores and blotches close up
        float ax = abs(vBind.x), yy = vBind.y;
        float cheek = exp(-pow(length(vec2(ax - uEye.x - 0.006, yy - uEye.y + 0.03) / vec2(0.022, 0.018)), 2.0));
        float nose = exp(-pow(length(vec2(ax, yy - uFaceMisc.y) / vec2(0.012, 0.02)), 2.0));
        c *= mix(vec3(1.0), vec3(1.1, 0.91, 0.87), clamp(cheek * 0.85 + nose * 0.65, 0.0, 1.0));
        // (cooler, a little darker round the eyes; broad, soft blotches a few centimetres across)
        float ering = exp(-pow(length(vec2(ax - uEye.x, yy - uEye.y + 0.001) / vec2(0.022, 0.014)), 2.0));
        c *= mix(vec3(1.0), vec3(0.94, 0.93, 0.97), ering);
        c *= 1.0 + 0.03 * sin(vBind.x * 140.0 + vBind.y * 90.0 + 1.3) * sin(vBind.y * 170.0 - vBind.x * 60.0);
        float jaw = smoothstep(uFaceMisc.y - 0.012, uFaceMisc.w - 0.004, yy) * smoothstep(uFaceMisc.w - 0.045, uFaceMisc.w - 0.02, yy) * smoothstep(0.075, 0.03, ax);
        c *= mix(vec3(1.0), vec3(0.95, 0.95, 0.97), jaw * (0.3 + 0.7 * uLook2.y));
        c *= 1.0 + 0.06 * smoothstep(uEye.y + 0.02, uEye.y + 0.05, yy);
        float pf = 1.0 - smoothstep(0.0004, 0.0009, fw);
        float pore = sin(vBind.x * 3100.0 + sin(vBind.y * 2300.0)) * sin(vBind.y * 2900.0 + sin(vBind.x * 2700.0));
        kitH += pf * 0.000015 * pore;
        c *= 1.0 + 0.04 * sin(vBind.x * 430.0 + vBind.y * 260.0) * sin(vBind.y * 510.0 - vBind.x * 170.0);
        // the eye sockets and under the cheekbones in shadow, the cheekbones and jaw edge lit; and age
        // (FIG(17).x): creases deeper, lines on the forehead and at the eyes' corners, bags under
        // them, a greyer stubble, a little less colour in the skin
        float age = FIG(17).x;
        float dxE = ax - uEye.x, dyE = yy - uEye.y;
        float sock = exp(-pow(length(vec2(dxE + 0.002, dyE + 0.001) / vec2(0.026, 0.017)), 2.0));
        float hollow = exp(-pow(length(vec2(ax - 0.05, yy - uFaceMisc.y + 0.012) / vec2(0.016, 0.02)), 2.0));
        float cbone = exp(-pow(length(vec2(ax - 0.048, yy - uEye.y + 0.022) / vec2(0.018, 0.008)), 2.0));
        float old = smoothstep(0.5, 1.0, age);      // (age 0.5 is about 35: nothing of it before)
        c *= (1.0 - (0.05 * sock + 0.04 * hollow) * shk) * (1.0 + 0.05 * cbone);
        c *= mix(1.0, 0.3 + 1.4 * f.r, (0.12 + 0.6 * old) * shk);
        float fine = 1.0 - smoothstep(0.0005, 0.0011, fw);
        float fh = smoothstep(uEye.y + 0.03, uEye.y + 0.045, yy) * smoothstep(uEye.y + 0.08, uEye.y + 0.06, yy) * smoothstep(0.06, 0.03, ax);
        c *= 1.0 - old * 0.32 * fh * smoothstep(0.4, 1.0, sin(yy * 820.0 + sin(vBind.x * 40.0) * 1.5)) * fine;
        float crow = smoothstep(0.012, 0.018, dxE) * smoothstep(0.032, 0.022, dxE) * smoothstep(0.01, 0.0, abs(dyE - 0.004));
        c *= 1.0 - old * 0.38 * crow * smoothstep(0.35, 1.0, sin(atan(dyE, dxE - 0.008) * 18.0)) * fine;
        float bag = exp(-pow(length(vec2(dxE, dyE + 0.011) / vec2(0.012, 0.004)), 2.0));
        c *= 1.0 - (0.02 + old * 0.2) * bag;
        c = mix(c, vec3(dot(c, vec3(0.3, 0.55, 0.15))), 0.18 * old);
        float liner = clamp(1.0 - 2.0 * f.b, 0.0, 1.0), white = clamp(2.0 * f.b - 1.0, 0.0, 1.0) * step(0.5, uLod);
        float lip = f.a * step(4.5, s);
        float dk = smoothstep(0.35, 0.12, dot(FIG(4).rgb, vec3(0.3, 0.55, 0.15)));
        c = mix(c, c * mix(vec3(0.93, 0.8, 0.82), vec3(0.84, 0.75, 0.72), dk), lip * (1.0 - step(7.5, s)));
        gSpec += lip * 0.03 * (1.0 - dk); gShin = mix(gShin, 12.0, lip);   // (no sky-blue sheen on dark lips)
        // beard: stubble shadow, then hair where the beard reaches
        float bf = f.g;
        // (stubble: a tint of the hair's colour over the skin, thicker toward the beard's centre;
        // a beard: soft-edged, thinning out at its border into the stubble, the hair colour lifted
        // a little so a dark beard on dark skin reads as hair, not a hole)
        vec3 hc = mix(max(uHair, vec3(0.035, 0.028, 0.022)) * 1.35, vec3(0.42, 0.4, 0.38), smoothstep(0.55, 0.95, age));
        // (a light shadow: at 1.5 m a heavy one boxes the lower face in)
        // (its own soft mask, not the beard's field: that one's moustache and goatee shapes box the mouth in)
        float stub = uLook2.y * smoothstep(uFaceMisc.y - 0.004, uFaceMisc.y - 0.026, yy) * smoothstep(0.07, 0.042, ax) * (1.0 - f.a);
        c = mix(c, c * 0.82 + hc * 0.12, stub * 0.4);
        float b0 = 1.0 - uLook2.x, beard = smoothstep(b0 - 0.08, b0 + 0.3, bf) * step(0.01, uLook2.x);
        float bph = vBind.x * 1900.0 + sin(vBind.y * 700.0) * 3.0, bph2 = vBind.x * 1500.0 + vBind.y * 900.0;
        float strands = 0.93 + 0.07 * sin(bph) * (1.0 - smoothstep(0.3, 0.8, fwidth(bph)));
        beard *= 0.55 + 0.45 * smoothstep(b0, b0 + 0.35, bf);
        c = mix(c, mix(hc, c * 0.55, 0.35) * strands, beard * 0.72);
        gSSS *= 1.0 - beard; gSpec = mix(gSpec, 0.1, beard); gShin = mix(gShin, 12.0, beard);
        kitH += beard * 0.00004 * sin(bph2) * (1.0 - smoothstep(0.3, 0.8, fwidth(bph2)));
        // a soft shadow under the brow and in the eye's inner corner (depth, not a line)
        { float bs = exp(-pow(length(vec2(ax - uEye.x + 0.002, yy - uEye.y - 0.009) / vec2(0.016, 0.0055)), 2.0));
          float ic = exp(-pow(length(vec2(ax - uEye.x + 0.0155, yy - uEye.y + 0.0005) / vec2(0.004, 0.0045)), 2.0));
          c *= 1.0 - (0.1 * bs + 0.1 * ic) * shk; }
        // (the brows: hair-coloured, their width each man's own (FIG(17).z), a fine grain of strokes running
        // out along them; the lash line as it was)
        if (yy > uEye.y + 0.011) {
          float bh = FIG(17).z;
          float bl = smoothstep(0.32 - 0.16 * bh, 0.8 - 0.16 * bh, liner);
          float sph = ax * 1100.0 - yy * 1500.0;
          vec3 bc = uHair * (0.45 + 0.1 * sin(sph) * (1.0 - smoothstep(0.4, 1.0, fwidth(sph)))) + 0.008;
          c = mix(c, bc, bl * 0.9); gSpec *= 1.0 - 0.6 * bl;
        } else c = mix(c, uHair * 0.35, liner * 0.92);
        c = mix(c, vec3(0.78, 0.76, 0.72), white);
        // forehead, nose and cheekbones are a little shinier
        // a low, rough shine; a faint sheen only on the forehead, the nose and the cheekbones; warm on dark
        // skin (a white highlight on dark brown reads grey)
        { float fh = smoothstep(uEye.y + 0.02, uEye.y + 0.045, yy) * smoothstep(0.05, 0.02, ax);
          float nb = exp(-pow(length(vec2(ax / 0.01, (yy - uFaceMisc.y - 0.012) / 0.022)), 2.0));
          float cb = exp(-pow(length(vec2((ax - 0.045) / 0.014, (yy - uEye.y + 0.02) / 0.008)), 2.0));
          float sh = clamp(fh + nb + 0.7 * cb, 0.0, 1.0);
          gSpec = mix(gSpec, 0.022 + 0.04 * sh, 1.0 - clamp(beard + lip, 0.0, 1.0)); gShin = mix(gShin, 4.5 + 3.0 * sh, 1.0 - lip);
          gSpecC = mix(vec3(1.0), vec3(1.0, 0.82, 0.66), dk); }
        gBounce = 1.0 + 1.2 * dk;
        // zinc cream (now and then): a thin, worn stripe down the bridge of the nose, not a blob
        float zx = abs(vBind.x) / 0.0055, zy = (vBind.y - uFaceMisc.y - 0.004) / 0.019;
        float zc = uLook2.w * 0.45 * smoothstep(1.0, 0.6, zx) * smoothstep(1.0, 0.7, abs(zy)) * step(uFaceMisc.z - 0.006, vBind.z);
        c = mix(c, mix(c, vec3(0.62, 0.6, 0.57), 0.55), zc); gSSS *= 1.0 - zc; gSpec = mix(gSpec, 0.03, zc);
      }
    } else if (gKind > 2.5 && gKind < 3.5) {
      // ---- hair: a soft hairline (cropped cuts thin out toward the edge), strands
      vec4 uLook2 = FIG(9); vec3 uSkin = FIG(4).rgb;
      float cover = smoothstep(0.0, 0.4 - 0.25 * uLook2.z, vHairE);
      vec2 hq = vBind.xz - uSkull.xz;
      float an = atan(hq.x, hq.y);
      // (faded by the stripes' own rate on screen, not by distance: they are finer toward the crown, and from
      // 1.5 m they beat with the pixels into a fingerprint. Gone before two pixels a stripe.)
      float hph = an * 260.0 + sin(vBind.y * 120.0) * 3.0;
      float strands = sin(hph) * (1.0 - smoothstep(0.7, 1.5, fwidth(hph)));
      // (locks of a centimetre or so carry the hair's grain at the distances where the strands are gone)
      float lph = an * 38.0 + sin(vBind.y * 45.0 + an * 3.0) * 2.2;
      float locks = sin(lph) * (1.0 - smoothstep(0.7, 1.5, fwidth(lph)));
      bool brow = vBind.z > uEye.w - 0.01;            // (the brows, not the scalp)
      // (the brows: hair, drawn as hair, its strokes running outward and a little up)
      if (brow) { float st = 0.75 + 0.25 * sin((abs(vBind.x) * 900.0 - vBind.y * 1400.0)) * (1.0 - smoothstep(0.0005, 0.001, fw)); c = mix(c, uSkin * 0.45, 0.25) * st; gSpec = 0.04; }
      else {
        c = mix(uSkin * 0.82, c * (0.86 + 0.1 * strands + 0.07 * locks), cover * (0.55 + 0.45 * uLook2.z));
        kitH += 0.00008 * strands * uLook2.z;
        gSpec *= 0.55 * cover * uLook2.z;          // (a sheen, not a polished cap)
      }
    } else if (gKind > 3.5 && gKind < 4.5) {
      // ---- eyes: lids painted over the top and bottom of the eyeball (the source's
      // wide-open stare), a lash line on the upper lid, the white shaded under it
      vec3 uSkin = FIG(4).rgb, uHair = FIG(5).rgb; float uSeed = FIG(0).w;
      vec2 e = vec2(abs(vBind.x) - uEye.x, vBind.y - uEye.y);
      vec2 eo = e;     // (the iris's own pattern turns with the eyeball; the lids, e, stay)
      if (FIG(18).w > 0.5) {
        float gw = FIG(18).w, gy = (floor(gw / 128.0) - 64.0) * 0.01, gp = (gw - floor(gw / 128.0) * 128.0 - 64.0) * 0.01;
        eo = vec2(e.x - sign(vBind.x) * sin(gy) * 0.0128, e.y - sin(gp) * 0.0128);
      }
      float r = uEye.z, u = clamp(e.x / 0.0152, -1.0, 1.0);      // (headMesh.js: the lids' opening, 30 mm across)
      float ageE = FIG(17).x + (abs(FIG(18).x - 1.0) < 0.5 ? 0.55 : FIG(18).x > 1.5 ? 0.25 : 0.0);      // (an older man's lids sit lower; a focused man narrows his eyes, a smiling one a little)
      // (just inside the lids' own edges, so the lid's margin and the lash line are one line: the upper lid
      // over the top of the iris, white either side of it)
      float up = r * (0.66 - 0.14 * ageE - 0.44 * u * u) + 0.17 * r * u, lo = -r * (0.84 - 0.08 * ageE - 0.48 * u * u) + 0.17 * r * u;
      // a blink every few seconds (each man on his own clock): the upper lid comes down for ~0.15 s
      // (quick and not often: about 0.1 s every 5..8 s)
      float bp = fract(uTime / (5.0 + 3.0 * uSeed) + uSeed * 7.3);
      up = mix(up, lo + 0.0006, smoothstep(0.0, 0.005, bp) * (1.0 - smoothstep(0.011, 0.019, bp)));
      float px = max(fw, 0.0003);
      gBounce = 0.8;
      c *= vec3(0.97, 0.9, 0.82) * mix(1.0, 0.84, smoothstep(up - 0.003, up, e.y)) * mix(1.0, 0.9, smoothstep(lo + 0.002, lo, e.y));
      float lid = max(smoothstep(up - px, up + px, e.y), smoothstep(lo + px, lo - px, e.y));
      c = mix(c, uSkin * 0.95, lid);
      float lash = exp(-pow((e.y - up - 0.0003) / 0.0008, 2.0)) * (1.0 - smoothstep(0.8, 1.05, abs(u)));
      c = mix(c, uHair * 0.22, clamp(lash, 0.0, 1.0) * 0.95);
      c *= 1.0 - 0.35 * exp(-pow((e.y - up + 0.0007) / 0.0006, 2.0)) * (1.0 - lid);      // (the lid's thickness: its shadow on the eye)
      c = mix(c, uSkin * 0.8, exp(-pow((e.y - lo + 0.0004) / 0.0007, 2.0)) * 0.15);   // (the lower lid: no lashes, a light edge)
      // the iris: a dark ring at its edge, lighter flecks round the pupil, the pupil black; and a
      // catch-light (the sky in the wet eye) on the same side of both eyes
      float ir = length(eo) / (uEye.z * 0.84);
      if (s > 24.5 && s < 25.5) {
        float fl = 0.88 + 0.12 * sin(atan(eo.y, eo.x) * 23.0);
        c *= mix(1.3 * fl, 0.3, smoothstep(0.72, 0.98, ir));      // (a darker limbal ring)
        c = mix(c, vec3(0.012), smoothstep(0.42, 0.36, ir));
      }
      vec2 cl = vec2(vBind.x - sign(vBind.x) * uEye.x - 0.0024, e.y - 0.0026);
      totalEmissiveRadiance += vec3(0.85, 0.88, 0.92) * 0.35 * smoothstep(0.0012, 0.0007, length(cl)) * (1.0 - lid);
      gSpec = mix(gSpec, 0.1, lid); gShin = mix(gShin, 16.0, lid); gSSS = lid;
    } else if (gKind > 5.5) {
      // sunglass lenses: a dark smoked lens with a blue-violet mirror coat, deeper toward the bottom
      // and the sky caught along its upper edge (a reflection that moves with the head, not a flat band)
      float g = smoothstep(uEye.y - 0.016, uEye.y + 0.014, vBind.y);
      c = mix(vec3(0.012, 0.013, 0.018), vec3(0.04, 0.05, 0.09), g);
      float curve = abs(vBind.x) / 0.09;
      totalEmissiveRadiance += vec3(0.3, 0.42, 0.62) * smoothstep(0.55, 1.0, g) * (0.6 + 0.4 * curve) * 0.5;
      gSpec = 1.4; gShin = 220.0;
    } else if (gKind > 4.5 && gKind < 5.5) {
      // padding / leather / boots: a fine grain
      kitH += 0.00003 * sin(vBind.x * 2100.0 + vBind.y * 1700.0) * sin(vBind.z * 1900.0 - vBind.y * 1300.0) * (1.0 - smoothstep(0.0008, 0.0016, fw));
      if (vSeg.z > 0.5 && vBind.y < 0.17) {
        // boots: a stitched toe cap, a heel tab in the team colour, a rubber sole
        vec3 aj = vBind.x > 0.0 ? uAnkleL : uAnkleL * vec3(-1.0, 1.0, 1.0);
        vec2 f = vec2(vBind.z - aj.z, vBind.y);
        float sx = (abs(vBind.x) - abs(aj.x)) / 0.05;
        float fine = 1.0 - smoothstep(0.0015, 0.003, fw);
        if (s < 0.5) {
          // the sole: dark rubber, the spikes' studs hinted round its edge
          c = vec3(0.075, 0.075, 0.08) * (1.0 - 0.35 * step(0.6, fract(f.x * 55.0)) * fine);
          gSpec = 0.02; gShin = 6.0;
        } else if (s > 32.5) {
          // the upper: a stitched toe cap, a mesh panel on the side, laces over the tongue, a heel tab in the team colour
          float toe = abs(f.x - 0.17 + 0.035 * sx * sx);
          c *= 1.0 - 0.3 * smoothstep(0.003, 0.001, toe) * fine;
          float mesh = smoothstep(0.55, 0.75, abs(sx)) * step(0.0, f.x) * step(f.x, 0.12) * step(0.08, f.y);
          c *= 1.0 - 0.12 * mesh * (0.5 + 0.5 * sin(f.x * 900.0) * sin(f.y * 900.0)) * fine;
          float lace = step(abs(sx), 0.28) * step(0.03, f.x) * step(f.x, 0.13) * step(0.105, f.y);
          c = mix(c, vec3(0.93), lace * smoothstep(0.35, 0.15, abs(fract(f.x * 70.0) - 0.5)) * fine);
          c *= 1.0 - 0.2 * lace * smoothstep(0.24, 0.3, abs(sx));
          c = mix(c, uKit1, smoothstep(-0.055, -0.065, f.x) * smoothstep(0.07, 0.08, f.y));
          // (the tongue's edges in shade either side of the laces; the sole a dark band with a clean top edge)
          c *= 1.0 - 0.16 * smoothstep(0.38, 0.3, abs(sx)) * smoothstep(0.22, 0.3, abs(sx)) * step(0.02, f.x) * step(f.x, 0.14) * step(0.095, f.y);
          c = mix(c, vec3(0.055, 0.055, 0.06), smoothstep(0.0255, 0.0235, f.y));
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
        float seam = smoothstep(0.05, 0.0, ph) * front * (1.0 - roll) + (exp(-pow((ky + 0.016) / 0.003, 2.0)) + exp(-pow((ky - 0.041) / 0.003, 2.0)) + exp(-pow((ky - 0.096) / 0.003, 2.0))) * front;
        c *= 1.0 - 0.28 * clamp(seam, 0.0, 1.0) * mix(0.5, 1.0, fade);
        c *= vec3(1.0, 0.99, 0.965);
      }
    } else if (gKind > 1.5 && gKind < 2.5) {
      // helmet shell / hard plastic: the crest on its front
      if (vHeadW > 0.5 && vBind.z > 0.1) { vec4 t = decalAt(vBind.xy, uCapAt, FIG(10), 0.0); c = mix(c, t.rgb, t.a); gSpec *= 1.0 - 0.3 * t.a; }
    }
    #ifdef FP_BODY
      // (the sleeve's seam where it meets the body, and the yoke's edge along the shoulder: from
      // above they say "shirt" where a plain dome said nothing)
      if (shirt && gl_FrontFacing) {
        vec2 at = armAt(vBind);
        float seam = exp(-pow((at.x - 0.1) / 0.008, 2.0)) * step(0.0, at.x);
        float yoke = exp(-pow((vBind.y - 1.418 + 0.05 * max(0.0, abs(vBind.x) - 0.2)) / 0.003, 2.0)) * step(0.072, abs(vBind.x)) * (1.0 - step(0.5, vArmW));
        c *= 1.0 - 0.35 * clamp(seam + yoke, 0.0, 1.0);
        kitH -= 0.0006 * seam;
      }
      // (seen from inside: a trouser leg or a pad is dark lining; the shirt and anything above it is
      // the shirt, shaded, so an opening at the collar never shows a dark hollow)
      if (!gl_FrontFacing) {
        bool lowS = (s > 3.5 && s < 4.5 && vBind.y < 0.9) || vSeg.y + vSeg.z > 0.5;
        if (lowS) c *= 0.32; else { c = uKit1 * 0.5; gWrap = 0.6; }
        gSpec = 0.0; gSSS = 0.0;
      }
      // (your neck's close, under the chin you do not have: the shadow inside your collar)
      if (vHeadW > 0.2 && skin) { c = mix(c, uKit1 * 0.5, smoothstep(0.2, 0.35, vHeadW)); gSpec = 0.0; gSSS = 0.0; gWrap = 0.6; }     // (your own body is two-sided: the inside of a trouser leg or pad is dark lining, not a hole)
    #endif
    diffuseColor.rgb = c;
  }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  if (uDetail > 0.5) {
    // bump from the procedural height (screen-space derivatives: no tangents needed)
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float dhx = dFdx(kitH), dhy = dFdy(kitH);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 gr = sign(det) * (dhx * r1 + dhy * r2);
    vec3 bn = normalize(abs(det) * normal - gr);
    normal = abs(det) > 1e-14 ? bn : normal;
  }
  #ifdef FP_BODY
    // (the inside of your shirt, and your neck's close, read as one flat lid lit from above: the top
    // of a solid body, never a hollow with its inner folds)
    if ((!gl_FrontFacing && !((vSlot > 3.5 && vSlot < 4.5 && vBind.y < 0.9) || vSeg.y + vSeg.z > 0.5)) || (vHeadW > 0.2 && vSlot > 4.5 && vSlot < 5.5)) normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  #endif`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  #ifdef FP_BODY
    if (vHeadW > 1.5 || (vHeadW > 0.35 && (vSlot < 4.5 || vSlot > 5.5))) discard;     // (your neck's skin stays: it closes the collar)
  #else
    if (vHeadW > 1.5 || (vHeadW > 0.35 && FIG(3).w > 0.5)) discard;     // (FIG(3).w: no head)
  #endif`)
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
            float refl = gKind > 5.5 ? 0.12 : gKind > 4.5 ? 0.06 : gKind > 3.5 ? 0.1 : 0.22;
            totalEmissiveRadiance += env * ao * refl * mix(0.25, 1.0, fres) * (gKind > 1.5 && gKind < 2.5 ? gSpec : 1.0);
          }
        }`)
      .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + totalEmissiveRadiance;');
    // (the constants in place of their uniforms)
    const strip = (src) => consts + src.replace(new RegExp(`uniform\\s+\\w+\\s+(${CONST_UNIFORMS.join('|')})\\s*;`, 'g'), '');
    sh.vertexShader = strip(sh.vertexShader); sh.fragmentShader = strip(sh.fragmentShader);
  };
  mat.customProgramCacheKey = () => 'cricket-kit-v13';
  mat.userData.uniforms = uniforms;
  return mat;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _S = new THREE.Vector3(), _E = new THREE.Vector3(),
  _T = new THREE.Vector3(), _dir = new THREE.Vector3(), _pv = new THREE.Vector3(), _end = new THREE.Vector3();
const _pq = new THREE.Quaternion(), _eul = new THREE.Euler(), _bq = new THREE.Quaternion();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const FOOT_ONLY = {}, HAND_ONLY = {};
// lowest(): the order the bones are tried in (where their joints usually are, lowest first)
const LOW_NAMES = ['ankleL', 'ankleR', 'kneeL', 'kneeR', 'handL', 'handR', 'hipL', 'hipR', 'hips', 'elbowL', 'elbowR', 'spine', 'head', 'neck', 'chest', 'shoulderL', 'shoulderR'];
let LOW_ORDER = null;
const _fq = new THREE.Quaternion();
const _wl = new THREE.Matrix4(), _om = new THREE.Matrix4(), _rw = new THREE.Matrix4();
// The bones whose position (not only rotation) the animation moves: the hips, and the
// elbows and hands (an arm lengthened to keep the gloves on the bat). Humanoid.update compares these.
const MOVABLE = ['hips', 'elbowL', 'handL', 'elbowR', 'handR'];
// c[o..o+2] = v? If not, it is now (an input of update() changed).
function same3(c, o, v) {
  if (c[o] === v.x && c[o + 1] === v.y && c[o + 2] === v.z) return true;
  c[o] = v.x; c[o + 1] = v.y; c[o + 2] = v.z;
  return false;
}

export class Humanoid {
  // vary: let this figure's height differ from the standard (fielders, umpires: not
  // the figures whose bodies the game measures, e.g. your own).
  constructor({ team = 'home', skin = null, hair = null, headgear = 'cap', pads = false, gloves = false, keeper = false, playerGrip = false, scale = 1, seed = 0, vary = false } = {}) {
    if (!RIG) throw new Error('loadAthlete() must finish before creating players');
    const rnd = (n) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    const look = this.look = lookFor(seed, team, team === 'umpire' ? 'umpire' : playerGrip ? 'self' : 'player');
    this.opts = { headgear, pads, gloves, keeper, playerGrip, shades: look.shades && (headgear === 'cap' || headgear === 'bare' || headgear === 'hat') };
    const u = this.u = figureValues();
    this.own = null;                              // (a material of its own, made when first needed: setGhost / setFade)
    this.material = sharedMaterial();
    u.uSkin.value.setHex(skin ?? look.skin);
    u.uHair.value.setHex(hair ?? look.hair);
    u.uIris.value.setHex(look.iris);
    u.uLook.value.set(look.build, look.hairVol, look.sleeves, look.sweatband);
    u.uLook2.value.set(look.beard, look.stubble, look.hairCut, look.zinc);
    u.uLook3.value.set(look.age, look.nose, look.brow, look.jaw);
    u.uLook4.value.set(look.expr || 0, look.hairStyle || 0, headgear === 'cap' || headgear === 'hat' || headgear === 'helmet' ? 1 : 0, 0);
    u.uLook5.value.set(look.faceLen || 0, look.faceWid || 0, look.cheek || 0, look.lips || 0);
    if (vary) scale *= look.scale;
    u.uSeed.value = rnd(9);
    u.uShades.value = this.opts.shades ? 1 : 0;
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
    // (detached, identity bind: the bone matrices are each bone relative to the mesh, so a figure
    // whose pose has not changed is not re-skinned or re-uploaded when only its root moves; see update())
    this.mesh.bindMode = THREE.DetachedBindMode;
    // Generous fixed culling sphere (covers raised arms, dives and a bat).
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.1);
    this.mesh.frustumCulled = true;
    this.boneList = bones;
    this._yr = new Float64Array(bones.length * 4);         // (lowest(): each bone's skinning matrix, its height row)
    this._ms = new Int32Array(bones.length).fill(-1);      // (... and the version of the world matrices it was made at)
    this.root = new THREE.Group();
    this.root.add(this.mesh);
    this._lookV = 1; this._blockV = 0;          // (the look's version, and the one written into the bone texture)
    this.trackMatrices();
    this.baseScale = BASE_SCALE * scale;
    this.root.scale.setScalar(this.baseScale);
    this.hipsRest = this.bones.hips.position.clone();
    this.ankleHeight = RIG.sole;                  // sole to ankle joint (model units)
    this.toeLength = RIG.toe;                     // ankle to the tip of the sole, along the foot (model units)
    this.lowY = 0;                                // the lowest point of the body last frame (world y, after groundGuard)
    this.armLength = RIG.J.shoulderL.distanceTo(RIG.J.elbowL) + RIG.J.elbowL.distanceTo(RIG.J.handL);
    // (everything set on a figure later, declared now in one order: every figure has the same
    // shape, so the per-frame code that reads and writes them stays monomorphic and boxes nothing)
    this.guardLift = 0; this.lowBone = -1; this.ghost = false; this.fade = 1;
    this.replayVisible = undefined; this.lodNear = undefined; this.extras = null;
    this._hullGeo = null; this._hull = null; this._low = 0.5; this._lowV = -1; this._lowB = -1; this._lowOut = 0.5;
    this._clipRig = null; this._shotLeg = null; this._lieIdx = null; this._kneeIdx = null; this._diveIdx = null; this._shinIx = null;
    u.uGloved.value = gloves ? 1 : 0;
    this.lookChanged();
    this.setNumber(team === 'umpire' ? 0 : 1 + Math.floor(rnd(3) * 98));
    this.setName(look.name);
    this.setTeam(team);
    // Contact shadow: a slot in the shared instanced shadow mesh.
    this.shadowSlot = ShadowPool.alloc(this);
    Humanoid.all.push(this);
  }

  // Pick the level of detail for every visible figure from the viewer's position
  // (h.lodNear: a figure the player watches closely keeps full detail further out).
  // (Humanoid.lodNear: the quality level's near distance, render/quality.js; a figure's own lodNear wins)
  static updateLods(viewer, nearDist = Humanoid.lodNear) {
    Humanoid.frame = (Humanoid.frame + 1) | 0;    // (once a frame: the pose LOD's stagger)
    if (SHARED) SHARED.uTime.value = (performance.now() / 1000) % 1000;
    for (const h of Humanoid.all) {
      if (!h.root.visible) continue;
      const p = h.root.position, dx = p.x - viewer.x, dz = p.z - viewer.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      h.setLod(d > (h.lodNear || nearDist) * (h.lod === 0 ? 1.15 : 1) ? 1 : 0);
    }
    Humanoid.updateGaze(viewer);
  }

  // The eyes turn, slowly, to you when you are within 3 m and inside ~40 degrees of where the head
  // faces (the two nearest such men only). Written into the look block (FIG(18).w) only when the
  // angle has moved by 2 degrees; a near figure's bone texture is uploaded each frame for its pose
  // anyway, so this adds no upload.
  static updateGaze(viewer) {
    const G = Humanoid._gz || (Humanoid._gz = { m: new THREE.Matrix4(), v: new THREE.Vector3(), near: [] });
    const near = G.near; near.length = 0;
    for (const h of Humanoid.all) {
      if (!h.root.visible || h.lod !== 0 || h.ghost || !h.bones || !h.bones.head) continue;
      const p = h.root.position, dx = p.x - viewer.x, dz = p.z - viewer.z, d2 = dx * dx + dz * dz;
      if (d2 < 9) near.push([d2, h]);
      else if (h._gaze) h._gazeTo(0, 0, true);
    }
    near.sort((a, b) => a[0] - b[0]);
    const F = RIG.face, ey = F.eye[1] - RIG.J.head.y, ez = F.front - 0.0128 - RIG.J.head.z;
    near.forEach(([, h], i) => {
      let ty = 0, tp = 0;
      if (i < 2) {
        const v = G.v.copy(viewer).applyMatrix4(G.m.copy(h.bones.head.matrixWorld).invert());
        v.y -= ey; v.z -= ez;
        const l = v.length();
        if (l > 1e-3 && v.z / l > 0.77) { ty = Math.max(-0.35, Math.min(0.35, Math.atan2(v.x, v.z))); tp = Math.max(-0.2, Math.min(0.2, Math.atan2(v.y, Math.hypot(v.x, v.z)))); }
      }
      if (i < 2) {
        // (small saccades: every half second to two seconds the eyes jump a degree or two, and back)
        const now = performance.now() / 1000, g = h._sac || (h._sac = { t: 0, y: 0, p: 0 });
        if (now > g.t) { const r = Math.random(); g.t = now + 0.5 + 1.5 * r; const z = r < 0.4; g.y = z ? 0 : (Math.random() - 0.5) * 0.08; g.p = z ? 0 : (Math.random() - 0.5) * 0.05; }
        ty += g.y; tp += g.p;
      }
      h._gazeTo(ty, tp, false);
    });
  }
  _gazeTo(ty, tp, snap) {
    const g = this._gaze || (this._gaze = { y: 0, p: 0, wy: 0, wp: 0 });
    if (snap) { g.y = ty; g.p = tp; } else { g.y += (ty - g.y) * 0.06; g.p += (tp - g.p) * 0.06; }
    if (Math.abs(g.y - g.wy) < 0.035 && Math.abs(g.p - g.wp) < 0.035 && !(snap && (g.wy || g.wp))) return;
    g.wy = g.y; g.wp = g.p;
    this.u.uLook4.value.w = (Math.round(g.y * 100) + 64) * 128 + (Math.round(g.p * 100) + 64);
    this.lookChanged();
  }

  // Shirt number on the back (0 = none), printed from the lettering glyphs.
  setNumber(n) {
    n = Math.max(0, Math.min(99, n | 0));
    this.number = n;
    this.u.uNum.value.set(n >= 10 ? Math.floor(n / 10) : -1, n === 0 ? -1 : n % 10);
    this.lookChanged();
  }

  // Name over the number (up to 12 letters).
  setName(name) {
    const u = this.u, s = String(name || '').toUpperCase().slice(0, 12);
    this.name = s;
    for (let i = 0; i < 12; i++) u.uName.value[i] = i < s.length ? glyphOf(s[i]) : -1;
    u.uNameLen.value = s.length;
    this.lookChanged();
  }

  setTeam(team) {
    const k = KITS[team] || KITS.home;
    const u = this.u;
    u.uKit1.value.setHex(k.kit1); u.uKit2.value.setHex(k.kit2); u.uKit3.value.setHex(k.kit3); u.uKit4.value.setHex(k.kit4);
    u.uPanel.value.setHex(k.panel ?? k.kit1);
    u.uCrestUV.value.copy(ATLAS.crest[k.crest] || ATLAS.crest[0]);
    if (k.sponsor >= 0) u.uSponsorUV.value.copy(ATLAS.sponsor[k.sponsor]); else u.uSponsorUV.value.set(0, 0, 0, 0);
    u.uTeamIx.value = team === 'umpire' ? 2 : team === 'away' ? 1 : 0;
    this.team = team;
    this.lookChanged();
  }

  // Look like another figure (skin, hair, face, build, shirt name and number): the two figures that draw the same man.
  copyLook(o) {
    const u = this.u, v = o.u;
    for (const k of ['uSkin', 'uHair', 'uIris', 'uLook', 'uLook2', 'uLook3', 'uLook4', 'uLook5']) u[k].value.copy(v[k].value);
    this.lookChanged();
    this.setNumber(o.number);
    this.setName(o.name);
    if (this.opts.shades !== o.opts.shades) { this.opts.shades = o.opts.shades; u.uShades.value = v.uShades.value; this.mesh.geometry = geometryFor(this.opts, this.lod); }
  }

  // 0 = full detail, 1 = distant.
  setLod(lod) {
    if (lod === this.lod) return;
    this.lod = lod;
    this.mesh.geometry = geometryFor(this.opts, lod);
    this.u.uLod.value = lod;
    this.lookChanged();
  }
  // The bare hand not drawn (bone index, -1 none): your bowling hand while it has its own model (viewModes.js).
  setHideHand(i) {
    if (this.u.uHideHand.value === i) return;
    this.u.uHideHand.value = i;
    this.lookChanged();
  }
  // A value of the figure's look changed: its block in the bone texture is written again (Humanoid.writeLook).
  lookChanged() { this._lookV++; }
  // The material it is drawn with: the shared one, or its own while it is your body through your
  // eyes (FP_BODY) or fading (alpha hash).
  ownMaterial() { return this.own || (this.own = kitMaterial(this.u)); }
  useMaterial() {
    const m = this.ghost || this.fade < 1 ? this.ownMaterial() : sharedMaterial();
    if (this.mesh.material !== m) this.mesh.material = m;
    this.material = m;
  }

  // Your own body through your own eyes: SOLID (kit, pads, boots, gloves on
  // the bat, forearms), only without the head and neck, in one opaque draw.
  // It used to be a faint see-through body because solid legs hid the ball at
  // your feet; now the body steps aside instead, only where it must: seeThrough()
  // tells the shader where the ball and your bat's blade are, and the body has a
  // dithered hole along your line of sight to them (and fades right at your eyes).
  // (legs, trunk: kept for the callers; the body no longer has opacities)
  setGhost(on) {
    on = !!on;
    if (!!this.ghost === on) return;
    this.ghost = on;
    const m = this.ownMaterial(), u = this.u;
    if (on) m.defines.FP_BODY = 1; else delete m.defines.FP_BODY;
    m.side = on ? THREE.DoubleSide : THREE.FrontSide;
    m.transparent = false; m.alphaHash = false; m.opacity = 1; m.depthWrite = true; m.needsUpdate = true;
    this.fade = 1;
    u.uNoHead.value = on ? 1 : 0;
    this.lookChanged();
    if (!on) { u.uFpBall.value.w = 0; u.uFpB0.value.w = 0; }
    this.useMaterial();
  }

  // Your upper body drawn behind your eyes (through your own eyes only): v world, or null for none.
  fpShift(v) {
    const u = this.u.uFpShift.value;
    if (!v) { u.set(0, 0, 0); return; }
    u.copy(v).applyQuaternion(_fq.copy(this.root.quaternion).invert()).divideScalar(this.root.scale.x || 1);
  }

  // Where the ball (or null: none to keep in view) and the bat's blade (b0 shoulder, b1 toe, or
  // null; halfWidth m) are this frame, for your own body to stay out of your line of sight to them.
  seeThrough(ball, b0 = null, b1 = null, halfWidth = 0.06) {
    const u = this.u;
    if (ball) u.uFpBall.value.set(ball.x, ball.y, ball.z, 1); else u.uFpBall.value.w = 0;
    if (b0 && b1) { u.uFpB0.value.set(b0.x, b0.y, b0.z, halfWidth); u.uFpB1.value.set(b1.x, b1.y, b1.z); } else u.uFpB0.value.w = 0;
  }

  // Fade the whole figure (and its bat) in or out: a = 0..1. Nobody appears
  // or disappears in one frame while he can be seen: a figure that has to
  // come or go (your runner leaving / rejoining you, a batter at the
  // pavilion gate) is faded. 1 = solid again (opaque material, depth written).
  setFade(a) {
    a = a < 0 ? 0 : a > 1 ? 1 : a;
    if (a === (this.fade ?? 1)) return;
    this.fade = a;
    if (this.ghost) return;                       // (your own body through your eyes is never faded)
    // (dissolved, not see-through: a hashed cut-out, so a fading figure is never a translucent ghost
    // with its far side showing through, and stays in the opaque pass; in a material of its own meanwhile)
    const m = this.ownMaterial();
    const tr = a < 1;
    if (m.alphaHash !== tr) { m.alphaHash = tr; m.needsUpdate = true; }
    m.opacity = a;
    this.useMaterial();
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
    this.placeShadow();
  }
  // The contact shadow under the hips (the matrices fresh).
  placeShadow() {
    if (!this.root.visible) return;
    this.update();
    _v.setFromMatrixPosition(this.bones.hips.matrixWorld);
    ShadowPool.set(this.shadowSlot, _v.x, _v.z, true, this.root.scale.x * (0.8 + 0.4 * Math.min(1, (_v.y - this.root.position.y) / 1.0)) * (this.ghost ? 1 : this.fade ?? 1));
  }
  // Lowest point of the posed body (world y): every bone's hull points
  // (vertex extremes, gear included; see hullFor) carried rigidly by the bone.
  // Bones whose joint is higher above the ground than their hull reaches are skipped.
  // The bones are tried lowest-first (feet, then up the body by where their joints
  // usually are), so for a figure on its feet the first few set `low` and every other
  // bone's joint is too high for its hull to reach under it. Unchanged since the
  // last call (the same world matrices): the same answer.
  lowest(only = null) { this.lowestInto(only); return this._lowOut; }
  // (the work: the answer left in _lowOut, not returned -- a number returned from a call
  // that is not inlined is a new heap number, several a figure a frame)
  lowestInto(only) {
    this.update();
    if (!only && this._lowV === this._wv) { this.lowBone = this._lowB; this._lowOut = this._low; return; }
    // (the full-detail mesh's hull, whatever LOD is drawn; looked up again only when the mesh changes:
    // geometryFor builds a key string, garbage every frame for every figure)
    if (this._hullGeo !== this.mesh.geometry) { this._hullGeo = this.mesh.geometry; this._hull = hullFor(geometryFor(this.opts, 0)); }
    const H = this._hull, sc = this.root.scale.y, BL = this.boneList;
    const Y = this._yr, MS = this._ms, v = this._wv, I = RIG.inverses;
    const L = only || LOW_ORDER || (LOW_ORDER = LOW_NAMES.map((n) => RIG.index[n]));
    let low = Infinity;
    for (let j = 0; j < L.length; j++) {
      const b = L[j], hb = H[b];
      if (!hb || BL[b].matrixWorld.elements[13] - hb.r * sc > low) continue;
      // (the height row of each skinning matrix the points use: bone world x inverse bind)
      for (let k = 0, U = hb.u; k < U.length; k++) {
        const s = U[k];
        if (MS[s] === v) continue;
        MS[s] = v;
        const w = BL[s].matrixWorld.elements, m = I[s].elements;
        for (let c = 0; c < 4; c++) Y[s * 4 + c] = w[1] * m[c * 4] + w[5] * m[c * 4 + 1] + w[9] * m[c * 4 + 2] + w[13] * m[c * 4 + 3];
      }
      const n = hb.n, e = hb.e;
      for (let i = 0, o = 0; i < n.length; i++) {
        let y = 0;                                    // linear blend skinning, height only
        for (let c = n[i]; c > 0; c--, o += 5) { const r = e[o] * 4; y += Y[r] * e[o + 1] + Y[r + 1] * e[o + 2] + Y[r + 2] * e[o + 3] + Y[r + 3] * e[o + 4]; }
        if (y < low) { low = y; this.lowBone = b; }
      }
    }
    if (!only) { this._low = low; this._lowV = v; this._lowB = this.lowBone; }
    this._lowOut = low;
  }

  // A swinging (not planted) foot that dips into the turf: bend that leg
  // (IK, same knee direction, same foot orientation) so the sole clears it.
  // pole: the knee's IK pole to keep (default: out along the knee's current direction).
  clearFoot(side, pole = null) {
    const ia = RIG.index[nm('ankle', side)], ik = RIG.index[nm('knee', side)];
    const low = this.lowest(FOOT_ONLY[side] || (FOOT_ONLY[side] = [ia, ik]));
    if (low >= 0) return 0;
    const ank = this.bones[nm('ankle', side)];
    ank.getWorldQuaternion(_bq);
    ank.getWorldPosition(_T); _T.y -= low;
    this.bones[nm('knee', side)].getWorldPosition(_v);
    this.bones[nm('hip', side)].getWorldPosition(_v2);
    _v.add(_v.clone().sub(_v2).setY(0).multiplyScalar(2));       // pole: out along the knee's current direction
    this.ikLeg(side, _T, pole || _v);
    this.setWorldQuat(nm('ankle', side), _bq);
    return -low;
  }

  // The same for an arm (a dive's leading arm stretched along the turf):
  // bend it so the hand and forearm stay on top of the turf.
  clearHand(side) {
    const ih = RIG.index[nm('hand', side)], ie = RIG.index[nm('elbow', side)];
    const low = this.lowest(HAND_ONLY[side] || (HAND_ONLY[side] = [ih, ie]));
    if (low >= 0) return 0;
    const hand = this.bones[nm('hand', side)];
    hand.getWorldQuaternion(_bq);
    hand.getWorldPosition(_T); _T.y -= low;
    this.bones[nm('elbow', side)].getWorldPosition(_v); _v.y -= 0.3;
    this.ikArm(side, _T, _v);
    this.setWorldQuat(nm('hand', side), _bq);
    return -low;
  }

  // Last line of defence: if any part of the body is below the turf (a pose
  // or a blend the animation code did not foresee), lift the whole figure so
  // its lowest point is on it. tol: what may go under (soles / pads press in).
  groundGuard(tol = 0.002) {
    this.lowestInto(null);
    const low = this._lowOut;
    this.lowY = low;
    this.guardLift = low < -tol ? -(low + tol) : 0;
    if (low < -tol) {
      this.root.position.y -= low + tol;
      this.update();
      this.lowY = -tol;
    }
    return low;
  }

  reset() {
    for (let i = 0, L = this.boneList; i < L.length; i++) L[i].quaternion.identity();     // (not Object.values: an array a figure a frame)
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

  // The figure's matrices (root, mesh, bones), made fresh only where an input has changed
  // since they were last made: a bone's rotation (its quaternion's change callback), the
  // position of a bone that can move (the hips; the elbows and hands, an arm's stretch:
  // MOVABLE), the root's place, turn and size. Everything that refreshes or reads a world
  // matrix (updateMatrixWorld, updateWorldMatrix, getWorldPosition / Quaternion,
  // worldToLocal: ours, the IK's, three's own scene pass) comes here, so a figure is posed
  // once and its matrices made once, not the whole figure again at every read; with
  // nothing changed it is a few comparisons. The mesh never moves on its root, and the
  // scene above is not moved (its matrix is compared where a move would show: scale, place).
  // _lv / _wv: versions of the pose (bones on the root) and of the world matrices.
  update() {
    const r = this.root, c = this._in, P = r.parent;
    let all = this._all;
    if (!same3(c, 0, r.position)) all = true;
    if (!same3(c, 3, r.scale)) all = true;
    { const q = r.quaternion; if (c[6] !== q._x || c[7] !== q._y || c[8] !== q._z || c[9] !== q._w) { c[6] = q._x; c[7] = q._y; c[8] = q._z; c[9] = q._w; all = true; } }
    if (P) { const e = P.matrixWorld.elements; if (c[10] !== e[0] || c[11] !== e[5] || c[12] !== e[10] || c[13] !== e[12] || c[14] !== e[13] || c[15] !== e[14]) { c[10] = e[0]; c[11] = e[5]; c[12] = e[10]; c[13] = e[12]; c[14] = e[13]; c[15] = e[14]; all = true; } }
    const B = this.boneList, MV = this._mv;
    let dm = this._dm;
    for (let k = 0; k < MV.length; k++) if (!same3(c, 16 + 3 * k, B[MV[k]].position)) dm |= 1 << MV[k];
    if (!all && dm === 0) return;
    const m = this.mesh;
    if (all) {
      r.matrix.compose(r.position, r.quaternion, r.scale);
      if (P) r.matrixWorld.multiplyMatrices(P.matrixWorld, r.matrix); else r.matrixWorld.copy(r.matrix);
      m.matrix.compose(m.position, m.quaternion, m.scale);
      m.matrixWorld.multiplyMatrices(r.matrixWorld, m.matrix);
      r.matrixWorldNeedsUpdate = m.matrixWorldNeedsUpdate = false;
      this._all = false;
    }
    const pi = this._pi, W = m.matrixWorld;
    let moved = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], p = pi[i], bit = 1 << i, own = (dm & bit) !== 0;
      if (own) b.matrix.compose(b.position, b.quaternion, b.scale);
      if (own || all || (p >= 0 && (moved & (1 << p)) !== 0)) {
        b.matrixWorld.multiplyMatrices(p < 0 ? W : B[p].matrixWorld, b.matrix);
        b.matrixWorldNeedsUpdate = false;
        moved |= bit;
      }
    }
    this._dm = 0;
    if (dm !== 0) this._lv++;
    this._wv++;
  }

  // The figure's look into the tail of its bone texture data M (texels 224.., FIG(i) in the
  // shaders): kit colours (linear), skin, hair, panel, iris with a scalar each, the build and
  // face, the crest and sponsor rects, the brim, the number and the name's glyphs.
  writeLook(M) {
    const u = this.u, o = FIG_TEXEL * 4;
    const c3 = (i, c, w) => { const k = o + i * 4; M[k] = c.r; M[k + 1] = c.g; M[k + 2] = c.b; M[k + 3] = w; };
    const v4 = (i, v) => { const k = o + i * 4; M[k] = v.x; M[k + 1] = v.y; M[k + 2] = v.z; M[k + 3] = v.w; };
    c3(0, u.uKit1.value, u.uSeed.value); c3(1, u.uKit2.value, u.uLod.value); c3(2, u.uKit3.value, u.uTeamIx.value); c3(3, u.uKit4.value, u.uNoHead.value);
    c3(4, u.uSkin.value, u.uGloved.value); c3(5, u.uHair.value, u.uHideHand.value); c3(6, u.uPanel.value, u.uShades.value); c3(7, u.uIris.value, u.uNameLen.value);
    v4(8, u.uLook.value); v4(9, u.uLook2.value); v4(10, u.uCrestUV.value); v4(11, u.uSponsorUV.value); v4(17, u.uLook3.value); v4(18, u.uLook4.value); v4(19, u.uLook5.value);
    { const k = o + 48, b = u.uBrim.value; M[k] = b.x; M[k + 1] = b.y; M[k + 2] = b.z; M[k + 3] = u.uNum.value.x; }
    for (let i = 0; i < 12; i++) M[o + 52 + i] = u.uName.value[i];
    M[o + 64] = u.uNum.value.y;
  }

  // Route every matrix refresh of this figure through update() (see there), and skin from
  // the bones relative to the mesh: a skeleton re-made (and its bone texture re-uploaded)
  // only when the pose has changed, not when the figure only moves. Nothing else of the
  // figure is a child of a bone (gear is merged into the mesh; bats are scene objects).
  trackMatrices() {
    const B = this.boneList;
    this._mv = Int8Array.from(MOVABLE, (n) => RIG.index[n]);
    this._in = new Float64Array(16 + this._mv.length * 3).fill(NaN);
    this._pi = Int8Array.from(B, (b) => B.indexOf(b.parent));
    this._dm = (1 << B.length) - 1; this._all = true; this._lv = 0; this._wv = 0;
    B.forEach((b, i) => b.quaternion._onChange(() => { this._dm |= 1 << i; }));   // (no Euler kept in step: nothing reads a bone's .rotation)
    const up = () => this.update(), root = this.root;
    for (const o of [root, this.mesh, ...B]) {
      o.updateMatrixWorld = up;
      o.updateWorldMatrix = up;
      o.worldToLocal = (v) => { up(); return v.applyMatrix4(_wl.copy(o.matrixWorld).invert()); };
      o.localToWorld = (v) => { up(); return v.applyMatrix4(o.matrixWorld); };
      // (a world rotation is the rotations up the chain, multiplied: no matrices made or taken
      // apart for it, so the IK turning one bone after another needs none in between; sizes are uniform)
      o.getWorldQuaternion = (q) => { q.copy(o.quaternion); for (let p = o.parent; p !== null; p = p.parent) q.premultiply(p.quaternion); return q.normalize(); };
    }
    // (each bone on the mesh: its world matrix seen from the mesh's; at most once a pose)
    const m = this.mesh, sk = m.skeleton, R = B.map(() => new THREE.Matrix4());
    let rv = -1;
    const rel = () => {
      up();
      if (rv === this._wv) return R;
      rv = this._wv;
      _rw.copy(m.matrixWorld).invert();
      for (let i = 0; i < B.length; i++) R[i].multiplyMatrices(_rw, B[i].matrixWorld);
      return R;
    };
    // (the bone texture made here, 16 x 16: the bones' 68 texels at its head, the figure's look at its tail)
    sk.boneMatrices = new Float32Array(16 * 16 * 4);
    sk.boneTexture = new THREE.DataTexture(sk.boneMatrices, 16, 16, THREE.RGBAFormat, THREE.FloatType);
    let sv = -1;
    sk.update = () => {
      up();
      const pose = sv !== this._lv, look = this._blockV !== this._lookV;
      if (!pose && !look) return;
      const M = sk.boneMatrices;
      if (pose) {
        sv = this._lv;
        rel();
        const I = sk.boneInverses;
        for (let i = 0; i < R.length; i++) _om.multiplyMatrices(R[i], I[i]).toArray(M, i * 16);
      }
      if (look) { this._blockV = this._lookV; this.writeLook(M); }
      sk.boneTexture.needsUpdate = true;
    };
    // (a vertex skinned on the CPU, in the mesh's space as three's own: the bones relative to the mesh)
    const sI = new THREE.Vector4(), sW = new THREE.Vector4(), b0 = new THREE.Vector3(), t = new THREE.Vector3();
    m.applyBoneTransform = (index, v) => {
      rel();
      sI.fromBufferAttribute(m.geometry.attributes.skinIndex, index);
      sW.fromBufferAttribute(m.geometry.attributes.skinWeight, index);
      b0.copy(v); v.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sW.getComponent(k);
        if (w !== 0) { const s = sI.getComponent(k); v.addScaledVector(t.copy(b0).applyMatrix4(_om.multiplyMatrices(R[s], sk.boneInverses[s])), w); }
      }
      return v;
    };
  }

  // Capture the current pose so a new one can be blended from it.
  snapshot(out = { q: [], hipsY: 0, hipsP: new THREE.Vector3() }) {
    for (let i = 0, L = this.boneList; i < L.length; i++) (out.q[i] ||= new THREE.Quaternion()).copy(L[i].quaternion);
    out.hipsP.copy(this.bones.hips.position);
    return out;
  }
  // current = lerp(snapshot, current, w)
  blendFrom(snap, w) {
    if (w >= 1) return;
    for (let i = 0, L = this.boneList; i < L.length; i++) { const q = L[i].quaternion; _bq.copy(q); q.slerpQuaternions(snap.q[i], _bq, w); }
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
    const pitch = clamp(Math.atan2(-_v2.y, hyp(_v2.x, _v2.z)), -0.7, 0.8) * amount;
    this.rot('neck', pitch * 0.4, yaw * 0.45, 0, 'YXZ');
    this.rot('head', pitch * 0.6, yaw * 0.55, 0, 'YXZ');
  }

  worldPos(name, out) { return this.bones[name].getWorldPosition(out); }

  // Two-bone IK: limb = 'L' | 'R' arm, or 'legL' | 'legR'.
  ikArm(side, target, pole) {
    const b = this.bones;
    solveTwoBone(b[nm('shoulder', side)], b[nm('elbow', side)], b[nm('hand', side)], target, pole, 1);
  }
  ikLeg(side, target, pole) {
    const b = this.bones;
    solveTwoBone(b[nm('hip', side)], b[nm('knee', side)], b[nm('ankle', side)], target, pole, -1);
  }

  // Set a bone's world orientation.
  setWorldQuat(name, q) {
    const bone = this.bones[name];
    bone.parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq).multiply(q);        // (its matrices are made when next read: update())
  }
}

// All actor shadows (sun shadows shaped by the bones + foot contact): one
// instanced draw, render/shadows.js.
import { ShadowPool } from './shadows.js';
export { ShadowPool };

// Aim a bone's -Y axis along a world direction.
function aimBone(bone, dirWorld) {
  bone.parent.getWorldQuaternion(_pq).invert();
  _v2.copy(dirWorld).applyQuaternion(_pq).normalize();
  bone.quaternion.setFromUnitVectors(DOWN, _v2);
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
  upper.getWorldPosition(_S);                   // (fresh matrices: Humanoid.update)
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
}
Humanoid.all = [];
Humanoid.lodNear = 13;          // m: full detail inside this (the quality level sets it; render/quality.js)
Humanoid.eye = null;            // your eyes (world; NearCull.update keeps it: the game's eye, the replay's or a ceremony's camera)
Humanoid.frame = 0;

// Pose LOD: a figure that is far from your eyes and calm (standing, walking in, jogging
// back: nothing he is doing with the ball, no signal, no celebration) has his full-body
// pose made every midDiv-th frame beyond `near` m and every farDiv-th beyond `far` m,
// staggered across the figures, each made for the time it is reached (that many frames
// ahead); every frame in between shows the pose between the last two, by time (Actor.lodShow),
// and his root (place, turn, stride), ground guard and shadow are made every frame. So
// what is drawn, and what the replay records, moves every frame. Never inside
// ANIM_LOD_MIN m. on = false: every pose every frame. A lever for the quality governor
// (render/perf.js): `near` / `far` nearer, the divisors larger, when the CPU is short.
export const ANIM_LOD = { on: true, near: 18, far: 40, midDiv: 2, farDiv: 3, calmSpeed: 4.5 };
export const ANIM_LOD_MIN = 12;
// Every how many frames to pose a figure whose root is at p (x, z), calm or not.
export function poseEvery(p, calm) {
  const L = ANIM_LOD, e = Humanoid.eye;
  if (!calm || !L.on || !e) return 1;
  const dx = p.x - e.x, dz = p.z - e.z, d2 = dx * dx + dz * dz, n = Math.max(L.near, ANIM_LOD_MIN);
  return d2 < n * n ? 1 : d2 < L.far * L.far ? L.midDiv : L.farDiv;
}
