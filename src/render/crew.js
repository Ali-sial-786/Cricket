// The batters between balls. Nobody is put anywhere: when the ball is dead the
// figures WALK to where they belong for the next one, and the next ball waits
// for them (FieldController.settled()):
//   - after an odd number of runs the two batters have changed ends: whoever is
//     at the far end is the non-striker now and walks to his mark there, whoever
//     is at the striker's end takes guard (the AI) or, when you bat, walks the
//     last steps to where you stand and fades into you (you see out of his eyes);
//   - a batter who is out walks off to the pavilion gate and fades there; the new
//     one comes out from the gate at a run to the end that is empty;
//   - a figure only ever appears or disappears faded (Humanoid.setFade), at the
//     gate or at your own head, never in one frame.
// Each figure being moved carries `actor.task` (see walkTask / stepWalk); the
// views in people.js pose a figure with a task by walking it, and take it back
// (stance, leaning on the bat) when the task is done.
import * as THREE from 'three';
import { BatterActor } from './actors.js';
import { steerAmong, STUMP_CLEAR } from '../game/fielding.js';
import { PITCH } from '../physics/pitch.js';
import { CONFIG } from '../config.js';
import { sstep, clamp } from './anim.js';

const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU; return d; };

// The pavilion gate in the boundary boards (off side, square of the pitch).
export const GATE = { x: CONFIG.field.boundaryRadius - 1.5, z: PITCH.centerZ + 2.5 };
export const STRIKER_SPOT = { x: -0.33, z: -1.19 };      // the middle of the AI striker's stance (actors.js STANCE)
// Your runner (and anyone walking into you) is drawn solid beyond FADE_FAR of
// your head and not at all within FADE_NEAR; in between he fades.
export const FADE_NEAR = 1.15, FADE_FAR = 2.0;
export const fadeNearHead = (d) => sstep(FADE_NEAR, FADE_FAR, d);

const WALK = 1.7, JOG = 3.6, RUN = 5.0, SPRINT = 6.4;
const _st = { x: 0, z: 0 };

// A walking task for a figure: go to `to` {x, z} (a live object: it may move),
// then turn to `face` (rad, or null: stay as he is). opts:
//   speed     m/s cruising (WALK by default); arriveBy: s from now by which he
//             should be there (he speeds up to make it, up to a sprint)
//   kind      'walk' | 'in' (comes out of the gate: fades in) | 'off' (leaves:
//             fades out at the gate) | 'merge' (walks into you and fades)
//   tol       m: how close counts as there
export function walkTask(to, face = null, opts = {}) {
  return { to, face, kind: opts.kind || 'walk', speed: opts.speed || WALK, left: opts.arriveBy ?? null, tol: opts.tol ?? 0.1, age: 0, done: false, onDone: opts.onDone || null };
}

