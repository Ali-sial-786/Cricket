// Mixed-reality nets: place the batting stumps on your real floor with a
// hit-test reticle (falls back to the local-floor plane y = 0), the pitch runs
// the way you are facing and extends into passthrough.
import * as THREE from 'three';
import { Vec3 } from '../physics/math.js';
import { computeRig, headForward } from '../game/calibration.js';
import { buildRingMarker } from '../render/objects.js';

export class MRPlacer {
  constructor(game) {
    this.game = game;
    this.reticle = new THREE.Group();
    const ring = buildRingMarker(0x5cf2a6, 0.18);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.25, 12), new THREE.MeshBasicMaterial({ color: 0x5cf2a6 }));
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.02, -0.45);
    this.reticle.add(ring, arrow);
    this.reticle.visible = false;
    game.scene.add(this.reticle);
    this.hitSource = null;
    this.hitSourceFor = null;
    this.placedRig = null;
    this.point = null;
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3();
    this.restart();
  }

  restart() {
    const g = this.game;
    g.state = 'mrplace';
    g.setRig({ x: 0, z: 0, yaw: 0 });      // world == reference space while placing
    g.env.pitchGroup.visible = false;
    this.reticle.visible = false;
    g.ui.setHudPose('mr');
    const h = g.input.headPose, f = headForward(h.q);
    g.ui.hud.mesh.position.set(h.p.x + f.x * 1.6, Math.max(1.2, h.p.y - 0.1), h.p.z + f.z * 1.6);
    g.ui.hud.mesh.lookAt(h.p.x, Math.max(1.2, h.p.y - 0.1), h.p.z);
    g.ui.hud.mesh.scale.setScalar(1);
    g.ui.setHud({ title: 'Mixed reality nets', score: '', sub: 'Point the LEFT controller at your floor', big: 'Place stumps', bigColor: '#5cf2a6', last: 'Pull the trigger where the stumps should go.', detail: 'The pitch will run the way you are facing.', footer: 'Make sure 2 m around you is clear.' });
  }

  requestHitSource(session, inputSource) {
    if (!session.requestHitTestSource || this.hitSourceFor === inputSource) return;
    this.hitSourceFor = inputSource;
    session.requestHitTestSource({ space: inputSource.targetRaySpace })
      .then((src) => { this.hitSource = src; })
      .catch(() => { this.hitSource = null; });
  }

  update(frame) {
    const g = this.game;
    const L = g.input.left.connected ? g.input.left : g.input.right;
    const session = g.renderer.xr.getSession();
    if (session && L.source) this.requestHitSource(session, L.source);

    let p = null;
    if (frame && this.hitSource) {
      try {
        const res = frame.getHitTestResults(this.hitSource);
        if (res.length) {
          const pose = res[0].getPose(g.renderer.xr.getReferenceSpace());
          if (pose) {
            const t = pose.transform.position;
            if (Math.abs(t.y) < 0.4) p = new Vec3(t.x, t.y, t.z); // floor-ish only
          }
        }
      } catch { /* hit test not available this frame */ }
    }
    if (!p && g.input.pointerRay(this._o, this._d) && this._d.y < -0.05) {
      const s = -this._o.y / this._d.y;            // intersect y = 0
      if (s > 0 && s < 15) p = new Vec3(this._o.x + this._d.x * s, 0, this._o.z + this._d.z * s);
    }
    if (p) {
      this.point = p;
      const f = headForward(g.input.headRef.q);
      this.reticle.position.set(p.x, p.y + 0.005, p.z);
      this.reticle.rotation.set(0, Math.atan2(-f.x, -f.z), 0);
      this.reticle.visible = true;
    } else this.reticle.visible = false;

    if (this.point && (g.input.left.buttons.trigger.down || g.input.right.buttons.trigger.down)) this.place();
  }

  place() {
    const g = this.game;
    const f = headForward(g.input.headRef.q);
    // Stumps at the chosen point, bowler in the direction you face.
    this.placedRig = computeRig(this.point, f, 0, 0, -1);
    g.setRig(this.placedRig);
    g.env.pitchGroup.visible = true;
    this.reticle.visible = false;
    g.state = 'menu';
    g.ui.setHudPose('mr');
    g.ui.setHud({ title: 'Mixed reality nets', big: 'Stumps placed', bigColor: '#5cf2a6', sub: 'Stand at the crease in front of them', last: 'Nets: Batting or Bowling from the menu.', detail: '' });
    g.ui.openMenu('main');
    g.input.left.pulse(0.5, 40);
  }

  // Batting end uses the placed anchor; bowling re-anchors at your feet.
  rigFor(end) {
    if (end === 'bowling') return null;
    return this.placedRig;
  }

  dispose() {
    try { if (this.hitSource) this.hitSource.cancel(); } catch { /* ignore */ }
    this.hitSource = null;
    this.game.scene.remove(this.reticle);
    this.game.env.pitchGroup.visible = true;
  }
}

