// Animated people: AI batter (with bat + arms tied to the handle), AI bowler
// (run-up + delivery stride + arm whirl), non-striker, fielders.
import * as THREE from 'three';
import { Vec3, Pose, clamp, smoothstep } from '../physics/math.js';
import { buildFigure, reachArm, animateRun } from './figures.js';
import { buildBatMesh } from './objects.js';
import { toV3, toQ } from './util.js';

// AI batter: figure + its own bat mesh posed from the AIBatter provider.
export class BatterView {
  constructor(scene, ai) {
    this.ai = ai;
    this.fig = buildFigure({ shirt: 0x1c3f8f, trousers: 0xf0f0f0, head: 'helmet', pads: true, gloves: true });
    this.fig.userData.body.material.color = new THREE.Color(1, 1, 1);
    this.bat = buildBatMesh();
    scene.add(this.fig, this.bat);
    this.pose = new Pose();
    this._top = new THREE.Vector3();
    this._bot = new THREE.Vector3();
    this.show(false);
  }
  show(v) { this.fig.visible = v; this.bat.visible = v; }
  update(t) {
    if (!this.fig.visible) return;
    this.ai.poseAt(t, this.pose);
    toV3(this.bat.position, this.pose.p);
    toQ(this.bat.quaternion, this.pose.q);
    const b = this.ai.bodyAt(t);
    this.fig.position.set(b.x, 0, b.z);
    this.fig.rotation.set(0, Math.PI / 2, 0);
    this.fig.userData.body.rotation.x = b.lean;
    // Bottom hand at the grip point, top hand ~10 cm up the handle.
    toV3(this._bot, this.pose.p);
    const up = new Vec3(0, 0.1, 0).applyQuat(this.pose.q);
    this._top.set(this.pose.p.x + up.x, this.pose.p.y + up.y, this.pose.p.z + up.z);
    reachArm(this.fig, this.fig.userData.armR, this._bot);
    reachArm(this.fig, this.fig.userData.armL, this._top);
  }
}

// AI bowler: runs in from behind the bowler's stumps, bowls from the release
// point. update() returns true at the release instant during a run-up.
export class BowlerView {
  constructor(scene) {
    this.fig = buildFigure({ shirt: 0xb3261e, trousers: 0xb3261e, head: 'cap', capColor: 0x7a1712 });
    scene.add(this.fig);
    this.runup = null;
    this.home = new THREE.Vector3(0.9, 0, -30.5);
    this.fig.position.copy(this.home);
    this.show(false);
  }
  show(v) { this.fig.visible = v; }
  startRunup(t, releasePos) {
    const dur = 2.3;
    this.runup = { t0: t, tRel: t + dur, rel: releasePos.clone ? releasePos.clone() : new Vec3(releasePos.x, releasePos.y, releasePos.z) };
    this.fig.position.copy(this.home);
  }
  // Returns true on the frame the ball should be released.
  update(dt, t) {
    const f = this.fig, u = f.userData;
    if (!this.runup) { animateRun(f, dt, 0); return false; }
    const r = this.runup;
    const relX = r.rel.x + 0.28;     // body is to the left of the bowling hand
    const endZ = r.rel.z - 0.25;
    if (t < r.tRel) {
      const k = (t - r.t0) / (r.tRel - r.t0);
      const e = smoothstep(0, 1, k) * 0.6 + k * 0.4;
      const z = this.home.z + (endZ - this.home.z) * e;
      const x = this.home.x + (relX - this.home.x) * e;
      const speed = 7.5 * (1 - Math.abs(0.75 - k) * 0.6);
      f.position.set(x, 0, z);
      f.rotation.set(0, 0, 0);
      if (k < 0.82) animateRun(f, dt, speed);
      else {
        // Delivery stride: bowling arm whirls over.
        const a = (k - 0.82) / 0.18;
        u.armR.rotation.set(Math.PI * (0.3 + 1.2 * a), 0, 0);
        u.armL.rotation.set(-Math.PI * 0.9 * (1 - a), 0, 0);
        u.body.rotation.x = 0.15 * a;
      }
      return false;
    }
    if (t - r.tRel < dt + 1e-6) {
      u.armR.rotation.set(Math.PI * 1.55, 0, 0);
      return true;
    }
    // Follow-through then walk back.
    const k = clamp((t - r.tRel) / 0.6, 0, 1);
    u.armR.rotation.set(Math.PI * (1.55 + 0.35 * k), 0, 0);
    f.position.z = endZ + 1.4 * smoothstep(0, 1, k);
    if (t - r.tRel > 1.5) { this.runup = null; f.position.copy(this.home); u.armR.rotation.set(0, 0, 0); u.body.rotation.x = 0; }
    return false;
  }
}

// Fielders (+ keeper) — positions driven by the fielding logic.
export class FieldView {
  constructor(scene, n) {
    this.figs = [];
    for (let i = 0; i < n; i++) {
      const keeper = i === 0;
      const f = buildFigure({ shirt: 0xb3261e, trousers: 0xb3261e, head: keeper ? 'helmet' : 'hat', pads: keeper, gloves: keeper });
      scene.add(f);
      this.figs.push(f);
    }
    this.show(false);
  }
  show(v) { this.visible = v; for (const f of this.figs) f.visible = v; }
  // states: [{x, z, face (yaw), speed, crouch, armsUp}]
  update(dt, states) {
    for (let i = 0; i < this.figs.length && i < states.length; i++) {
      const f = this.figs[i], s = states[i];
      f.visible = this.visible && !s.hidden;
      f.position.set(s.x, 0, s.z);
      f.rotation.set(0, s.face, 0);
      animateRun(f, dt, s.speed);
      if (s.armsUp) {
        f.userData.armL.rotation.set(-2.6, 0, 0.2);
        f.userData.armR.rotation.set(-2.6, 0, -0.2);
      } else if (s.speed < 0.3 && s.crouch) {
        f.userData.armL.rotation.set(-0.7, 0, 0.3);
        f.userData.armR.rotation.set(-0.7, 0, -0.3);
        f.userData.body.position.y = -0.18;
      }
    }
  }
}

// Non-striker: stands at the bowler's end, backs up.
export function buildNonStriker(scene) {
  const f = buildFigure({ shirt: 0x1c3f8f, trousers: 0xf0f0f0, head: 'helmet', pads: true, gloves: true });
  const bat = buildBatMesh();
  bat.position.set(0.25, 1.0, 0.1);
  bat.rotation.set(0.3, 0, 0);
  f.add(bat);
  scene.add(f);
  f.visible = false;
  return f;
}
