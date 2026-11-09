// One pooled particle system (single draw call): bounce dust, grass flecks,
// boundary fireworks, stumps splinters. Soft round points with per-particle
// colour, alpha and size; works in XR (size scales with projection).
import * as THREE from 'three';

const N = 420;

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    this.alpha = new Float32Array(N);
    this.size = new Float32Array(N);
    this.vel = new Float32Array(N * 3);
    this.life = new Float32Array(N);
    this.age = new Float32Array(N).fill(1e9);
    this.drag = new Float32Array(N);
    this.grav = new Float32Array(N);
    this.size0 = new Float32Array(N);
    this.grow = new Float32Array(N);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uHalfH: { value: 500 } },
      vertexShader: `
        attribute float alpha; attribute float size; attribute vec3 color;
        varying float vA; varying vec3 vC;
        uniform float uHalfH;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = alpha > 0.001 ? size * projectionMatrix[1][1] * uHalfH / max(0.1, -mv.z) : 0.0;
        }`,
      fragmentShader: `
        varying float vA; varying vec3 vC;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          float a = vA * (1.0 - smoothstep(0.25, 0.5, r));
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC, a);
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.next = 0;
    this.live = 0;
  }

  spawn(x, y, z, vx, vy, vz, { color = 0xffffff, life = 1, size = 0.1, grow = 0, drag = 1, grav = 9.81, alpha = 1 } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % N;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    _c.setHex(color);
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
    this.life[i] = life; this.age[i] = 0; this.size0[i] = size; this.grow[i] = grow;
    this.drag[i] = drag; this.grav[i] = grav; this.alpha[i] = alpha;
    this.size[i] = size;
  }

  dust(p, speed, outfield = false) {
    const n = outfield ? 7 : 10;
    const k = Math.min(1, speed / 30);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.4 + Math.random() * 1.2) * (0.5 + k);
      if (outfield) {
        this.spawn(p.x, 0.03, p.z, Math.cos(a) * s, 1 + Math.random() * 2 * k, Math.sin(a) * s,
          { color: Math.random() < 0.5 ? 0x4f8f35 : 0x7cbf5a, life: 0.5, size: 0.025, drag: 2, grav: 9.8 });
      } else {
        this.spawn(p.x, 0.04, p.z, Math.cos(a) * s * 0.6, 0.3 + Math.random() * 0.8 * k, Math.sin(a) * s * 0.6,
          { color: 0xb59a6a, life: 0.7 + Math.random() * 0.4, size: 0.06 + 0.08 * k, grow: 0.25, drag: 3, grav: 0.4, alpha: 0.55 });
      }
    }
  }

  fireworks(p) {
    const cols = [0xff4d6d, 0xffd34d, 0x4dd2ff, 0x7dff8a, 0xff9f43, 0xffffff, 0xb57bff];
    for (let b = 0; b < 3; b++) {
      const cx = p.x + (Math.random() - 0.5) * 10, cy = 14 + Math.random() * 8, cz = p.z + (Math.random() - 0.5) * 10;
      const col = cols[Math.floor(Math.random() * cols.length)];
      for (let i = 0; i < 40; i++) {
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        const s = 6 + Math.random() * 4;
        this.spawn(cx, cy, cz, r * Math.cos(th) * s, u * s, r * Math.sin(th) * s,
          { color: col, life: 1.3 + Math.random() * 0.6, size: 1.1, drag: 1.4, grav: 3, alpha: 1 });
      }
    }
  }

  splinters(p) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn(p.x, 0.5 + Math.random() * 0.25, p.z, Math.cos(a) * 1.5, 1 + Math.random() * 2, Math.sin(a) * 1.5 + 1.5,
        { color: 0xf1e6c8, life: 0.8, size: 0.03, drag: 1, grav: 9.8 });
    }
  }

  update(dt, halfH) {
    this.mat.uniforms.uHalfH.value = halfH;
    if (dt <= 0) return;
    for (let i = 0; i < N; i++) {
      if (this.age[i] >= this.life[i]) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.01, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * k * 4);
      this.alpha[i] = k >= 1 ? 0 : (this.alpha[i] > 0 ? Math.min(this.alpha[i], 1 - k * k) : 0);
    }
    for (const a of ['position', 'alpha', 'size', 'color']) this.geo.attributes[a].needsUpdate = true;
  }
}
const _c = new THREE.Color();
