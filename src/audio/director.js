// Where the game's sounds come from, and when: the one place the game's events become sound.
// game.js hands it the physics events (bat, bounce, wicket, boundary), the commentary's match cues
// (the run-up, the release, the dead ball, a review, the result), the crowd's reactions and the
// named sounds the sessions ask for (game.sample(): 'gloves', 'stumps', 'footstep', 'appeal' ...),
// and every frame it puts the listener in your head and watches what has no event of its own:
// the bowler's and the fielders' feet, your own run-up, the ball rolling, your bat tapping the
// crease, the ball into the pads (the contact log), the machine humming, a review's heartbeat.
// Each sound is placed where it happens (sfx.js voices); the recordings are layered with
// synthesis so nothing repeats exactly.
import { CONFIG } from '../config.js';
import { MIX } from './mix.js';
import { surfaceAt } from '../physics/pitch.js';
import { Vec3, hypot2, hypot3, distGT, distLT } from '../physics/math.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rr = (k = 0.04) => 1 - k + Math.random() * 2 * k;
const UI_SAMPLES = new Set(['umpire_out', 'umpire_not_out', 'chime', 'drs_stinger', 'coin', 'cam_whoosh']);

// A bat contact, by its quality and speed: sweet | mistimed | edge | toe | block | handle.
export function batKind(e) {
  if (e.face === 'handle') return 'handle';
  if (e.isEdge) return 'edge';
  if (e.face === 'toe') return 'toe';
  if ((e.batSpeed ?? 10) < 4 && e.quality < 0.75) return 'block';
  return e.quality > 0.6 ? 'sweet' : 'mistimed';
}

export class AudioDirector {
  constructor(game) {
    this.g = game; this.sfx = game.sfx; this.samples = game.samples; this.crowd = game.crowd;
    this.t = 0;
    this.started = false;
    this.ball = { x: 0, y: 0.5, z: -10 };    // where the ball is (or was last: a take removes it)
    this.prev = { x: 0, y: 0, z: 0, ok: false };
    this.feet = new Map();                   // actor -> its feet's last heights
    this.own = { x: 0, z: 0, ok: false, speed: 0, acc: 0 };
    this.tap = { y: 1, t: -9 };
    this.seen = { list: null, n: 0 };        // the contact log, read so far
    this.lastPad = -9;
    this.review = false; this.reviewT = 0; this.beatIn = 0;
    this.menuWas = false; this.lastSting = -99; this.stingAt = null; this.stingKind = '';
    this.boardsAt = null;
    this.roll = null; this.machine = null;
    this._toe = null;
    this._p = { x: 0, y: 0, z: 0 };
  }

  get on() { return this.sfx.ok && this.g.settings.sound !== false; }

  applySettings(s) { this.sfx.setLevels(s); }

  // ------------------------------------------------------------ places
  feetPos() { const e = this.g.eye.p; return { x: e.x, y: 0.03, z: e.z }; }
  bonePos(actor, name, out = this._p) {
    const b = actor && actor.h && actor.h.bones && actor.h.bones[name];
    if (!b) return null;
    const m = b.matrixWorld.elements;
    out.x = m[12]; out.y = m[13]; out.z = m[14];
    return out;
  }
  keeperPos() {
    const a = this.g.fieldView && this.g.fieldView.actors[0];
    return a && a.visible ? { x: a.pos.x, y: 1.3, z: a.pos.z } : { x: 0, y: 1.3, z: CONFIG.keeper.standBack };
  }
  machinePos(out = this._mp || (this._mp = { x: 0, y: 0, z: 0 })) {
    const m = this.g.machine && this.g.machine.group;
    if (!m) return null;
    const e = m.matrixWorld.elements;
    out.x = e[12]; out.y = e[13] + 0.9; out.z = e[14];
    return out;
  }

