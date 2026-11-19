import test from 'node:test';
import assert from 'node:assert/strict';
import { eyeError, blurEllipse, psfTaps, eyeKernel, VISION } from '../src/game/vision.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('a short-sighted eye at the 1.3 m picture: what it cannot relax for is its blur', () => {
  const e = eyeError({ sph: -2 });                         // far point 0.5 m: 2 - 1/1.3 = 1.23 D out
  assert.ok(near(e.e1, 2 - 1 / 1.3) && near(e.e2, e.e1));
  assert.ok(near(eyeError({ sph: -0.5 }).e1, 0), 'mild myopia: the picture is inside its range, sharp');
});

test('a long-sighted eye focuses for it while it can; past that, the rest is blur', () => {
  assert.ok(near(eyeError({ sph: 1 }).e1, 0));
  const e = eyeError({ sph: 3 }, { accom: 1 });            // needs 3.77 D, has 1
  assert.ok(near(e.e1, -(3 + 1 / 1.3 - 1)));
});

test('astigmatism: the two meridians differ by the cylinder, the eye focuses between them', () => {
  const e = eyeError({ sph: -1, cyl: -1.5, axis: 30 });
  assert.ok(near(e.e2 - e.e1, 1.5), 'the cylinder');
  assert.ok(near(e.angle, -30 * Math.PI / 180), 'the axis as the wearer sees it (the examiner\'s counter-clockwise is the wearer\'s clockwise)');
  const f = eyeError({ sph: 1, cyl: -2, axis: 90 });       // needs 1.77 and -0.23: focuses between, e1 = -e2
  assert.ok(near(f.e1, -f.e2));
});

test('the fine-tune adds to both meridians', () => {
  const a = eyeError({ sph: -2 }), b = eyeError({ sph: -2 }, { tune: -0.25 });
  assert.ok(near(b.e1, a.e1 - 0.25));
});

test('blur ellipse: the pupil spread by the error, at the eye buffer\'s scale', () => {
  const b = blurEllipse({ e1: 1.5, e2: 1.5, angle: 0 }, 4, 824);
  assert.ok(near(b.a1, 0.002 * 1.5 * 824) && near(b.a2, b.a1));   // 2.47 px radius
});

test('PSF taps: they sum to 1, are symmetric about the pixel, and keep most of the light', () => {
  const t = psfTaps({ a1: 2.5, a2: 2.5, angle: 0 });
  assert.ok(t && t.length % 3 === 0);
  let w = 0, mx = 0, my = 0;
  for (let i = 0; i < t.length; i += 3) { w += t[i + 2]; mx += t[i] * t[i + 2]; my += t[i + 1] * t[i + 2]; }
  assert.ok(near(w, 1, 1e-5) && Math.abs(mx) < 0.02 && Math.abs(my) < 0.02, `sum ${w}, centroid ${mx}, ${my}`);
  assert.ok(t.length / 3 < 25, `merged into ${t.length / 3} fetches`);
});

test('PSF taps: an astigmatic blur lies along its axis', () => {
  const t = psfTaps({ a1: 4, a2: 1, angle: Math.PI / 2 });   // long along +y
  let xx = 0, yy = 0;
  for (let i = 0; i < t.length; i += 3) { xx += t[i] ** 2 * t[i + 2]; yy += t[i + 1] ** 2 * t[i + 2]; }
  assert.ok(yy > 4 * xx, `spread x ${xx.toFixed(2)} y ${yy.toFixed(2)}`);
});

test('no blur worth the name: no kernel; a huge one: capped to the budget', () => {
  assert.equal(psfTaps({ a1: 0.2, a2: 0.3, angle: 0 }), null);
  const big = psfTaps({ a1: 40, a2: 40, angle: 0 });
  assert.ok(big.length / 3 <= VISION.maxTaps);
});

test('one eye end to end: -2.00 at 4 mm on the Quest 3S eye buffer is a ~2 px radius blur', () => {
  const k = eyeKernel({ sph: -2 }, {}, 824);
  assert.ok(k.ell.a1 > 1.9 && k.ell.a1 < 2.1, `radius ${k.ell.a1}`);
  assert.ok(k.taps.length / 3 >= 5);
});

test('the GPU pass\'s pixel mapping: straight ahead lands mid-viewport; an off-centre lens moves it', async () => {
  let pixelsFromDir;
  try { ({ pixelsFromDir } = await import('../src/render/visionCorrect.js')); } catch { return; }   // (no three.js installed)
  const THREE = await import('three');
  const cam = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  const px = (K, d) => { const v = new THREE.Vector3(...d).applyMatrix3(K); return [v.x / v.z, v.y / v.z]; };
  const K = pixelsFromDir({ vp: { x: 600, y: 0, z: 600, w: 600 }, P: cam.projectionMatrix.elements });
  const [x, y] = px(K, [0, 0, -1]);
  assert.ok(near(x, 900, 1e-6) && near(y, 300, 1e-6), `${x}, ${y}`);
  const [x2] = px(K, [Math.tan(Math.PI / 8), 0, -1]);       // 22.5 deg right: a quarter-width... of tan(45) = 1
  assert.ok(near(x2, 900 + 300 * Math.tan(Math.PI / 8), 1e-6));
  cam.projectionMatrix.elements[8] = 0.2;                   // a lens frustum off-centre (toward the nose)
  const [x3] = px(pixelsFromDir({ vp: { x: 0, y: 0, z: 600, w: 600 }, P: cam.projectionMatrix.elements }), [0, 0, -1]);
  assert.ok(near(x3, 300 - 0.2 * 300, 1e-6), `${x3}`);
});
