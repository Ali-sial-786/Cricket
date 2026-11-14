// Stadium environment, built for Quest 3S: everything static is merged into a
// handful of meshes with vertex colours / small canvas textures, one instanced
// crowd with a cheering vertex shader, no realtime shadows.
//
//   sky dome with painted clouds + sun · distant skyline · tone-mapped lighting
//   two-tier stepped stands (sector seat colours, concourse, roof canopies,
//   pillars) · pavilion · big screen · scrolling LED boards · floodlights
//   with halos · striped turf with a worn rim · detailed pitch · sightscreens
import * as THREE from 'three';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { part, merge, vertexColorMat, radialTexture } from './util.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const CZ = PITCH.centerZ;
const rand = mulberry(7);
function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function canvasTex(w, h, draw, { repeat = null, srgb = true, aniso = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

function speckle(g, w, h, n, a, light, size = 2) {
  for (let i = 0; i < n; i++) {
    const v = light ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${rand() * a})`;
    g.fillRect(rand() * w, rand() * h, 1 + rand() * size, 1 + rand() * size);
  }
}

export function buildEnvironment(scene) {
  const root = new THREE.Group(); root.name = 'environment';
  const stadium = new THREE.Group(); stadium.name = 'stadium';
  const pitchGroup = new THREE.Group(); pitchGroup.name = 'pitch';
  root.add(stadium, pitchGroup);

  // ---------------------------------------------------------- light + air
  const hemi = new THREE.HemisphereLight(0xd6e8ff, 0x8c9478, 1.35);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.position.set(-40, 70, 30);
  const fill = new THREE.DirectionalLight(0xc8dcff, 0.45);
  fill.position.set(40, 30, -60);
  root.add(hemi, sun, fill);
  scene.fog = new THREE.Fog(0xc9dcee, 170, 560);

  // ---------------------------------------------------------- sky
  const skyTex = canvasTex(2048, 1024, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#2c64b8');
    grd.addColorStop(0.32, '#5d93d6');
    grd.addColorStop(0.47, '#b9d6f0');
    grd.addColorStop(0.5, '#d9e7f2');
    grd.addColorStop(1, '#9fb3a0');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    // Sun glow.
    const sx = w * 0.62, sy = h * 0.2;
    const sg = g.createRadialGradient(sx, sy, 0, sx, sy, 260);
    sg.addColorStop(0, 'rgba(255,250,232,1)');
    sg.addColorStop(0.08, 'rgba(255,246,220,0.9)');
    sg.addColorStop(0.35, 'rgba(255,240,210,0.25)');
    sg.addColorStop(1, 'rgba(255,240,210,0)');
    g.fillStyle = sg; g.fillRect(0, 0, w, h);
    // Cumulus clouds: clusters of soft puffs, flatter near the horizon.
    for (let c = 0; c < 42; c++) {
      const cx = rand() * w, cy = h * (0.12 + rand() * 0.34);
      const flat = 0.35 + (cy / h) * 0.9;
      const n = 6 + Math.floor(rand() * 10);
      const size = (40 + rand() * 90) * (1.15 - cy / h);
      for (let i = 0; i < n; i++) {
        const px = cx + (rand() - 0.5) * size * 2.6, py = cy + (rand() - 0.5) * size * 0.6 * flat;
        const r = size * (0.45 + rand() * 0.6);
        const cg = g.createRadialGradient(px, py - r * 0.2, 0, px, py, r);
        cg.addColorStop(0, 'rgba(255,255,255,0.85)');
        cg.addColorStop(0.55, 'rgba(244,248,252,0.55)');
        cg.addColorStop(1, 'rgba(225,235,245,0)');
        g.fillStyle = cg;
        g.beginPath(); g.ellipse(px, py, r * 1.3, r * flat, 0, 0, Math.PI * 2); g.fill();
      }
    }
  }, { aniso: 1 });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 40, 20),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false }));
  sky.renderOrder = -10;
  sky.position.set(0, -40, CZ);
  stadium.add(sky);

  // Distant skyline (city + trees) on an open cylinder.
  const skyline = new THREE.Mesh(new THREE.CylinderGeometry(330, 330, 70, 64, 1, true),
    new THREE.MeshBasicMaterial({
      map: canvasTex(4096, 256, (g, w, h) => {
        g.clearRect(0, 0, w, h);
        let x = 0;
        while (x < w) {
          const bw = 20 + rand() * 70, bh = 30 + rand() * 150 * (rand() < 0.15 ? 1.6 : 1);
          const shade = 120 + rand() * 40;
          g.fillStyle = `rgb(${shade - 20},${shade - 5},${shade + 20})`;
          g.fillRect(x, h - bh, bw, bh);
          g.fillStyle = 'rgba(255,255,255,0.12)';
          for (let wy = h - bh + 6; wy < h - 6; wy += 10) for (let wx = x + 4; wx < x + bw - 4; wx += 8) if (rand() < 0.3) g.fillRect(wx, wy, 3, 4);
          x += bw + rand() * 25;
        }
        for (let i = 0; i < 900; i++) {          // tree line
          const tx = rand() * w, tr = 8 + rand() * 16;
          g.fillStyle = `rgb(${70 + rand() * 30},${100 + rand() * 30},${80 + rand() * 20})`;
          g.beginPath(); g.arc(tx, h - tr * 0.6, tr, 0, Math.PI * 2); g.fill();
        }
      }, { aniso: 1 }),
      transparent: true, side: THREE.BackSide, depthWrite: false, fog: true,
    }));
  skyline.material.map.wrapS = THREE.RepeatWrapping;
  skyline.position.set(0, 26, CZ);
  skyline.renderOrder = -9;
  stadium.add(skyline);

  // ---------------------------------------------------------- outfield
  const grassTex = canvasTex(1024, 1024, (g, w, h) => {
    const bands = 8;
    for (let i = 0; i < bands; i++) {
      g.fillStyle = i % 2 ? '#4a8a35' : '#58a03f';
      g.fillRect((i * w) / bands, 0, w / bands, h);
    }
    // Cross-mown chequer (subtle).
    for (let j = 0; j < bands; j++) {
      g.fillStyle = j % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.035)';
      g.fillRect(0, (j * h) / bands, w, h / bands);
    }
    speckle(g, w, h, 26000, 0.13, false, 2);
    speckle(g, w, h, 14000, 0.09, true, 2);
    for (let i = 0; i < 3000; i++) {            // blade streaks
      g.strokeStyle = `rgba(${rand() < 0.5 ? '30,70,20' : '150,200,110'},${0.08 + rand() * 0.1})`;
      const x = rand() * w, y = rand() * h;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 3, y - 4 - rand() * 6); g.stroke();
    }
  }, { repeat: [11, 11] });
  const groundGeo = new THREE.CircleGeometry(CONFIG.field.groundRadius + 26, 128, 0, Math.PI * 2);
  {
    const pos = groundGeo.attributes.position, col = [];
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      const k = r < 55 ? 1 : r < CONFIG.field.boundaryRadius ? 1 - (r - 55) * 0.007 : 0.86 - Math.min(0.1, (r - 65) * 0.004);
      col.push(k, k, k * 0.98);
    }
    groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: grassTex, vertexColors: true }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, CZ);
  stadium.add(ground);

  // Rope + 30-yard circle.
  const rope = new THREE.Mesh(new THREE.TorusGeometry(CONFIG.field.boundaryRadius, 0.08, 6, 220),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x222222 }));
  rope.rotation.x = Math.PI / 2;
  rope.position.set(0, 0.08, CZ);
  stadium.add(rope);
  const dots = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    dots.push(part(new THREE.CircleGeometry(0.2, 10), 0xffffff, [Math.sin(a) * 27.4, 0.006, CZ + Math.cos(a) * 27.4], [-Math.PI / 2, 0, 0]));
  }
  stadium.add(new THREE.Mesh(merge(dots), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));

  // ---------------------------------------------------------- pitch strip
  const stripLen = PITCH.stripMaxZ - PITCH.stripMinZ;
  const zToY = (z, h) => ((PITCH.stripMaxZ - z) / stripLen) * h;
  const pitchTex = canvasTex(256, 2048, (g, w, h) => {
    g.fillStyle = '#cdb782'; g.fillRect(0, 0, w, h);
    // Lengthwise roller sheen bands.
    for (let i = 0; i < 6; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)'; g.fillRect((i * w) / 6, 0, w / 6, h); }
    const edge = g.createLinearGradient(0, 0, w, 0);
    edge.addColorStop(0, 'rgba(96,138,60,0.85)'); edge.addColorStop(0.13, 'rgba(110,140,70,0.15)');
    edge.addColorStop(0.87, 'rgba(110,140,70,0.15)'); edge.addColorStop(1, 'rgba(96,138,60,0.85)');
    g.fillStyle = edge; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 30000, 0.12, false, 2);
    speckle(g, w, h, 16000, 0.12, true, 2);
    // Hairline cracks.
    for (let i = 0; i < 160; i++) {
      g.strokeStyle = `rgba(90,70,45,${0.15 + rand() * 0.2})`;
      g.lineWidth = 0.6 + rand() * 0.8;
      let x = w * (0.2 + rand() * 0.6), y = rand() * h;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 6; s++) { x += (rand() - 0.5) * 14; y += (rand() - 0.5) * 22; g.lineTo(x, y); }
      g.stroke();
    }
    // Footholes, scuffed batting creases and the bowlers' rough.
    for (const z of [PITCH.battingStumpsZ - 1.25, PITCH.bowlingStumpsZ + 1.25]) {
      for (const [fx, rx, ry, a] of [[0.36, 0.12, 0.014, 0.35], [0.63, 0.14, 0.018, 0.4], [0.5, 0.3, 0.03, 0.18]]) {
        const cy = zToY(z, h);
        const fg = g.createRadialGradient(w * fx, cy, 0, w * fx, cy, w * rx);
        fg.addColorStop(0, `rgba(118,92,60,${a})`); fg.addColorStop(1, 'rgba(118,92,60,0)');
        g.fillStyle = fg;
        g.beginPath(); g.ellipse(w * fx, cy, w * rx, h * ry, 0, 0, Math.PI * 2); g.fill();
      }
    }
    for (const z of [-5.5, -14.6]) {
      const cy = zToY(z, h);
      const rg = g.createRadialGradient(w * 0.75, cy, 0, w * 0.75, cy, w * 0.2);
      rg.addColorStop(0, 'rgba(120,96,64,0.22)'); rg.addColorStop(1, 'rgba(120,96,64,0)');
      g.fillStyle = rg; g.fillRect(0, cy - h * 0.06, w, h * 0.12);
    }
  });
  const pitchMesh = new THREE.Mesh(new THREE.PlaneGeometry(PITCH.stripHalfWidth * 2, stripLen),
    new THREE.MeshLambertMaterial({ map: pitchTex }));
  pitchMesh.rotation.x = -Math.PI / 2;
  pitchMesh.position.set(0, 0.003, (PITCH.stripMaxZ + PITCH.stripMinZ) / 2);
  pitchGroup.add(pitchMesh);
  pitchGroup.userData.pitchMesh = pitchMesh;
  // Wider square of slightly different grass around the strip.
  const square = new THREE.Mesh(new THREE.PlaneGeometry(14, 34), new THREE.MeshLambertMaterial({ color: 0x5fa548, transparent: true, opacity: 0.35, depthWrite: false }));
  square.rotation.x = -Math.PI / 2;
  square.position.set(0, 0.0015, CZ);
  stadium.add(square);

  // Creases (crisp geometry, not texture).
  const W = 0.05, Y = 0.006, lines = [];
  const quad = (x0, z0, x1, z1) => {
    lines.push(part(new THREE.PlaneGeometry(Math.max(Math.abs(x1 - x0), W), Math.max(Math.abs(z1 - z0), W)), 0xffffff,
      [(x0 + x1) / 2, Y, (z0 + z1) / 2], [-Math.PI / 2, 0, 0]));
  };
  for (const [sz, dir] of [[PITCH.battingStumpsZ, -1], [PITCH.bowlingStumpsZ, 1]]) {
    const pop = sz + dir * PITCH.poppingOffset;
    quad(-PITCH.returnCreaseX, sz, PITCH.returnCreaseX, sz);
    quad(-PITCH.poppingHalfLength, pop, PITCH.poppingHalfLength, pop);
    for (const sx of [-1, 1]) quad(sx * PITCH.returnCreaseX, pop, sx * PITCH.returnCreaseX, pop - dir * 2.44);
    for (const sx of [-1, 1]) quad(sx * PITCH.wideLineX, pop, sx * PITCH.wideLineX, pop - dir * 0.6);
  }
  pitchGroup.add(new THREE.Mesh(merge(lines), new THREE.MeshBasicMaterial({ vertexColors: true })));

  // ---------------------------------------------------------- stands
  const R0 = CONFIG.field.groundRadius + 4;           // front wall radius (84 m)
  const prof = [];
  prof.push([R0 - 0.3, 0], [R0 - 0.3, 1.4], [R0, 1.4]);
  const lower = { rows: 15, depth: 0.82, rise: 0.42 }, upper = { rows: 14, depth: 0.85, rise: 0.55 };
  let r = R0, y = 1.4;
  const rowsInfo = [];
  for (let i = 0; i < lower.rows; i++) { prof.push([r, y + lower.rise]); y += lower.rise; prof.push([r + lower.depth, y]); rowsInfo.push({ r: r + lower.depth * 0.5, y }); r += lower.depth; }
  prof.push([r + 2.6, y]);                            // concourse
  r += 2.6;
  prof.push([r, y + 3.2]); y += 3.2;                  // upper tier front wall
  prof.push([r + 0.4, y]); r += 0.4;
  for (let i = 0; i < upper.rows; i++) { prof.push([r, y + upper.rise]); y += upper.rise; prof.push([r + upper.depth, y]); rowsInfo.push({ r: r + upper.depth * 0.5, y }); r += upper.depth; }
  prof.push([r, y + 3.5], [r + 1.2, y + 3.5], [r + 1.2, 0]);
  const standTop = y + 3.5, standBack = r + 1.2;
  const lathe = new THREE.LatheGeometry(prof.map(([pr, py]) => new THREE.Vector2(pr, py)), 128).toNonIndexed();
  lathe.computeVertexNormals();
  {
    const pos = lathe.attributes.position, nor = lathe.attributes.normal, col = new Float32Array(pos.count * 3);
    const sectorCols = [0x1f4fa8, 0xf2c12e, 0x1f4fa8, 0xd8dde3, 0xb3221c, 0xf4f4f4, 0xb3221c, 0x2d8a57, 0x1f4fa8, 0xd8dde3, 0x7a3fa0, 0xe57c2a].map((c) => new THREE.Color(c));
    const concrete = new THREE.Color(0x9ea4ab), dark = new THREE.Color(0x6c727a), c = new THREE.Color();
    for (let i = 0; i < pos.count; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const ny = (nor.getY(i) + nor.getY(i + 1) + nor.getY(i + 2)) / 3;
      const a = Math.atan2(cx, cz);
      const rr = Math.hypot(cx, cz);
      const seating = rr > R0 + 0.05 && cy > 1.45 && cy < standTop - 0.1 && Math.abs(rr - (R0 + lower.rows * lower.depth + 1.3)) > 1.4
        && !(cy > 1.4 + lower.rows * lower.rise + 0.05 && cy < 1.4 + lower.rows * lower.rise + 3.2);
      if (seating) {
        const sec = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 24) % 12;
        const aisle = Math.abs(((a + Math.PI) * 24 / (Math.PI * 2)) % 1 - 0.5) > 0.47;
        c.copy(aisle ? concrete : sectorCols[sec]);
        const rowShade = 0.85 + 0.15 * (Math.floor(cy / 0.45) % 2);
        // Seat backs (risers, facing the pitch) carry the colour; treads are darker.
        c.multiplyScalar(rowShade * (Math.abs(ny) > 0.7 ? 0.55 : 1) * (0.75 + 0.25 * Math.min(1, (standTop - cy) / 6)));
      } else {
        c.copy(cy > standTop - 0.2 || rr > standBack - 0.6 ? dark : concrete).multiplyScalar(Math.abs(ny) > 0.7 ? 1 : 0.8);
      }
      for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
    }
    lathe.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const stands = new THREE.Mesh(lathe, vertexColorMat({ side: THREE.DoubleSide }));
  stands.position.z = CZ;
  stadium.add(stands);

  // Roof canopies over the side stands + pillars.
  const roofParts = [];
  const roofProf = [new THREE.Vector2(R0 + 8, standTop + 7.5), new THREE.Vector2(standBack + 1, standTop + 4.8), new THREE.Vector2(standBack + 1, standTop + 4.2), new THREE.Vector2(R0 + 8, standTop + 7.0)];
  for (const [start, len] of [[0.42, Math.PI - 0.84], [Math.PI + 0.42, Math.PI - 0.84]]) {
    const rg = new THREE.LatheGeometry(roofProf, 48, start, len);
    roofParts.push(part(rg, 0xe9edf0));
    for (let a = start + 0.03; a < start + len; a += 0.13) {
      roofParts.push(part(new THREE.CylinderGeometry(0.35, 0.45, standTop + 4.9, 6), 0xc7cdd3, [Math.sin(a) * (standBack + 0.6), (standTop + 4.9) / 2, Math.cos(a) * (standBack + 0.6)]));
    }
  }
  const roof = new THREE.Mesh(merge(roofParts), vertexColorMat({ side: THREE.DoubleSide, emissive: 0x4a5058 }));
  roof.position.z = CZ;
  stadium.add(roof);

  // Pavilion (off side, square): white two-storey building with balconies.
  const pav = [];
  const PX = R0 - 3.5, PZ = CZ + 4;
  pav.push(part(new THREE.BoxGeometry(6, 9, 26), 0xf3efe6, [PX + 3, 4.5, PZ]));
  pav.push(part(new THREE.BoxGeometry(2.4, 0.3, 26), 0xd9d3c4, [PX - 0.2, 3.2, PZ]));
  pav.push(part(new THREE.BoxGeometry(2.4, 0.3, 26), 0xd9d3c4, [PX - 0.2, 6.4, PZ]));
  for (let i = -12; i <= 12; i += 3) pav.push(part(new THREE.BoxGeometry(0.15, 9, 0.15), 0xe8e3d8, [PX - 1.3, 4.5, PZ + i]));
  pav.push(part(new THREE.BoxGeometry(2.4, 1.0, 0.08), 0x8a6e4a, [PX - 0.2, 3.85, PZ + 13]));
  for (let row = 0; row < 2; row++) for (let i = -11; i <= 11; i += 2.2) pav.push(part(new THREE.BoxGeometry(0.05, 1.6, 1.4), 0x2c4a63, [PX - 0.01, 1.8 + row * 3.2, PZ + i]));
  pav.push(part(new THREE.CylinderGeometry(0.1, 13, 5, 4, 1), 0x7b2e22, [PX + 3, 11.5, PZ], [0, Math.PI / 4, 0], [0.3, 1, 1.4]));
  pav.push(part(new THREE.CylinderGeometry(1.4, 1.4, 0.25, 20), 0xf7f3ea, [PX - 0.2, 10.5, PZ], [0, 0, Math.PI / 2]));
  pav.push(part(new THREE.CylinderGeometry(1.2, 1.2, 0.27, 20), 0x1a1a1a, [PX - 0.25, 10.5, PZ], [0, 0, Math.PI / 2]));
  pav.push(part(new THREE.CylinderGeometry(0.05, 0.05, 4, 6), 0xdddddd, [PX + 3, 15.5, PZ]));
  pav.push(part(new THREE.BoxGeometry(0.05, 1.0, 1.6), 0x1f4fa8, [PX + 3, 16.8, PZ + 0.8]));
  stadium.add(new THREE.Mesh(merge(pav), vertexColorMat()));

  // ---------------------------------------------------------- sightscreens
  const ss = [];
  for (const dir of [-1, 1]) {
    const z = CZ + dir * (CONFIG.field.boundaryRadius + 6);
    ss.push(part(new THREE.BoxGeometry(26, 10.5, 0.4), 0x0e1218, [0, 5.4, z]));
    ss.push(part(new THREE.BoxGeometry(26.4, 0.35, 0.7), 0x2a303a, [0, 10.8, z]));
    for (const x of [-12, -6, 0, 6, 12]) ss.push(part(new THREE.BoxGeometry(0.3, 0.6, 1.4), 0x30363f, [x, 0.3, z - dir * 0.5]));
  }
  stadium.add(new THREE.Mesh(merge(ss), vertexColorMat()));

  // ---------------------------------------------------------- LED boards
  const brands = ['CREASE', 'OVERARM ENERGY', 'SILLY POINT COLA', 'LONG ON TRAVEL', 'NIGHTWATCH INSURANCE', 'GULLY GRILL', 'NO BALL RADIO', 'FOLLOW-ON FIBRE', 'DEEP COVER BANK', 'GOOD LENGTH'];
  const ledTex = canvasTex(4096, 128, (g, w, h) => {
    const cols = ['#0b2a66', '#b3221c', '#0d6b3f', '#f2c12e', '#4b1f7a', '#0c4f8a'];
    const seg = w / brands.length;
    brands.forEach((b, i) => {
      g.fillStyle = cols[i % cols.length]; g.fillRect(i * seg, 0, seg, h);
      g.fillStyle = i % cols.length === 3 ? '#111' : '#fff';
      g.font = '800 70px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(b, i * seg + seg / 2, h / 2 + 3, seg - 30);
    });
  }, { aniso: 4 });
  ledTex.wrapS = THREE.RepeatWrapping;
  ledTex.repeat.set(-4, 1);              // negative: read correctly from inside the cylinder
  const ledR = CONFIG.field.boundaryRadius + 3.2;
  const led = new THREE.Mesh(new THREE.CylinderGeometry(ledR, ledR, 0.95, 160, 1, true),
    new THREE.MeshBasicMaterial({ map: ledTex, side: THREE.BackSide, toneMapped: false }));
  led.position.set(0, 0.5, CZ);
  stadium.add(led);

  // ---------------------------------------------------------- floodlights
  const fl = [], halos = [];
  const haloMat = new THREE.SpriteMaterial({ map: radialTexture(64, 'rgba(255,250,225,0.9)', 'rgba(255,250,225,0)'), blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const rr = standBack + 6;
    const x = Math.sin(a) * rr, z = CZ + Math.cos(a) * rr;
    fl.push(part(new THREE.CylinderGeometry(0.5, 1.4, 52, 6), 0x8f969e, [x, 26, z]));
    for (let k = 0; k < 6; k++) fl.push(part(new THREE.BoxGeometry(2.8, 0.15, 0.15), 0x8f969e, [x, 8 + k * 7, z], [0, a, 0]));
    fl.push(part(new THREE.BoxGeometry(11, 6.5, 1.2), 0x3a4048, [x, 55, z], [0.32, a + Math.PI, 0]));
    for (let gy = -1; gy <= 1; gy++) for (let gx = -2; gx <= 2; gx++) {
      const lx = gx * 2.0, ly = gy * 1.9;
      const ca = Math.cos(a + Math.PI), sa = Math.sin(a + Math.PI);
      fl.push(part(new THREE.BoxGeometry(1.6, 1.5, 0.3), 0xfffbe6, [x + lx * ca - 0.7 * Math.sin(a), 55 + ly * Math.cos(0.32), z - lx * sa - 0.7 * Math.cos(a)], [0.32, a + Math.PI, 0]));
    }
    const halo = new THREE.Sprite(haloMat);
    halo.position.set(x - Math.sin(a) * 2, 55, z - Math.cos(a) * 2);
    halo.scale.set(26, 18, 1);
    halos.push(halo);
  }
  stadium.add(new THREE.Mesh(merge(fl), vertexColorMat({ emissive: 0x101010 })));
  for (const h of halos) stadium.add(h);

  // ---------------------------------------------------------- big screen
  const screenPos = new THREE.Vector3();
  {
    const a = -2.08, rr = R0 + 9;
    screenPos.set(Math.sin(a) * rr, standTop + 6, CZ + Math.cos(a) * rr);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 1.2), new THREE.MeshLambertMaterial({ color: 0x1b1f26 }));
    frame.position.copy(screenPos).add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.8));
    frame.lookAt(0, screenPos.y - 4, CZ);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1, standTop + 6, 1), new THREE.MeshLambertMaterial({ color: 0x5d636b }));
    legs.position.set(screenPos.x * 1.04, (standTop + 6) / 2, CZ + (screenPos.z - CZ) * 1.04);
    stadium.add(frame, legs);
  }

  // ---------------------------------------------------------- crowd
  const crowd = buildCrowd(rowsInfo, R0, lower.rows);
  crowd.position.z = CZ;
  stadium.add(crowd);
  // Front-wall band (team colours) along the upper tier.
  {
    const r1 = R0 + lower.rows * lower.depth + 2.6;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r1 - 0.05, r1 - 0.05, 1.2, 128, 1, true),
      new THREE.MeshBasicMaterial({ map: ledTex, side: THREE.BackSide, toneMapped: false, fog: true }));
    band.position.set(0, 1.4 + lower.rows * lower.rise + 1.6, CZ);
    stadium.add(band);
  }

  scene.add(root);
  const env = {
    root, stadium, pitchGroup, crowd, sky, ground,
    screen: { pos: screenPos, look: new THREE.Vector3(0, screenPos.y - 5, CZ) },
    update(dt, t) {
      ledTex.offset.x = (t * 0.012) % 1;
      skyline.rotation.y = 0;
    },
  };
  return env;
}

// Spectators: one instanced, camera-facing cut-out per seat (2 triangles),
// drawn from an atlas of 4 people x 2 poses (sitting / up and cheering).
// The texture is a mask, not colours: R = shading, G = shirt, B = skin,
// A = cut-out; each fan gets their own shirt, skin and hair colour. They
// stand and bounce when the ground cheers, and a Mexican wave goes round now
// and then (uWave / uWaveOn).
function crowdAtlas() {
  const CW = 128, CH = 320, PPM = CH / 1.5;           // cell = 0.6 m x 1.5 m
  const c = document.createElement('canvas');
  c.width = CW * 8; c.height = CH;
  const g = c.getContext('2d');
  const col = (r, gg, b, a = 1) => `rgba(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)},${a})`;
  const SHIRT = (sh) => col(sh, 1, 0), SKIN = (sh) => col(sh, 0, 1), HAIR = (sh) => col(sh, 0, 0);
  const Y = (m) => CH - m * PPM;                     // metres above the seat -> canvas y
  const rrect = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  const shirtGrad = (x0, x1) => { const gr = g.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, SHIRT(0.68)); gr.addColorStop(0.35, SHIRT(1)); gr.addColorStop(0.7, SHIRT(0.95)); gr.addColorStop(1, SHIRT(0.62)); return gr; };
  for (let cell = 0; cell < 8; cell++) {
    const v = cell % 4, up = cell >= 4;
    const cx = cell * CW + CW / 2;
    const base = up ? 0.42 : 0;                      // standing lifts the body
    // Torso.
    const tw = (v === 1 ? 0.34 : 0.4) * PPM, top = Y(base + 0.5), bot = Y(base - 0.05);
    g.fillStyle = shirtGrad(cx - tw / 2, cx + tw / 2);
    rrect(cx - tw / 2, top, tw, bot - top, 14); g.fill();
    // Arms: down by the sides, or raised in a V.
    g.lineCap = 'round';
    if (up) {
      for (const sx of [-1, 1]) {
        const shx = cx + sx * tw * 0.42, shy = top + 10;
        const hx = cx + sx * (0.27 + 0.03 * v) * PPM, hy = Y(base + 1.0 + 0.04 * v);
        g.strokeStyle = SHIRT(0.85); g.lineWidth = 0.1 * PPM;
        g.beginPath(); g.moveTo(shx, shy); g.lineTo((shx + hx) / 2, (shy + hy) / 2); g.stroke();
        g.strokeStyle = SKIN(0.9); g.lineWidth = 0.075 * PPM;
        g.beginPath(); g.moveTo((shx + hx) / 2, (shy + hy) / 2); g.lineTo(hx, hy); g.stroke();
        g.fillStyle = SKIN(1); g.beginPath(); g.arc(hx, hy, 0.05 * PPM, 0, Math.PI * 2); g.fill();
      }
    } else {
      for (const sx of [-1, 1]) {
        g.strokeStyle = SHIRT(0.72); g.lineWidth = 0.09 * PPM;
        g.beginPath(); g.moveTo(cx + sx * tw * 0.46, top + 12); g.lineTo(cx + sx * tw * 0.5, Y(base + 0.12)); g.stroke();
        g.fillStyle = SKIN(0.85); g.beginPath(); g.arc(cx + sx * tw * 0.42, Y(base + 0.08), 0.045 * PPM, 0, Math.PI * 2); g.fill();
      }
    }
    // Neck and head.
    const hy = Y(base + 0.68), hr = 0.105 * PPM;
    g.fillStyle = SKIN(0.8); g.fillRect(cx - 0.05 * PPM, Y(base + 0.58), 0.1 * PPM, 0.08 * PPM);
    const sg = g.createRadialGradient(cx - hr * 0.3, hy - hr * 0.3, hr * 0.2, cx, hy, hr);
    sg.addColorStop(0, SKIN(1)); sg.addColorStop(1, SKIN(0.78));
    g.fillStyle = sg; g.beginPath(); g.ellipse(cx, hy, hr * 0.92, hr, 0, 0, Math.PI * 2); g.fill();
    // Hair / headwear by variant.
    if (v === 0) { g.fillStyle = HAIR(0.9); g.beginPath(); g.ellipse(cx, hy - hr * 0.45, hr * 0.95, hr * 0.62, 0, Math.PI, 0); g.fill(); }
    if (v === 1) {                                     // long hair
      g.fillStyle = HAIR(0.95); g.beginPath(); g.ellipse(cx, hy - hr * 0.3, hr * 1.05, hr * 0.85, 0, Math.PI, 0); g.fill();
      g.fillRect(cx - hr * 1.05, hy - hr * 0.35, hr * 0.42, hr * 1.9); g.fillRect(cx + hr * 0.63, hy - hr * 0.35, hr * 0.42, hr * 1.9);
    }
    if (v === 2) { g.fillStyle = HAIR(0.85); g.beginPath(); g.ellipse(cx, hy - hr * 0.55, hr * 0.9, hr * 0.48, 0, Math.PI, 0); g.fill(); }
    if (v === 3) {                                     // cap in the shirt colour
      g.fillStyle = SHIRT(0.9); g.beginPath(); g.ellipse(cx, hy - hr * 0.42, hr * 1.0, hr * 0.7, 0, Math.PI, 0); g.fill();
      g.fillStyle = SHIRT(0.7); g.fillRect(cx - hr * 1.15, hy - hr * 0.48, hr * 2.3, hr * 0.22);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;                 // a data mask, not colours
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function buildCrowd(rows, R0, lowerRows) {
  void R0;
  const geo = new THREE.PlaneGeometry(0.6, 1.5);
  geo.translate(0, 0.75, 0);
  const uniforms = { uTime: { value: 0 }, uCheer: { value: 0 }, uWave: { value: 0 }, uWaveOn: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ map: crowdAtlas(), alphaTest: 0.45, side: THREE.DoubleSide });
  mat.alphaToCoverage = true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uCheer; uniform float uWave; uniform float uWaveOn;
        attribute vec3 aShirt; attribute vec3 aSkin; attribute vec3 aHair; attribute vec3 aMeta;   // meta: variant, random, angle
        varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair;
        float crowdLift;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        {
          float rnd = aMeta.y, ph = rnd * 37.0;
          float d = mod(aMeta.z - uWave + 3.14159, 6.28318) - 3.14159;
          float wave = uWaveOn * exp(-d * d * 30.0);
          float stand = max(step(rnd, uCheer * 1.15 - 0.08), step(0.3, wave));
          crowdLift = stand * (uCheer * 0.16 * abs(sin(uTime * 7.5 + ph)) + wave * 0.3) + 0.01 * sin(uTime * 1.3 + ph);
          #ifdef USE_MAP
            vMapUv.x = (vMapUv.x + aMeta.x + 4.0 * stand) / 8.0;
          #endif
          vShirt = aShirt; vSkin = aSkin; vHair = aHair;
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y += crowdLift;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair;')
      .replace('#include <map_fragment>', `
        vec4 tx = texture2D(map, vMapUv);
        vec3 crowdCol = mix(mix(vHair, vSkin, tx.b), vShirt, tx.g) * tx.r;
        diffuseColor.rgb = crowdCol;
        diffuseColor.a *= tx.a;`);
  };
  mat.customProgramCacheKey = () => 'crowd-cutout-v1';
  // Seats: packed, a few empty ones.
  const perRowSpacing = 0.56;
  const list = [];
  rows.forEach((row, ri) => {
    const n = Math.floor((Math.PI * 2 * row.r) / perRowSpacing);
    const occ = ri < lowerRows ? 0.94 : 0.9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (ri % 2) * (0.5 / n);
      if (Math.abs(Math.sin(a)) < 0.17) continue;                // behind the sightscreens
      if (Math.abs(a - Math.PI / 2) < 0.2 && ri < lowerRows) continue; // pavilion front
      if (rand() > occ) continue;
      list.push({ a, r: row.r, y: row.y, ri });
    }
  });
  const shirts = [0x1f4fa8, 0xf2c12e, 0x1f4fa8, 0xb3221c, 0xf4f4f4, 0xd94a3d, 0x2d8a57, 0x222222, 0x8f4bb5, 0xe57c2a, 0x7fb7e6, 0xffffff, 0x14285a, 0xffd34d];
  const skins = [0xf3cfae, 0xe0b088, 0xc68e62, 0x9a6a46, 0x6b4630];
  const hairs = [0x1d1510, 0x3b2a1c, 0x5a4330, 0x0e0e0e, 0x8a6a40, 0xc9a050, 0x9a9a9a];
  const group = new THREE.Group();
  group.userData.uniforms = uniforms;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const maxTotal = CONFIG.render.crowdMax;
  const stride = Math.max(1, list.length / maxTotal);
  // Four quadrants so the ones behind you are frustum-culled.
  for (let quad = 0; quad < 4; quad++) {
    const sel = [];
    for (let f = 0; f < list.length; f += stride) {
      const it = list[Math.floor(f)];
      const qa = Math.floor(((it.a + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2)) % 4;
      if (qa === quad) sel.push(it);
    }
    const n = sel.length;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    const aShirt = new Float32Array(n * 3), aSkin = new Float32Array(n * 3), aHair = new Float32Array(n * 3), aMeta = new Float32Array(n * 3);
    sel.forEach((it, i) => {
      p.set(Math.sin(it.a) * it.r, it.y - 0.05, Math.cos(it.a) * it.r);
      q.setFromAxisAngle(up, it.a + Math.PI + (rand() - 0.5) * 0.25);
      const k = 0.92 + rand() * 0.16;
      sc.set(k, k * (0.94 + rand() * 0.12), 1);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      // Sections of the ground lean to one team's colours.
      const sec = Math.floor(((it.a + Math.PI) / (Math.PI * 2)) * 8);
      const pool = sec % 3 === 0 ? [0, 1, 2, 12, 13] : sec % 3 === 1 ? [3, 4, 5] : [6, 7, 8, 9, 10, 11];
      color.setHex(shirts[rand() < 0.72 ? pool[Math.floor(rand() * pool.length)] : Math.floor(rand() * shirts.length)]);
      aShirt.set([color.r, color.g, color.b], i * 3);
      color.setHex(skins[Math.floor(rand() * skins.length)]);
      aSkin.set([color.r, color.g, color.b], i * 3);
      color.setHex(hairs[Math.floor(rand() * hairs.length)]);
      aHair.set([color.r, color.g, color.b], i * 3);
      aMeta.set([Math.floor(rand() * 4), rand(), (it.a + Math.PI * 2) % (Math.PI * 2)], i * 3);
    });
    mesh.geometry = geo.clone();
    mesh.geometry.setAttribute('aShirt', new THREE.InstancedBufferAttribute(aShirt, 3));
    mesh.geometry.setAttribute('aSkin', new THREE.InstancedBufferAttribute(aSkin, 3));
    mesh.geometry.setAttribute('aHair', new THREE.InstancedBufferAttribute(aHair, 3));
    mesh.geometry.setAttribute('aMeta', new THREE.InstancedBufferAttribute(aMeta, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  group.userData.count = Math.round(list.length / stride);
  return group;
}
