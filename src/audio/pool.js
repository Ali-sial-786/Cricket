// Voices for a modest node graph on the Quest: a fixed set of panner chains handed out in turn
// (VoicePool), and a cap on one-shot sources sounding at once (VoiceBudget). Plain logic: the
// Web Audio nodes are whatever `make` builds, so both can be tested without a browser.

export class VoicePool {
  constructor(size, make = null) {
    this.slots = [];
    for (let i = 0; i < size; i++) this.slots.push({ i, node: make ? make(i) : null, until: -Infinity, prio: 0, x: 0, y: 0, z: 0 });   // (a panner starts at the origin)
  }

  /**
   * A slot for a sound of `dur` s starting at `now` at `pos`: of the free ones, the one last used
   * nearest there (an HRTF panner glides ~50 ms to a new direction: a bat crack must not start on
   * its way over from the pitch); none free, the one ending soonest whose sound matters no more
   * than this one (better than silence for a loud event, and its sound is nearly over). null when
   * every slot is busy with something more important.
   */
  acquire(now, dur, prio = 1, pos = null) {
    let best = null, bd = Infinity, steal = null;
    for (const s of this.slots) {
      if (s.until <= now) {
        const d = pos ? (s.x - pos.x) ** 2 + (s.y - pos.y) ** 2 + (s.z - pos.z) ** 2 : 0;
        if (d < bd) { bd = d; best = s; if (!pos) break; }
      } else if (s.prio <= prio && (!steal || s.until < steal.until)) steal = s;
    }
    best = best || steal;
    if (!best) return null;
    best.until = now + dur; best.prio = prio;
    if (pos) { best.x = pos.x; best.y = pos.y; best.z = pos.z; }
    return best;
  }

  busy(now) { let n = 0; for (const s of this.slots) if (s.until > now) n++; return n; }
}

// Priorities: 0 ambience (a distant clap), 1 normal, 2 the game's own events (bat, stumps,
// the big roar): those always sound, up to `hard`.
export class VoiceBudget {
  constructor(max = 24, hard = max + 8) {
    this.max = max; this.hard = hard;
    this.ends = new Float64Array(hard); this.n = 0;
  }

  _prune(now) {
    let j = 0;
    for (let i = 0; i < this.n; i++) if (this.ends[i] > now) this.ends[j++] = this.ends[i];
    this.n = j;
  }

  count(now) { this._prune(now); return this.n; }

  /** May a sound of `dur` s start now? (and it is counted if so) */
  admit(now, dur, prio = 1) {
    this._prune(now);
    const room = prio >= 2 ? this.hard : prio <= 0 ? this.max - 4 : this.max;
    if (this.n >= room) return false;
    this.ends[this.n++] = now + dur;
    return true;
  }
}
