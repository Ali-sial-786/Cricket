// Gameplay objects: bat, ball (+ blob shadow + trail), stumps (breakable),
// bowling machine with release-cue lights, pitch markers.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { PITCH, STUMP_X } from '../physics/pitch.js';
import { BatGeometry } from '../physics/bat.js';
import { part, merge, vertexColorMat, radialTexture, toV3, colorize } from './util.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- Bat
// Mesh origin = grip point; axes match the physics bat frame
// (+Y to handle top, +Z = hitting face, +X across).
// Shaped willow blade: flat face, curved back with a central spine, rounded
// edges and toe; turned shoulders; ribbed rubber grip; face + back stickers.
let _stickerTex = null;
function stickerTexture() {
  if (_stickerTex) return _stickerTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 512;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 512);
  // Top sticker (logo), mid band, toe band.
  g.fillStyle = '#b3221c'; g.fillRect(6, 10, 116, 150);
  g.fillStyle = '#ffffff'; g.font = '900 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.save(); g.translate(64, 85); g.rotate(-Math.PI / 2); g.fillText('CREASE', 0, 0); g.restore();
  g.fillStyle = '#f2c12e'; g.fillRect(6, 150, 116, 10);
  g.fillStyle = '#1f3a93'; g.fillRect(14, 420, 100, 26);
  g.fillStyle = '#ffffff'; g.font = '800 16px system-ui, sans-serif'; g.fillText('PRO', 64, 433);
  _stickerTex = new THREE.CanvasTexture(c);
  _stickerTex.colorSpace = THREE.SRGBColorSpace;
  return _stickerTex;
}

export function buildBatMesh(cfg = CONFIG.bat) {
  const g = new BatGeometry(cfg);
  const bl = cfg.bladeLength, w = cfg.bladeWidth, face = cfg.bladeThickness / 2;
  const edgeBack = face - 0.038, spineBack = face - 0.064;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, face);
  shape.lineTo(w / 2, face);
  shape.quadraticCurveTo(w / 2 + 0.006, (face + edgeBack) / 2, w / 2, edgeBack);
  shape.bezierCurveTo(w * 0.28, edgeBack - 0.012, w * 0.12, spineBack, 0, spineBack);
  shape.bezierCurveTo(-w * 0.12, spineBack, -w * 0.28, edgeBack - 0.012, -w / 2, edgeBack);
  shape.quadraticCurveTo(-w / 2 - 0.006, (face + edgeBack) / 2, -w / 2, face);
  const blade = new THREE.ExtrudeGeometry(shape, { depth: bl - 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.003, bevelSegments: 2, curveSegments: 6 });
  blade.rotateX(Math.PI / 2);                       // extrusion → -Y, face → +Z
  blade.translate(0, g.shoulderY - 0.006, 0);
  const parts = [colorize(blade, 0xe9d4a2)];
  // Shoulders: half-ellipsoid cap blending into the handle.
  const sh = new THREE.SphereGeometry(w / 2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  parts.push(part(sh, 0xdec58f, [0, g.shoulderY - 0.008, (face + spineBack) / 2 * 0.4], null, [1, 0.75, 0.42]));
  // Handle: splice + ribbed grip + cap.
  const hl = cfg.handleLength, hr = cfg.handleRadius;
  parts.push(part(new THREE.CylinderGeometry(hr * 0.95, hr * 1.05, 0.06, 10), 0xc9a466, [0, g.shoulderY + 0.03, 0]));
  const gripLen = hl - 0.07, rings = 14;
  for (let i = 0; i < rings; i++) {
    const y0 = g.shoulderY + 0.06 + (i / rings) * gripLen;
    parts.push(part(new THREE.CylinderGeometry(hr * 1.08, hr * 1.08, gripLen / rings * 0.62, 10), i % 2 ? 0x1b1b1b : 0x2b2f36, [0, y0 + gripLen / rings * 0.31, 0]));
    parts.push(part(new THREE.CylinderGeometry(hr, hr, gripLen / rings * 0.4, 10), 0x111111, [0, y0 + gripLen / rings * 0.8, 0]));
  }
  parts.push(part(new THREE.CylinderGeometry(hr * 1.12, hr * 0.9, 0.02, 10), 0x111111, [0, g.handleTopY - 0.005, 0]));
  const mesh = new THREE.Mesh(merge(parts), vertexColorMat());
  mesh.name = 'bat';
  // Stickers (face and back) — a second, textured mesh.
  const tex = stickerTexture();
  const stMat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const fg = new THREE.PlaneGeometry(w * 0.86, bl * 0.86);
  fg.translate(0, (g.shoulderY + g.toeY) / 2 + 0.01, face + 0.0012);
  const bg = new THREE.PlaneGeometry(w * 0.5, bl * 0.4);
  bg.rotateY(Math.PI);
  bg.translate(0, g.shoulderY - bl * 0.25, spineBack - 0.0015);
  mesh.add(new THREE.Mesh(mergeGeometries([fg, bg], false), stMat));
  return mesh;
}

