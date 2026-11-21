// Loading's last steps, behind the loading bar, so that nothing compiles or
// uploads for the first time during play (on Quest a frame that stalls on
// that is reprojected: a smear, a dark edge):
//   1. every shader program, compiled in parallel (renderer.compileAsync:
//      KHR_parallel_shader_compile, the page stays responsive) with every
//      material variant there is in the scene at once: the whole scene, the
//      DRS review (out of the scene until a review), your see-through body
//      (setGhost) and a fading figure (setFade);
//   2. every texture uploaded (renderer.initTexture), a few per frame;
//   3. one draw of everything into a single pixel, hidden things too, both
//      levels of detail of every figure and the variants again, so the first
//      use of each program and buffer (uniform locations, vertex buffers,
//      skeleton textures) happens now: three only finishes a program on its
//      first draw, and a driver may not compile for real until then.
// Game.prewarm() is the same thing in one synchronous go (tests, the harness).
import * as THREE from 'three';
import { Humanoid } from './humanoid.js';

const frame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 0)));
const TEX_KEYS = ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'aoMap', 'lightMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'specularMap'];

// Every texture a material in these roots uses (named maps and ShaderMaterial / onBeforeCompile uniforms).
export function texturesIn(roots) {
  const out = new Set();
  const add = (t) => { if (t && t.isTexture && !t.isRenderTargetTexture) out.add(t); };
  for (const root of roots) {
    if (!root) continue;
    root.traverse((o) => {
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) {
        for (const k of TEX_KEYS) add(m[k]);
        const u = m.uniforms || (m.userData && m.userData.uniforms);
        if (u) for (const k in u) add(u[k] && u[k].value);
      }
    });
  }
  return [...out];
}

// The material variants that only show now and then, switched on for a compile / draw; returns undo().
function variants(game) {
  const me = game.playerBody && game.playerBody.actor.h, any = Humanoid.all.find((h) => h !== me);
  const undo = [];
  if (me && !me.ghost) { me.setGhost(true); undo.push(() => me.setGhost(false)); }
  if (any && (any.fade ?? 1) === 1) { any.setFade(0.5); undo.push(() => any.setFade(1)); }
  return () => { for (const u of undo) u(); };
}

// Everything visible (and not culled), every camera layer, the DRS group in the scene; returns undo().
function showAll(game) {
  const { scene, camera } = game, restore = [], layers = camera.layers.mask;
  const drs = game.drs && game.drs.group, added = drs && !drs.parent;
  if (added) scene.add(drs);
  scene.traverse((o) => { restore.push(o, o.visible, o.frustumCulled); o.visible = true; o.frustumCulled = false; });
  camera.layers.enableAll();
  return () => {
    camera.layers.mask = layers;
    for (let i = 0; i < restore.length; i += 3) { restore[i].visible = restore[i + 1]; restore[i].frustumCulled = restore[i + 2]; }
    if (added) scene.remove(drs);
  };
}

// The 1-pixel draw of everything (both LODs; then the variants). Synchronous.
export function warmDraw(game) {
  const r = game.renderer, { scene, camera } = game;
  const vp = r.getViewport(new THREE.Vector4()), sc = r.getScissor(new THREE.Vector4()), sct = r.getScissorTest();
  const unshow = showAll(game);
  r.setViewport(0, 0, 1, 1); r.setScissor(0, 0, 1, 1); r.setScissorTest(true);
  const lods = Humanoid.all.map((h) => h.lod);
  try {
    for (const lod of [1, 0]) { for (const h of Humanoid.all) h.setLod(lod); r.render(scene, camera); }
    const unvar = variants(game);
    try { for (const lod of [1, 0]) { for (const h of Humanoid.all) h.setLod(lod); r.render(scene, camera); } } finally { unvar(); }
  } finally {
    Humanoid.all.forEach((h, i) => h.setLod(lods[i]));
    r.setViewport(vp); r.setScissor(sc); r.setScissorTest(sct);
    unshow();
  }
}

