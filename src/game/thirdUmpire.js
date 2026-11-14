// Close run-outs and stumpings go upstairs: the square-leg umpire draws the
// TV screen, the third-umpire board shows the crease, then OUT / NOT OUT.
import * as THREE from 'three';

const _head = new THREE.Vector3();

export class ThirdUmpireFlow {
  constructor(game) { this.g = game; this.active = false; this.done = true; this.out = false; }

  // kind: 'run_out' | 'stumping'; end: 'batting' | 'bowling'; margin (m): > 0
  // short of the crease (out), < 0 home: the margin the decision was made on.
  // out: the decision itself, if the caller has it (it wins over the margin's
  // sign, so the board can never disagree with the result); by: what was
  // grounded, 'foot' | 'bat' (shown on the board), if known.
  start({ kind, end, margin, out = null, by = null }) {
    const g = this.g;
    this.kind = kind; this.out = out == null ? margin > -1e-6 : !!out;
    this.active = true; this.done = false; this.t = 0; this.phase = 'board';
    const hp = g.input.headPose.p;
    _head.set(hp.x, hp.y, hp.z);
    g.drs.startThird({ kind, end, margin, out: this.out, by, viewerPos: _head });
    // Seen from the far end the board is made big and hung over the pitch.
    const farEnd = end === 'batting' ? hp.z < -9 : hp.z > -9;
    if (farEnd) g.drs.placeBoard(_head, { distance: 9, scale: 2.2, height: 3.4 });
    g.ui.hud.mesh.visible = false;
    g.umpires.signal('review', g.clock);
    g.sample('drs_stinger', { gain: 0.8 });
    g.say('third_umpire');
    g.ui.prompt('THIRD UMPIRE…', 2.2, '#7fd3ff');
  }

  finish() {
    this.done = true; this.active = false;
    this.g.drs.hide();
    this.g.ui.hud.mesh.visible = true;
  }

  // dt = real seconds.
  update(dt) {
    const g = this.g;
    if (!this.active) return;
    this.t += dt;
    if (this.phase === 'board') {
      g.drs.update(dt);
      for (const cue of g.drs.takeCues()) {
        if (cue.startsWith('chime')) g.sample('chime', { gain: 0.8 });
        else if (cue === 'out') g.sample('umpire_out');
        else if (cue === 'not_out') g.sample('umpire_not_out');
      }
      if (g.drs.done) {
        g.umpires.signal(this.out ? 'out' : 'notout', g.clock);
        g.say('third_result', { what: this.kind === 'stumping' ? 'stumping' : 'run_out', out: this.out });
        g.ui.prompt(this.out ? 'OUT!' : 'NOT OUT', 2.2, this.out ? '#ff5a5a' : '#7dff8a');
        this.phase = 'final'; this.t = 0;
      }
    } else if (this.t > 1.2) this.finish();
  }
}
