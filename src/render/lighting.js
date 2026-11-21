// The one sun: key light direction, colours and intensities for the whole
// scene, in one place, so the sky's sun disc, the baked stand shadow on the
// turf, the figures' sun shadows (shadows.js) and the lights all agree.
//
// Late afternoon: the sun ~36 deg up, side-on to the pitch (behind square leg
// for the batter, over the bowler's right shoulder at the far end), so it is
// never in the eyeline down the pitch from either end. Warm key, cool sky
// fill: lit kit reads warm, shade reads blue.
import * as THREE from 'three';
import { SUN_BLOCKERS } from './stadium.js';

// Unit vector from the ground TOWARD the sun.
export const SUN_DIR = new THREE.Vector3(-0.70, 0.588, 0.405).normalize();
export const SUN_COLOR = new THREE.Color(0xffe6c4);
export const SUN_INTENSITY = 3.5;
export const SKY_COLOR = new THREE.Color(0x9ec3ee);      // hemisphere: sky dome light
export const GROUND_COLOR = new THREE.Color(0x7c7650);   // hemisphere: warm turf bounce
export const HEMI_INTENSITY = 1.4;
// A weak cool fill from the side away from the sun (the bright sky opposite),
// so the shade side of a figure keeps its shape instead of going flat.
export const FILL_DIR = new THREE.Vector3(0.62, 0.32, -0.45).normalize();
export const FILL_COLOR = new THREE.Color(0xb7cdf0);
export const FILL_INTENSITY = 0.4;
// Aerial haze: the sky's horizon colour, so distant things melt into it.
export const HAZE_COLOR = new THREE.Color(0xcfdbe6);
export const FOG_NEAR = 140, FOG_FAR = 900;

// Ground shadow projection: a point at height y lands on the turf at
// (x + y * SHADOW_X, z + y * SHADOW_Z) (away from the sun).
export const SHADOW_X = -SUN_DIR.x / SUN_DIR.y;
export const SHADOW_Z = -SUN_DIR.z / SUN_DIR.y;

// What a flat, up-facing Lambert surface receives from these lights (linear,
// already / PI like three's BRDF_Lambert): the custom turf, pitch and rope
// shaders multiply their albedo by this so they match the Lambert world.
// shade = sky light only (in the sun's shadow).
export function flatIrradiance(shade = false, out = new THREE.Color()) {
  out.copy(SKY_COLOR).multiplyScalar(HEMI_INTENSITY);
  out.r += FILL_COLOR.r * FILL_INTENSITY * Math.max(0, FILL_DIR.y);
  out.g += FILL_COLOR.g * FILL_INTENSITY * Math.max(0, FILL_DIR.y);
  out.b += FILL_COLOR.b * FILL_INTENSITY * Math.max(0, FILL_DIR.y);
  if (!shade) {
    const k = SUN_INTENSITY * SUN_DIR.y;
    out.r += SUN_COLOR.r * k; out.g += SUN_COLOR.g * k; out.b += SUN_COLOR.b * k;
  }
  return out.multiplyScalar(1 / Math.PI);
}

// Shade / sun ratio per channel (linear): how much a sun shadow keeps of the
// lit turf. Cool, because only the blue sky still reaches it.
export function shadeRatio(out = new THREE.Color()) {
  const lit = flatIrradiance(false), sh = flatIrradiance(true, out);
  return out.setRGB(sh.r / lit.r, sh.g / lit.g, sh.b / lit.b);
}

// The stands' shadow on the outfield (0 = sunlit .. 1 = in shade), from the
// bowl as stadium.js builds it (SUN_BLOCKERS): a sun ray from the turf is
// blocked if it passes under a roof lip, or below the stand / bank / pavilion
// profile at that angle. Soft over ~2 m (the edges are far away and not knife
// edges) and over a degree at the ends of the roofs. Used for the baked turf
// shadow and to fade the sun shadows of figures standing in it.
const _hx = SUN_DIR.x / Math.hypot(SUN_DIR.x, SUN_DIR.z), _hz = SUN_DIR.z / Math.hypot(SUN_DIR.x, SUN_DIR.z);
const TAN_E = SUN_DIR.y / Math.hypot(SUN_DIR.x, SUN_DIR.z);
const DEG = 180 / Math.PI;
export function standShade(x, z, centreZ) {
  const px = x, pz = z - centreZ, B = SUN_BLOCKERS, Rf = B.roof;
  const b = px * _hx + pz * _hz, c = px * px + pz * pz;
  let s = 0;
  const hit = (R) => { const disc = b * b - (c - R * R); return disc > 0 ? -b + Math.sqrt(disc) : -1; };
  // Roof lip: under it, the ray meets the roof or the closed back of the stand.
  let t = hit(Rf.rF);
  if (t > 0) {
    const a = Math.atan2(px + _hx * t, pz + _hz * t) * DEG;
    const roofed = (B.roofed(a - 0.6) + B.roofed(a) + B.roofed(a + 0.6)) / 3;
    if (roofed > 0) s = roofed * smooth(-1.6, 1.6, Rf.yF - t * TAN_E);
  }
  // The open profile: stands without a roof, the grass bank, the pavilion.
  if (s > 0.999) return 1;
  for (const R of B.radii) {
    if ((t = hit(R)) <= 0 || t * TAN_E > Rf.yF + 1) continue;     // (already above anything the bowl has)
    const top = B.top(Math.atan2(px + _hx * t, pz + _hz * t) * DEG, R);
    if (top > 0) s = Math.max(s, smooth(-1.6, 1.6, top - t * TAN_E));
  }
  return s;
}
function smooth(a, b, v) { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); }

export function buildLights(parent, scene) {
  const hemi = new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, HEMI_INTENSITY);
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.copy(SUN_DIR).multiplyScalar(100);
  const fill = new THREE.DirectionalLight(FILL_COLOR, FILL_INTENSITY);
  fill.position.copy(FILL_DIR).multiplyScalar(100);
  parent.add(hemi, sun, fill);
  scene.fog = new THREE.Fog(HAZE_COLOR, FOG_NEAR, FOG_FAR);
  return { hemi, sun, fill };
}
