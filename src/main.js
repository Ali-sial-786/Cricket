// Entry point: renderer, scene, rig, XR buttons, animation loop.
import * as THREE from 'three';
import { Game } from './game/game.js';
import { XRSessionManager } from './xr/session.js';

const container = document.getElementById('app');
const statusEl = document.getElementById('status');
const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.setClearColor(0x9fc4e8, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.03, 700);
const rig = new THREE.Group();
rig.name = 'playerRig';
rig.add(camera);
scene.add(rig);

const game = new Game({ renderer, scene, camera, rig, dom: renderer.domElement });
window.__game = game; // handy for debugging in the console

const xr = new XRSessionManager(renderer, {
  onStart: (mode) => { document.body.classList.add('in-xr'); game.onXRStart(mode); },
  onEnd: () => { document.body.classList.remove('in-xr'); game.onXREnd(); },
  onStatus: setStatus,
  onReset: () => game.onReferenceReset(),
  onVisibility: (state) => game.onVisibilityChange(state),
});
game.requestXR = (kind) => xr.start(kind);
game.xrManager = xr;

const vrBtn = document.getElementById('enter-vr');
const arBtn = document.getElementById('enter-mr');
xr.supported().then((s) => {
  game.xrSupported = s;
  if (vrBtn) { vrBtn.disabled = !s.vr; vrBtn.textContent = s.vr ? 'Enter VR' : 'VR not available'; }
  if (arBtn) { arBtn.disabled = !s.ar; arBtn.textContent = s.ar ? 'Enter MR nets' : 'MR not available'; }
  setStatus(s.vr ? 'Headset ready.' : 'No WebXR headset found — desktop debug mode (see controls).');
});
vrBtn?.addEventListener('click', () => { game.sfx.init(); xr.start('vr'); });
arBtn?.addEventListener('click', () => { game.sfx.init(); xr.start('ar'); });
renderer.domElement.addEventListener('pointerdown', () => game.sfx.init());
document.getElementById('toggle-help')?.addEventListener('click', () => document.body.classList.toggle('help-hidden'));

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;   // the XR runtime owns the framebuffer size
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((time, frame) => {
  try {
    game.frame(time, frame);
  } catch (e) {
    console.error(e);
    setStatus('Error: ' + (e.message || e));
  }
  renderer.render(scene, camera);
});
