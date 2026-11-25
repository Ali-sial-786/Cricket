// One pooled particle system (single draw call): pitch dust puffs and grit,
// grass flecks, a dust ring where the bat's toe hits the turf, the flash and
// ring of a sweet bat contact, the broken wicket's chips and dust, and the
// boundary's confetti cannons on the roof.
// Point sprites with per-particle colour, alpha, size and kind:
//   0 soft puff · 1 hard fleck · 2 ring · 3 sparkle (additive) · 4.x confetti (x: its spin phase)
// Premultiplied blending lets the additive sparkles share the draw with the
// alpha-blended dust. Works in XR (size scales with the projection). Nothing
// is uploaded while no particle is alive.
import * as THREE from 'three';
import { SUN_BLOCKERS } from './stadium.js';
import { PITCH } from '../physics/pitch.js';
import { hypot2 } from '../physics/math.js';

const N = 512;
const PUFF = 0, FLECK = 1, RING = 2, SPARK = 3;
// The pitch's dust and soil (sRGB, written straight to the framebuffer).
const PITCH_DUST = [0xefe3c4, 0xe4d3ab, 0xf6eedb], PITCH_GRIT = [0x7d6544, 0x5e4a30, 0x9c8158];
const GRASS = [0x2f6a22, 0xa8c46a, 0xc9d98c, 0x6d5a3a];
// Paper confetti: bright but not neon, with white and a foil gold.
const CONFETTI = [0xf2f2ee, 0xf2f2ee, 0xffd34d, 0xe8b33a, 0xe23b4e, 0x2f7de1, 0x35b768, 0xff8a3d];
const WOOD = [0xf1ead8, 0xe6d9b8, 0xd8c79e];

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    this.alpha = new Float32Array(N);
    this.size = new Float32Array(N);
    this.kind = new Float32Array(N);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N);
    this.age = new Float32Array(N).fill(1e9);
    this.drag = new Float32Array(N);
    this.grav = new Float32Array(N);
    this.size0 = new Float32Array(N);
    this.grow = new Float32Array(N);
    this.keep = 1;                     // share of spawned particles kept (quality.js)
    this.celebrations = true;          // the boundary cannons (off for a training session in the nets)
    this.alpha0 = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('kind', new THREE.BufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uHalfH: { value: 500 }, uTime: { value: 0 } },
      vertexShader: `
        attribute float alpha; attribute float size; attribute vec3 color; attribute float kind;
        varying float vA; varying vec3 vC; varying float vK;
        uniform float uHalfH;
        void main() {
          vA = alpha; vC = color; vK = kind;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // A sprite is a flat square facing you at its centre's depth: a big dust puff on the ground
          // went half under the turf, and the depth test cut it off along a hard, straight line (a pale
          // stepped rectangle where the ball pitched). Its depth is taken twice its size nearer to you
          // (a grazing look at the turf needs that much; at most 1.2 m), so the whole of it clears the
          // ground it sits on; it still goes behind anything really in front.
          vec4 near = projectionMatrix * vec4(mv.xy, min(mv.z + min(size * 2.0, 1.2), -0.05), 1.0);
          gl_Position.z = max(near.z / near.w, -0.999) * gl_Position.w;
          gl_PointSize = alpha > 0.001 ? size * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z) : 0.0;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC; varying float vK;
        uniform float uTime;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float a;
          vec3 c = vC;
          if (vK < 0.5) { float q = max(0.0, 1.0 - r * r); a = q * q; }                       // soft puff
          else if (vK < 1.5) a = 1.0 - smoothstep(0.55, 1.0, r);                              // fleck
          else if (vK < 2.5) { float e = (r - 0.8) / 0.13; a = exp(-e * e); }                 // ring
          else if (vK < 3.5) {                                                                // sparkle: core + cross
            vec2 ad = abs(d);
            a = (1.0 - smoothstep(0.0, 0.32, r)) + 0.8 * (1.0 - smoothstep(0.0, 0.07, min(ad.x, ad.y))) * (1.0 - smoothstep(0.2, 1.0, r));
          } else {                                                                            // confetti: a crisp paper rectangle tumbling
            float ph = fract(vK) * 6.2832, sp = cos(uTime * (5.0 + 7.0 * fract(vK * 7.13)) + ph);
            vec2 q = vec2(cos(ph) * d.x - sin(ph) * d.y, sin(ph) * d.x + cos(ph) * d.y);
            float e = 0.06, hx = 0.05 + 0.31 * abs(sp);
            a = (1.0 - smoothstep(hx - e, hx + e, abs(q.x))) * (1.0 - smoothstep(0.2 - e, 0.2 + e, abs(q.y)));
            c *= 0.62 + 0.45 * abs(sp);                                                       // catching the sun as it turns
          }
          a *= vA;
          if (a < 0.004) discard;
          float add = step(2.5, vK) * step(vK, 3.5);
          gl_FragColor = vec4(c * a, a * (1.0 - add));
        }`,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
    scene.add(this.points);
    this.next = 0;
    this.live = 0;
    this._log = null; this._logN = 0;
    this._dived = new WeakSet();
  }

  spawn(x, y, z, vx, vy, vz, { color = 0xffffff, life = 1, size = 0.1, grow = 0, drag = 1, grav = 9.81, alpha = 1, kind = PUFF } = {}) {
    if (this.keep < 1 && Math.random() > this.keep) return;      // (quality.js: a share of them at low levels)
    const i = this.next;
    this.next = (this.next + 1) % N;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    _c.setHex(color, THREE.LinearSRGBColorSpace);           // (the hex as written: the shader outputs it unconverted)
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
    this.life[i] = life; this.age[i] = 0; this.size0[i] = size; this.grow[i] = grow;
    this.drag[i] = drag; this.grav[i] = grav; this.alpha[i] = this.alpha0[i] = alpha;
    this.size[i] = size; this.kind[i] = kind;
    this.live = N;                                          // (recounted next update)
    this.points.visible = true;
    this.geo.attributes.color.needsUpdate = true; this.geo.attributes.kind.needsUpdate = true;
  }

  // The ball landing: on the pitch a soft puff of dust drifting along the ball's
  // line and grit thrown forward; on the grass a spray of grass flecks.
  // vel (optional): the ball's velocity off the ground.
  dust(p, speed, outfield = false, vel = null) {
    const k = Math.min(1, speed / 30), R = Math.random;
    let fx = 0, fz = 1;
    if (vel) { const h = hypot2(vel.x, vel.z); if (h > 0.5) { fx = vel.x / h; fz = vel.z / h; } }
    if (outfield) {
      for (let i = 0; i < 9; i++) {
        const a = R() * Math.PI * 2, s = (0.4 + R() * 1.2) * (0.5 + k);
        this.spawn(p.x, 0.03, p.z, Math.cos(a) * s + fx * s, 1 + R() * 2 * k, Math.sin(a) * s + fz * s,
          { color: pick(GRASS), life: 0.55 + R() * 0.2, size: 0.02 + R() * 0.016, drag: 2, grav: 9.8, kind: FLECK });
      }
      return;
    }
    for (let i = 0; i < 6; i++) {
      const a = R() * Math.PI * 2, s = (0.15 + R() * 0.5) * (0.5 + k);
      this.spawn(p.x + Math.cos(a) * 0.02, 0.03 + R() * 0.03, p.z + Math.sin(a) * 0.02,
        Math.cos(a) * s + fx * (0.4 + R() * 0.9) * k, 0.15 + R() * 0.45 * k, Math.sin(a) * s + fz * (0.4 + R() * 0.9) * k,
        // (thin: six puffs at half opacity on one spot added up to a pale disc of light on the strip)
        { color: pick(PITCH_DUST), life: 0.7 + R() * 0.5, size: 0.06 + 0.05 * k, grow: 0.3, drag: 2.6, grav: -0.12, alpha: 0.13 + 0.09 * k, kind: PUFF });
    }
    for (let i = 0; i < 10; i++) {
      const a = (R() - 0.5) * 1.6, s = (1 + R() * 2.4) * (0.4 + k);
      const sx = Math.sin(a), cz = Math.cos(a);
      this.spawn(p.x, 0.02, p.z, (fx * cz - fz * sx) * s, 0.6 + R() * 1.8 * k, (fz * cz + fx * sx) * s,
        { color: pick(PITCH_GRIT), life: 0.35 + R() * 0.3, size: 0.009 + R() * 0.008, drag: 1.5, grav: 9.8, kind: FLECK });
    }
  }

  // The toe of the bat banged into the turf: a low ring of dust running out.
  toeRing(p, speed = 2) {
    const R = Math.random, k = Math.min(1, speed / 3);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + R() * 0.4, s = 0.35 + R() * 0.35 + k * 0.4;
      this.spawn(p.x + Math.cos(a) * 0.03, 0.02, p.z + Math.sin(a) * 0.03, Math.cos(a) * s, 0.05 + R() * 0.15, Math.sin(a) * s,
        { color: pick(PITCH_DUST), life: 0.6 + R() * 0.4, size: 0.05 + R() * 0.03, grow: 0.3, drag: 3.5, grav: 0, alpha: 0.4 + 0.2 * k, kind: PUFF });
    }
    for (let i = 0; i < 5; i++) {
      const a = R() * Math.PI * 2;
      this.spawn(p.x, 0.02, p.z, Math.cos(a) * 0.8, 0.6 + R() * 0.8, Math.sin(a) * 0.8, { color: pick(PITCH_GRIT), life: 0.3, size: 0.006, drag: 1, grav: 9.8, kind: FLECK });
    }
  }

  // A diving fielder (or batter) hitting the grass: flecks and a little dust along his line.
  flecks(p, dirX = 0, dirZ = 0) {
    const R = Math.random;
    for (let i = 0; i < 16; i++) {
      const a = R() * Math.PI * 2, s = 0.5 + R() * 1.4;
      this.spawn(p.x + (R() - 0.5) * 0.4, 0.05, p.z + (R() - 0.5) * 0.4, Math.cos(a) * s * 0.6 + dirX * s, 0.8 + R() * 1.6, Math.sin(a) * s * 0.6 + dirZ * s,
        { color: pick(GRASS), life: 0.6 + R() * 0.3, size: 0.02 + R() * 0.016, drag: 2.2, grav: 9.8, kind: FLECK });
    }
    for (let i = 0; i < 4; i++) {
      this.spawn(p.x + (R() - 0.5) * 0.5, 0.06, p.z + (R() - 0.5) * 0.5, dirX * 0.6, 0.2, dirZ * 0.6,
        { color: 0xd9dcc0, life: 0.8, size: 0.14, grow: 0.3, drag: 2.5, grav: 0, alpha: 0.3, kind: PUFF });
    }
  }

  // Bat on ball: a quick flash at the point of contact and, from the middle of
  // the bat, a faint ring opening out (the sweeter the hit, the brighter).
  contact(p, quality = 0.5, edge = false) {
    if (!p) return;
    const q = Math.max(0, Math.min(1, quality)), R = Math.random;
    if (edge) {
      for (let i = 0; i < 4; i++) { const a = R() * Math.PI * 2; this.spawn(p.x, p.y, p.z, Math.cos(a) * 0.8, R() * 0.8, Math.sin(a) * 0.8, { color: 0xf0e2c0, life: 0.25, size: 0.008, drag: 2, grav: 4, kind: FLECK }); }
      return;
    }
    this.spawn(p.x, p.y, p.z, 0, 0, 0, { color: 0xfff1d0, life: 0.09 + 0.05 * q, size: 0.04 + 0.08 * q, grow: 0.2, drag: 0, grav: 0, alpha: 0.25 + 0.4 * q, kind: SPARK });
    if (q > 0.5) this.spawn(p.x, p.y, p.z, 0, 0, 0, { color: 0xffffff, life: 0.22, size: 0.08, grow: 1.2, drag: 0, grav: 0, alpha: 0.4 * (q - 0.3), kind: RING });
  }

  // A boundary (p: where the ball crossed the rope; six: over it on the full): confetti cannons on the
  // roof lip either side of where it went, a pop of smoke at each mouth and paper fluttering down in
  // the sun for a few seconds. A six: five cannons; a four: two, smaller. (Daylight: no light show.)
  celebrate(p, six = true) {
    if (!this.celebrations) return;
    const R = Math.random, B = SUN_BLOCKERS, cz = PITCH.centerZ;
    const a0 = Math.atan2(p.x, p.z - cz) * DEG;
    const slots = six ? [-17, -8.5, 0, 8.5, 17] : [-5, 5], per = six ? 40 : 20;
    for (const off of slots) {
      // on a roofed arc (the nearest roof where the bank, the pavilion or a sightscreen wedge is)
      let a = a0 + off;
      for (let k = 1; k < 40 && !B.roofed(a); k++) a = a0 + off + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2;
      if (!B.roofed(a)) continue;
      const s = Math.sin(a / DEG), c = Math.cos(a / DEG), rr = B.roof.rF + 0.4;
      const x = s * rr, y = B.roof.yF + 1.6, z = cz + c * rr;
      for (let i = 0; i < 3; i++) this.spawn(x, y, z, -s * (1 + i), 3 + R() * 2, -c * (1 + i),
        { color: 0xeeece6, life: 1.2 + R() * 0.5, size: 1.8, grow: 0.6, drag: 2.4, grav: -0.3, alpha: 0.5, kind: PUFF });
      for (let i = 0; i < per; i++) {
        const up = (six ? 10 : 7.5) + R() * 7, inn = 2 + R() * (six ? 8 : 5), side = (R() - 0.5) * 9;
        this.spawn(x + (R() - 0.5) * 0.6, y, z + (R() - 0.5) * 0.6, -s * inn + c * side, up, -c * inn - s * side,
          { color: pick(CONFETTI), life: 3.6 + R() * 1.8, size: 0.5 + R() * 0.3, drag: 1.25, grav: 2.0, alpha: 1, kind: 4 + R() * 0.999 });
      }
    }
  }
  fireworks(p) { this.celebrate(p, true); }

  // The wicket broken: chips of wood off the stumps and bails, and a puff of dust off the crease
  // (the bails themselves fly and the LEDs flash: objects.js).
  splinters(p) {
    const R = Math.random, dz = p.z < -10 ? -1 : 1;
    for (let i = 0; i < 12; i++) {
      const a = R() * Math.PI * 2;
      this.spawn(p.x + (R() - 0.5) * 0.2, 0.5 + R() * 0.25, p.z, Math.cos(a) * 1.5, 1 + R() * 2, Math.sin(a) * 1.5 + 1.5 * dz,
        { color: pick(WOOD), life: 0.8, size: 0.012 + R() * 0.01, drag: 1, grav: 9.8, kind: FLECK });
    }
    for (let i = 0; i < 7; i++) {
      this.spawn(p.x + (R() - 0.5) * 0.24, 0.71 + R() * 0.04, p.z, (R() - 0.5) * 1.4, 0.6 + R() * 1.4, (R() - 0.2) * 1.4 * dz,
        { color: pick(WOOD), life: 0.5 + R() * 0.3, size: 0.008 + R() * 0.008, drag: 1.2, grav: 9.8, kind: FLECK });
    }
    for (let i = 0; i < 7; i++) {
      const a = R() * Math.PI * 2;
      this.spawn(p.x + (R() - 0.5) * 0.25, 0.03 + R() * 0.05, p.z, Math.cos(a) * 0.45, 0.12 + R() * 0.2, Math.sin(a) * 0.45 + 0.35 * dz,
        { color: pick(PITCH_DUST), life: 1.0 + R() * 0.4, size: 0.1 + R() * 0.05, grow: 0.4, drag: 2.5, grav: -0.05, alpha: 0.32, kind: PUFF });
    }
  }

  // The contact log's bat-toe ground strikes (edgeTrack.js) since the last call.
  pollContacts(log) {
    const ev = log && log.events;
    if (!ev) return;
    if (ev !== this._log) { this._log = ev; this._logN = 0; }
    for (; this._logN < ev.length; this._logN++) { const e = ev[this._logN]; if (e.type === 'ground' && e.pos) this.toeRing(e.pos, e.speed); }
  }

  // Fielders' dives (fielding.js states): flecks as each one lands, once a dive.
  pollDives(states, t) {
    if (!states) return;
    for (let i = 0; i < states.length; i++) {       // (every frame: no iterator)
      const s = states[i];
      const a = s.action;
      if (!a || a.type !== 'catch' || !a.dive || s.hidden || this._dived.has(a)) continue;
      const ta = t - a.t0;
      if (ta < 0.32 || ta > 1) continue;
      this._dived.add(a);
      const d = a.dir || { x: 0, z: 0 }, l = (a.lunge || 0.5) * 0.8;
      const x = s.x + d.x * l, z = s.z + d.z * l;
      if (Math.abs(x) < 1.5 && z < 1.5 && z > -21.6) this.toeRing({ x, z }, 3);     // on the pitch: dust
      else this.flecks({ x, z }, d.x, d.z);
    }
  }

  update(dt, halfH) {
    this.mat.uniforms.uHalfH.value = halfH;
    if (dt <= 0 || this.live === 0) return;
    this.mat.uniforms.uTime.value = (this.mat.uniforms.uTime.value + dt) % 1000;
    let live = 0;
    for (let i = 0; i < N; i++) {
      if (this.age[i] >= this.life[i]) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      live++;
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.01, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * k * 4);
      // puffs fade in and out softly; the rest hold, then go
      const kd = this.kind[i];
      this.alpha[i] = k >= 1 ? 0 : this.alpha0[i] * (kd === PUFF ? Math.min(1, k * 8) * (1 - k) * (1 - k) * 1.3 : kd === RING ? 1 - k : 1 - k * k);
    }
    this.live = live;
    if (!live) this.points.visible = false;
    const A = this.geo.attributes;
    A.position.needsUpdate = A.alpha.needsUpdate = A.size.needsUpdate = true;
  }
}
const _c = new THREE.Color();
const DEG = 180 / Math.PI;
const pick = (a) => a[(Math.random() * a.length) | 0];
