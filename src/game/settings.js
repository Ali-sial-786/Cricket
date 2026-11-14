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
    turn: 'snap',                  // right stick looks around: snap | smooth | off
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
  // v3 of the aiming: the floor marker is the target again (once, for everyone).
  if (!saved || saved.aimV !== 3) { s.aimAssist = true; s.aimMarker = true; s.aimV = 3; }
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
