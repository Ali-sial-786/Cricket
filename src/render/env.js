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
import { buildLights } from './lighting.js';
import { buildSky } from './sky.js';
import { buildGround } from './ground.js';

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

// The sightscreen's face: vertical slats (panels with seams), a soft sheen
// that is lighter toward the top, and faint weathering. Its own random
// stream, so the rest of the ground is laid out as before.
function sightscreenTexture() {
  const r = mulberry(1234);
  return canvasTex(1024, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#2e3744'); grad.addColorStop(0.45, '#222a35'); grad.addColorStop(1, '#171c24');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const n = 16, pw = w / n;
    for (let i = 0; i < n; i++) {
      // Each panel a touch different, darker at its edges (slightly curved slats).
      const v = (r() - 0.5) * 0.06;
      g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v * 1.5})`;
      g.fillRect(i * pw, 0, pw, h);
      const s = g.createLinearGradient(i * pw, 0, (i + 1) * pw, 0);
      s.addColorStop(0, 'rgba(0,0,0,0.22)'); s.addColorStop(0.5, 'rgba(255,255,255,0.03)'); s.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = s; g.fillRect(i * pw, 0, pw, h);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(i * pw, 0, 3, h);                 // seam
      g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(i * pw + 3, 0, 2, h);     // its lit lip
    }
    // Horizontal stiffeners showing through.
    for (const y of [0.33, 0.66]) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y * h - 2, w, 4); g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(0, y * h + 2, w, 2); }
    // Weathering: faint streaks and grain.
    for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.035})`; g.fillRect(r() * w, r() * h, 1 + r() * 2, 20 + r() * 120); }
    for (let i = 0; i < 9000; i++) { const l = r() < 0.5; g.fillStyle = l ? `rgba(255,255,255,${r() * 0.05})` : `rgba(0,0,0,${r() * 0.12})`; g.fillRect(r() * w, r() * h, 1.5, 1.5); }
  }, { aniso: 4 });
}

