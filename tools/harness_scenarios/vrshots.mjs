// Your figure from realistic VR input: head + bat paths derived from the reference
// batter's tracked ears / wrists (tools/video_shots/takes.json), resampled to 72 Hz
// with tracking jitter, fed through PlayerBodyView.update exactly as updateViews does.
// Logs per take: the class read live, the replay re-solve, grip error (max per frame),
// figure metrics (stride, hip height, knee bend) at contact / finish / +1.5 s, and
// renders strips (live + replay) from square leg.
// env: TAKES=label substrings (comma), MODE=real|still|early|noisy, RENDER=0/1
import fs from 'node:fs';
import { execSync } from 'node:child_process';
export const width = 300, height = 400;
const takesFile = process.env.GAME_ROOT ? process.env.GAME_ROOT + '/tools/video_shots/takes.json' : new URL('../video_shots/takes.json', import.meta.url);

// The bat's toe direction (world: +x off side, +y up, +z toward the keeper) at stance, top, contact, finish.
const TOE = {
  stance: [0.12, -0.95, 0.25], top: [0.2, 0.6, 0.78],
  'front foot defence': [[0.05, -0.97, -0.2], [0.05, -0.97, -0.2]],
  'backfoot defence': [[0.05, -0.98, -0.1], [0.05, -0.98, -0.1]],
  'straight drive': [[0.02, -0.97, -0.25], [-0.25, 0.55, 0.8]],
  'cover drive': [[0.25, -0.93, -0.25], [-0.3, 0.5, 0.8]],
  'lofted drive': [[0.0, -0.9, -0.42], [-0.3, 0.3, 0.9]],
  'backfoot punch': [[0.15, -0.95, -0.2], [0.1, -0.6, -0.78]],
  flick: [[-0.2, -0.95, -0.15], [-0.7, 0.2, 0.68]],
  pull: [[-0.85, 0.0, -0.5], [-0.6, 0.6, 0.55]],
  hook: [[-0.8, 0.25, -0.5], [-0.5, 0.75, 0.45]],
  'square cut': [[0.95, -0.15, -0.2], [0.3, 0.7, 0.65]],
  'late cut': [[0.6, -0.45, 0.6], [0.3, -0.6, 0.75]],
  sweep: [[-0.55, -0.3, -0.78], [-0.75, 0.35, 0.55]],
  'slog sweep': [[-0.7, 0.05, -0.7], [-0.5, 0.75, 0.45]],
  'reverse sweep': [[0.6, -0.3, -0.74], [0.75, 0.4, 0.5]],
};
const nrm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
function axisAt(take, tau) {
  const e = take.events, K = TOE[take.label] || TOE['straight drive'];
  const keys = [[0, TOE.stance], [Math.max(0.05, e.top), TOE.top], [e.contact, K[0]], [e.finish, K[1]]];
  let i = 0; while (i < keys.length - 2 && tau > keys[i + 1][0]) i++;
  const [ta, A] = keys[i], [tb, B] = keys[i + 1];
  let k = Math.min(1, Math.max(0, (tau - ta) / (tb - ta))); k = k * k * (3 - 2 * k);
  return nrm(A.map((v, j) => v + (B[j] - v) * k)).map((v) => -v);   // handle-up axis = -toe
}
export function coachingFrames(take, mode = 'real') {
  const C = take.canon, n = C.length;
  // keep indices: 0 nose,1/2 ears,3/4 sh L/R,5/6 elbows,7/8 wrists L/R,9/10 index L/R,11/12 hips,13/14 knees,15/16 ankles
  const sm = (f, j) => { const o = [0, 0, 0]; let w = 0; for (let k = -1; k <= 1; k++) { const i = Math.min(n - 1, Math.max(0, f + k)); const ww = k ? 0.25 : 0.5; for (let a = 0; a < 3; a++) o[a] += C[i][j][a] * ww; w += ww; } return o.map((v) => v / w); };
  const W = (c) => [c[2], c[1], -c[0]];               // canon (bowler +X, off +Z) -> world (bowler -Z, off +X)
  const frames = [];
  for (let f = 0; f < n; f++) {
    const e1 = W(sm(f, 1)), e2 = W(sm(f, 2)), wl = W(sm(f, 7)), wr = W(sm(f, 8)), il = W(sm(f, 9)), ir = W(sm(f, 10));
    const head = e1.map((v, i) => (v + e2[i]) / 2);
    const hand = wr.map((v, i) => v + (ir[i] - v) * 0.5);
    const top = wl.map((v, i) => v + (il[i] - v) * 0.5);
    // (the tracked wrists are too noisy for the bat's direction: it is keyframed per shot below)
    const mid = hand.map((v, i) => (v + top[i]) / 2);
    frames.push({ head, hand: mid, ax: axisAt(take, f / 30), ankY: Math.min(C[f][15][1], C[f][16][1]) });
  }
  const s0 = frames.slice(0, 5);
  const ankY = Math.min(...s0.map((f) => f.ankY));
  const h0 = [0, 1, 2].map((a) => s0.reduce((s, f) => s + f.head[a], 0) / s0.length);
  const off = [-0.42 - h0[0], 0.08 - ankY, -1.05 - h0[2]];
  for (const f of frames) {
    for (const k of ['head', 'hand']) f[k] = f[k].map((v, i) => v + off[i]);
    if (mode === 'still') f.head = f.head.map((v, i) => i === 1 ? v : h0[i] + off[i] + (v - h0[i] - off[i]) * 0.25);
  }
  return frames;
}

