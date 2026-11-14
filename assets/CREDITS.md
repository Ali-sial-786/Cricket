# Asset credits

- `assets/models/athlete.*` — converted from Courtside's `Athlete.glb` (your own project), which derives from the
  MakeHuman HM08 base mesh, skeleton and weights (CC0-1.0). Converted by `tools/build_athlete.mjs`, which reshapes
  it (head, arms), cuts and extends Courtside's shorts into trousers, paints the cricket kit panels into the cloth and
  bakes ambient occlusion. The cricket gear (`src/render/gear.js`) is procedural geometry original to this game.
- `assets/commentary/` and `assets/audio/` — from Courtside's cricket game; see the `LICENSE.txt` in each folder.
  The commentary (fictional commentators Kate Marsden and Geoff Hollins, original lines) is Courtside's British
  bank (branch `codex/cricket-british-commentary`, commit dbfa16b9), voiced with Cartesia Sonic 3.6 library voices
  (Gemma for Kate, Harrison for Geoff) and distributed under Courtside's licence and Cartesia's service terms;
  re-encoded here to 24 kHz Ogg Vorbis.
- `assets/audio/crowd/` — crowd reactions copied from Courtside's `assets/audio/crowd` (cuts of CC0 and public-domain
  recordings; provenance per clip in `assets/audio/crowd/manifest.json`).
