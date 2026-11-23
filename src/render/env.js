// Stadium environment, built for Quest 3S: everything static is merged into a
// handful of meshes with vertex colours / small canvas textures, one instanced
// crowd with a cheering vertex shader, no realtime shadows.
//
//   sky dome with painted clouds + sun · distant skyline · tone-mapped lighting
//   the bowl, roofs, pavilion, towers, boards and crowd (stadium.js, crowd.js)
//   · striped turf with a worn rim · detailed pitch · sightscreens
import * as THREE from 'three';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { part, merge, vertexColorMat } from './util.js';
import { buildLights } from './lighting.js';
import { buildSky } from './sky.js';
import { buildGround } from './ground.js';
import { buildStadium } from './stadium.js';
import { buildCrowd } from './crowd.js';
import { freezeStatic } from './drawCost.js';

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
    grad.addColorStop(0, '#3a4554'); grad.addColorStop(0.45, '#2a3341'); grad.addColorStop(1, '#1d232d');
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
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(i * pw, 0, 7, h);                 // seam (~18 cm: a line still at 85 m)
      g.fillStyle = 'rgba(255,255,255,0.13)'; g.fillRect(i * pw + 7, 0, 3, h);     // its lit lip
    }
    // A fine horizontal weave (the mesh of the slats), too faint to move against a white ball.
    for (let y = 0; y < h; y += 4) { g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, y, w, 1); }
    // Horizontal stiffeners showing through.
    for (const y of [0.33, 0.66]) { g.fillStyle = 'rgba(0,0,0,0.32)'; g.fillRect(0, y * h - 3, w, 6); g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, y * h + 3, w, 2); }
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
  const { hemi, sun, fill } = buildLights(root, scene);
  const skyView = buildSky(stadium, CZ);
  const sky = skyView.sky;
  const { ground, pitchMesh } = buildGround(stadium, pitchGroup);
  pitchGroup.userData.pitchMesh = pitchMesh;

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
  // (a faint emissive lift: the screen in the stands' shade is a dark face, not a hole)
  const ssFaceMat = new THREE.MeshLambertMaterial({ map: ssTex, color: 0xffffff, emissive: 0x0d1117 });
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
    const fz = z - dir * 0.06, rail = 0x9ba3ac;
    ss.push(part(new THREE.BoxGeometry(SW + 0.7, 0.4, 0.26), rail, [0, SB + SH + 0.14, fz]));
    ss.push(part(new THREE.BoxGeometry(SW + 0.7, 0.32, 0.26), rail, [0, SB - 0.1, fz]));
    for (const sx of [-1, 1]) ss.push(part(new THREE.BoxGeometry(0.36, SH + 0.7, 0.26), rail, [sx * (SW / 2 + 0.17), SB + SH / 2, fz]));
    // Its shadow on the turf: a dark band at its foot, darkest right under it (it stands in it).
    ss.push(part(new THREE.BoxGeometry(SW + 1.6, 0.02, 1.4), 0x26331f, [0, 0.012, z - dir * 0.55]));
    ss.push(part(new THREE.BoxGeometry(SW + 3.0, 0.02, 1.2), 0x33452a, [0, 0.01, z - dir * 1.6]));
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
  // Nothing built here moves (the crowd and the LED boards move in their shaders; MR moves
  // the rig, not this): matrices once, not every frame (drawCost.js). Things added later
  // (the stumps, the machine, the scoreboard) keep their own updates.
  freezeStatic(root);
  const env = {
    root, stadium, pitchGroup, crowd, sky, ground,
    screen: { pos: screenPos, look: new THREE.Vector3(0, screenPos.y - 5, CZ) },
    update(dt, t) {
      bowl.update(t);
      skyView.update(t);
    },
    // The crowd's visual reaction (game.crowdReact): boundaries spread from where the ball went.
    crowdReact(kind, strength, ballPos) {
      const ang = ballPos && Math.hypot(ballPos.x, ballPos.z - CZ) > 40 ? Math.atan2(ballPos.x, ballPos.z - CZ) : null;
      return crowd.userData.react(kind, strength, ang == null ? null : (ang + Math.PI * 2) % (Math.PI * 2));
    },
  };
  return env;
}
