// Persistent settings + calibration (localStorage, every access wrapped in
// try/catch: Quest private browsing or storage quota must never break play).
import { DEFAULT_MACHINE } from '../physics/bowlingMachine.js';
import { CONFIG } from '../config.js';

const KEY_SETTINGS = 'creasevr.settings.v2';
const KEY_CAL = 'creasevr.calibration.v1';

export function loadJSON(key) {
  try {
    const s = globalThis.localStorage?.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
export function saveJSON(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function removeKey(key) {
  try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
}

export function defaultSettings() {
  return {
    difficulty: 'medium',          // easy | medium | hard
    machine: { ...DEFAULT_MACHINE },
    autoFeed: true,
    batAngleDeg: 0,                // extra tilt of the bat relative to calibration
    guardX: -0.05,                 // where your hand sits in stance (x, m): middle-and-leg
    aimAssist: true,               // pull deliveries toward the floor marker (off: the ball goes where you throw it)
    aimMarker: true,               // the floor target (left stick moves it)
    aimV: 3,
    bowlByFeel: false,             // false: pick the delivery with A / B; true: the wrist action decides it
    runUp: true,                   // run in to bowl (hold right grip / left trigger); false: bowl from the crease
    turn: 'smooth',                // right stick turns you: smooth (continuous) | snap | off
    turnV: 2,
    trail: true,
    ballBoost: true,               // draw the ball at a minimum angular size far away
    debugFrames: false,            // debug: the perf panel below your view, and the HUD footer counts long frames (window.__longFrames has them)
    quality: 'auto',               // graphics: auto (the governor, render/quality.js) | ultra | high | medium | low | minimum
    sound: true,
    volMaster: 1, volCrowd: 1, volEffects: 1, volCommentary: 1,   // the Audio tab's volumes (0..1, src/audio/mix.js)
    overs: 5,
    bowlerType: 'fast',            // your bowler: fast | medium | offspin | legspin
    contactAssist: 'normal',       // off | low | normal | high (see CONFIG.contactAssist)
    view: 'eyes',                  // eyes | helmet (eyes behind a helmet grille) | behind (third person)
    ownBody: true,                 // see a faint body (legs, feet) when you look down
    sweepDrop: true,               // holding the sweep button lowers your view to a kneeling sweeper's
    ballFinder: true,              // arrow / halo / landing ring to find the ball after a hit
    replay: 'bowler',              // off | bowler: a replay after every ball, from the bowler's end
    commentary: true,
    seenHowTo: false,
    paceMultiplier: CONFIG.bowling.paceMultiplier,
    batSpeedMultiplier: CONFIG.bat.speedMultiplier,
    hapticsScale: 1.0,
    seenSafety: false,
    bowlNeutralElevDeg: null,      // set by "Calibrate bowling release"
    // Vision correction without glasses (src/game/vision.js): your prescription for each eye
    // (sph / cyl in dioptres, axis in degrees), and the in-headset fine tuning.
    vision: { on: false, L: { sph: 0, cyl: 0, axis: 0 }, R: { sph: 0, cyl: 0, axis: 0 }, pupil: 4, tune: 0, strength: 1, steps: 2, region: 0.45, imageDist: 1.3 },
  };
}

export function loadSettings() {
  const s = defaultSettings();
  const saved = loadJSON(KEY_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) {
      if (k === 'machine' && saved.machine) s.machine = { ...s.machine, ...saved.machine };
      else if (k === 'vision' && saved.vision && typeof saved.vision === 'object') {
        s.vision = { ...s.vision, ...saved.vision, L: { ...s.vision.L, ...(saved.vision.L || {}) }, R: { ...s.vision.R, ...(saved.vision.R || {}) } };
      }
      else if (saved[k] !== undefined && (s[k] === null || typeof saved[k] === typeof s[k])) s[k] = saved[k];
    }
  }
  if (s.replay !== 'off') s.replay = 'bowler';         // (the batter's-view replay is gone: one camera, from the bowler's end)
  // v3 of the aiming: the floor marker is the target again (once, for everyone).
  if (!saved || saved.aimV !== 3) { s.aimAssist = true; s.aimMarker = true; s.aimV = 3; }
  // v2 of turning: the stick turns you smoothly, like turning your body (once, for everyone).
  if (!saved || saved.turnV !== 2) { s.turn = 'smooth'; s.turnV = 2; }
  return s;
}
export function saveSettings(s) { return saveJSON(KEY_SETTINGS, s); }

// Calibration: { offset: {x,y,z,w} (grip-local bat rotation), when }
export function loadCalibration() {
  const c = loadJSON(KEY_CAL);
  if (!c || !c.offset || typeof c.offset.w !== 'number') return null;
  return c;
}
export function saveCalibration(cal) { return saveJSON(KEY_CAL, cal); }
export function clearCalibration() { removeKey(KEY_CAL); }
