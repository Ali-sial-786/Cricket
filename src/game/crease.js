// Are you in your ground? (Law 30: some part of your person or bat grounded
// behind the popping crease.) Pure JS, unit tested in node.
//
// In the headset nothing tracks your feet, so the decision is made on what is
// real: your head (the headset), how far the game has carried you (the rig
// offset: the stick in the crease, the trigger down the pitch) and the bat.
// It is never made on the figure's animated feet: those play a captured shot
// (src/render/playerShot.js) whose front-foot stride and back-foot pivot onto
// the toe are not yours.
//
// Your back foot is planted where you took guard and stays there while you
// lean, reach and pivot: it only moves when your head makes it, by going
// further down the pitch than a lunge can reach (you stepped or charged), or
// back over it (you went back). Charging with the trigger moves the rig, and
// your feet with it.
import { clamp } from '../physics/math.js';
import { battingPoppingZ } from '../physics/pitch.js';

export const CREASE = {
  footBack: 0.26,     // m: your back foot behind your head in the stance (actors.js FOOT_BACK)
  reach: 0.9,         // m: furthest your head goes ahead of a planted back foot (a full lunge)
  footHalf: 0.06,     // m: half the width of a boot (you stand side-on to the crease)
  batY: 0.25,         // m: the toe of the bat lower than this counts as grounded
  legsSlack: 0.05,    // m: desktop, the legs point stands in for the feet
};

// Your back foot along the pitch, in the room (rig) frame.
export class BackFoot {
  constructor() { this.z = null; }
  reset() { this.z = null; }
  // headZ: your head along the pitch in the room (world z less the rig offset).
  update(headZ) {
    const lo = headZ + CREASE.footBack, hi = headZ + CREASE.reach;
    this.z = this.z == null ? lo : clamp(this.z, lo, hi);
    return this.z;
  }
}

// m short of your ground at the batting end (<= 0: in), and what counted.
//   xr:     in the headset
//   headZ:  headset, world z            rigZ: the rig offset along the pitch
//   foot:   a BackFoot (updated here with the head)
//   legsZ:  no headset: where the batter's legs are (BattingSession.body())
//   bat:    the toe of the real bat {y, z} (world), or null (no tracked bat)
export function creaseShort({ xr, headZ = 0, rigZ = 0, foot = null, legsZ = 0, bat = null }) {
  let body, by = 'foot', footZ = null;
  if (xr) {
    const f = foot || new BackFoot();
    footZ = f.update(headZ - rigZ) + rigZ;
    body = battingPoppingZ - (footZ + CREASE.footHalf);
  } else body = battingPoppingZ - CREASE.legsSlack - legsZ;
  let margin = body;
  if (xr && bat && bat.y < CREASE.batY) {
    const m = battingPoppingZ - bat.z;
    if (m < margin) { margin = m; by = 'bat'; }
  }
  return { margin, by, footZ };
}