  // ------------------------------------------------------------ named sounds (game.sample)
  sample(name, o = {}) {
    const S = this.samples, s = this.sfx, B = this.ball, gain = o.gain ?? 1;
    if (!this.on) return S.play(name, o);             // (false, and the clip starts loading)
    switch (name) {
      case 'whoosh': return this.release();
      case 'gloves': case 'catch': {
        const sp = this.g.world.ball ? hypot3(this.g.world.ball.vel.x, this.g.world.ball.vel.y, this.g.world.ball.vel.z) : 20;
        S.play(name, { gain: gain * 0.5, pos: B, rate: rr(), prio: 2 });
        s.gloves(B, sp);
        return true;
      }
      case 'stumps': S.play('stumps', { gain, pos: B, rate: rr(), prio: 2 }); s.stumps(B, 15, false); return true;
      case 'bails': S.play('bails', { gain, pos: B, rate: rr(0.06), prio: 1 }); s.bails(B); return true;
      case 'pad':
        if (this.t - this.lastPad < 1.5) return true;   // (the contact log has sounded it)
        S.play('pad', { gain, pos: B, rate: rr(), prio: 2 }); s.pad(B, 25); return true;
      case 'footstep': {
        const f = this.feetPos();
        s.footstep(f, surfaceAt(f.x, f.z) === 'pitch' ? 'pitch' : 'turf', 1.1 * gain);
        S.play('footstep', { gain: gain * 0.3, pos: f, rate: rr(0.08), prio: 0 });
        if (gain === 0.9) s.dive(f);                    // (batting.js asks for this one as you dive)
        return true;
      }
      case 'appeal': case 'howzat': return S.play(name, { ...o, pos: this.keeperPos(), prio: 2 });
      case 'applause_polite': case 'applause_warm': return this.crowd.applause(name, gain);
      default:
        if (UI_SAMPLES.has(name)) return S.play(name, { ...o, bus: 'ui', prio: 2 });
        if (name.startsWith('crowd_')) return this.crowd._layer(name, gain, o.when || 0, 'round', null, 1);
        if (name.startsWith('bat_')) return S.play(name, { ...o, bus: 'ui', prio: 2 });   // (the review's snicko spike)
        return S.play(name, o);
    }
  }

  // The release: the machine fires; the bowler's arm comes over (and now and then his grunt);
  // or your own arm past your ear.
  release() {
    const g = this.g, ses = g.session, s = this.sfx;
    if (ses && ses.bowler === 'machine') { s.machineThunk(this.machinePos({})); return true; }
    if (ses && ses.isBowling) { s.whoosh(14); return true; }
    const a = g.figures && g.figures.bowler.actor;
    if (a && a.visible) {
      const p = this.bonePos(a, 'head', {}) || { x: 0, y: 2, z: -19 };
      s.whoosh(22, p);
      if (Math.random() < 0.65) s.grunt(p, 0.8 + Math.random() * 0.4);
    }
    return true;
  }

