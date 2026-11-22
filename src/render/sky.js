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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
        // Clouds on a flat layer, drawn finer overhead (x3.4 at the zenith, still monotonic out to the
        // horizon): a plain flat layer is closest straight up, where its soft puffs were magnified into
        // smeared swirls.
        vec2 cp = d.xz / (h + 0.09) * (1.0 + 2.4 * h * h);
        float up = smoothstep(0.35, 0.85, h);
        vec4 c1 = texture2D(uClouds, cp * 0.15 + vec2(0.31, 0.17));
        vec4 c2 = texture2D(uClouds, cp * 0.07 + vec2(0.6, 0.2) + vec2(0.0011, 0.0005) * uTime);
        float fade = smoothstep(0.015, 0.16, h);
        // Fair-weather cumulus bank toward the horizon; a clearer, deeper sky overhead, with crisper,
        // broken (not blurrier) edges where the texture is magnified most.
        // (the cirrus streaks in the same texel fray the cumulus edges a little overhead: wisps, not a blur)
        float e = c1.r - c1.b * 0.5 * up;
        float cr = mix(c1.r, smoothstep(0.1, 0.75, e), 0.15 + 0.3 * up);
        float dens = cr * fade * (1.0 - 0.86 * up);
        float rim = sd * sd * sd * sd; rim *= rim;
        // Thin edges are lit through; only the thick cores show the shaded side,
        // and not round the sun, where the glare through the haze fills them in.
        float near = sd * sd * sd; near *= near;
        float lk = mix(mix(0.92, c1.g, smoothstep(0.1, 0.7, c1.r)), 1.0, max(near * 0.85, up * 0.3));   // (low contrast overhead)
        vec3 cc = mix(uCloudShade, uCloudLit, lk) + uSunHaze * rim * (1.0 - c1.r) * 0.9;
        cc = mix(cc, uHorizon, (1.0 - fade) * 0.5);
        sky = mix(sky, mix(uHorizon, uCloudLit, 0.6) * (0.92 + 0.12 * rim), c2.b * fade * 0.4 * (1.0 - 0.6 * up));
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

  const skyline = new THREE.Mesh(skylineGeometry(),
    new THREE.MeshBasicMaterial({ map: skylineTexture(), transparent: true, side: THREE.BackSide, depthWrite: false, fog: true }));
  skyline.position.set(0, 26, centreZ);
  skyline.renderOrder = -9;
  parent.add(skyline);

  return { sky, skyline, update(t) { uniforms.uTime.value = t % 10000; } };
}

// The skyline's cylinder in two halves sharing one 2048 x 512 texture (the 4096 x 256 panorama
// folded: the brief's 2048 limit, the same texels a metre). The second half's band is flipped so the
// two meet ground to ground in the middle (a mip level's bleed there is treeline into treeline) and
// the texture's outer edges are clear sky.
function skylineGeometry() {
  const halves = [0, 1].map((k) => {
    const g = new THREE.CylinderGeometry(330, 330, 70, 32, 1, true, k * Math.PI, Math.PI);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const v = uv.getY(i); uv.setY(i, k ? 0.5 - 0.5 * v : 0.5 + 0.5 * v); }
    return g;
  });
  return mergeGeometries(halves, false);
}