// Advance a figure along its task: position, heading and speed only (no pose).
// He moves the way he faces and turns at a walker's pace, so the path curves
// and he never slides sideways or backwards; round whatever is in `obs`
// (circles {x, z, r}). Returns true when the task is finished.
export function stepWalk(a, dt, obs = null) {
  const k = a.task;
  if (!k || k.done) return true;
  k.age += dt;
  if (k.left != null) k.left = Math.max(0, k.left - dt);
  const dx = k.to.x - a.pos.x, dz = k.to.z - a.pos.z, d = Math.hypot(dx, dz);
  if (d <= k.tol || k.there) {
    // there: stop, then turn to face the right way
    k.there = true;
    a.speed = Math.max(0, a.speed - 6 * dt);
    if (d > 1e-4 && d < 0.6) { const s = Math.min(1, 3 * dt); a.pos.x += dx * s; a.pos.z += dz * s; }     // (ease onto the spot)
    let turned = true;
    if (k.face != null) {
      const e = angDiff(a.heading, k.face);
      a.heading += clamp(e, -3.6 * dt, 3.6 * dt);
      turned = Math.abs(e) < 0.06;
    }
    if (turned && a.speed < 0.05 && d < Math.max(k.tol, 0.15)) { k.done = true; a.speed = 0; if (k.onDone) k.onDone(a); return true; }
    if (d > 0.9) k.there = false;                        // (the spot moved away: walk again)
    return false;
  }
  let cruise = k.speed;
  if (k.left != null) cruise = clamp(d / Math.max(0.35, k.left - 0.5), k.speed, SPRINT);
  const u = obs ? steerAmong(a.pos.x, a.pos.z, k.to.x, k.to.z, obs, _st) : { x: dx / d, z: dz / d };
  const want = Math.atan2(u.x, u.z);
  const err = Math.abs(angDiff(a.heading, want));
  // (close in, the turn tightens so he does not circle the spot)
  a.turnToward(want, dt, d < 1.2 ? 7 : a.speed > 3 ? 3.4 : 4.4);
  let v = Math.min(cruise, Math.sqrt(2 * 3.5 * Math.max(0, d - k.tol)) + 0.3);
  v *= clamp(1.2 - err / 1.3, 0.15, 1);                   // turning first, then walking
  a.speed += clamp(v - a.speed, -7 * dt, (cruise > 3 ? 4.5 : 3) * dt);
  const step = Math.min(d, a.speed * dt);
  a.pos.x += Math.sin(a.heading) * step;
  a.pos.z += Math.cos(a.heading) * step;
  if (obs) for (const o of obs) {                          // (never inside one, whatever the turn allowed)
    if (!o) continue;
    const ox = a.pos.x - o.x, oz = a.pos.z - o.z, od = Math.hypot(ox, oz);
    if (od < o.r && od > 1e-4 && Math.hypot(k.to.x - o.x, k.to.z - o.z) >= o.r) { a.pos.x = o.x + ox / od * o.r; a.pos.z = o.z + oz / od * o.r; }
  }
  return false;
}

const _look = new THREE.Vector3();

export class BatterCrew {
  constructor(game, scene) {
    this.g = game;
    // Two more batters than are at the crease: one on his way off, one on his way in.
    this.spares = [new BatterActor(scene, { team: 'home', seed: 31 }), new BatterActor(scene, { team: 'home', seed: 47 })];
    for (const a of this.spares) { a.visible = false; a.h.replayVisible = false; }
    // All four figures, for good: the two views hand theirs round as batters
    // come and go, so "whoever the views hold now + the spares" would lose one.
    this.all = [game.batterView.actor, game.nonStrikerView.actor, ...this.spares];
    this.leaving = [];           // batters walking off (nobody else poses them)
    this.pending = null;         // the ball is dead; sorted out once the runners have stopped
    this.team = 'home';
    this.obs = [];
  }
  get pool() { return this.all; }
  setTeam(team) { this.team = team; for (const a of this.pool) a.h.setTeam(team); }

  // A session starts or ends: nobody is walking anywhere.
  reset() {
    const g = this.g;
    this.pending = null;
    for (const a of this.leaving) { a.task = null; a.visible = false; a.h.setFade(1); }
    this.leaving.length = 0;
    for (const a of this.pool) { a.task = null; a.h.setFade(1); if (a !== g.batterView.actor && a !== g.nonStrikerView.actor) { a.visible = false; a.h.replayVisible = false; } }
    g.batterView.blend = null;
  }

  // A batter nobody is using (hidden, no task, not one of the two at the crease).
  free() {
    const g = this.g;
    for (const a of this.pool) if (a !== g.batterView.actor && a !== g.nonStrikerView.actor && !this.leaving.includes(a)) return a;
    // Everyone is busy (three wickets in a few seconds): the one furthest on
    // his way off (nearest the gate, most faded) is done.
    let a = null;
    for (const b of this.leaving) if (!a || (b.h.fade ?? 1) < (a.h.fade ?? 1)) a = b;
    if (a) { this.leaving.splice(this.leaving.indexOf(a), 1); a.task = null; a.visible = false; }
    return a;
  }

  // The ball is dead. info: { wicket: how (or null), who: 'striker' |
  // 'nonStriker' (a run-out: as they were when the ball was bowled) }.
  ballDead(info = {}) { if (!this.pending) this.pending = { wicket: info.wicket || null, who: info.who || null, wait: 0 }; }