  // ------------------------------------------------------------ physics events
  physics(e) {
    if (!this.on) return;
    const s = this.sfx, S = this.samples;
    switch (e.type) {
      case 'bounce': {
        if (e.speedIn <= 1.5) break;
        const v = this.g.world.ball.vel, pitch = e.surface === 'pitch';
        const skid = pitch && !e.batted ? clamp((hypot2(v.x, v.z) / (Math.abs(v.y) + 0.5) - 4) / 6, 0, 1) : 0;
        s.bounce(e.speedIn, pitch ? 'pitch' : 'turf', e.pos, skid);
        break;
      }
      case 'bat': {
        const kind = batKind(e), speed = e.speedIn + (e.batSpeed || 0);
        const name = kind === 'sweet' ? 'bat_sweet' : kind === 'edge' ? 'bat_edge' : 'bat_block';
        const gain = clamp(0.45 + speed / 70, 0.4, 1) * ({ sweet: 1, edge: 0.6, toe: 0.75, mistimed: 0.7, block: 0.55, handle: 0.6 }[kind]);
        const rate = (kind === 'toe' ? 0.84 : kind === 'mistimed' ? 0.93 : kind === 'handle' ? 0.8 : 1) * rr();
        const ok = S.play(name, { gain, rate, pos: e.pos, prio: 2, lowpass: kind === 'mistimed' || kind === 'toe' || kind === 'handle' ? 2200 : 0 });
        if (ok) s.batLayer(kind, e.quality, speed, e.pos); else s.batCrack(e.quality, speed, e.isEdge, e.pos);
        break;
      }
      case 'wicket': {
        const p = { x: e.pos.x, y: 0.4, z: e.end === 'batting' ? 0 : -20.12 };
        S.play('stumps', { gain: 0.9, pos: p, rate: rr(), prio: 2 });
        s.stumps(p, e.speed || 20);
        S.play('bails', { gain: 0.6, pos: p, rate: rr(0.06), prio: 1 });
        break;
      }
      case 'boundary':
        // Along the ground (or bounced) into the boards a couple of metres past the rope.
        if (!e.onFull) { const v = this.g.world.ball.vel, sp = hypot2(v.x, v.z); this.boardsAt = { t: this.t + clamp(2.5 / Math.max(sp, 3), 0.05, 0.6), pos: { x: e.pos.x, y: 0.3, z: e.pos.z }, speed: sp }; }
        break;
      default:
    }
  }

  // ------------------------------------------------------------ cues and reactions
  cue(kind, ctx = {}) {
    this.crowd.cue(kind, ctx);
    switch (kind) {
      case 'result': this.stingAt = this.t + 3.5; this.stingKind = ctx.winner === 0 ? 'win' : 'lose'; break;
      case 'innings_break': this.stingAt = this.t + 2.5; this.stingKind = 'innings'; break;
      case 'catch_chance': this.fielderCall(); break;
      case 'ball':
        if (this.on && !ctx.wicket && !ctx.boundary && !ctx.wide && ctx.runs >= 1) this.crowd.react('single', 0.6 + 0.15 * ctx.runs);
        break;
      default:
    }
  }

  react(kind, strength, ballPos) { this.crowd.react(kind, strength, ballPos); }

  cheer(intensity) { const m = this.crowd.mood; m.swell = Math.max(m.swell, clamp(intensity, 0, 1.2)); }

