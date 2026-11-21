// The one sun: key light direction, colours and intensities for the whole
// scene, in one place, so the sky's sun disc, the baked stand shadow on the
// turf, the figures' sun shadows (shadows.js) and the lights all agree.
//
// Late afternoon: the sun ~36 deg up, side-on to the pitch (behind square leg
// for the batter, over the bowler's right shoulder at the far end), so it is
// never in the eyeline down the pitch from either end. Warm key, cool sky
// fill: lit kit reads warm, shade reads blue.
import * as THREE from 'three';

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
// stand outline in env.js: the side-stand roof lip (~29.6 m up at r 92, the
// roofs cover |sin(azimuth)| > sin(0.42)) and the top of the upper tier
// (~22 m at r 111) all round. A sun ray from the turf toward the sun is
// blocked if it is still below an edge when it reaches that radius. Soft over
// ~2 m (the edge is far away and the roof is not a knife edge). Used for the
// baked turf shadow and to fade the sun shadows of figures standing in it.
const ROOF_R = 92, ROOF_H = 29.6, TOP_R = 111.2, TOP_H = 22.1, ROOF_SIN = Math.sin(0.42);
const _hx = SUN_DIR.x / Math.hypot(SUN_DIR.x, SUN_DIR.z), _hz = SUN_DIR.z / Math.hypot(SUN_DIR.x, SUN_DIR.z);
const TAN_E = SUN_DIR.y / Math.hypot(SUN_DIR.x, SUN_DIR.z);
export function standShade(x, z, centreZ) {
  const px = x, pz = z - centreZ;
  const b = px * _hx + pz * _hz, c = px * px + pz * pz;
  let s = 0;
  // Roof lip.
  let disc = b * b - (c - ROOF_R * ROOF_R);
  if (disc > 0) {
    const t = -b + Math.sqrt(disc);
    const hx = px + _hx * t;
    const roofed = smooth(ROOF_SIN - 0.03, ROOF_SIN + 0.03, Math.abs(hx) / ROOF_R);
    s = Math.max(s, roofed * smooth(-1.6, 1.6, ROOF_H - t * TAN_E));
  }
  disc = b * b - (c - TOP_R * TOP_R);
  if (disc > 0) s = Math.max(s, smooth(-1.6, 1.6, TOP_H - (-b + Math.sqrt(disc)) * TAN_E));
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
