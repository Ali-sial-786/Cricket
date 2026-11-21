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
import { part, merge, vertexColorMat } from './util.js';
import { buildStadium } from './stadium.js';
import { buildCrowd } from './crowd.js';

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

  // ---------------------------------------------------------- stadium + crowd
  // The bowl, roofs, pavilion, towers, screen frame, boards and the crowd
  // live in stadium.js / crowd.js, lit from the lights above.
  const bowlRoot = new THREE.Group(); bowlRoot.position.z = CZ; stadium.add(bowlRoot);
  const lit = { hemi, dirs: [sun, fill].map((l) => ({ dir: l.position.clone().sub(l.target.position).normalize(), color: l.color.clone().multiplyScalar(l.intensity) })) };
  const bowl = buildStadium(bowlRoot, lit);
  const crowd = buildCrowd(bowl.spots, { blocks: bowl.blocks, lights: lit, maxCount: CONFIG.render.crowdMax });
  bowlRoot.add(crowd);
  const screenPos = bowl.screenPos.clone().setZ(bowl.screenPos.z + CZ);

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

  scene.add(root);
  const env = {
    root, stadium, pitchGroup, crowd, sky, ground,
    screen: { pos: screenPos, look: new THREE.Vector3(0, screenPos.y - 5, CZ) },
    update(dt, t) {
      bowl.update(t);
      skyline.rotation.y = 0;
    },
    // The crowd's visual reaction (game.crowdReact): boundaries spread from where the ball went.
    crowdReact(kind, strength, ballPos) {
      const ang = ballPos && Math.hypot(ballPos.x, ballPos.z - CZ) > 40 ? Math.atan2(ballPos.x, ballPos.z - CZ) : null;
      return crowd.userData.react(kind, strength, ang == null ? null : (ang + Math.PI * 2) % (Math.PI * 2));
    },
  };
  return env;
}