  // The fielder under a catch calling for it ("mine!": a voice gliding a to i).
  fielderCall() {
    if (!this.on || !this.g.fieldView) return;
    let best = null, bd = 1e9;
    for (const a of this.g.fieldView.actors) {
      if (!a.visible) continue;
      const d = hypot2(a.pos.x - this.ball.x, a.pos.z - this.ball.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) return;
    this.sfx.voice({ pos: { x: best.pos.x, y: 1.6, z: best.pos.z }, f0: 135 + Math.random() * 40, glide: 0.85, vowels: ['a', 'i'], dur: 0.32, gain: 0.6, breath: 0.25, prio: 1 });
  }

  // ------------------------------------------------------------ every frame
  update(dt) {
    const g = this.g, s = this.sfx;
    this.t += dt;
    if (!s.ctx || !s.bus) return;
    if (!this.started) {
      this.started = true;
      this.samples.preload();
      this.roll = s.hum('roll'); this.machine = s.hum('machine');
      s.setLevels(g.settings);
    }
    const ses = g.session, play = g.state === 'play', replay = !!(g.replay && g.replay.active);
    if (!this.on) return;
    s.listen(g.eye.p, g.eye.q);
    s.setDuck(g.commentary && g.commentary.speaking() ? MIX.duck.crowd : 1);
    const nets = !!ses && (ses.kind === 'nets' || ses.kind === 'bowlnets');
    const cu = this._cu || (this._cu = {});
    cu.active = play && !replay; cu.present = !g.mr; cu.practice = nets; cu.menu = !play || !!(g.ui && g.ui.menuOpen); cu.situation = g.commentary && g.commentary.situation;
    this.crowd.update(dt, cu);
    this.trackBall(dt, replay);
    if (play && !replay) { this.footfalls(dt); this.ownSteps(dt, ses); this.batTaps(dt, ses); this.contacts(); }
    // The machine hums while it is the bowler.
    const mp = ses && ses.bowler === 'machine' && play ? this.machinePos() : null;
    s.anchor.machine = mp;
    if (this.machine) this.machine.set(mp, mp ? 0.5 : 0);
    if (this.boardsAt && this.t >= this.boardsAt.t) { s.boards(this.boardsAt.pos, this.boardsAt.speed); this.boardsAt = null; }
    // A review (the DRS pictures, the third umpire's board): the ground waits, a heartbeat quickening.
    const rev = !!ses && ses.state === 'review' && ((ses.lbw && ses.lbw.phase === 'review') || (ses.third && ses.third.active && ses.third.phase === 'board'));
    if (rev && !this.review) { this.reviewT = 0; this.beatIn = 0.8; }
    this.review = rev; this.crowd.mood.reviewing = rev;
    if (rev) {
      this.reviewT += dt; this.beatIn -= dt;
      if (this.beatIn <= 0) { const k = clamp(this.reviewT / 10, 0, 1); s.heartbeat(0.7 + 0.4 * k); this.beatIn = 60 / (66 + 30 * k); }
    }
    if (this.stingAt != null && this.t >= this.stingAt) { s.sting(this.stingKind); this.stingAt = null; this.lastSting = this.t; }
    // The title ident as the main menu opens (not every time you go back to it).
    const menu = g.state === 'menu' && g.ui && g.ui.menuOpen && g.ui.page === 'main';
    if (menu && !this.menuWas && this.t - this.lastSting > 45) { s.sting('menu'); this.lastSting = this.t; }
    this.menuWas = menu;
  }

  // The ball: its last place (for the gloves, a catch), and the sound of it rolling.
  trackBall(dt, replay) {
    const b = this.g.world.ball, R = CONFIG.ball.radius, B = this.ball, P = this.prev;
    let level = 0, freq = 0;
    if (b.active) {
      B.x = b.pos.x; B.y = b.pos.y; B.z = b.pos.z;
      if (P.ok && dt > 0 && !replay) {
        const sp = hypot2(B.x - P.x, B.z - P.z) / dt;     // (from what it did, so a pause is silent)
        if (B.y < R + 0.02 && Math.abs(B.y - P.y) < 0.01 && sp > 0.4 && sp < 60) { level = clamp(sp / 18, 0, 1) * 0.3; freq = 300 + sp * 45; }
      }
      P.x = B.x; P.y = B.y; P.z = B.z; P.ok = true;
    } else P.ok = false;
    if (this.roll) this.roll.set(level > 0 ? B : null, level, freq);
  }

  // Footfalls from the figures' ankles: a foot that was coming down and has stopped is on the
  // ground. The bowler (his last stride before the release lands hard), the fielders, the
  // batters running: the near ones.
  // (Every frame, for every figure: no lists, iterators or boxed numbers made here.)
  footfalls(dt) {
    const g = this.g, e = g.eye.p, bow = g.figures && g.figures.bowler.actor, fa = g.fieldView ? g.fieldView.actors : null;
    const n = 3 + (fa ? fa.length : 0);
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? bow : i === 1 ? g.batterView && g.batterView.actor : i === 2 ? g.nonStrikerView && g.nonStrikerView.actor : fa[i - 3];
      if (!a || !a.visible || !a.h) continue;
      const ex = a.pos.x - e.x, ez = a.pos.z - e.z;
      if (distGT(ex, ez, a === bow ? 45 : 28)) continue;
      let st = this.feet.get(a);
      if (!st) { st = { L: { y: 1, vy: 0, t: -9 }, R: { y: 1, vy: 0, t: -9 }, x: a.pos.x, z: a.pos.z, speed: 0 }; this.feet.set(a, st); }
      st.speed = dt > 0 ? hypot2(a.pos.x - st.x, a.pos.z - st.z) / dt : 0; st.x = a.pos.x; st.z = a.pos.z;
      for (let k = 0; k < 2; k++) {
        const p = this.bonePos(a, k === 0 ? 'ankleL' : 'ankleR');
        if (!p) continue;
        const f = k === 0 ? st.L : st.R, vy = dt > 0 ? (p.y - f.y) / dt : 0;
        // (a walk is heard only close by; running, from further off)
        if (f.vy < -0.25 && vy > -0.05 && p.y < 0.25 && this.t - f.t > 0.18 && (st.speed > 2.2 || (st.speed > 0.5 && distLT(ex, ez, 9)))) {
          f.t = this.t;
          let w = clamp(0.3 + st.speed / 6, 0.3, 1.2) * (a === bow ? 1.4 : 0.6);
          const run = a === bow && a.run;
          if (run && Math.abs(g.simTime - run.tr) < 0.3) w = 2;        // the front foot at the crease
          this.sfx.footstep({ x: p.x, y: 0.03, z: p.z }, surfaceAt(p.x, p.z) === 'pitch' ? 'pitch' : 'turf', w);
        }
        f.y = p.y; f.vy = vy;
      }
    }
  }

