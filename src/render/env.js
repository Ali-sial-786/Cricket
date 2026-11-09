// Stadium environment: sky, outfield, pitch + creases, rope, stands, crowd,
// sightscreens, floodlights. Built for Quest: unlit/Lambert materials, merged
// geometry, a single InstancedMesh crowd, no realtime shadows.
import * as THREE from 'three';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { part, merge, vertexColorMat } from './util.js';

function canvasTex(w, h, draw, repeat = null) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

function noise(g, w, h, n, alpha, light = false) {
  for (let i = 0; i < n; i++) {
    const v = light ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${Math.random() * alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

export function buildEnvironment(scene) {
  const root = new THREE.Group();
  root.name = 'environment';
  const stadium = new THREE.Group();   // hidden in mixed reality
  stadium.name = 'stadium';
  const pitchGroup = new THREE.Group(); // stays in MR
  pitchGroup.name = 'pitch';
  root.add(stadium, pitchGroup);

  // --- Lights (no shadows) ---
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x4a6a2a, 1.6);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.8);
  sun.position.set(-30, 60, 25);
  root.add(hemi, sun);

  // --- Sky dome with vertex gradient ---
  const skyGeo = new THREE.SphereGeometry(320, 24, 12);
  const cols = [];
  const top = new THREE.Color(0x2f6fc0), hor = new THREE.Color(0xbfdcf5), bot = new THREE.Color(0x9fb89a);
  const pos = skyGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 320;
    const c = y > 0 ? hor.clone().lerp(top, Math.pow(y, 0.6)) : hor.clone().lerp(bot, Math.min(1, -y * 4));
    cols.push(c.r, c.g, c.b);
  }
  skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
  sky.renderOrder = -10;
  sky.position.z = PITCH.centerZ;
  stadium.add(sky);

  // --- Outfield with mowing stripes ---
  const grassTex = canvasTex(256, 256, (g, w, h) => {
    const stripes = 4;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? '#4f8f37' : '#5c9e40';
      g.fillRect((i * w) / stripes, 0, w / stripes, h);
    }
    noise(g, w, h, 2500, 0.12);
    noise(g, w, h, 1200, 0.08, true);
  }, [14, 14]);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(CONFIG.field.groundRadius + 20, 64),
    new THREE.MeshLambertMaterial({ map: grassTex }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, PITCH.centerZ);
  stadium.add(ground);

  // Boundary rope.
  const rope = new THREE.Mesh(
    new THREE.TorusGeometry(CONFIG.field.boundaryRadius, 0.07, 5, 160),
    new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }),
  );
  rope.rotation.x = Math.PI / 2;
  rope.position.set(0, 0.07, PITCH.centerZ);
  stadium.add(rope);

  // Inner 30-yard circle dots (visual reference for distances).
  const dotGeo = [];
  const circleR = 27.4;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    dotGeo.push(part(new THREE.CircleGeometry(0.18, 8), 0xffffff, [Math.sin(a) * circleR, 0.006, PITCH.centerZ + Math.cos(a) * circleR], [-Math.PI / 2, 0, 0]));
  }
  stadium.add(new THREE.Mesh(merge(dotGeo), new THREE.MeshBasicMaterial({ vertexColors: true })));

  // --- Pitch strip ---
  const stripLen = PITCH.stripMaxZ - PITCH.stripMinZ;
  const pitchTex = canvasTex(128, 1024, (g, w, h) => {
    g.fillStyle = '#c9b27c';
    g.fillRect(0, 0, w, h);
    // Greener edges, worn centre and footholes.
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, 'rgba(110,140,70,0.55)');
    grd.addColorStop(0.18, 'rgba(110,140,70,0.0)');
    grd.addColorStop(0.82, 'rgba(110,140,70,0.0)');
    grd.addColorStop(1, 'rgba(110,140,70,0.55)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 5000, 0.10);
    noise(g, w, h, 3000, 0.10, true);
    const zToY = (z) => ((PITCH.stripMaxZ - z) / stripLen) * h;
    for (const z of [PITCH.battingStumpsZ - 1.2, PITCH.bowlingStumpsZ + 1.2]) {
      g.fillStyle = 'rgba(120,95,60,0.35)';
      g.beginPath();
      g.ellipse(w * 0.62, zToY(z), w * 0.14, h * 0.018, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(w * 0.38, zToY(z), w * 0.12, h * 0.015, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
  const pitchMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH.stripHalfWidth * 2, stripLen),
    new THREE.MeshLambertMaterial({ map: pitchTex }),
  );
  pitchMesh.rotation.x = -Math.PI / 2;
  pitchMesh.position.set(0, 0.003, (PITCH.stripMaxZ + PITCH.stripMinZ) / 2);
  pitchGroup.add(pitchMesh);
  pitchGroup.userData.pitchMesh = pitchMesh;

  // --- Creases (thin white quads, merged) ---
  const W = 0.05, Y = 0.006;
  const lines = [];
  const quad = (x0, z0, x1, z1) => {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const lx = Math.max(Math.abs(x1 - x0), W), lz = Math.max(Math.abs(z1 - z0), W);
    lines.push(part(new THREE.PlaneGeometry(lx, lz), 0xffffff, [cx, Y, cz], [-Math.PI / 2, 0, 0]));
  };
  for (const [sz, dir] of [[PITCH.battingStumpsZ, -1], [PITCH.bowlingStumpsZ, 1]]) {
    const pop = sz + dir * PITCH.poppingOffset;
    quad(-PITCH.returnCreaseX, sz, PITCH.returnCreaseX, sz);               // bowling crease
    quad(-PITCH.poppingHalfLength, pop, PITCH.poppingHalfLength, pop);     // popping crease
    for (const sx of [-1, 1]) quad(sx * PITCH.returnCreaseX, pop, sx * PITCH.returnCreaseX, pop - dir * 2.44); // return creases
    for (const sx of [-1, 1]) quad(sx * PITCH.wideLineX, pop, sx * PITCH.wideLineX, pop - dir * 0.6);        // wide guides
  }
  const creaseMesh = new THREE.Mesh(merge(lines), new THREE.MeshBasicMaterial({ vertexColors: true }));
  pitchGroup.add(creaseMesh);

  // --- Stands (lathe bowl) ---
  const R0 = CONFIG.field.groundRadius + 4;
  const profile = [];
  const tiers = 7;
  for (let i = 0; i <= tiers; i++) {
    const r = R0 + i * 3.2, y = i * 2.4;
    profile.push(new THREE.Vector2(r, y), new THREE.Vector2(r + 3.2, y));
  }
  profile.push(new THREE.Vector2(R0 + tiers * 3.2 + 3.2, tiers * 2.4 + 7));
  const standGeo = new THREE.LatheGeometry(profile, 72);
  const sc = [];
  const sp = standGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i);
    const c = new THREE.Color(y > tiers * 2.4 + 1 ? 0x55606e : (Math.floor(y / 2.4) % 2 ? 0x8a94a3 : 0x7a8493));
    sc.push(c.r, c.g, c.b);
  }
  standGeo.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
  const stands = new THREE.Mesh(standGeo, vertexColorMat({ side: THREE.DoubleSide }));
  stands.position.z = PITCH.centerZ;
  stadium.add(stands);

  // Advertising boards around the rope (one merged ring of panels).
  const boards = [];
  const nb = 90;
  const boardColors = [0x16325c, 0xc23b22, 0x1d7a4d, 0xe8b100, 0x5b2a86];
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2;
    const r = CONFIG.field.boundaryRadius + 3.0;
    boards.push(part(new THREE.BoxGeometry(4.4, 0.9, 0.1), boardColors[i % boardColors.length],
      [Math.sin(a) * r, 0.45, PITCH.centerZ + Math.cos(a) * r], [0, a, 0]));
  }
  stadium.add(new THREE.Mesh(merge(boards), vertexColorMat()));

  // --- Sightscreens (dark, for a white ball) ---
  const ssParts = [];
  for (const dir of [-1, 1]) {
    const z = PITCH.centerZ + dir * (CONFIG.field.boundaryRadius + 5.5);
    ssParts.push(part(new THREE.BoxGeometry(24, 10, 0.4), 0x10141c, [0, 5, z]));
    ssParts.push(part(new THREE.BoxGeometry(24.4, 0.4, 0.6), 0x2a303a, [0, 10.1, z]));
  }
  stadium.add(new THREE.Mesh(merge(ssParts), vertexColorMat()));

  // --- Floodlight towers ---
  const fl = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const r = R0 + 30;
    const x = Math.sin(a) * r, z = PITCH.centerZ + Math.cos(a) * r;
    fl.push(part(new THREE.CylinderGeometry(0.6, 1.0, 45, 6), 0x9aa1aa, [x, 22.5, z]));
    fl.push(part(new THREE.BoxGeometry(9, 5, 1), 0xf4f1d0, [x, 46, z], [0.35, a + Math.PI, 0]));
  }
  stadium.add(new THREE.Mesh(merge(fl), vertexColorMat({ emissive: 0x111111 })));

  // --- Crowd: one InstancedMesh, cheer animation in the vertex shader ---
  const crowd = buildCrowd(R0, tiers);
  crowd.position.z = PITCH.centerZ;
  stadium.add(crowd);

  scene.add(root);
  return { root, stadium, pitchGroup, crowd, sky, ground };
}