export function buildEnvironment(scene) {
  const root = new THREE.Group(); root.name = 'environment';
  const stadium = new THREE.Group(); stadium.name = 'stadium';
  const pitchGroup = new THREE.Group(); pitchGroup.name = 'pitch';
  root.add(stadium, pitchGroup);

  // ---------------------------------------------------------- light, sky, ground
  // (render/lighting.js: the one sun; render/sky.js: dome, clouds, skyline;
  // render/ground.js: turf, pitch and creases, boundary cushion, 30-yard discs.)
  buildLights(root, scene);
  const skyView = buildSky(stadium, CZ);
  const sky = skyView.sky;
  const { ground, pitchMesh } = buildGround(stadium, pitchGroup);
  pitchGroup.userData.pitchMesh = pitchMesh;

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
  // Black for a white ball, but a real structure: a lit, slatted face (dark
  // charcoal-navy with panel seams, a soft top-to-bottom sheen and a little
  // weathering) in a galvanised frame, on posts with back braces and wheeled
  // bogies, so it reads as a screen and not as a hole in the world.
  const SW = 26, SH = 10.2, SB = 0.6;                         // face width, height, bottom edge
  const ssTex = sightscreenTexture();
  const ssFaceMat = new THREE.MeshLambertMaterial({ map: ssTex, color: 0xffffff });
  const ss = [];
  for (const dir of [-1, 1]) {
    const z = CZ + dir * (CONFIG.field.boundaryRadius + 6);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), ssFaceMat);
    face.position.set(0, SB + SH / 2, z);
    if (dir > 0) face.rotation.y = Math.PI;                    // face the pitch
    stadium.add(face);
    const back = z + dir * 0.18;                              // behind the face
    ss.push(part(new THREE.BoxGeometry(SW, SH, 0.3), 0x3a4049, [0, SB + SH / 2, back]));
    // Frame: top, bottom and side rails, standing a little proud of the face.
    const fz = z - dir * 0.06, rail = 0x7d858f;
    ss.push(part(new THREE.BoxGeometry(SW + 0.5, 0.28, 0.24), rail, [0, SB + SH + 0.1, fz]));
    ss.push(part(new THREE.BoxGeometry(SW + 0.5, 0.24, 0.24), rail, [0, SB - 0.08, fz]));
    for (const sx of [-1, 1]) ss.push(part(new THREE.BoxGeometry(0.26, SH + 0.5, 0.24), rail, [sx * (SW / 2 + 0.12), SB + SH / 2, fz]));
    // A cap along the top.
    ss.push(part(new THREE.BoxGeometry(SW + 0.8, 0.12, 0.9), 0x2b3038, [0, SB + SH + 0.3, back]));
    // Posts, back braces and wheeled bogies.
    for (const x of [-12.4, -6.2, 0, 6.2, 12.4]) {
      ss.push(part(new THREE.BoxGeometry(0.22, SB + SH + 0.4, 0.22), 0x6b737d, [x, (SB + SH + 0.4) / 2, back + dir * 0.28]));
      const brace = new THREE.BoxGeometry(0.12, 7.6, 0.12);
      ss.push(part(brace, 0x5d646e, [x, 3.4, back + dir * 2.2], [-dir * 0.62, 0, 0]));
      ss.push(part(new THREE.BoxGeometry(0.3, 0.25, 4.6), 0x4a5059, [x, 0.42, back + dir * 2.0]));
      for (const wz of [0.4, 3.9]) ss.push(part(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 12), 0x1d2025, [x, 0.28, back + dir * wz], [0, 0, Math.PI / 2]));
    }
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
  const ledR = CONFIG.field.boundaryRadius + CONFIG.field.boardsOffset;
  const led = new THREE.Mesh(new THREE.CylinderGeometry(ledR, ledR, CONFIG.field.boardsHeight - 0.025, 160, 1, true),
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
    // (high enough that the stand's roof edge clears its face, seen from the crease)
    const a = -2.08, rr = R0 + 9, sy = standTop + 12;
    screenPos.set(Math.sin(a) * rr, sy, CZ + Math.cos(a) * rr);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 1.2), new THREE.MeshLambertMaterial({ color: 0x1b1f26 }));
    frame.position.copy(screenPos).add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.8));
    frame.lookAt(0, screenPos.y - 4, CZ);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(1, sy, 1), new THREE.MeshLambertMaterial({ color: 0x5d636b }));
    legs.position.set(screenPos.x * 1.04, sy / 2, CZ + (screenPos.z - CZ) * 1.04);
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
      skyView.update(t);
    },
  };
  return env;
}