// ---------------------------------------------------------------- Ball
export class BallView {
  constructor(scene) {
    const r = CONFIG.ball.radius;
    const geo = new THREE.SphereGeometry(r, 20, 14);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ map: ballTexture(), color: 0xffffff, emissive: 0x2a2a2a, shininess: 38, specular: 0x555555 }));
    this.mesh.name = 'ball';
    scene.add(this.mesh);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: radialTexture(64, 'rgba(0,0,0,0.6)'), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    scene.add(this.shadow);

    // Trail for hit balls / debug (fixed-size line strip).
    this.trailN = 40;
    const tp = new Float32Array(this.trailN * 3);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(tp, 3));
    this.trail = new THREE.Line(this.trailGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    scene.add(this.trail);
    this.trailCount = 0;
    this.trailEnabled = true;
    this.spinAngle = 0;
    this.visible = true;
  }

  setVisible(v) {
    this.visible = v;
    this.mesh.visible = v;
    this.shadow.visible = v;
    if (!v) { this.trail.visible = false; this.trailCount = 0; }
  }

  // pos: physics Vec3 (or three Vector3); spin: rad/s vector for visual rotation.
  update(pos, dt, spin = null, showTrail = false) {
    toV3(this.mesh.position, pos);
    if (spin && dt > 0) {
      const w = Math.hypot(spin.x, spin.y, spin.z);
      if (w > 1e-3) {
        _axis.set(spin.x / w, spin.y / w, spin.z / w);
        _q.setFromAxisAngle(_axis, w * dt);
        this.mesh.quaternion.premultiply(_q);
      }
    }
    const h = Math.max(0, pos.y - CONFIG.ball.radius);
    const s = 0.11 + h * 0.06;
    this.shadow.scale.set(s, s, s);
    this.shadow.position.set(pos.x, 0.008, pos.z);
    this.shadow.material.opacity = Math.max(0.15, 1 - h * 0.12);

    if (showTrail && this.trailEnabled) {
      const arr = this.trailGeo.attributes.position.array;
      if (this.trailCount < this.trailN) this.trailCount++;
      arr.copyWithin(3, 0, (this.trailN - 1) * 3);
      arr[0] = pos.x; arr[1] = pos.y; arr[2] = pos.z;
      for (let i = this.trailCount; i < this.trailN; i++) { arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z; }
      this.trailGeo.attributes.position.needsUpdate = true;
      this.trail.visible = true;
    }
  }
  clearTrail() { this.trailCount = 0; this.trail.visible = false; }
}
const _axis = new THREE.Vector3(), _q = new THREE.Quaternion();

// White leather with a raised stitched seam around the equator.
function ballTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f6f4ee'; g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(120,110,95,${Math.random() * 0.08})`; g.fillRect(Math.random() * 512, Math.random() * 256, 2, 2); }
  // Quarter seam (faint) and main seam.
  g.strokeStyle = 'rgba(150,145,135,0.6)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.moveTo(384, 0); g.lineTo(384, 256); g.stroke();
  g.fillStyle = '#d9d4c8'; g.fillRect(0, 120, 512, 16);
  g.strokeStyle = '#6b7b8c'; g.lineWidth = 2;
  for (const yy of [118, 138]) for (let x = 0; x < 512; x += 7) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + 4, yy + (yy < 128 ? 4 : -4)); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- Stumps
