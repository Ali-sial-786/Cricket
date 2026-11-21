// Long frames, for matching what the next headset recording shows (a smeared
// or dark edge where the compositor had no new frame) to a cause. Pure JS.
//
// Every frame whose own work (game logic + draw call submission) took more
// than `limit` ms, or that came more than `limit` ms after the one before (a
// frame the headset missed, whatever the reason: GC, the GPU, the browser),
// or in which something was used for the first time (a shader program, a
// texture or a geometry buffer new since the frame before), is written into
// a ring buffer of the last `cap` such frames with what was going on (see
// Game.frameContext): the game and session state, the replay's time and phase.
// The game exposes it as window.__longFrames (oldest first).
export class FrameLog {
  constructor({ cap = 64, limit = 25 } = {}) {
    this.cap = cap; this.limit = limit;
    this.entries = [];
    this.count = 0;              // long frames seen so far (not only those still in the ring)
    this.lastAt = null;          // timestamp of the frame before (ms)
    this.prev = { programs: 0, textures: 0, geometries: 0 };   // resource counts after the frame before
    this.hasPrev = false;
  }

  // now: this frame's timestamp (ms, the animation loop's / XR frame's time);
  // work: ms spent in it; info: { programs, textures, geometries } counts after
  // it; ctx: () => what was going on (only called for a frame that is logged).
  // Returns the entry written, or null.
  sample(now, work, info, ctx = null) {
    const gap = this.lastAt == null ? 0 : now - this.lastAt;
    this.lastAt = now;
    // (no garbage on an ordinary frame: the counts go into one reused object)
    const p = this.prev, had = this.hasPrev;
    const dp = info.programs - p.programs, dt = info.textures - p.textures, dg = info.geometries - p.geometries;
    p.programs = info.programs; p.textures = info.textures; p.geometries = info.geometries; this.hasPrev = true;
    const first = had && (dp > 0 || dt > 0 || dg > 0);
    const fresh = first ? { programs: dp, textures: dt, geometries: dg } : null;
    const long = work > this.limit || gap > this.limit;
    if (!long && !first) return null;
    if (long) this.count++;
    const e = { at: +now.toFixed(1), work: +work.toFixed(1), gap: +gap.toFixed(1), long, fresh, ...(ctx ? ctx() : {}) };
    this.entries.push(e);
    if (this.entries.length > this.cap) this.entries.shift();
    return e;
  }

  clear() { this.entries.length = 0; this.count = 0; }
}