  // Your own run-up when you bowl (you run for real, or the stick carries you): steps at a
  // cadence that quickens with your speed.
  ownSteps(dt, ses) {
    const o = this.own, e = this.g.eye.p;
    if (!ses || !ses.isBowling || dt <= 0) { o.ok = false; return; }
    if (o.ok) {
      const sp = hypot2(e.x - o.x, e.z - o.z) / dt;
      o.speed += (sp - o.speed) * Math.min(1, dt * 8);
    }
    o.x = e.x; o.z = e.z; o.ok = true;
    if (o.speed < 1.3 || o.speed > 12 || e.y < 0.9) { o.acc = 0.2; return; }
    o.acc += dt;
    if (o.acc >= clamp(0.62 - 0.045 * o.speed, 0.27, 0.5)) {
      o.acc = 0;
      const f = this.feetPos();
      this.sfx.footstep(f, surfaceAt(f.x, f.z) === 'pitch' ? 'pitch' : 'turf', 0.6 + o.speed / 10);
    }
  }

  // Your bat tapped on the crease (its toe coming down onto the ground).
  batTaps(dt, ses) {
    if (!ses || ses.isBowling || !this.g.batToe || dt <= 0) return;
    if (!this._toe) this._toe = new Vec3();
    let p;
    try { p = this.g.batToe(this._toe); } catch { return; }
    const T = this.tap, vy = (p.y - T.y) / dt;
    if (T.y >= 0.035 && p.y < 0.035 && vy < -0.25 && this.t - T.t > 0.2) { T.t = this.t; this.sfx.batTap({ x: p.x, y: 0.02, z: p.z }, -vy); }
    T.y = p.y;
  }

  // The ball into the pads, the body or the helmet: from the contact log (edgeTrack.js).
  contacts() {
    const log = this.g.contacts, ev = log && log.events;
    if (!ev) return;
    const S = this.seen;
    if (ev !== S.list || S.n > ev.length) { S.list = ev; S.n = 0; }
    for (let i = S.n; i < ev.length; i++) {
      const c = ev[i];
      if (c.type !== 'pad' && c.type !== 'body') continue;
      const part = c.type === 'body' && c.pos.y > 1.45 ? 'helmet' : c.type;
      this.sfx.pad(c.pos, c.speed, part);
      if (part === 'pad') this.samples.play('pad', { gain: 0.6, pos: c.pos, rate: rr(), prio: 2 });
      this.lastPad = this.t;
    }
    S.n = ev.length;
  }
}
