// Sun shadows without shadow maps: every figure, bat and stump casts a soft
// shadow along the sun (lighting.js), all in ONE instanced draw.
//
// An instance is a quad on the turf round a set of capsules in ground space:
// for a figure, the shadows of its shins, thighs, trunk, head and arms (its
// bone positions pushed down the sun's rays onto the turf), plus a tight dark
// contact blob under each foot that fades as the foot lifts. The fragment
// shader takes the union of the capsules (min of distances: no dark overlaps)
// and multiplies the ground by the cool shade colour, so a shadow is the turf
// with only the sky's light, as the baked stand shadow is. A figure's shadow
// leaves its feet when it jumps or dives, and sticks (bat, stumps) use the
// shin slot alone.
import * as THREE from 'three';
import { hyp } from './anim.js';
import { SHADOW_X, SHADOW_Z, shadeRatio, standShade } from './lighting.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';

const F = 36;                // floats per instance: 9 vec4
const Y = 0.014;             // above the turf and the pitch (with polygon offset)
const SOLE = 0.08;           // ankle joint above the turf when standing (m, life size)

// Display-space multipliers: the shade colour (sky light only) and the contact blob.
const _sr = shadeRatio();
const SHADE = new THREE.Vector3(Math.pow(_sr.r, 1 / 2.2), Math.pow(_sr.g, 1 / 2.2), Math.pow(_sr.b, 1 / 2.2));

function shadowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uShade: { value: SHADE }, uY: { value: Y }, uDetail: { value: 2 } },
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,      // dst * src: a multiply
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    vertexShader: /* glsl */`
      uniform float uY;
      attribute vec4 aAnk; attribute vec4 aKnee; attribute vec4 aHip; attribute vec4 aBody;
      attribute vec4 aHead; attribute vec4 aHand; attribute vec4 aFoot; attribute vec4 aRad; attribute vec4 aMisc;
      varying vec4 vAnk; varying vec4 vKnee; varying vec4 vHip; varying vec4 vBody; varying vec4 vHead; varying vec4 vHand; varying vec4 vFoot; varying vec4 vRad; varying vec4 vMisc;
      varying vec2 vP;
      void main() {
        vAnk = aAnk; vKnee = aKnee; vHip = aHip; vBody = aBody; vHead = aHead; vHand = aHand; vFoot = aFoot; vRad = aRad; vMisc = aMisc;
        vec2 lo = min(min(min(aAnk.xy, aAnk.zw), min(aKnee.xy, aKnee.zw)), min(min(aHip.xy, aHip.zw), min(aBody.xy, aBody.zw)));
        lo = min(lo, min(min(aHead.xy, aHead.zw), aHand.xy));
        vec2 hi = max(max(max(aAnk.xy, aAnk.zw), max(aKnee.xy, aKnee.zw)), max(max(aHip.xy, aHip.zw), max(aBody.xy, aBody.zw)));
        hi = max(hi, max(max(aHead.xy, aHead.zw), aHand.xy));
        float m = max(max(aRad.x, aRad.y), max(aRad.z, aRad.w)) + aMisc.z + 0.08;
        vP = mix(lo - m, hi + m, position.xz);
        gl_Position = max(aMisc.x, aMisc.y) <= 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(vP.x, uY, vP.y, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uShade;
      varying vec4 vAnk; varying vec4 vKnee; varying vec4 vHip; varying vec4 vBody; varying vec4 vHead; varying vec4 vHand; varying vec4 vFoot; varying vec4 vRad; varying vec4 vMisc;
      varying vec2 vP;
      float seg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / (dot(ba, ba) + 1e-6), 0.0, 1.0)); }
      uniform float uDetail;    // quality.js: 2 every limb, 1 legs and trunk, 0 one soft blob + the contact pools
      void main() {
        vec2 p = vP;
        float sun = 0.0;
        if (uDetail > 0.5) {
        float sd = min(seg(p, vAnk.xy, vKnee.xy), seg(p, vAnk.zw, vKnee.zw));
        sd = min(sd, min(seg(p, vKnee.xy, vHip.xy), seg(p, vKnee.zw, vHip.zw))) - vRad.x;
        sd = min(sd, seg(p, vBody.xy, vBody.zw) - vRad.y);
        if (uDetail > 1.5) {
        sd = min(sd, seg(p, vBody.zw, vHead.xy) - vRad.z);                 // head: neck..crown
        sd = min(sd, min(seg(p, vBody.zw, vHead.zw), seg(p, vBody.zw, vHand.xy)) - vRad.w);
        }
        float aa = 0.03 + 0.7 * length(fwidth(p));                 // soft edge, never narrower than a pixel
        sun = smoothstep(aa, -aa, sd) * vMisc.x;
        } else {
          // the cheapest level: one soft capsule from between the feet to the hips' shadow, so a figure
          // is still standing on the turf (not floating) when the limbs' shadows are off
          float sd = seg(p, (vAnk.xy + vAnk.zw) * 0.5, vBody.xy) - max(vRad.x, vRad.y);
          sun = smoothstep(0.14, -0.1, sd) * vMisc.x * 0.8;
        }
        // Contact: a soft dark pool centred under each foot (vMisc.z = its radius, vHand.zw = strengths):
        // smooth to its rim (no dark core), and cool grey rather than plain darker: on the pitch's clay a
        // straight multiply read as a brown stain.
        float r = max(vMisc.z, 1e-3);
        vec2 q0 = (p - vFoot.xy) / r, q1 = (p - vFoot.zw) / r;
        float c0 = max(1.0 - dot(q0, q0), 0.0), c1 = max(1.0 - dot(q1, q1), 0.0);
        float ao = max(c0 * c0 * vHand.z, c1 * c1 * vHand.w) * vMisc.y;
        gl_FragColor = vec4(mix(vec3(1.0), uShade, sun) * mix(vec3(1.0), uShade * 0.6, ao * 0.85), 1.0);
      }`,
  });
}