export class StumpsView {
  constructor(parent, z) {
    this.group = new THREE.Group();
    this.group.position.z = z;
    parent.add(this.group);
    const mat = new THREE.MeshLambertMaterial({ color: 0xf1e6c8 });
    const tipMat = new THREE.MeshLambertMaterial({ color: 0xc0392b });
    this.pieces = [];
    const h = PITCH.stumpHeight, r = PITCH.stumpRadius;
    const stumpGeo = merge([
      part(new THREE.CylinderGeometry(r, r * 0.92, h, 8), 0xf1e6c8, [0, h / 2, 0]),
      part(new THREE.CylinderGeometry(r * 1.03, r * 1.03, 0.07, 8), 0xc0392b, [0, h - 0.13, 0]),
      part(new THREE.CylinderGeometry(r * 1.03, r * 1.03, 0.02, 8), 0x1f3a93, [0, h - 0.2, 0]),
    ]);
    const stumpMat = vertexColorMat();
    void tipMat;
    for (const x of STUMP_X) {
      const m = new THREE.Mesh(stumpGeo, stumpMat);
      m.position.set(x, 0, 0);
      this.group.add(m);
      this.pieces.push({ mesh: m, home: m.position.clone(), vel: new THREE.Vector3(), ang: new THREE.Vector3(), kind: 'stump' });
    }
    const bailGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.108, 6);
    bailGeo.rotateZ(Math.PI / 2);
    for (const x of [(STUMP_X[0] + STUMP_X[1]) / 2, (STUMP_X[1] + STUMP_X[2]) / 2]) {
      const m = new THREE.Mesh(bailGeo, mat);
      m.position.set(x, h + 0.006, 0);
      this.group.add(m);
      this.pieces.push({ mesh: m, home: m.position.clone(), vel: new THREE.Vector3(), ang: new THREE.Vector3(), kind: 'bail' });
    }
    this.broken = false;
  }

  break(ballVel, stumpIndex = 1) {
    if (this.broken) return;
    this.broken = true;
    const sp = Math.min(40, Math.hypot(ballVel.x, ballVel.y, ballVel.z));
    const dirZ = Math.sign(ballVel.z) || 1;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (p.kind === 'bail') {
        p.vel.set((Math.random() - 0.5) * 3, 3 + Math.random() * 3 + sp * 0.08, dirZ * (2 + sp * 0.15));
        p.ang.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
        p.flying = true;
      } else {
        const hit = Math.abs(i - stumpIndex) === 0 ? 1 : 0.35;
        p.tilt = { axis: new THREE.Vector3(1, 0, 0), rate: dirZ * (2 + sp * 0.25) * hit, angle: 0, max: hit > 0.5 ? 1.2 : 0.3 };
        if (hit > 0.5 && sp > 25) {
          p.vel.set((Math.random() - 0.5) * 2, 1.5, dirZ * sp * 0.12);
          p.ang.set(dirZ * 12, 0, (Math.random() - 0.5) * 6);
          p.flying = true;
        }
      }
    }
  }

  update(dt) {
    if (!this.broken) return;
    for (const p of this.pieces) {
      const m = p.mesh;
      if (p.flying) {
        p.vel.y -= 9.81 * dt;
        m.position.addScaledVector(p.vel, dt);
        m.rotation.x += p.ang.x * dt; m.rotation.y += p.ang.y * dt; m.rotation.z += p.ang.z * dt;
        if (m.position.y < 0.01) {
          m.position.y = 0.01;
          p.vel.multiplyScalar(0.3);
          p.vel.y = Math.abs(p.vel.y) * 0.3;
          p.ang.multiplyScalar(0.5);
          if (p.vel.length() < 0.3) p.flying = false;
        }
      } else if (p.tilt && p.tilt.angle < p.tilt.max) {
        p.tilt.angle = Math.min(p.tilt.max, p.tilt.angle + Math.abs(p.tilt.rate) * dt);
        m.rotation.x = Math.sign(p.tilt.rate) * p.tilt.angle;
      }
    }
  }

  reset() {
    this.broken = false;
    for (const p of this.pieces) {
      p.mesh.position.copy(p.home);
      p.mesh.rotation.set(0, 0, 0);
      p.vel.set(0, 0, 0); p.ang.set(0, 0, 0);
      p.flying = false; p.tilt = null;
    }
  }
}

