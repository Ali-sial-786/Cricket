// Mode factory: wires sessions, innings and AI for each game mode.
import { BattingSession } from './batting.js';

export function createSession(game, kind) {
  switch (kind) {
    case 'nets':
    default:
      return new BattingSession(game, { kind: 'nets', title: 'Nets · Batting' });
  }
}