// Distant skyline (an open cylinder 330 m out, y -9..61 m; canvas x = the
// angle round the ground from +z toward +x, as in stadium.js). Seen over the
// roofs from up high and through the grass bank's gap (20-50 deg): layers of
// hazy hills, a town in two clusters (behind the North End and the west side)
// with varied silhouettes, sunlit faces and faint window rows, and a dense
// treeline in front; the further, the paler (mixed toward the horizon haze).
function skylineTexture() {
  const W = 4096, H = 256, r = mulberry(77);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const groundY = H - Math.round((9 / 70) * H);            // y = 0 on the canvas
  const haze = [HAZE_COLOR.r, HAZE_COLOR.g, HAZE_COLOR.b].map((v) => Math.round(255 * Math.pow(v, 1 / 2.2)));
  const hz = (c3, k) => `rgb(${c3.map((v, i) => Math.round(v + (haze[i] - v) * k)).join(',')})`;
  const X = (deg) => (deg / 360) * W;
  const wrap = (fn) => { fn(0); fn(-W); fn(W); };
  // Hills: two ridgelines, the far one palest.
  for (const [base, amp, k, col, f] of [[62, 30, 0.72, [96, 122, 132], 1], [44, 18, 0.55, [78, 108, 92], 2.3]]) {
    g.fillStyle = hz(col, k);
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, groundY - base - amp * (0.5 + 0.3 * Math.sin(x * 0.0021 * f + base) + 0.2 * Math.sin(x * 0.0063 * f + 1.7)));
    g.lineTo(W, H); g.fill();
  }
  // Town: blocks and towers in clusters.
  const building = (x, w, h, k, tone) => {
    const top = groundY - h, base = [tone - 8, tone, tone + 12];
    g.fillStyle = hz(base, k); g.fillRect(x, top, w, h);
    g.fillStyle = hz(base.map((v) => v + 34), k); g.fillRect(x, top, w * 0.42, h);            // the sunlit face
    g.fillStyle = `rgba(30,40,50,${0.10 * (1 - k)})`;
    for (let y = top + 4; y < groundY - 3; y += 4) g.fillRect(x + 1, y, w - 2, 1);           // window rows
    const roof = r();
    if (roof < 0.25) { g.fillStyle = hz(base, k); g.fillRect(x + w * 0.2, top - h * 0.12, w * 0.6, h * 0.12 + 1); g.fillRect(x + w * 0.35, top - h * 0.2, w * 0.3, h * 0.08 + 1); }   // setbacks
    else if (roof < 0.4) { g.fillStyle = hz(base, k); g.beginPath(); g.moveTo(x, top); g.lineTo(x + w, top); g.lineTo(x + w, top - w * 0.5); g.fill(); }   // a slanted crown
    else if (roof < 0.55) { g.fillStyle = hz(base, k); g.fillRect(x + w / 2 - 1, top - 22, 2, 22); }                  // mast
  };
  for (const [a0, a1] of [[150, 215], [262, 305]]) wrap((o) => {
    for (const [n, k, tone, hmax] of [[70, 0.62, 150, 70], [40, 0.5, 132, 120], [10, 0.45, 120, 165]]) {
      for (let i = 0; i < n; i++) {
        const t = r(), x = o + X(a0 + (a1 - a0) * t), mid = 1 - Math.abs(t - 0.5) * 1.6;      // taller in the middle of a cluster
        building(x, 6 + r() * 16, 14 + r() * hmax * (0.35 + 0.65 * mid), k, tone + r() * 14);
      }
    }
  });
  // Elsewhere, a few low roofs and a church spire among the trees (seen through the bank).
  wrap((o) => {
    for (let i = 0; i < 60; i++) { const x = o + r() * W; if ((x / W) * 360 % 360 > 150 && (x / W) * 360 % 360 < 305) continue; building(x, 8 + r() * 14, 8 + r() * 14, 0.5, 150); }
    const sx = o + X(36);
    g.fillStyle = hz([150, 146, 140], 0.45); g.fillRect(sx, groundY - 34, 7, 34);
    g.beginPath(); g.moveTo(sx - 1, groundY - 34); g.lineTo(sx + 8, groundY - 34); g.lineTo(sx + 3.5, groundY - 62); g.fill();
  });
  // Treeline: overlapping crowns, darker low down, a few tall poplars.
  for (let i = 0; i < 4200; i++) {
    const x = r() * W, tall = r() < 0.06, tr = tall ? 4 + r() * 3 : 5 + r() * 9, y = groundY - (tall ? 18 + r() * 14 : 5 + r() * 14), v = r();
    g.fillStyle = hz([46 + v * 30, 70 + v * 34, 48 + v * 20], 0.32);
    g.beginPath();
    if (tall) g.ellipse(x, y, tr * 0.6, tr * 2.6, 0, 0, Math.PI * 2); else g.arc(x, y, tr, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = hz([44, 66, 48], 0.32); g.fillRect(0, groundY - 8, W, H - groundY + 8);
  // folded into 2048 x 512 (skylineGeometry): 0-180 deg on top, 180-360 deg below it upside down
  const f = document.createElement('canvas'); f.width = W / 2; f.height = H * 2;
  const fg = f.getContext('2d');
  fg.drawImage(c, 0, 0, W / 2, H, 0, 0, W / 2, H);
  fg.save(); fg.translate(0, H * 2); fg.scale(1, -1); fg.drawImage(c, W / 2, 0, W / 2, H, 0, 0, W / 2, H); fg.restore();
  const t = new THREE.CanvasTexture(f);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 2;
  return t;
}