// Sticks: a..b the thick part (shins + thighs slots), b..c a thin part (arm slot).
// Bat (mesh frame: grip at the origin, +Y up the handle): blade toe..shoulder, then the handle.
const _bc = CONFIG.bat, _sh = _bc.gripFromHandleTop - _bc.handleLength;
const BAT = { a: new THREE.Vector3(0, _sh - _bc.bladeLength, 0), b: new THREE.Vector3(0, _sh, 0), c: new THREE.Vector3(0, _bc.gripFromHandleTop, 0), r: _bc.bladeWidth * 0.36, rArm: _bc.handleRadius };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m = new THREE.Vector3();
// A bone's shadow on the turf into d[o + k], d[o + k + 1].
// (a plain function: a closure made per figure per frame was garbage; nothing returned: a number
// returned from a call that is not inlined is a heap number)
function P(d, o, bone, k) {
  const e = bone.matrixWorld.elements, y = e[13];
  d[o + k] = e[12] + y * SHADOW_X; d[o + k + 1] = e[14] + y * SHADOW_Z;
}

export const ShadowPool = {
  mesh: null, n: 0, max: 40, data: null, buf: null, owners: [], sticks: [], dirty: false, used: 0, scene: null, scanned: -1,
  init(scene) {
    if (this.mesh) return;
    this.scene = scene;
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.rotateX(-Math.PI / 2);
    quad.translate(0.5, 0, 0.5);                        // corners 0..1 (the vertex shader spans them)
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.attributes.position);
    this.data = new Float32Array(this.max * F);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, F, 1).setUsage(THREE.DynamicDrawUsage);
    ['aAnk', 'aKnee', 'aHip', 'aBody', 'aHead', 'aHand', 'aFoot', 'aRad', 'aMisc'].forEach((k, i) => g.setAttribute(k, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4)));
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, shadowMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'sunShadows';
    scene.add(this.mesh);
  },
  // A figure's slot (owner: the Humanoid, whose bones shape the shadow).
  alloc(owner = null) {
    if (this.n >= this.max - 12) return -1;           // (the last slots are for sticks)
    this.owners[this.n] = owner;
    return this.n++;
  },
  // A rigid stick that casts a shadow (kind 'bat' | 'stump'), read from its world matrix every frame.
  track(obj, kind) {
    if (this.sticks.some((s) => s.obj === obj) || this.sticks.length >= 12) return;
    const h = PITCH.stumpHeight, r = PITCH.stumpRadius;
    this.sticks.push(kind === 'bat' ? { obj, ...BAT } : { obj, a: new THREE.Vector3(0, 0, 0), b: new THREE.Vector3(0, h, 0), c: new THREE.Vector3(0, h, 0), r, rArm: 0 });
  },
  // Called by a figure once it is posed for the frame (Humanoid.syncShadow).
  set(slot, x, z, visible, scale = 1) {
    if (!this.mesh || slot < 0) return;
    const o = slot * F, d = this.data, h = this.owners[slot];
    this.dirty = true;
    if (slot + 1 > this.used) this.used = slot + 1;
    if (!visible || !h) {
      d.fill(0, o, o + F);
      if (visible) {                                    // (no bones: a plain blob at x, z)
        for (let k = 0; k < 28; k += 2) { d[o + k] = x; d[o + k + 1] = z; }
        d[o + 28] = 0.3 * scale; d[o + 33] = 1; d[o + 32] = 0.5;
      }
      return;
    }
    const s = h.root.scale.x, B = h.bones;
    const fade = h.ghost ? 1 : h.fade ?? 1;
    P(d, o, B.ankleL, 0); P(d, o, B.ankleR, 2);
    const yl = B.ankleL.matrixWorld.elements[13], yr = B.ankleR.matrixWorld.elements[13];
    P(d, o, B.kneeL, 4); P(d, o, B.kneeR, 6); P(d, o, B.hipL, 8); P(d, o, B.hipR, 10);
    P(d, o, B.hips, 12); P(d, o, B.neck, 14);
    // Head: up to near the crown, on along the neck's line from the head joint.
    {
      const e = B.head.matrixWorld.elements, n = B.neck.matrixWorld.elements;
      let ux = e[12] - n[12], uy = e[13] - n[13], uz = e[14] - n[14];
      const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1, k = 0.15 * s / l;
      ux = e[12] + ux * k; uy = e[13] + uy * k; uz = e[14] + uz * k;
      d[o + 16] = ux + uy * SHADOW_X; d[o + 17] = uz + uy * SHADOW_Z;
    }
    P(d, o, B.handL, 18); P(d, o, B.handR, 20);
    // Contact strengths: full with the foot on the turf, gone 30 cm up.
    const sole = SOLE * s;
    d[o + 22] = 1 - Math.min(1, Math.max(0, (yl - sole) / (0.3 * s)));
    d[o + 23] = 1 - Math.min(1, Math.max(0, (yr - sole) / (0.3 * s)));
    // Contact pools: under the middle of each foot (the ankle's forward axis).
    for (let f = 0; f < 2; f++) {
      const e = (f ? B.ankleR : B.ankleL).matrixWorld.elements, fl = Math.sqrt(e[8] * e[8] + e[10] * e[10]) || 1, k = 24 + f * 2;
      d[o + k] = e[12] + (e[8] / fl) * 0.05 * s; d[o + k + 1] = e[14] + (e[10] / fl) * 0.05 * s;
    }
    d[o + 28] = 0.068 * s; d[o + 29] = 0.15 * s; d[o + 30] = 0.095 * s; d[o + 31] = 0.042 * s;
    // Opacity: faded figures fade theirs; in the stands' shade there is no sun to cast one.
    const e = B.hips.matrixWorld.elements;
    d[o + 32] = fade * (1 - standShade(e[12], e[14], PITCH.centerZ));
    d[o + 33] = fade;
    d[o + 34] = 0.15 * s;
    d[o + 35] = 0;
  },
  // Quality hook (render/quality.js): 2 every limb's shadow, 1 legs and trunk, 0 one soft blob a figure + the contact pools.
  setDetail(level) { if (this.mesh) this.mesh.material.uniforms.uDetail.value = level; },
  // Once a frame, after everything is posed: the sticks, and the upload.
  update() {
    if (!this.mesh) return;
    // The bats come with the figures that carry them: look again when a figure is added.
    if (this.scanned !== this.n) { this.scanned = this.n; this.scene.traverse((o) => { if (o.name === 'bat') this.track(o, 'bat'); }); }
    const base = this.max - 12, d = this.data;
    for (let i = 0; i < this.sticks.length; i++) {
      const st = this.sticks[i], o = (base + i) * F;
      let vis = true;
      for (let p = st.obj; p; p = p.parent) if (!p.visible) { vis = false; break; }
      if (!vis) { if (d[o + 32] !== 0) { d.fill(0, o, o + F); this.dirty = true; } continue; }
      st.obj.updateWorldMatrix(true, false);
      const M = st.obj.matrixWorld;
      _a.copy(st.a).applyMatrix4(M); _b.copy(st.b).applyMatrix4(M); _c.copy(st.c).applyMatrix4(M);
      const ax = _a.x + _a.y * SHADOW_X, az = _a.z + _a.y * SHADOW_Z;
      const bx = _b.x + _b.y * SHADOW_X, bz = _b.z + _b.y * SHADOW_Z;
      _m.lerpVectors(_a, _b, 0.5);
      const mx = _m.x + _m.y * SHADOW_X, mz = _m.z + _m.y * SHADOW_Z;
      const cx = _c.x + _c.y * SHADOW_X, cz = _c.z + _c.y * SHADOW_Z;
      // shins = a..mid, thighs = mid..b, trunk/head collapsed on a, arm = b..c.
      d[o] = d[o + 2] = ax; d[o + 1] = d[o + 3] = az;
      d[o + 4] = d[o + 6] = mx; d[o + 5] = d[o + 7] = mz;
      d[o + 8] = d[o + 10] = bx; d[o + 9] = d[o + 11] = bz;
      d[o + 12] = ax; d[o + 13] = az; d[o + 14] = bx; d[o + 15] = bz;
      d[o + 16] = ax; d[o + 17] = az; d[o + 18] = cx; d[o + 19] = cz;
      d[o + 20] = cx; d[o + 21] = cz;
      // A little contact where the lower end touches the turf (a grounded bat toe, a stump's foot).
      const low = Math.min(1, Math.max(0, 1 - _a.y / 0.12));
      d[o + 22] = low; d[o + 23] = 0;
      d[o + 24] = d[o + 26] = _a.x; d[o + 25] = d[o + 27] = _a.z;
      d[o + 28] = st.r; d[o + 29] = 0; d[o + 30] = 0; d[o + 31] = st.rArm;
      d[o + 32] = 1 - standShade(_a.x, _a.z, PITCH.centerZ); d[o + 33] = 0.8; d[o + 34] = st.r * 2.2; d[o + 35] = 0;
      this.dirty = true;
    }
    const count = this.sticks.length ? base + this.sticks.length : this.used;
    this.mesh.geometry.instanceCount = count;
    if (this.dirty) { this.buf.needsUpdate = true; this.dirty = false; }
  },
};

