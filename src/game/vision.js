// Vision correction without glasses (pure JS, tested in node). See src/render/visionCorrect.js
// for the GPU side and DECISIONS.md "Vision correction" for the research it follows.
//
// The headset shows its picture at a fixed distance (Quest 2 / 3S lenses: about 1.3 m). An eye
// that cannot focus there sees every pixel spread into a blur: geometrically, the pupil mapped
// by the eye's focusing error -- a uniformly lit ellipse, the same for every pixel (the PSF).
// The game pre-corrects the picture against that PSF (ChromaCorrect, Guzel et al. 2023: find the
// displayed image s in [0, 1] whose blurred version is closest to the intended one, starting
// from it), so the blur in the eye undoes some of the softness. It cannot bring back detail the
// blur wipes out entirely, and contrast suffers: a help, not glasses.
//
// Prescriptions as written by an optician (minus cylinder or plus, TABO axis 0-180 degrees,
// measured counter-clockwise as the examiner looks at you).

export const VISION = {
  imageDist: 1.3,        // m: where the Quest 2 / 3S lenses put the picture (Carmack's figure for Quest 2; same lenses)
  pupil: 4.0,            // mm: the pupil in a headset (3-5); the blur grows with it
  accom: 2.0,            // D: focusing the eye can still add (a long-sighted eye uses it; less with age)
  energy: 0.92,          // the kernel keeps its strongest taps holding this much of the light (the rest are a faint halo)
  maxTaps: 72,           // per eye, after pairing (uniform budget)
  maxRadius: 14,         // px: a blur bigger than this is beyond help (and beyond the uniform budget)
  steps: 2,              // projected-gradient steps a frame (they carry over from frame to frame: a still view gets 60 in half a second)
  mu: 1.8,               // their size (< 2: the PSF passes no frequency above 1)
};

const DEG = Math.PI / 180;

// The eye's focusing error along its two principal meridians (D, signed: + = focused in front
// of the retina, i.e. too strong) when it looks at the picture: rx { sph, cyl, axis }, plus the
// fine-tune `tune` (D) the player sets in the headset. The eye focuses (accommodates) as well as it
// can: between the two meridians, from 0 to `accom` D.
//   e1 along the cylinder axis (power sph), e2 across it (power sph + cyl);
//   angle: the axis direction in the picture, rad counter-clockwise from +x, as YOU see it
//   (the examiner's counter-clockwise is the wearer's clockwise: angle = -axis).
export function eyeError(rx = {}, { imageDist = VISION.imageDist, accom = VISION.accom, tune = 0 } = {}) {
  const sph = num(rx.sph), cyl = num(rx.cyl), axis = num(rx.axis);
  const V = 1 / Math.max(0.2, imageDist);                 // D of focusing an unaided normal eye needs
  // focusing each meridian needs (a short-sighted eye, sph < 0, needs less: negative = cannot relax that far)
  const need1 = V + sph, need2 = V + sph + cyl;
  const A = Math.min(Math.max(0, (need1 + need2) / 2), Math.max(0, accom));
  return { e1: A - need1 + tune, e2: A - need2 + tune, angle: -axis * DEG };
}

// The blur ellipse (semi-axes in px along the axis direction and across it) for a pupil of
// `pupil` mm, at `pxPerRad` pixels per radian of view (the eye buffer's own scale at the centre).
export function blurEllipse({ e1, e2, angle }, pupil = VISION.pupil, pxPerRad = 824) {
  const r = (pupil * 1e-3) / 2 * pxPerRad;                // px per dioptre of error, radius
  return { a1: r * Math.abs(e1), a2: r * Math.abs(e2), angle };
}

// The PSF as taps for a shader: [dx, dy, w, ...] (px), w summing to 1. The ellipse is area-sampled
// (8 x 8 per pixel), its weakest taps dropped until `energy` of the light is kept, and horizontal
// neighbours merged into one bilinear fetch each (the weights split as the hardware's interpolation
// would: exact). Point-symmetric, so it is its own transpose. A blur under ~0.4 px is no blur: null.
export function psfTaps({ a1, a2, angle }, { energy = VISION.energy, maxTaps = VISION.maxTaps, maxRadius = VISION.maxRadius, sx = 1, sy = 1 } = {}) {
  if (!(Math.max(a1, a2) > 0.4)) return null;
  const A1 = Math.min(Math.max(a1, 0.35), maxRadius), A2 = Math.min(Math.max(a2, 0.35), maxRadius);
  const R = Math.ceil(Math.max(A1, A2) * Math.max(sx, sy)) + 1, ss = 8, c = Math.cos(angle), s = Math.sin(angle);
  const W = 2 * R + 1, grid = new Float64Array(W * W);
  let sum = 0;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    let n = 0;
    for (let v = 0; v < ss; v++) for (let u = 0; u < ss; u++) {
      const x = (i - R + (u + 0.5) / ss - 0.5) / sx, y = (j - R + (v + 0.5) / ss - 0.5) / sy;
      const xa = x * c + y * s, ya = -x * s + y * c;
      if ((xa / A1) ** 2 + (ya / A2) ** 2 <= 1) n++;
    }
    grid[j * W + i] = n; sum += n;
  }
  // the strongest taps holding `energy` of it (ties kept together: the kernel stays symmetric)
  const order = Array.from(grid.keys()).filter((k) => grid[k] > 0).sort((p, q) => grid[q] - grid[p]);
  const keep = new Uint8Array(W * W);
  let acc = 0, cut = Infinity;
  for (const k of order) {
    if (acc >= energy * sum && grid[k] < cut) break;
    keep[k] = 1; acc += grid[k]; cut = grid[k];
  }
  // merge along rows: (i, i+1) -> one fetch between them
  const taps = [];
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!keep[k]) continue;
      const w1 = grid[k];
      if (i + 1 < W && keep[k + 1]) {
        const w2 = grid[k + 1];
        taps.push(i - R + w2 / (w1 + w2), j - R, w1 + w2);
        i++;
      } else taps.push(i - R, j - R, w1);
    }
  }
  // (a kernel too big for the budget: the weakest merged fetches go too)
  let n = taps.length / 3;
  if (n > maxTaps) {
    const idx = Array.from({ length: n }, (_, i) => i).sort((p, q) => taps[q * 3 + 2] - taps[p * 3 + 2]).slice(0, maxTaps);
    const t2 = []; for (const i of idx) t2.push(taps[i * 3], taps[i * 3 + 1], taps[i * 3 + 2]);
    taps.length = 0; taps.push(...t2); n = maxTaps;
  }
  let w = 0; for (let i = 2; i < taps.length; i += 3) w += taps[i];
  for (let i = 2; i < taps.length; i += 3) taps[i] /= w;
  return new Float32Array(taps);
}

// Everything the GPU needs for one eye: its taps, or null (nothing to correct).
export function eyeKernel(rx, opts = {}, pxPerRad = 824, pxAspect = 1) {
  const err = eyeError(rx, opts);
  const ell = blurEllipse(err, opts.pupil ?? VISION.pupil, pxPerRad);
  return { err, ell, taps: psfTaps(ell, { sy: pxAspect }) };
}

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
