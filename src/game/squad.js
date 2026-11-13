// Fictional squads. Pure JS.
//
// Each side has a batting order (the top six bat in a 5-wicket game) and the
// AI batters differ: openers are steady, the middle order hits, the tail is
// easier to get out. `sigma` scales the batter's timing / placement errors
// (1 = the difficulty's standard, more = worse), `aggr` shifts how often
// they attack, `charge` how readily they come down the pitch to slow bowling.

export const SQUADS = {
  home: {
    name: 'Harbour Kings', short: 'HK',
    batters: ['J. Carter', 'K. Mensah', 'R. Tanaka', 'D. Okafor', 'S. Whitlock', 'A. Rahimi', 'T. Vance'],
  },
  away: {
    name: 'Summit Stars', short: 'SS',
    batters: ['M. Delgado', 'P. Nwosu', 'H. Lindqvist', 'C. Bairam', 'O. Fairweather', 'N. Kapule', 'E. Brandt'],
  },
};

export const BAT_PROFILES = [
  { role: 'opener', sigma: 1.0, aggr: -0.06, charge: 0.6 },
  { role: 'opener', sigma: 1.05, aggr: 0.04, charge: 0.8 },
  { role: 'number three', sigma: 0.85, aggr: 0.0, charge: 1.0 },
  { role: 'hitter', sigma: 1.15, aggr: 0.2, charge: 1.5 },
  { role: 'all-rounder', sigma: 1.2, aggr: 0.1, charge: 1.1 },
  { role: 'tail-ender', sigma: 1.5, aggr: 0.15, charge: 0.9 },
  { role: 'tail-ender', sigma: 1.75, aggr: 0.25, charge: 0.7 },
];

export function batProfile(position) { return BAT_PROFILES[Math.min(Math.max(0, position), BAT_PROFILES.length - 1)]; }