// First use of each program a few at a time, yielding between (where the browser has no parallel
// compile, three's compileAsync returns at once and the real compile happens on the first draw:
// seconds on a slow GPU, which would freeze the page in one go). One mesh per (material, kind of
// mesh) is drawn into the pixel with everything else hidden; then warmDraw() draws it all.
async function firstUses(game, progress) {
  const r = game.renderer, { scene, camera } = game;
  const unshow = showAll(game);
  const all = [], seen = new Set();
  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const k = ms.map((m) => m && m.uuid).join() + (o.isSkinnedMesh ? 's' : '') + (o.isInstancedMesh ? 'i' : '') + (o.geometry && o.geometry.attributes.color ? 'c' : '') + (o.isPoints ? 'p' : '');
    if (!seen.has(k)) { seen.add(k); all.push(o); }
  });
  const vis = [], lights = [];
  scene.traverse((o) => { vis.push(o); if (o.isLight) lights.push(o); });
  const vp = r.getViewport(new THREE.Vector4()), sc = r.getScissor(new THREE.Vector4()), sct = r.getScissorTest();
  try {
    let t = performance.now();
    for (let i = 0; i < all.length; i += 4) {
      for (const o of vis) o.visible = false;
      for (const l of lights) for (let o = l; o; o = o.parent) o.visible = true;     // (the lights are part of every program's key)
      for (let j = i; j < Math.min(all.length, i + 4); j++) for (let o = all[j]; o; o = o.parent) o.visible = true;
      r.setViewport(0, 0, 1, 1); r.setScissor(0, 0, 1, 1); r.setScissorTest(true);
      r.render(scene, camera);
      r.setViewport(vp); r.setScissor(sc); r.setScissorTest(sct);
      progress(Math.min(1, (i + 4) / all.length));
      if (performance.now() - t > 30) { await frame(); t = performance.now(); }
    }
  } finally {
    for (const o of vis) o.visible = true;     // (showAll's state, which unshow() then restores)
    r.setViewport(vp); r.setScissor(sc); r.setScissorTest(sct);
    unshow();
  }
}

// The whole warm-up, a step at a time. progress(fraction 0..1, label).
export async function warmUp(game, progress = () => {}) {
  const r = game.renderer, { scene, camera } = game;
  const t0 = performance.now(), T = {};
  // the DRS screen's Snicko / Hot Spot canvases, drawn once
  game.drs._build();
  game.drs.prewarmScreen(r);
  T.drs = performance.now() - t0;
  // 1. programs: the scene with everything shown, both LODs' geometry, then the variants
  progress(0, 'Preparing the shaders');
  try { T.parallel = !!r.getContext().getExtension('KHR_parallel_shader_compile'); } catch { T.parallel = false; }
  const t1 = performance.now();
  const unshow = showAll(game);
  try {
    const poll = setInterval(() => {
      const ps = r.info.programs || [];
      let ready = 0;
      for (const p of ps) if (!p.isReady || p.isReady()) ready++;
      progress(ps.length ? 0.55 * ready / ps.length : 0, 'Preparing the shaders');
    }, 100);
    try {
      if (r.compileAsync) {
        await r.compileAsync(scene, camera);
        const unvar = variants(game);
        try { await r.compileAsync(scene, camera); } finally { unvar(); }
        const lods = Humanoid.all.map((h) => h.lod);
        for (const h of Humanoid.all) h.setLod(1 - h.lod);
        try { await r.compileAsync(scene, camera); } finally { Humanoid.all.forEach((h, i) => h.setLod(lods[i])); }
      } else {
        r.compile(scene, camera);
      }
    } finally { clearInterval(poll); }
  } finally { unshow(); }
  T.compile = performance.now() - t1;
  // 2. textures, a few per frame (a 2048 canvas's upload and mipmaps can take tens of ms on a headset)
  const t2 = performance.now();
  const tex = texturesIn([scene, game.drs && game.drs.group]);
  let budget = performance.now();
  for (let i = 0; i < tex.length; i++) {
    r.initTexture(tex[i]);
    progress(0.6 + 0.3 * (i + 1) / tex.length, 'Uploading the textures');
    if (performance.now() - budget > 12) { await frame(); budget = performance.now(); }
  }
  T.textures = performance.now() - t2; T.textureCount = tex.length;
  // 3. first use of everything: each program a few at a time, then everything (and the variants) at once
  const t3 = performance.now();
  await firstUses(game, (f) => progress(0.9 + 0.08 * f, 'Warming up'));
  const unvar = variants(game);
  try { await firstUses(game, () => {}); } finally { unvar(); }
  T.firstUse = performance.now() - t3;
  await frame();
  const t4 = performance.now();
  warmDraw(game);
  T.draw = performance.now() - t4;
  progress(1);
  T.total = performance.now() - t0;
  return T;
}
