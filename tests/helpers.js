// Shared helpers for physics tests.
import { CONFIG } from '../src/config.js';

export function cfgWith(overrides = {}) {
  const c = structuredClone(CONFIG);
  for (const [k, v] of Object.entries(overrides)) Object.assign(c[k], v);
  return c;
}

export const kmh = (k) => k / 3.6;