// The ball's own sun shadow (its own small mesh: replays place it too). The
// ball's disc pushed down the sun's rays: an ellipse stretched along the sun,
// sharp on the ground, leaving the ball as it climbs and softening a little
// with height (the sun's penumbra) but never fading out: it is the depth cue
// for judging a catch or a bouncer.
const _SUN_LEN = hyp(SHADOW_X, SHADOW_Z), _SUN_YAW = Math.atan2(SHADOW_X, SHADOW_Z), _STRETCH = Math.sqrt(1 + _SUN_LEN * _SUN_LEN);
export function ballShadowMesh() {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uShade: { value: SHADE.clone().multiplyScalar(0.82) }, uSoft: { value: 0.3 }, uOpacity: { value: 1 } },
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    vertexShader: /* glsl */`
      varying vec2 vQ;
      void main() { vQ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 uShade; uniform float uSoft; uniform float uOpacity;
      varying vec2 vQ;
      void main() {
        float a = smoothstep(1.0, 1.0 - uSoft, length(vQ)) * uOpacity;
        gl_FragColor = vec4(mix(vec3(1.0), uShade, a), 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.y = _SUN_YAW;
  m.scale.setScalar(0);                               // (nothing until the ball is first placed)
  m.renderOrder = 1;
  m.frustumCulled = false;
  m.name = 'ballShadow';
  return m;
}
export function placeBallShadow(m, pos, radius) {
  const y = Math.max(radius, pos.y);
  const pen = (y - radius) * 0.012;                      // the sun's penumbra (a little wider: it stays readable far off)
  const rx = radius * 1.05 + pen, rz = radius * _STRETCH * 1.05 + pen;
  m.position.set(pos.x + y * SHADOW_X, Y, pos.z + y * SHADOW_Z);
  m.scale.set(rx, 1, rz);
  m.material.uniforms.uSoft.value = Math.min(0.9, 0.3 + pen / rx);
  m.material.uniforms.uOpacity.value = Math.max(0.55, 1 - pen * 2) * (1 - 0.6 * standShade(m.position.x, m.position.z, PITCH.centerZ));
}
