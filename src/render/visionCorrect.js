// Vision correction on the GPU (see src/game/vision.js for the eye and the method).
//
// With it on, a frame goes:
//   1. the scene into our own buffer (sceneRT, the headset's size: the same tone mapping and sRGB
//      as the headset's own; in VR the XR camera draws both eyes into it, as into the headset's);
//   2. for each eye, the middle of its picture (`region` of the shorter side, centred where you
//      look straight ahead through the lens -- the lens is only sharp there anyway) into a
//      working buffer, in linear light (what the eye blurs);
//   3. `steps` projected-gradient steps (ChromaCorrect's problem), from where the last frame got to:
//      its correction (s - t), moved with your head (a rotation: the scene is far), wherever what
//      is under it has not changed -- so a still picture keeps converging frame after frame
//      (60-120 steps in a second or two: nearly ChromaCorrect's optimiser), and anything that
//      moved (the ball, a bat, a step) starts again from s = t (no smearing):
//         r = PSF * s - t          (how the eye would see this picture, minus what it should see)
//         s = clamp(s - mu PSF * r, 0, 1)
//      with each eye's own PSF (its prescription: blur size, shape, axis);
//   4. the frame into the headset: the picture as rendered, the corrected middle blended in
//      (a soft edge, so nothing marks where it stops).
// It costs a frame's scene drawn off-screen (no fixed foveation for it) and 2 x steps small passes.
import * as THREE from 'three';
import { VISION, eyeKernel } from '../game/vision.js';

const MAXT = VISION.maxTaps;

const VERT = /* glsl */`
  void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
  precision highp float;
  uniform vec2 uWork;          // working buffer size (px): views side by side, each R x R
  uniform float uR;
  uniform vec3 uK[${2 * MAXT}];
  uniform int uN0, uN1;
  vec3 dec(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 enc(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  int eyeOf(vec2 p) { return int(p.x / uR); }
  // PSF * tex at working-buffer pixel p (the taps stay inside this eye's square)
  vec3 blurAt(sampler2D tex, vec2 p) {
    int e = eyeOf(p);
    float x0 = float(e) * uR + 0.5, x1 = float(e + 1) * uR - 0.5;
    int n = e == 0 ? uN0 : uN1, o = e == 0 ? 0 : ${MAXT};
    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${MAXT}; i++) {
      if (i >= n) break;
      vec3 k = uK[o + i];
      vec2 q = vec2(clamp(p.x + k.x, x0, x1), clamp(p.y + k.y, 0.5, uR - 0.5));
      acc += k.z * texture2D(tex, q / uWork).rgb;
    }
    return acc;
  }`;

// 2: the middle of each eye's picture, decoded to linear light
const EXTRACT = COMMON + /* glsl */`
  uniform sampler2D uScene;
  uniform vec2 uFb;
  uniform vec2 uO0, uO1;       // each eye's square: its lower-left corner in the frame (px)
  void main() {
    vec2 p = gl_FragCoord.xy; int e = eyeOf(p);
    vec2 f = (e == 0 ? uO0 : uO1) + p - vec2(float(e) * uR, 0.0);
    gl_FragColor = vec4(dec(texture2D(uScene, f / uFb).rgb), 1.0);
  }`;

