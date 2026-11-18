// "The bat is lagging": a synthetic bat swung very fast (whole arcs in ~0.2 s, the
// bat turning 60 deg+ per 33 ms, hands out at full reach in every direction)
// while a ball comes and is hit, so the figure goes through stance -> captured
// shot -> blend back. Each frame: the distance from each glove (hand bone) to
// where it grips the handle. Must stay < 2 cm. Also renders the first-person view
// (ghost body, looking down) at the worst frames. env: HZ (default 72)
export const width = 480, height = 480;
export default async function ({ page, shot }) {
  await page.evaluate(() => { const g = window.__game; g.settings.replay = 'off'; g.actions.start('chase'); if (g.ui.menuOpen) g.ui.closeMenu(); window.__step(30); });
  const hz = +(process.env.HZ || 72);
  const res = await page.evaluate(async ({ hz }) => {
    const THREE = await import('three');
    const { gloveError } = await import('./tests/battingTracks.js');
    const g = window.__game, body = g.playerBody, A = body.actor, h = A.h;
    body.show(true); g.batMesh.visible = true; g.world.ball.active = false;
    const head = new THREE.Vector3(-0.42, 1.62, -1.05);
    const sh = new THREE.Vector3(-0.42, 1.30, -1.0);
    const out = { frames: 0, max: 0, maxAt: null, over2: 0, maxStretch: 0, worst: [] };
    const dt = 1 / hz;
    let id = 1;

    for (let rep = 0; rep < 6; rep++) {
      const T0 = 100 + rep * 4, Tc = T0 + 1.2;
      id++;
      for (let t = T0; t < T0 + 3.6; t += dt) {
        const r = t - T0;
        // stance, a backlift, then whirling arcs at reach (radius 0.55..0.8 m from the shoulders)
        let ang, el, rad;
        if (r < 0.6) { ang = 0.3; el = -0.9; rad = 0.55; }
        else if (r < 1.0) { const k = (r - 0.6) / 0.4; ang = 0.3 + 2.4 * k; el = -0.9 + 1.6 * k; rad = 0.55 + 0.1 * k; }
        else { const k = (r - 1.0); ang = 2.7 - k * (rep % 2 ? 14 : -11); el = 0.7 * Math.sin(k * 9 + rep); rad = 0.62 + 0.18 * Math.abs(Math.sin(k * 5 + rep)); }
        const dir = new THREE.Vector3(Math.sin(ang) * Math.cos(el), Math.sin(el), -Math.cos(ang) * Math.cos(el));
        const pos = sh.clone().addScaledVector(dir, rad);
        // the bat: along the arc's tangent, rolling
        const y = new THREE.Vector3(-Math.cos(ang), 0.4 * Math.sin(r * 7), -Math.sin(ang)).normalize();
        const z = new THREE.Vector3(0, 0, -1); z.addScaledVector(y, -z.dot(y)); if (z.lengthSq() < 1e-4) z.set(1, 0, 0); z.normalize();
        const x = new THREE.Vector3().crossVectors(y, z);
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
        const hp = head.clone().add(new THREE.Vector3(0.05 * Math.sin(r * 3), r > 1 ? -0.05 : 0, r > 1 ? -0.1 : 0));
        const info = { sweep: rep === 4 && r > 0.5 ? { k: 1, slog: false, reverse: false } : null, ball: { id, live: t < Tc, arrive: Tc, y: 0.7, length: 5 }, hit: t >= Tc && rep !== 3 ? { t: Tc, launch: 10, name: '', dir: { x: Math.sin(rep), y: 0.1, z: -Math.cos(rep) } } : null, crease: rep === 5 ? { z: -0.95, pin: 1 } : null };
        g.batMesh.position.copy(pos); g.batMesh.quaternion.copy(q);
        body.update(dt, t, g.batMesh.position, g.batMesh.quaternion, null, { p: hp, q: { x: -0.38, y: 0, z: 0, w: 0.92 } }, info);
        h.update();
        const e = Math.max(gloveError(h, pos, q), A.gripErr || 0);
        const st = A.armRest ? h.bones.elbowR.position.length() / A.armRest.elbowR.length() : 1;
        out.maxStretch = Math.max(out.maxStretch, st, A.armRest ? h.bones.elbowL.position.length() / A.armRest.elbowL.length() : 1);
        out.frames++;
        if (e > 0.02) out.over2++;
        if (e > out.max) { out.max = e; out.maxAt = [rep, +(t - Tc).toFixed(3), +pos.distanceTo(sh).toFixed(2)]; }
      }
    }
    out.max = +(out.max * 100).toFixed(2);
    out.maxStretch = +out.maxStretch.toFixed(3);
    return out;
  }, { hz });
  console.log('fastbat', hz, 'Hz', JSON.stringify(res));
  // first person, looking down, at a fast frame
  await page.evaluate(() => {
    const g = window.__game, h = g.playerBody.actor.h;
    h.setGhost(true);
    g.camera.traverse((o) => { if (o !== g.camera) o.visible = false; });
    for (const el of document.querySelectorAll('body *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
    window.__cam(-0.42, 1.62, -1.05, -0.1, 0.4, -1.3, 90);
  });
  await shot('fp_last');
}
