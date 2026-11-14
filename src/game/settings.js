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
    aimAssist: false,              // pull deliveries toward the floor marker (off: the ball goes where you aim)
    aimMarker: false,
    aimV: 2,
    trail: true,
    ballBoost: true,               // draw the ball at a minimum angular size far away
    sound: true,
    overs: 5,
    bowlerType: 'fast',            // your bowler: fast | medium | offspin | legspin
    contactAssist: 'normal',       // off | low | normal | high (see CONFIG.contactAssist)
    view: 'eyes',                  // eyes | helmet (eyes behind a helmet grille) | behind (third person)
    ownBody: true,                 // see a faint body (legs, feet) when you look down
    ballFinder: true,              // arrow / halo / landing ring to find the ball after a hit
    replay: 'bowler',              // off | bowler | batter: replay after every ball
    commentary: true,
    seenHowTo: false,
    paceMultiplier: CONFIG.bowling.paceMultiplier,
    batSpeedMultiplier: CONFIG.bat.speedMultiplier,
    hapticsScale: 1.0,
    seenSafety: false,
    bowlNeutralElevDeg: null,      // set by "Calibrate bowling release"
  };
}

export function loadSettings() {
  const s = defaultSettings();
  const saved = loadJSON(KEY_SETTINGS);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(s)) {
      if (k === 'machine' && saved.machine) s.machine = { ...s.machine, ...saved.machine };
      else if (saved[k] !== undefined && (s[k] === null || typeof saved[k] === typeof s[k])) s[k] = saved[k];
    }
  }
  // v2 of the aiming: no floor marker unless asked for again.
  if (!saved || saved.aimV !== 2) { s.aimAssist = false; s.aimMarker = false; s.aimV = 2; }
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