// 3: s to start from: last frame's correction, re-projected (uM: this frame's pixel -> last frame's),
// where the picture under it (and round it, as far as the blur reaches) is unchanged; else s = t
const INIT = COMMON + /* glsl */`
  uniform sampler2D uT, uHist;
  uniform mat3 uM0, uM1;
  uniform vec2 uO0, uO1, uP0, uP1;   // this frame's squares, last frame's
  uniform float uPR, uOk, uReach, uTol;
  uniform vec2 uPWork;
  float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec2 p = gl_FragCoord.xy; int e = eyeOf(p);
    vec3 t = texture2D(uT, p / uWork).rgb;
    vec2 l = p - vec2(float(e) * uR, 0.0);
    vec3 f = vec3((e == 0 ? uO0 : uO1) + l, 1.0);
    vec3 q = (e == 0 ? uM0 : uM1) * f;
    vec2 pl = q.xy / q.z - (e == 0 ? uP0 : uP1);          // where it was in last frame's square
    float m = uReach + 1.0;
    if (uOk < 0.5 || q.z <= 0.0 || pl.x < m || pl.y < m || pl.x > uPR - m || pl.y > uPR - m) { gl_FragColor = vec4(t, 1.0); return; }
    vec2 hp = pl + vec2(float(e) * uPR, 0.0);
    float d = 0.0;
    for (int i = 0; i < 9; i++) {                          // here and on a ring as far as the blur reaches
      float a = float(i) * 0.785398;
      vec2 o = i == 8 ? vec2(0.0) : uReach * vec2(cos(a), sin(a));
      float now = lum(texture2D(uT, (p + o) / uWork).rgb), was = texture2D(uHist, (hp + o) / uPWork).a;
      d = max(d, abs(now - was) / (0.05 + now + was));
    }
    if (d > uTol) { gl_FragColor = vec4(t, 1.0); return; }
    gl_FragColor = vec4(clamp(t + texture2D(uHist, hp / uPWork).rgb, 0.0, 1.0), 1.0);
  }`;

// 3, after: what this frame leaves the next: its correction, and the picture's brightness
const STORE = COMMON + /* glsl */`
  uniform sampler2D uS, uT;
  float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec2 uv = gl_FragCoord.xy / uWork;
    vec3 t = texture2D(uT, uv).rgb;
    gl_FragColor = vec4(texture2D(uS, uv).rgb - t, lum(t));
  }`;

// 3a: r = PSF * s - t
const RESID = COMMON + /* glsl */`
  uniform sampler2D uS, uT;
  void main() {
    vec2 p = gl_FragCoord.xy;
    gl_FragColor = vec4(blurAt(uS, p) - texture2D(uT, p / uWork).rgb, 1.0);
  }`;

// 3b: s = clamp(s - mu PSF * r)     (the PSF is point-symmetric: its own transpose)
const UPDATE = COMMON + /* glsl */`
  uniform sampler2D uS, uRes;
  uniform float uMu;
  void main() {
    vec2 p = gl_FragCoord.xy;
    gl_FragColor = vec4(clamp(texture2D(uS, p / uWork).rgb - uMu * blurAt(uRes, p), 0.0, 1.0), 1.0);
  }`;

// 4: the frame, the corrected middle blended in (this eye's view only: one quad per eye)
const COMPOSITE = /* glsl */`
  precision highp float;
  uniform sampler2D uScene, uS;
  uniform vec2 uFb, uWork, uO;
  uniform float uR, uE, uMix, uFeather, uShow;
  vec3 dec(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 enc(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  void main() {
    vec2 f = gl_FragCoord.xy;
    vec4 base = texture2D(uScene, f / uFb);
    vec2 l = f - uO;
    float d = min(min(l.x, l.y), min(uR - l.x, uR - l.y));
    if (uShow < 0.5 || d <= 0.0) { gl_FragColor = base; return; }
    float w = smoothstep(0.0, uFeather, d) * uMix;
    vec3 lin = dec(base.rgb);
    vec3 s = texture2D(uS, (l + vec2(uE * uR, 0.0)) / uWork).rgb;
    gl_FragColor = vec4(enc(lin + w * (s - lin)), base.a);
  }`;