function buildCrowd(R0, tiers) {
  const geo = new THREE.BoxGeometry(0.45, 0.75, 0.35);
  geo.translate(0, 0.375, 0);
  const mat = new THREE.MeshLambertMaterial();
  const uniforms = { uTime: { value: 0 }, uCheer: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCheer = uniforms.uCheer;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uCheer;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float ph = float(gl_InstanceID) * 1.37;
        transformed.y += (0.02 * sin(uTime * 1.3 + ph) + uCheer * 0.35 * abs(sin(uTime * 9.0 + ph))) * step(0.1, position.y);`);
  };
  const perRing = 150;
  const count = tiers * perRing;
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const color = new THREE.Color();
  const palette = [0xd8d8d8, 0x2b4c9b, 0xc8322b, 0xf1c232, 0x3c8d40, 0x222222, 0xe07b39, 0x8e44ad, 0xffffff, 0x1abc9c];
  let n = 0;
  for (let t = 0; t < tiers; t++) {
    for (let i = 0; i < perRing; i++) {
      const a = (i / perRing) * Math.PI * 2 + (t % 2) * 0.02 + (Math.random() - 0.5) * 0.01;
      // Leave gaps behind the sightscreens.
      const behindEnds = Math.abs(Math.sin(a)) < 0.16;
      const r = R0 + t * 3.2 + 1.6;
      if (behindEnds || Math.random() < 0.12) {
        m.makeScale(0, 0, 0);
      } else {
        p.set(Math.sin(a) * r, t * 2.4, Math.cos(a) * r);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a + Math.PI);
        const k = 0.85 + Math.random() * 0.3;
        s.set(k, k, k);
        m.compose(p, q, s);
      }
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, color.setHex(palette[(Math.random() * palette.length) | 0]));
      n++;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  return mesh;
}