  // Are the batters where they should be for the next ball? (A batter on his
  // way off only has to be well clear of the square.)
  settled() {
    const g = this.g, bv = g.batterView, ns = g.nonStrikerView;
    if (this.pending) return false;
    if (bv.shown && bv.actor.task) return false;
    if (ns.visible && (ns.actor.task || ns.moving)) return false;
    for (const a of this.leaving) if (Math.abs(a.pos.x) < 9 && a.pos.z > -24 && a.pos.z < 5) return false;
    return true;
  }

  // Someone has a long way to come (a new batter from the gate): the bowler waits longer.
  busy() {
    const g = this.g;
    return !!this.pending || [g.batterView.actor, g.nonStrikerView.actor].some((a) => a.task && a.task.kind === 'in');
  }

  // Circles for a walking batter to go round: fielders, umpires, the bowler,
  // the stumps, the other batters and you.
  obstacles(self) {
    const g = this.g, obs = this.obs;
    obs.length = 0;
    const ses = g.session, L = ses && ses.field ? ses.field.logic : null;
    if (L && g.fieldView.visible) for (const f of L.fielders) { if (f.bowler && (!L.bowlerFields || !f.out)) continue; obs.push({ x: f.pos.x, z: f.pos.z, r: f.keeper ? 1.1 : 0.8 }); }
    if (g.umpires.visible) for (const u of g.umpires.spots()) obs.push({ x: u.x, z: u.z, r: 0.85 });
    const bw = g.figures.bowler.actor;
    if (bw.visible) obs.push({ x: bw.pos.x, z: bw.pos.z, r: 0.9 });
    obs.push({ x: 0, z: PITCH.battingStumpsZ, r: STUMP_CLEAR + 0.1 }, { x: 0, z: PITCH.bowlingStumpsZ, r: STUMP_CLEAR + 0.1 });
    for (const a of this.pool) if (a !== self && a.visible && (a.h.fade ?? 1) > 0.5) obs.push({ x: a.pos.x, z: a.pos.z, r: 0.85 });
    const hp = g.batterView.avoid;
    if (hp && !(self && self.task && self.task.kind === 'merge')) obs.push({ x: hp.x, z: hp.z, r: 1.5 });
    return obs;
  }

  // Sort the batters out for the next ball (called once the runners have
  // stopped): who is the non-striker, who takes guard / rejoins you, who walks
  // off, who comes in.
  resolve(p) {
    const g = this.g, bv = g.batterView, ns = g.nonStrikerView, r = g.runs;
    const you = !!bv.runnerOnly;
    const S = bv.actor, N = ns.visible ? ns.actor : null;
    const sUp = you ? !!bv.shown : true;                 // (your runner only exists once a run was called)
    // who is out and walks off
    let out = null;
    if (p.wicket) {
      if (/run/.test(p.wicket)) out = p.who === 'nonStriker' ? N : (sUp ? S : null);
      else out = you ? null : S;                         // (you, bowled or caught: there is no figure of you to walk off)
    }
    const stay = [sUp ? S : null, N].filter((a) => a && a !== out);
    // the one nearer the far end is the non-striker
    stay.sort((a, b) => a.pos.z - b.pos.z);
    let nsA = null, stA = null;
    if (N) {
      if (stay.length === 2) { nsA = stay[0]; stA = stay[1]; }
      else if (stay.length === 1) { if (stay[0].pos.z < PITCH.centerZ) nsA = stay[0]; else stA = stay[0]; }
    } else stA = stay[0] || null;
    r.reset();
    bv.running = null; ns.running = null;
    const prevS = bv.actor, prevN = ns.actor;
    // ---- off to the pavilion
    if (out) {
      out.task = walkTask(GATE, null, { kind: 'off', speed: 2.1, tol: 0.6 });
      out.h.setFade(1);
      this.leaving.push(out);
    }
    // ---- the non-striker's end
    if (N) {
      if (!nsA) nsA = this.comeIn();
      if (nsA) { ns.actor = nsA; nsA.visible = true; ns.walkHome(nsA.task && nsA.task.kind === 'in' ? nsA.task : null); }
    }
    // ---- the striker's end
    if (you) {
      // whoever is left near you walks into you; otherwise your runner is simply not out
      if (stA) {
        bv.actor = stA; bv.shown = true; stA.visible = true;
        stA.task = walkTask(bv.avoid || { x: -0.4, z: -1.05 }, null, { kind: 'merge', speed: JOG, tol: 0.25 });
      } else {
        const f = prevS !== nsA && !this.leaving.includes(prevS) ? prevS : this.free();
        bv.actor = f || prevS; bv.shown = false;
        if (f) { f.visible = false; f.task = null; }
      }
    } else {
      if (!stA) stA = this.comeIn(STRIKER_SPOT, Math.PI / 2);
      else if (stA !== prevS || Math.hypot(stA.pos.x - STRIKER_SPOT.x, stA.pos.z - STRIKER_SPOT.z) > 0.25) stA.task = walkTask(STRIKER_SPOT, Math.PI / 2, { speed: WALK });
      if (stA) { bv.actor = stA; stA.visible = true; bv.shown = true; }
    }
    void prevN;
    for (const a of this.pool) a.h.setTeam(this.team);
  }

