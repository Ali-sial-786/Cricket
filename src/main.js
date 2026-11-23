// Entry point: renderer, scene, rig, the loading sequence, XR buttons, animation loop.
//
// Loading, a step at a time with the page's bar fed by real progress and a
// frame between steps (the status line and the bar move; nothing freezes
// for seconds): the player model, clips and shots (fetched in parallel) ->
// the stadium -> the game -> every shader compiled in parallel, every texture
// uploaded and everything drawn once (render/warmup.js) -> ready: only then
// do the headset buttons light up and the animation loop start, so the
// first look round in VR compiles and uploads nothing. Audio is fetched and
// decoded later (src/audio: once a click has unlocked it). Each step leaves
// a performance mark ('load:<step>'); game.loadTiming has the durations.
import * as THREE from 'three';
import { Game } from './game/game.js';
import { XRSessionManager } from './xr/session.js';
import { loadAthlete } from './render/humanoid.js';
import { loadClips } from './render/clips.js';
import { loadShots } from './render/shots.js';
import { buildEnvironment } from './render/env.js';
import { warmUp } from './render/warmup.js';

const container = document.getElementById('app');
const statusEl = document.getElementById('status');
const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
const bar = document.querySelector('.progress');
const timing = {};
let tMark = performance.now();
const mark = (name) => { const t = performance.now(); timing[name] = Math.round(t - tMark); tMark = t; try { performance.mark('load:' + name); } catch { /* old browser */ } };
// The bar: a fraction of the whole load (index.html shows it while body.loading).
const progress = (f, label) => {
  if (bar) { bar.classList.add('determinate'); bar.style.setProperty('--p', `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`); }
  if (label) setStatus(label + '…');
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
mark('modules');

// The canvases painted while loading (turf, pitch, sky, ball, kits, faces, boards, panels) are drawn
// once and uploaded once: CPU-backed ones (willReadFrequently) paint thousands of small strokes and
// read back their pixels without a GPU round trip for each (the ball's two maps: 17 s with a GPU-backed
// canvas in software GL, 0.1 s on the CPU). Only during loading: canvases made later are left alone.
const getContext0 = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, opts) {
  return getContext0.call(this, type, type === '2d' && !(opts && 'willReadFrequently' in opts) ? { ...(opts || {}), willReadFrequently: true } : opts);
};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setClearColor(0xcfdbe6, 1);       // (the sky's horizon haze, lighting.js HAZE_COLOR)
// Neutral (Khronos PBR Neutral) keeps kit and turf hues true and rolls the
// highlights off gently: whites (kit, pads, ball, creases) stay white without
// clipping, where ACES pushed reds to orange and greens to yellow.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.matrixAutoUpdate = false;            // (never moves: else it forces every world matrix every frame, render/drawCost.js)
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 700);
const rig = new THREE.Group();
rig.name = 'playerRig';
rig.add(camera);
scene.add(rig);

// The headset check runs while we load; its answer is shown once we are ready.
const vrBtn = document.getElementById('enter-vr');
const arBtn = document.getElementById('enter-mr');
let game = null;
const xr = new XRSessionManager(renderer, {
  onStart: (mode) => { document.body.classList.add('in-xr'); game.onXRStart(mode); },
  onEnd: () => { document.body.classList.remove('in-xr'); game.onXREnd(); },
  onStatus: setStatus,
  onReset: () => game.onReferenceReset(),
  onVisibility: (state) => game.onVisibilityChange(state),
});
const supported = xr.supported();

progress(0.02, 'Loading the players');
try {
  // The clips and shots fail soft (the procedural poses take over), the model does not.
  let n = 0;
  const one = (p) => p.then((v) => { progress(0.04 + 0.2 * (++n / 3)); return v; });
  await Promise.all([one(loadAthlete()), one(loadClips()), one(loadShots())]);
} catch (e) {
  console.error(e);
  setStatus('Could not load the player model: ' + (e.message || e));
  throw e;
}
mark('assets');
progress(0.25, 'Building the stadium');
await nextFrame();
const env = buildEnvironment(scene);
mark('stadium');
progress(0.42, 'Dressing the players');
await nextFrame();
game = new Game({ renderer, scene, camera, rig, dom: renderer.domElement, env, deferPrewarm: true });
mark('game');
progress(0.55, 'Preparing the shaders');
await nextFrame();
try {
  const w = await warmUp(game, (f, label) => progress(0.55 + 0.45 * f, label));
  timing.warm = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round(v)]));
} catch (e) { console.warn('warm-up', e); }
mark('warmup');
HTMLCanvasElement.prototype.getContext = getContext0;
game.prewarmMs = timing.warmup;
game.loadTiming = timing;
game.ready = true;
window.__game = game; // handy for debugging in the console (and the harness: everything is loaded once it is set)

game.requestXR = (kind) => { if (game.ready) xr.start(kind); };
game.xrManager = xr;
xr.onSelect = () => { if (game.wantMR != null && game.clock - game.wantMR < 8) { game.wantMR = null; xr.switchTo('ar'); } };

// Entering: compile again whatever changed since loading (a setting can swap a material), then start.
const enter = (kind) => {
  if (!game.ready) return;
  game.sfx.init();
  try { renderer.compile(scene, camera); } catch { /* compiled at first use instead */ }
  xr.start(kind);
};
supported.then((s) => {
  game.xrSupported = s;
  if (vrBtn) { vrBtn.disabled = !s.vr; vrBtn.textContent = s.vr ? 'Enter VR' : 'VR not available'; }
  if (arBtn) { arBtn.disabled = !s.ar; arBtn.textContent = s.ar ? 'Enter MR nets' : 'MR not available'; }
  setStatus(s.vr ? 'Headset ready.' : 'No WebXR headset found — desktop debug mode (see controls).');
});
vrBtn?.addEventListener('click', () => enter('vr'));
arBtn?.addEventListener('click', () => enter('ar'));
renderer.domElement.addEventListener('pointerdown', () => game.sfx.init());
document.getElementById('toggle-help')?.addEventListener('click', () => document.body.classList.toggle('help-hidden'));

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;   // the XR runtime owns the framebuffer size
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// One frame: the game's update, then the draw; each one's CPU time goes to the
// frame stats (the quality governor, the perf panel) and long frames to window.__longFrames.
renderer.setAnimationLoop((time, frame) => {
  const t0 = performance.now();
  try {
    game.frame(time, frame);
  } catch (e) {
    console.error(e);
    setStatus('Error: ' + (e.message || e));
  }
  const t1 = performance.now();
  if (game.visionActive()) game.vision.render(scene, camera);     // (vision correction: render/visionCorrect.js)
  else renderer.render(scene, camera);
  const t2 = performance.now();
  game.sampleFrame(time, t2 - t0, t1 - t0, t2 - t1);
});