export default async function ({ page, shot, out }) {
  await page.evaluate(() => { const g = window.__game; g.settings.replay = 'off'; g.actions.start('chase'); if (g.ui.menuOpen) g.ui.closeMenu(); window.__step(30); });
  const want = (process.env.TAKES || '').split(',').filter(Boolean);
  const mode = process.env.MODE || 'real';
  const render = process.env.RENDER !== '0';
  const takesJson = JSON.parse(fs.readFileSync(takesFile));
  const takes = takesJson.takes.filter((t) => !want.length || want.some((w) => t.label.includes(w)));
  const summary = [];
  for (const take of takes) {
    const frames = coachingFrames(take, mode), ev = take.events, fps = takesJson.fps;
    const name = take.label.replace(/ /g, '_');
    const res = await page.evaluate(async ({ frames, ev, fps, label, mode, name, dumpAt }) => {
      const THREE = await import('three');
      const { gloveError } = await import('./tests/battingTracks.js');
      const g = window.__game, body = g.playerBody, A = body.actor, h = A.h;
      body.show(true); g.batMesh.visible = true;
      // the figure at your height, as updateViews sizes it (from the tallest you stand: here the stance + 8 cm)
      { const standEye = frames.slice(0, 5).reduce((s, f) => s + f.head[1], 0) / 5 + 0.08; const k = Math.min(1.12, Math.max(0.84, standEye / (A.headRestY * h.baseScale + 0.11))); h.root.scale.setScalar(h.baseScale * k); }
      g.world.ball.active = false; g.ballView.setVisible(false);
      const T0 = 40 + Math.random() * 0.01, dur = (frames.length - 1) / fps;
      const Tc = T0 + ev.contact, Tf = T0 + ev.finish;
      const sweepy = /sweep/.test(label), slog = /slog/.test(label), rev = /reverse/.test(label);
      const leave = mode === 'leave', miss = mode === 'miss' || /defence/.test(label) && false;
      const release = mode === 'early' ? T0 + ev.top + 0.1 : Tc - 0.6;
      const tEnd = T0 + dur + 2.5;
      let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
      const at = (t) => {
        const x = Math.min(frames.length - 1, Math.max(0, (t - T0) * fps)), i = Math.min(frames.length - 2, Math.floor(x)), k = x - i;
        const A = frames[i], B = frames[i + 1], L = (a, b) => a.map((v, j) => v + (b[j] - v) * k);
        return { head: L(A.head, B.head), hand: L(A.hand, B.hand), ax: L(A.ax, B.ax) };
      };
      const jit = mode === 'noisy' ? 0.006 : 0.002;
      const pose = (P) => {
        const y = new THREE.Vector3(...P.ax).normalize();
        const z = new THREE.Vector3(0, 0, -1); z.addScaledVector(y, -z.dot(y)); if (z.lengthSq() < 1e-4) z.set(1, 0, 0); z.normalize();
        const x = new THREE.Vector3().crossVectors(y, z);
        return { pos: new THREE.Vector3(P.hand[0] + rnd() * jit, P.hand[1] + rnd() * jit, P.hand[2] + rnd() * jit), q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)) };
      };
      const sweepK = (t) => sweepy ? Math.min(1, Math.max(0, (t - (T0 + ev.top - 0.35)) / 0.2)) * (1 - Math.min(1, Math.max(0, (t - (Tf + 0.5)) / 0.3))) : 0;
      const hitT = leave ? null : Tc;
      const info = (t) => {
        const k = sweepK(t);
        const s = mode === 'grip' ? { k: 1, slog: false, reverse: false } : k > 0.01 ? { k: k * k * (3 - 2 * k), slog: slog, reverse: rev } : null;
        const live = t >= release && (hitT == null ? t < Tc + 0.3 : t < hitT);
        return { sweep: s, ball: t >= release ? { id: 9, live, arrive: Tc, y: /hook/.test(label) ? 1.5 : /pull|cut|punch|back/.test(label) ? 0.95 : 0.55, length: /pull|hook|cut|back|punch/.test(label) ? 9 : 4 } : { id: 8, live: false, arrive: 1, y: 0.6, length: 5 }, hit: hitT != null && t >= hitT ? { t: hitT, launch: /lofted|slog|hook/.test(label) ? 30 : 8, name: '', dir: noDir ? undefined : DIR[label] } : null, crease: null };
      };
      const DIR = { 'front foot defence': { x: 0.1, y: 0, z: -1 }, 'backfoot defence': { x: 0.2, y: 0, z: -1 }, 'straight drive': { x: 0.05, y: 0.1, z: -1 }, 'cover drive': { x: 0.7, y: 0.1, z: -0.7 },
        'lofted drive': { x: 0.1, y: 0.5, z: -1 }, 'backfoot punch': { x: 0.6, y: 0.1, z: -0.8 }, hook: { x: -1, y: 0.4, z: 0.2 }, pull: { x: -1, y: 0.1, z: -0.2 }, flick: { x: -0.6, y: 0.05, z: -0.8 },
        'square cut': { x: 1, y: 0.1, z: 0.05 }, 'late cut': { x: 0.6, y: 0, z: 0.8 }, sweep: { x: -1, y: 0, z: 0.3 }, 'slog sweep': { x: -1, y: 0.5, z: -0.2 }, 'reverse sweep': { x: 1, y: 0, z: 0.3 } };
      const noDir = mode === 'nodir';
      const ballPos = new THREE.Vector3(0, 0.6, -10);
      const keep = () => ({ root: h.root.position.clone(), rq: h.root.quaternion.clone(), hips: h.bones.hips.position.clone(), q: h.boneList.map((b) => b.quaternion.clone()) });
      const metrics = () => {
        h.update();
        const v = (n) => h.worldPos(n, new THREE.Vector3());
        const fl = v('ankleL'), fr = v('ankleR'), hp = v('hips'), kL = v('kneeL'), kR = v('kneeR'), hL = v('hipL'), hR = v('hipR'), sl = v('shoulderL'), sr = v('shoulderR');
        const knee = (hh, k, a) => Math.PI - hh.clone().sub(k).angleTo(a.clone().sub(k));
        return { stride: +Math.hypot(fl.x - fr.x, fl.z - fr.z).toFixed(2), hipY: +hp.y.toFixed(2), kneeL: +(knee(hL, kL, fl) * 57.3).toFixed(0), kneeR: +(knee(hR, kR, fr) * 57.3).toFixed(0), shYaw: +(Math.atan2(sl.x - sr.x, sl.z - sr.z) * 57.3).toFixed(0), minKneeY: +Math.min(kL.y, kR.y).toFixed(2) };
      };
      const marks = { top: T0 + ev.top, pre: Tc - 0.12, contact: Tc, mid: Tc + (Tf - Tc) * 0.5, finish: Tf, f05: Tf + 0.5, f15: Tf + 1.5, end: tEnd - 0.05 };
      const live = {}, liveM = {};
      let fe = null;
      let prevE = null, maxEl = 0, elAt = null, jumpAt = null, indep = 0, gmax = 0, gsum = 0, gn = 0, cls = null, clsAt = null, t0 = null, worst = 0, worstT = 0, maxJump = 0, prevQ = null;
      for (let t = T0; t <= tEnd; t += 1 / 72) {
        const P = at(t), B = pose(P);
        body.update(1 / 72, t, B.pos, B.q, ballPos, { p: { x: P.head[0], y: P.head[1], z: P.head[2] }, q: { x: 0, y: 0, z: 0, w: 1 } }, info(t));
        const e = A.gripErr || 0; gsum += e; gn++; if (e > gmax) { gmax = e; worstT = t - Tc; }
        if (body.sense.leader) {
          cls = body.sense.leader; fe = body.sense.s.feat;
          if (t0 == null) t0 = body.sense.s.sw.t0 - Tc;
        }
        // largest per-frame joint jump (deg) after the swing: a freeze / snap detector
        h.update();
        const q = h.boneList.map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
        const elb = ['elbowL', 'elbowR', 'handL', 'handR'].map((n) => h.worldPos(n, new THREE.Vector3()));
        if (prevE && t > T0 + 0.3) elb.forEach((p, i) => { const d = p.distanceTo(prevE[i]); if (d > maxEl) { maxEl = d; elAt = [+(t - Tc).toFixed(2), i]; } });
        if (dumpAt != null && Math.abs(t - Tc - dumpAt) < 0.06) { const f = (v) => v.toArray().map((x) => x.toFixed(2)).join(','); console.log('D', (t - Tc).toFixed(3), 'shR', f(h.worldPos('shoulderR', new THREE.Vector3())), 'elR', f(elb[1]), 'hR', f(elb[3]), 'elL', f(elb[0]), 'hips', f(h.worldPos('hips', new THREE.Vector3())), 'bat', f(B.pos), 'cls', body.sense.leader); }
        prevE = elb;
        if (prevQ) { let m = 0, mi = 0; q.forEach((qq, i) => { const a = qq.angleTo(prevQ[i]); if (a > m) { m = a; mi = i; } }); if (m * 57.3 > maxJump && t > T0 + 0.3) { maxJump = m * 57.3; jumpAt = [+(t - Tc).toFixed(2), h.boneList[mi].name]; } }
        indep = Math.max(indep, gloveError(h, B.pos, B.q));
        prevQ = q;
        for (const [k, mt] of Object.entries(marks)) if (Math.abs(t - mt) < 0.5 / 72) { live[k] = { ...keep(), bat: B }; liveM[k] = metrics(); }
      }
      window.__live = live;
      const rep = {}, repM = {};
      let rgmax = 0;
      const ok = body.resolve(T0 + 0.05, tEnd, (t) => {
        rgmax = Math.max(rgmax, A.gripErr || 0);
        for (const [k, mt] of Object.entries(marks)) if (Math.abs(t - mt) < 0.5 / 72) { const P = at(t); rep[k] = { ...keep(), bat: pose(P) }; repM[k] = metrics(); }
      });
      window.__rep = rep;
      return { feat: fe && { cross: +fe.cross.toFixed(2), peak: +fe.peak.toFixed(1), dirX: +fe.dirX.toFixed(2), up: +fe.up.toFixed(2), front: +fe.front.toFixed(2) }, name, cls, t0: t0 != null ? +t0.toFixed(2) : null, gripMaxCm: +(gmax * 100).toFixed(2), worstAt: +worstT.toFixed(2), gripMeanCm: +(gsum / gn * 100).toFixed(2), repGripMaxCm: +(rgmax * 100).toFixed(2), resolved: ok, maxJumpDeg: +maxJump.toFixed(1), jumpAt, elJumpCm: +(maxEl * 100).toFixed(1), elAt, indepCm: +(indep * 100).toFixed(2), liveM, repM, marks: Object.keys(marks) };
    }, { frames, ev, fps, label: take.label, mode, name, dumpAt: process.env.DUMP ? +process.env.DUMP : null });
    console.log(JSON.stringify({ ...res, liveM: undefined, repM: undefined, marks: undefined }));
    for (const k of ['contact', 'finish', 'f15']) console.log('   ', k, 'live', JSON.stringify(res.liveM[k]), 'rep', JSON.stringify(res.repM[k]));
    summary.push(res);
    if (!render) continue;
    const ks = ['top', 'contact', 'mid', 'finish', 'f05', 'f15'];
    const sets = res.resolved ? ['live', 'rep'] : ['live'];
    for (const set of sets) {
      for (let i = 0; i < ks.length; i++) {
        const has = await page.evaluate(({ set, k }) => {
          const g = window.__game, h = g.playerBody.actor.h, F = (set === 'live' ? window.__live : window.__rep)[k];
          if (!F) return false;
          h.root.position.copy(F.root); h.root.quaternion.copy(F.rq); h.bones.hips.position.copy(F.hips);
          h.boneList.forEach((b, j) => b.quaternion.copy(F.q[j]));
          h.update(); h.root.traverse((o) => o.layers.set(0)); h.setGhost(false);
          g.batMesh.position.copy(F.bat.pos); g.batMesh.quaternion.copy(F.bat.q); g.batMesh.visible = true;
          g.camera.traverse((o) => { if (o !== g.camera) o.visible = false; });
          for (const el of document.querySelectorAll('body *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
          return true;
        }, { set, k: ks[i] });
        for (const [cn, c] of [['kp', [-0.35, 1.0, 4.5, -0.35, 0.8, -1.3, 30]], ['sq', [-6.5, 1.0, -1.4, -0.35, 0.8, -1.4, 24]]]) {
          if (!has) execSync(`cd ${out} && ffmpeg -v error -y -f lavfi -i color=gray:s=${width}x${height} -frames:v 1 ${name}_${set}_${cn}_${i}.png`);
          else { await page.evaluate((c) => window.__cam(...c), c); await shot(`${name}_${set}_${cn}_${i}`); }
        }
      }
      for (const cn of ['kp', 'sq']) execSync(`cd ${out} && ffmpeg -v error -y ${ks.map((_, k) => `-i ${name}_${set}_${cn}_${k}.png`).join(' ')} -filter_complex hstack=${ks.length} -q:v 3 strip_${name}_${set}_${cn}.jpg && rm ${name}_${set}_${cn}_*.png`);
    }
  }
  fs.writeFileSync(out + '/summary.json', JSON.stringify(summary, null, 1));
}