  // A new batter comes out of the gate. With `to`: to that spot; without: the
  // caller gives him his task's target (the non-striker's mark, see NonStrikerView.walkHome).
  comeIn(to = null, face = null) {
    const a = this.free();
    if (!a) return null;
    a.cut();
    a.place(GATE.x, GATE.z, -Math.PI / 2);
    a.speed = 0;
    a.h.setFade(0);
    a.visible = true;
    a.task = walkTask(to || { x: 0, z: 0 }, face, { kind: 'in', speed: RUN, arriveBy: 12.5 });
    return a;
  }

  // Once a frame while play is on (dt: game seconds).
  update(dt, t, ball = null) {
    const g = this.g, r = g.runs;
    if (this.pending) {
      this.pending.wait += dt;
      // (the batters finish what they were doing first: the run, the slide, getting up)
      if (!r.active || (!r.running && r.down <= 0) || this.pending.wait > 6) { const p = this.pending; this.pending = null; this.resolve(p); }
    }
    this.advanceLeaving(dt);
    for (const a of this.leaving) {
      a.updateMoving(dt || 1e-4, t, null);
      a.h.replayVisible = a.visible && (a.h.fade ?? 1) > 0.5;
    }
    void ball; void _look;
  }

  advanceLeaving(dt) {
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      const a = this.leaving[i];
      // (a walk at first, then a jog once he is off the square)
      const off = Math.hypot(a.pos.x, Math.max(0, Math.abs(a.pos.z - PITCH.centerZ) - 10));
      a.task.speed = off > 14 ? JOG : 2.1;
      const done = stepWalk(a, dt, this.obstacles(a));
      const d = Math.hypot(GATE.x - a.pos.x, GATE.z - a.pos.z);
      a.h.setFade(sstep(0.5, 4.5, d));
      if (done || d < 0.7) { a.task = null; a.visible = false; a.h.setFade(1); a.h.replayVisible = false; this.leaving.splice(i, 1); }
    }
  }

  // While a replay plays (dt: real seconds): the walk off and the walk in go on
  // (the cut back to live play shows them further along), and everyone the
  // recording shows is drawn solid.
  duringReplay(dt) {
    const g = this.g;
    // (he only leaves the field in live play: the replay puts every figure's visibility back when it ends)
    for (const a of this.leaving) if (Math.hypot(GATE.x - a.pos.x, GATE.z - a.pos.z) > 6) stepWalk(a, dt, this.obstacles(a));
    for (const a of [g.batterView.actor, g.nonStrikerView.actor]) {
      if (a.task && a.task.kind === 'in') stepWalk(a, dt, this.obstacles(a));
    }
    for (const a of this.pool) a.h.setFade(1);
  }
}
