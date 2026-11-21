// Sky, built for Quest 3S: one dome whose shader paints the late-afternoon
// gradient (deep zenith, hazy warm horizon, a brighter aureole round the sun),
// the sun disc and its glow where the key light comes from (lighting.js), and
// two cloud layers from one baked 1024^2 texture: fair-weather cumulus
// (density + baked sun-side shading) and high cirrus drifting slowly. Two
// fetches, no loops. The clouds lie on a flat layer (direction / height), so
// they shrink and flatten toward the horizon like real ones. Plus a hazy
// distant skyline on an open cylinder behind the stands.
import * as THREE from 'three';
import { SUN_DIR, HAZE_COLOR } from './lighting.js';

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// R = cumulus density, G = how sunlit (0.5 neutral), B = cirrus. Tileable.
function cloudTexture() {
  const N = 1024, r = mulberry(4242);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#000'; g.fillRect(0, 0, N, N); return g; };
  const wrapDraw = (g, x, y, rad, fn) => {
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      const px = x + ox, py = y + oy;
      if (px + rad < 0 || px - rad > N || py + rad < 0 || py - rad > N) continue;
      fn(px, py);
    }
  };
  // Cumulus: clusters of puffs, dense cores, ragged edges, a few small fragments.
  const cu = mk();
  cu.globalCompositeOperation = 'lighter';
  const puff = (x, y, rad, a) => wrapDraw(cu, x, y, rad, (px, py) => {
    const gr = cu.createRadialGradient(px, py, 0, px, py, rad);
    gr.addColorStop(0, `rgba(255,0,0,${a})`); gr.addColorStop(0.5, `rgba(255,0,0,${a * 0.7})`); gr.addColorStop(1, 'rgba(255,0,0,0)');
    cu.fillStyle = gr; cu.beginPath(); cu.arc(px, py, rad, 0, Math.PI * 2); cu.fill();
  });
  for (let c = 0; c < 15; c++) {
    const cx = r() * N, cy = r() * N, size = 40 + r() * 80, n = 16 + Math.floor(r() * 22), stretch = 1 + r() * 0.9, rot = r() * Math.PI;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * size * 1.3;
      const lx = Math.cos(a) * d * stretch, ly = Math.sin(a) * d;
      const x = cx + lx * Math.cos(rot) - ly * Math.sin(rot), y = cy + lx * Math.sin(rot) + ly * Math.cos(rot);
      puff(x, y, size * (0.35 + r() * 0.55) * (1 - d / (size * 2.2)), 0.22 + r() * 0.2);
    }
    // Smaller turrets and wisps on the cluster: lumpier tops, ragged edges.
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * size * 1.5;
      const lx = Math.cos(a) * d * stretch, ly = Math.sin(a) * d;
      puff(cx + lx * Math.cos(rot) - ly * Math.sin(rot), cy + lx * Math.sin(rot) + ly * Math.cos(rot), size * (0.1 + r() * 0.2), 0.12 + r() * 0.12);
    }
  }
  for (let i = 0; i < 40; i++) puff(r() * N, r() * N, 8 + r() * 18, 0.2 + r() * 0.15);
  // Cirrus: wispy brushed streaks, in blue on the same canvas ('lighter' adds per channel).
  const ci = cu;
  for (let s = 0; s < 18; s++) {
    const cx = r() * N, cy = r() * N, rot = r() * Math.PI;
    for (let i = 0; i < 30; i++) {
      const x = cx + (r() - 0.5) * 180, y = cy + (r() - 0.5) * 90, len = 20 + r() * 60, wid = 1.5 + r() * 4;
      wrapDraw(ci, x, y, len, (px, py) => {
        ci.save(); ci.translate(px, py); ci.rotate(rot + (r() - 0.5) * 0.7); ci.scale(1, wid / len);
        const gr = ci.createRadialGradient(0, 0, 0, 0, 0, len);
        gr.addColorStop(0, `rgba(0,0,255,${0.07 + r() * 0.08})`); gr.addColorStop(1, 'rgba(0,0,255,0)');
        ci.fillStyle = gr; ci.beginPath(); ci.arc(0, 0, len, 0, Math.PI * 2); ci.fill(); ci.restore();
      });
    }
  }
  const a = cu.getImageData(0, 0, N, N).data;
  // Density with defined, slightly soft edges; shading = how much less cloud
  // there is toward the sun (the sunward rim is bright, the far side and the
  // thick cores grey). Texel u, v follow world x, z.
  const sx = SUN_DIR.x / Math.hypot(SUN_DIR.x, SUN_DIR.z), sz = SUN_DIR.z / Math.hypot(SUN_DIR.x, SUN_DIR.z), off = 12;
  const ox = Math.round(sx * off), oy = Math.round(sz * off);
  const M = N - 1;
  const out = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const o = (j * N + i) * 4, v = a[o] / 255, vs = a[((((j + oy) & M) * N) + ((i + ox) & M)) * 4] / 255;
    const t = Math.min(1, Math.max(0, (v - 0.18) / 0.42)), dens = t * t * (3 - 2 * t);
    const lit = Math.min(1, Math.max(0, 0.74 + (v - vs) * 1.8 - Math.max(0, v - 0.55) * 0.6));
    out[o] = dens * 255; out[o + 1] = lit * 255; out[o + 2] = Math.min(255, a[o + 2] * 1.6); out[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(out, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const lin = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };

export function buildSky(parent, centreZ) {
  const uniforms = {
    uClouds: { value: cloudTexture() },        // (~80 ms in software GL)
    uTime: { value: 0 },
    uSunDir: { value: SUN_DIR.clone() },
    uZenith: { value: lin(0x2d62b4) },
    uMid: { value: lin(0x6f9fdb) },
    uHorizon: { value: new THREE.Vector3(HAZE_COLOR.r, HAZE_COLOR.g, HAZE_COLOR.b) },
    uSunHaze: { value: lin(0xf3dcb8) },
    uSun: { value: lin(0xfff6e2) },
    uCloudLit: { value: lin(0xffffff) },
    uCloudShade: { value: lin(0xa6b2c4) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uClouds; uniform float uTime; uniform vec3 uSunDir;
      uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uSunHaze; uniform vec3 uSun;
      uniform vec3 uCloudLit; uniform vec3 uCloudShade;
      varying vec3 vWorld;
      #include <common>
      void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float h = max(d.y, 0.0);
        float sd = max(dot(d, uSunDir), 0.0);
        // Gradient: haze at the horizon, through a clear mid blue, to a deep zenith.
        vec3 sky = mix(uHorizon, uMid, smoothstep(0.0, 0.28, pow(h, 0.8)));
        sky = mix(sky, uZenith, smoothstep(0.25, 1.0, h));
        // Warm aureole round the sun, strongest low down.
        float aur = sd * sd; aur *= aur;
        sky = mix(sky, uSunHaze, aur * aur * (0.75 - 0.45 * h));
        // Clouds on a flat layer.
        vec2 cp = d.xz / (h + 0.09);
        vec4 c1 = texture2D(uClouds, cp * 0.15 + vec2(0.31, 0.17));
        vec4 c2 = texture2D(uClouds, cp * 0.07 + vec2(0.6, 0.2) + vec2(0.0011, 0.0005) * uTime);
        float fade = smoothstep(0.015, 0.16, h);
        // Fair-weather cumulus bank toward the horizon; a clearer, deeper sky overhead.
        float dens = c1.r * fade * (1.0 - 0.85 * smoothstep(0.3, 0.75, h));
        float rim = sd * sd * sd * sd; rim *= rim;
        // Thin edges are lit through; only the thick cores show the shaded side.
        vec3 cc = mix(uCloudShade, uCloudLit, mix(0.92, c1.g, smoothstep(0.1, 0.7, c1.r))) + uSunHaze * rim * (1.0 - c1.r) * 0.9;
        cc = mix(cc, uHorizon, (1.0 - fade) * 0.5);
        sky = mix(sky, mix(uHorizon, uCloudLit, 0.6) * (0.92 + 0.12 * rim), c2.b * fade * 0.4);
        sky = mix(sky, cc, dens);
        // The sun: a hot disc, a tight glow and a wide one, dimmed through cloud.
        float disc = smoothstep(0.99990, 0.99994, sd);
        float glow = pow(sd, 1200.0) * 0.9 + pow(sd, 90.0) * 0.28;
        sky += uSun * glow * (1.0 - dens * 0.8);
        sky = mix(sky, uSun * 1.6, disc * (1.0 - dens * 0.92));
        gl_FragColor = vec4(min(sky, vec3(1.0)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), mat);
  sky.renderOrder = -10;
  sky.position.set(0, -40, centreZ);
  sky.frustumCulled = false;
  parent.add(sky);

  const skyline = new THREE.Mesh(new THREE.CylinderGeometry(330, 330, 70, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: skylineTexture(), transparent: true, side: THREE.BackSide, depthWrite: false, fog: true }));
  skyline.position.set(0, 26, centreZ);
  skyline.renderOrder = -9;
  parent.add(skyline);

  return { sky, skyline, update(t) { uniforms.uTime.value = t % 10000; } };
}

// Distant skyline, seen over the stands from up high: hazy rolling hills, a
// blue-grey city with varied towers (a few setbacks, spires, masts), and a
// darker treeline in front. Built in layers, nearer = darker and sharper.
function skylineTexture() {
  const W = 2048, H = 256, r = mulberry(77);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  // Far hills.
  g.fillStyle = 'rgb(168,184,200)';
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= W; x += 16) g.lineTo(x, H - 70 - 26 * Math.sin(x * 0.004 + 1) - 14 * Math.sin(x * 0.011));
  g.lineTo(W, H); g.fill();
  // City: two depths of towers.
  for (const [n, base, tint, max] of [[70, 168, 0, 100], [46, 150, -10, 120]]) {
    for (let i = 0; i < n; i++) {
      const x = r() * W, w = 12 + r() * 34, h = 30 + r() * max * (r() < 0.12 ? 1.5 : 1);
      if ((x % 700) > 470) continue;                        // gaps: not a solid wall of city
      const s = base + tint + r() * 16;
      g.fillStyle = `rgb(${s - 6},${s + 4},${s + 18})`;
      g.fillRect(x, H - h, w, h);
      if (r() < 0.35) g.fillRect(x + w * 0.2, H - h - h * 0.15, w * 0.6, h * 0.15 + 1);   // setback
      if (r() < 0.12) { g.fillRect(x + w / 2 - 1, H - h - 26, 2, 26); }                 // mast
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x, H - h, w * 0.35, h);         // sunlit side
    }
  }
  // Treeline: rounded crowns, lighter tops.
  for (let i = 0; i < 1500; i++) {
    const x = r() * W, tr = 6 + r() * 14, y = H - 18 - r() * 22;
    const v = r();
    g.fillStyle = `rgb(${70 + v * 26},${92 + v * 26},${84 + v * 16})`;
    g.beginPath(); g.arc(x, y, tr, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgb(66,86,78)'; g.fillRect(0, H - 22, W, 22);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 1;
  return t;
}