export class VisionCorrector {
  constructor(renderer) {
    this.renderer = renderer;
    this.on = false;
    this.show = true;               // false: the same frame path, the correction not blended in (A/B)
    this.cfg = { L: { sph: 0, cyl: 0, axis: 0 }, R: { sph: 0, cyl: 0, axis: 0 }, pupil: VISION.pupil, imageDist: VISION.imageDist, accom: VISION.accom, tune: 0, strength: 1, steps: VISION.steps, region: 0.45 };
    this.kernels = [null, null];
    this.kernelKey = '';
    this.info = { eyes: [] };
    this.sceneRT = null; this.work = []; this.size = new THREE.Vector2();
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(2, 2);
    const uK = { value: Array.from({ length: 2 * MAXT }, () => new THREE.Vector3()) };
    this.uK = uK;
    const common = () => ({ uWork: { value: new THREE.Vector2() }, uR: { value: 1 }, uK, uN0: { value: 0 }, uN1: { value: 0 } });
    const mat = (frag, u) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { ...common(), ...u }, depthTest: false, depthWrite: false, toneMapped: false });
    this.mExtract = mat(EXTRACT, { uScene: { value: null }, uFb: { value: new THREE.Vector2() }, uO0: { value: new THREE.Vector2() }, uO1: { value: new THREE.Vector2() } });
    this.mResid = mat(RESID, { uS: { value: null }, uT: { value: null } });
    this.mUpdate = mat(UPDATE, { uS: { value: null }, uRes: { value: null }, uMu: { value: VISION.mu } });
    this.mInit = mat(INIT, { uT: { value: null }, uHist: { value: null }, uM0: { value: new THREE.Matrix3() }, uM1: { value: new THREE.Matrix3() },
      uO0: { value: new THREE.Vector2() }, uO1: { value: new THREE.Vector2() }, uP0: { value: new THREE.Vector2() }, uP1: { value: new THREE.Vector2() },
      uPR: { value: 1 }, uOk: { value: 0 }, uReach: { value: 4 }, uTol: { value: 0.06 }, uPWork: { value: new THREE.Vector2(1, 1) } });
    this.mStore = mat(STORE, { uS: { value: null }, uT: { value: null } });
    this.hist = [];                 // [last frame's, this frame's]: rgb its correction, a its brightness
    this.prev = null;               // last frame: { views: [{ K, R }], O, R, nv, key }
    this.temporal = true;
    this.passMesh = new THREE.Mesh(quad, this.mExtract);
    this.passMesh.frustumCulled = false;
    this.passScene = new THREE.Scene(); this.passScene.add(this.passMesh);
    // the composite: one quad per view, each on that view's camera layer (XR: 1 = left, 2 = right; a monitor: 0)
    this.compScene = new THREE.Scene();
    this.comp = [0, 1].map((e) => {
      const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMPOSITE, depthTest: false, depthWrite: false, toneMapped: false,
        uniforms: { uScene: { value: null }, uS: { value: null }, uFb: { value: new THREE.Vector2() }, uWork: { value: new THREE.Vector2() }, uO: { value: new THREE.Vector2() }, uR: { value: 1 }, uE: { value: e }, uMix: { value: 1 }, uFeather: { value: 24 }, uShow: { value: 1 } } });
      const q = new THREE.Mesh(quad, m); q.frustumCulled = false; this.compScene.add(q);
      return q;
    });
  }

  configure(cfg) { Object.assign(this.cfg, cfg); this.kernelKey = ''; }

  // One frame: the scene, corrected, to whatever the renderer was about to draw to (the headset's
  // buffer in VR, the canvas on a monitor).
  render(scene, camera) {
    const r = this.renderer, out = r.getRenderTarget(), xrOn = r.xr.enabled && r.xr.isPresenting;
    if (out) this.size.set(out.width, out.height); else r.getDrawingBufferSize(this.size);
    const W = this.size.x, H = this.size.y;
    this.ensureScene(W, H);
    // 1. the scene, as the headset would get it
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    // the views: each eye's viewport and projection (a monitor: one)
    const cams = xrOn ? r.xr.getCamera().cameras : null;
    const rot = (c) => new THREE.Matrix3().setFromMatrix4(c.matrixWorld);
    const xv = cams ? cams.filter((c) => c.viewport && c.viewport.z > 0 && c.viewport.w > 0).slice(0, 2) : [];   // (an emulator's preview can show one eye)
    const views = xv.length ? xv.map((c) => ({ vp: c.viewport, P: c.projectionMatrix.elements, Rw: rot(c), layer: cams.indexOf(c) + 1 }))
      : [{ vp: new THREE.Vector4(0, 0, W, H), P: camera.projectionMatrix.elements, Rw: rot(camera), layer: 0 }];
    const nv = views.length;
    const R = Math.max(32, Math.round(this.cfg.region * Math.min(...views.map((v) => Math.min(v.vp.z, v.vp.w)))) & ~1);
    this.ensureWork(R * nv, R);
    // each eye's square, centred where straight ahead lands (an off-centre lens frustum: -P[8], -P[9] in NDC)
    const O = views.map((v) => {
      const cx = v.vp.x + (-v.P[8] * 0.5 + 0.5) * v.vp.z, cy = v.vp.y + (-v.P[9] * 0.5 + 0.5) * v.vp.w;
      return new THREE.Vector2(Math.round(Math.min(Math.max(cx - R / 2, v.vp.x), v.vp.x + v.vp.z - R)), Math.round(Math.min(Math.max(cy - R / 2, v.vp.y), v.vp.y + v.vp.w - R)));
    });
    this.updateKernels(views, xrOn);
    const live = this.kernels.slice(0, nv).some((k) => k && k.taps);
    // 2-3. the correction (not when no eye needs one)
    const xrWas = r.xr.enabled;
    if (live) {
      r.xr.enabled = false;
      const [T, S0, S1, Rs] = this.work;
      for (const m of [this.mExtract, this.mResid, this.mUpdate, this.mInit, this.mStore]) { m.uniforms.uWork.value.set(R * nv, R); m.uniforms.uR.value = R; }
      const ex = this.mExtract.uniforms;
      ex.uScene.value = this.sceneRT.texture; ex.uFb.value.set(W, H); ex.uO0.value.copy(O[0]); ex.uO1.value.copy(O[nv - 1]);
      this.pass(this.mExtract, T);
      // where to start: last frame's correction, carried over (re-projected), or s = t
      const cur = views.map((v, i) => ({ K: pixelsFromDir(v), Rw: v.Rw }));
      const P = this.prev, it = this.mInit.uniforms;
      const ok = this.temporal && P && P.nv === nv && P.key === this.kernelKey && this.hist.length === 2;
      it.uOk.value = ok ? 1 : 0;
      it.uT.value = T.texture; it.uO0.value.copy(O[0]); it.uO1.value.copy(O[nv - 1]);
      it.uReach.value = Math.max(2, Math.ceil(2 * Math.max(...this.kernels.map((k) => (k ? Math.max(k.ell.a1, k.ell.a2) : 0))))) ;
      if (ok) {
        it.uHist.value = this.hist[0].texture; it.uPR.value = P.R; it.uPWork.value.set(P.R * nv, P.R);
        it.uP0.value.copy(P.O[0]); it.uP1.value.copy(P.O[nv - 1]);
        for (let e = 0; e < 2; e++) {
          const i = Math.min(e, nv - 1);
          // this frame's pixel -> direction -> last frame's pixel
          const M = new THREE.Matrix3().copy(P.views[i].K).multiply(P.views[i].Rw.clone().transpose()).multiply(cur[i].Rw).multiply(cur[i].K.clone().invert());
          it[e === 0 ? 'uM0' : 'uM1'].value.copy(M);
        }
      }
      this.pass(this.mInit, S1);
      let s = S1, sNext = S0;
      for (let i = 0; i < this.cfg.steps; i++) {
        this.mResid.uniforms.uS.value = s.texture; this.mResid.uniforms.uT.value = T.texture;
        this.pass(this.mResid, Rs);
        this.mUpdate.uniforms.uS.value = s.texture; this.mUpdate.uniforms.uRes.value = Rs.texture;
        this.pass(this.mUpdate, sNext);
        s = sNext; sNext = sNext === S0 ? S1 : S0;
      }
      this.result = s;
      // what the next frame starts from
      if (this.temporal) {
        this.ensureHist(R * nv, R);
        const st = this.mStore.uniforms; st.uS.value = s.texture; st.uT.value = T.texture;
        this.pass(this.mStore, this.hist[1]);
        this.hist.reverse();
        this.prev = { views: cur, O: O.map((o) => o.clone()), R, nv, key: this.kernelKey };
      }
      r.xr.enabled = xrWas;
    } else this.prev = null;
    // 4. into the headset (or the canvas)
    r.setRenderTarget(out);
    for (let e = 0; e < 2; e++) {
      const q = this.comp[e], u = q.material.uniforms;
      q.visible = e < nv;
      q.layers.set(e < nv ? views[e].layer : 0);
      if (e >= nv) continue;
      u.uScene.value = this.sceneRT.texture; u.uS.value = live ? this.result.texture : null;
      u.uFb.value.set(W, H); u.uWork.value.set(R * nv, R); u.uO.value.copy(O[e]); u.uR.value = R;
      u.uMix.value = this.cfg.strength; u.uShow.value = live && this.show && this.kernels[e] && this.kernels[e].taps ? 1 : 0;
    }
    r.render(this.compScene, xrOn ? camera : this.ortho);     // (cleared first: colour and depth; the quads cover every pixel)
    this.info.R = R; this.info.views = nv; this.info.live = live;
  }

  pass(mat, rt) {
    const r = this.renderer;
    this.passMesh.material = mat;
    r.setRenderTarget(rt);
    r.render(this.passScene, this.ortho);
  }

  // Each eye's PSF taps, from its prescription and its view's own pixels-per-radian.
  updateKernels(views, xrOn) {
    const c = this.cfg;
    const scale = views.map((v) => [(v.vp.z / 2) * v.P[0], (v.vp.w / 2) * v.P[5]]);
    const key = JSON.stringify([c.L, c.R, c.pupil, c.imageDist, c.accom, c.tune, scale.map((s) => s.map((x) => Math.round(x)))]);
    if (key === this.kernelKey) return;
    this.kernelKey = key;
    const opts = { imageDist: c.imageDist, accom: c.accom, tune: c.tune, pupil: c.pupil };
    // (the left eye is view 0; a monitor shows the right-eye prescription... the better of the two would be a guess: use the right)
    const rxFor = (e) => (views.length > 1 ? (e === 0 ? c.L : c.R) : c.R);
    this.kernels = views.map((v, e) => eyeKernel(rxFor(e), opts, scale[e][0], scale[e][1] / scale[e][0]));
    for (let e = 0; e < 2; e++) {
      const k = this.kernels[Math.min(e, views.length - 1)], taps = k && k.taps;
      const n = taps ? taps.length / 3 : 0;
      for (let i = 0; i < MAXT; i++) {
        const v = this.uK.value[e * MAXT + i];
        if (i < n) v.set(taps[i * 3], taps[i * 3 + 1], taps[i * 3 + 2]); else v.set(0, 0, 0);
      }
      for (const m of [this.mExtract, this.mResid, this.mUpdate]) m.uniforms[e === 0 ? 'uN0' : 'uN1'].value = n;
    }
    this.info.eyes = this.kernels.map((k) => k && { e1: +k.err.e1.toFixed(2), e2: +k.err.e2.toFixed(2), radius: +Math.max(k.ell.a1, k.ell.a2).toFixed(2), taps: k.taps ? k.taps.length / 3 : 0 });
  }

  ensureScene(W, H) {
    if (this.sceneRT && this.sceneRT.width === W && this.sceneRT.height === H) return;
    if (this.sceneRT) this.sceneRT.dispose();
    const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, depthBuffer: true });
    rt.texture.internalFormat = 'RGBA8';     // sRGB-encoded bytes, as the headset's buffer holds them (the shaders decode)
    rt.isXRRenderTarget = true;              // (three: tone-map and encode into it as it does into the headset's)
    this.sceneRT = rt;
  }

  ensureWork(w, h) {
    if (this.work.length && this.work[0].width === w && this.work[0].height === h) return;
    for (const t of this.work) t.dispose();
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.work = [0, 1, 2, 3].map(() => new THREE.WebGLRenderTarget(w, h, opt));
  }

  ensureHist(w, h) {
    if (this.hist.length === 2 && this.hist[0].width === w && this.hist[0].height === h) return;
    for (const t of this.hist) t.dispose();
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    this.hist = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, opt));
    this.prev = null;
  }

  dispose() { this.sceneRT?.dispose(); for (const t of [...this.work, ...this.hist]) t.dispose(); }
}

// A view's pixels from view-space directions (homogeneous: pixel = K d / (K d).z), from its
// viewport and projection (column-major elements): a point at infinity, as the far scene nearly is.
export function pixelsFromDir({ vp, P }) {
  const hw = vp.z / 2, hh = vp.w / 2;
  return new THREE.Matrix3().set(
    hw * P[0], 0, hw * P[8] - (hw + vp.x),
    0, hh * P[5], hh * P[9] - (hh + vp.y),
    0, 0, -1);
}