// Spectators: one cut-out per seat (2 triangles, facing the pitch, all merged),
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
  t.anisotropy = 1;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function buildCrowd(rows, R0, lowerRows) {
  void R0;
  const uniforms = { uTime: { value: 0 }, uCheer: { value: 0 }, uWave: { value: 0 }, uWaveOn: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ map: crowdAtlas(), alphaTest: 0.45, side: THREE.DoubleSide });
  mat.alphaToCoverage = true;
  // Every fan is 4 vertices sharing their seat position; the vertex shader
  // spreads them into a quad facing the pitch (narrow and short when seated,
  // full size when standing), bounces them and picks the atlas cell.
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uCheer; uniform float uWave; uniform float uWaveOn;
        attribute vec2 aCorner; attribute vec2 aRight; attribute vec2 aSize;
        attribute vec3 aShirt; attribute vec3 aSkin; attribute vec3 aHair; attribute vec3 aMeta;   // meta: variant, random, angle
        varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair;
        float crowdLift; float crowdStand;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        {
          float rnd = aMeta.y, ph = rnd * 37.0;
          float d = mod(aMeta.z - uWave + 3.14159, 6.28318) - 3.14159;
          float wave = uWaveOn * exp(-d * d * 30.0);
          float stand = max(step(rnd, uCheer * 1.15 - 0.08), step(0.3, wave));
          crowdLift = stand * (uCheer * 0.16 * abs(sin(uTime * 7.5 + ph)) + wave * 0.3) + 0.01 * sin(uTime * 1.3 + ph);
          crowdStand = stand;
          #ifdef USE_MAP
            vec2 cu = vec2(aCorner.x * 0.5 + 0.5, aCorner.y);
            if (stand < 0.5) cu = vec2(0.5 + (cu.x - 0.5) * 0.767, cu.y * 0.567);   // seated: lower-middle of the cell
            vMapUv = vec2((cu.x + aMeta.x + 4.0 * stand) / 8.0, cu.y);
          #endif
          vShirt = aShirt; vSkin = aSkin; vHair = aHair;
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float sx = crowdStand < 0.5 ? 0.767 : 1.0, sy = crowdStand < 0.5 ? 0.567 : 1.0;
          transformed += vec3(aRight.x, 0.0, aRight.y) * (aCorner.x * aSize.x * sx);
          transformed.y += aCorner.y * aSize.y * sy + crowdLift;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair;')
      .replace('#include <map_fragment>', `
        vec4 tx = texture2D(map, vMapUv);
        vec3 crowdCol = mix(mix(vHair, vSkin, tx.b), vShirt, tx.g) * tx.r;
        diffuseColor.rgb = crowdCol;
        diffuseColor.a *= tx.a;`);
  };
  mat.customProgramCacheKey = () => 'crowd-merged-v1';
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
  const color = new THREE.Color();
  const maxTotal = CONFIG.render.crowdMax;
  const stride = Math.max(1, list.length / maxTotal);
  const CORNERS = [[-1, 0], [1, 0], [-1, 1], [1, 1]];
  let total = 0;
  // Four quadrants (one draw call each) so the ones behind you are culled.
  for (let quad = 0; quad < 4; quad++) {
    const sel = [];
    for (let f = 0; f < list.length; f += stride) {
      const it = list[Math.floor(f)];
      const qa = Math.floor(((it.a + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2)) % 4;
      if (qa === quad) sel.push(it);
    }
    const n = sel.length, nv = n * 4;
    total += n;
    const pos = new Float32Array(nv * 3), corner = new Float32Array(nv * 2), right = new Float32Array(nv * 2), size = new Float32Array(nv * 2);
    const shirt = new Uint8Array(nv * 3), skin = new Uint8Array(nv * 3), hair = new Uint8Array(nv * 3), meta = new Float32Array(nv * 3);
    const index = new Uint32Array(n * 6);
    const col3 = (arr, i, hex) => { color.setHex(hex); arr[i] = Math.round(color.r * 255); arr[i + 1] = Math.round(color.g * 255); arr[i + 2] = Math.round(color.b * 255); };
    sel.forEach((it, i) => {
      const x = Math.sin(it.a) * it.r, z = Math.cos(it.a) * it.r, y = it.y - 0.05;
      const yaw = it.a + Math.PI + (rand() - 0.5) * 0.25;           // facing the pitch, roughly
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const k = 0.92 + rand() * 0.16, hk = k * (0.94 + rand() * 0.12);
      const sec = Math.floor(((it.a + Math.PI) / (Math.PI * 2)) * 8);
      const pool = sec % 3 === 0 ? [0, 1, 2, 12, 13] : sec % 3 === 1 ? [3, 4, 5] : [6, 7, 8, 9, 10, 11];
      const sh = shirts[rand() < 0.72 ? pool[Math.floor(rand() * pool.length)] : Math.floor(rand() * shirts.length)];
      const sk = skins[Math.floor(rand() * skins.length)], hr = hairs[Math.floor(rand() * hairs.length)];
      const variant = Math.floor(rand() * 4), rnd = rand(), ang = (it.a + Math.PI * 2) % (Math.PI * 2);
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        pos.set([x, y, z], v * 3);
        corner.set(CORNERS[c], v * 2);
        right.set([rx, rz], v * 2);
        size.set([0.3 * k, 1.5 * hk], v * 2);
        col3(shirt, v * 3, sh); col3(skin, v * 3, sk); col3(hair, v * 3, hr);
        meta.set([variant, rnd, ang], v * 3);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('aRight', new THREE.BufferAttribute(right, 2));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 2));
    geo.setAttribute('aShirt', new THREE.BufferAttribute(shirt, 3, true));
    geo.setAttribute('aSkin', new THREE.BufferAttribute(skin, 3, true));
    geo.setAttribute('aHair', new THREE.BufferAttribute(hair, 3, true));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2));   // (map chunks expect it; the shader sets the real UV)
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 2;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  group.userData.count = total;
  return group;
}
