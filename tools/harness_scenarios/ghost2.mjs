// Your see-through body seen through your own eyes, looking down at your feet:
// on the pitch (at the crease) and on the grass (2 m to the leg side), stance and drive.
import { POSES } from './body.mjs';
import { execSync } from 'node:child_process';
export const width = 640, height = 640;
export default async function ({ page, shot, out }) {
  await page.evaluate(() => { const g = window.__game; g.actions.start('chase'); if (g.ui.menuOpen) g.ui.closeMenu(); window.__step(30); });
  const names = [];
  for (const [name, dx] of [['stance', 0], ['drive_contact', 0], ['stance', -2.4], ['drive_contact', -2.4]]) {
    const P = POSES.find((p) => p.n === name);
    await page.evaluate(async ({ P, dx }) => {
      const THREE = await import('three');
      const g = window.__game;
      const y = new THREE.Vector3(...P.toe).normalize().negate();
      let z = new THREE.Vector3(...P.face); z.addScaledVector(y, -z.dot(y)).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      const pos = new THREE.Vector3(P.hand[0] + dx, P.hand[1], P.hand[2]);
      const body = g.playerBody;
      body.actor.h.setGhost(true);
      body.show(true);
      g.batMesh.visible = true; g.batMesh.position.copy(pos); g.batMesh.quaternion.copy(q);
      body.actor.step = null; body.actor.handX = null;
      for (let i = 0; i < 60; i++) body.update(1 / 60, 50 + i / 60 + (dx ? 10 : 0) + (P.n.length), pos, q, null, { p: { x: P.head[0] + dx, y: P.head[1], z: P.head[2] }, q: { x: 0, y: 0, z: 0, w: 1 } }, null);
      body.actor.h.root.traverse((o) => o.layers.set(0));
      g.camera.traverse((o) => { if (o !== g.camera) o.visible = false; });
      for (const el of document.querySelectorAll('body *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
      window.__cam(P.head[0] + dx, P.head[1], P.head[2], P.head[0] + dx + 0.2, 0, P.head[2] - 0.45, 90);
    }, { P, dx });
    const n = `down_${name}_${dx ? 'grass' : 'pitch'}`;
    await shot(n); names.push(n);
  }
  execSync(`cd ${out} && ffmpeg -v error -y ${names.map((n) => `-i ${n}.png`).join(' ')} -filter_complex "[0][1][2][3]hstack=4" -q:v 3 sheet.jpg`);
}
