// three.js helpers shared by render code.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Physics <-> three conversions.
export const toV3 = (out, v) => out.set(v.x, v.y, v.z);
export const toQ = (out, q) => out.set(q.x, q.y, q.z, q.w);
export const fromV3 = (out, v) => out.set(v.x, v.y, v.z);
export const fromQ = (out, q) => out.set(q.x, q.y, q.z, q.w);

// Give a geometry a uniform vertex colour (so many parts can merge into one
// draw call with a vertexColors material).
export function colorize(geom, color) {
  const c = new THREE.Color(color);
  const g = geom.index ? geom.toNonIndexed() : geom;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

// Box/cylinder part, positioned, coloured.
export function part(geom, color, pos = [0, 0, 0], rot = null, scale = null) {
  const g = geom.clone();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const s = scale ? new THREE.Vector3(...scale) : new THREE.Vector3(1, 1, 1);
  m.compose(new THREE.Vector3(...pos), q, s);
  g.applyMatrix4(m);
  return colorize(g, color);
}

export function merge(parts) {
  const clean = parts.map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') out.deleteAttribute(k);
    return out;
  });
  return mergeGeometries(clean, false);
}

export const vertexColorMat = (opts = {}) => new THREE.MeshLambertMaterial({ vertexColors: true, ...opts });

// Radial gradient texture (blob shadows, glows).
export function radialTexture(size = 64, inner = 'rgba(0,0,0,0.55)', outer = 'rgba(0,0,0,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
}