// ---------------------------------------------------------------- Machine
// Low-poly bowling machine positioned so its wheel outlet is at the release
// point, with three cue lights (red → amber → green = release).
export class MachineView {
  constructor(parent) {
    this.group = new THREE.Group();
    parent.add(this.group);
    const m = CONFIG.machine;
    const parts = [];
    const outletY = m.releaseHeight;
    // Tripod legs.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      parts.push(part(new THREE.CylinderGeometry(0.025, 0.03, outletY - 0.1, 5), 0x3d4148,
        [Math.sin(a) * 0.3, (outletY - 0.1) / 2, -0.25 + Math.cos(a) * 0.3], [Math.cos(a) * 0.15, 0, -Math.sin(a) * 0.15]));
    }
    // Body and wheels (outlet faces +Z, toward the batter).
    parts.push(part(new THREE.BoxGeometry(0.45, 0.35, 0.55), 0x1f6fb2, [0, outletY + 0.05, -0.32]));
    parts.push(part(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 14), 0x22252a, [0.09, outletY, -0.12], [0, 0, Math.PI / 2]));
    parts.push(part(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 14), 0x22252a, [-0.09, outletY, -0.12], [0, 0, Math.PI / 2]));
    parts.push(part(new THREE.BoxGeometry(0.12, 0.12, 0.3), 0xe8e8e8, [0, outletY + 0.3, -0.45]));
    this.group.add(new THREE.Mesh(merge(parts), vertexColorMat()));

    // Cue lights on a mast above the machine (visible against the sightscreen).
    this.lights = [];
    const colors = [0xff2a1a, 0xffb000, 0x22ff55];
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.36, 0.04), new THREE.MeshBasicMaterial({ color: 0x0b0d10 }));
    board.position.set(0, outletY + 0.62, -0.34);
    this.group.add(board);
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x222222 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), mat);
      l.position.set(-0.31 + i * 0.31, outletY + 0.62, -0.3);
      l.userData.on = colors[i];
      this.group.add(l);
      this.lights.push(l);
    }
    this.setCue(0);
    this.setRelease('over');
  }
  setRelease(side) {
    const m = CONFIG.machine;
    this.group.position.set((side === 'around' ? -1 : 1) * m.releaseX, 0, m.releaseZ);
  }
  // stage: 0 off, 1 red, 2 amber, 3 green
  setCue(stage) {
    for (let i = 0; i < 3; i++) {
      const l = this.lights[i];
      l.material.color.setHex(stage === i + 1 ? l.userData.on : 0x222222);
    }
  }
  setVisible(v) { this.group.visible = v; }
}

// ---------------------------------------------------------------- Markers
export function buildRingMarker(color = 0xffe14d, radius = 0.22) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 0.75, radius, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.18, 16),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.011;
  g.add(ring, dot);
  g.renderOrder = 2;
  return g;
}

// Small dust-puff mark showing where the last ball pitched.
export class PitchMark {
  constructor(scene) {
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12),
      new THREE.MeshBasicMaterial({ color: 0x6e5532, transparent: true, opacity: 0.0, depthWrite: false }));
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
    this.age = 99;
  }
  show(pos) { this.mesh.position.set(pos.x, 0.009, pos.z); this.age = 0; }
  update(dt) {
    this.age += dt;
    this.mesh.material.opacity = this.age < 6 ? 0.8 * (1 - this.age / 6) : 0;
  }
}
