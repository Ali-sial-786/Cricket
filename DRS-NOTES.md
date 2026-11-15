# DRS / LBW / edges: integration notes

Ball tracking and the board were ported from courtside (`game/cricket/lbw.gd`, `drs.gd`, `umpire.gd`);
the edge checks (contact log, Snicko, Hot Spot), caught reviews, your appeal and the review counts are
this repo's own.

- `src/game/lbw.js` — pure LBW law, ball tracking, review rules, umpire error model.
- `src/game/edgeTrack.js` — pure: the per-delivery **contact log** (what the ball really touched, when),
  the Snicko trace, the Hot Spot marks, the umpire / fielder / AI-review rules for edges, the edge rows.
- `src/game/reviews.js` — reviews per side per innings (2), kept on overturn / umpire's call.
- `src/game/lbwFlow.js` — the flow: appeal (fielders, or you), on-field decision, review, final.
  LBW and caught (edge) appeals both run through `LbwFlow` (`kind: 'lbw' | 'caught'`).
- `src/render/drsView.js` — the presentation: board, ball tracking, the edge stage, third umpire.
- `src/render/snicko.js`, `src/render/hotspot.js` — the DRS screen's two pictures (canvas 2D).
- Tests: `tests/lbw.test.js`, `tests/edgeTrack.test.js`, `tests/appealFlow.test.js`.

Frame is this repo's: batting stumps at the origin, ball travels +Z, **off = +X, leg = -X**.

## 1. The contact log (edge truth)

`game.contacts = new ContactLog(CONFIG).attach(world)` (game.js). `attach` wraps `world.substep`, so the
log sees the ball and the bats every 1/480 s; it resets itself when `ball.launchTime` changes (every
delivery) and ignores a fielder's throw carrying on (`ball.thrown`, fielding.js relaunch). Events:

| type | when | what |
|---|---|---|
| `bat` | the physics `bat` event (also the glove: a handle contact above `shoulderY + 5 cm`) | `where` face / edge / toe / shoulder / back / handle / glove; `thickness` full / thick / thin / faint from the **overlap** (share of the ball's width over the bat's outline, `(hx + R - |x|) / 2R`: < 0.22 faint, < 0.5 thin); `edge` outside / inside / top / bottom (the touched edge's outward direction in the world); `strength` 0..1; `u` (across, ±1 = edges), `v` / `vBlade` (up the bat); `deflection` (deg) |
| `pad` / `body` | the first step after the session's `padHit` + `deflectOffPad` (or at once, `LbwFlow.notePad`) | position, speed, `u` (in the pad box, + off side), `v` (height); `body` above 0.6 m (thigh) |
| `ground` | the toe of the **visible** bat (no invisible contact-assist toe) comes down through 6 mm at ≥ 0.4 m/s | time (interpolated between steps), where, speed |

`frames`: while the ball is within 2.6 m of the striker's bat grip, every step: the ball in the world
and in the bat's frame (`lx` across the face, `ly` up the bat, `lz` out of the front face), its distance
to the bat surface `d`, and the bat's pose (`px..qw`). Closest approach = the "pass"
(`passOf`). `snapshot()` freezes a copy for the review.

`edgeTruth(log)` → `{ bat, pad, ground[], pass, touched, batFirst, batPad, thickness, where, noise }`.
`noise`: `'noise'` (bat on ground or the pad within 35 ms of the pass, bat within 15 cm), `'close'`
(< 5 cm), `'near'` (< 15 cm), `'clear'`.

## 2. Snicko and Hot Spot

`snickoTrace(log, { seed })` — the stump-mic trace from ±44 ms round the pass (stretched to show any
noise within 120 ms): seeded noise floor ~0.045; a bat contact = a sharp spike exactly at the contact
(0.55 ms attack, 3.2 ms ring), height `0.16 + 0.82 × strength` (faint ≈ 0.4, middle ≈ 1); pad / body =
a broad (6.8 ms), low (0.14–0.3) bump; bat on the ground = a spike (0.34–0.66) that does **not** line up
with the ball at the bat. Camera frames every 4 ms (250 fps), one exactly on the pass.

`hotspotMarks(log)` — one bright mark per bat / pad contact (size by strength). `hotspot.js
hotspotLayout()` places them: FRONT-ON (from the bowler's end: off side on the left) and a close-up of
the blade, with a caption ("MARK ON THE OUTSIDE EDGE · 26 cm FROM THE TOE"). No contact, no mark.

`edgeRows(truth, { review })` — the board rows `SNICKO` and `HOT SPOT`, law colours (green = condition
for OUT met). For `'caught'` an edge is what makes it out; for `'lbw'` the bat first makes it not out.

## 3. The flows (lbwFlow.js)

All run while the session is in `'review'` (so the order stays ball → appeal / decision / review →
verdict → replay → next ball). The session reads `this.lbw.result(notOutLbw)` when it is done.

| entry | from | does |
|---|---|---|
| `start({ impactState, path, shotOffered, playerIsBatter, by })` | pad strike (both sessions) | `by: 'fielders'` appeal; `'offer'` = your window (bowling, the fielders quiet: `!shouldAppeal(track)`, or `fieldersQuiet(track)`: 15% of close (`isMarginal`) shouts; an obvious one always goes up) |
| `caught(res, { notOut, path, playerIsBatter })` | `field.result()` is a catch | false (out as it stands) unless `edgeQuestion(truth, { catchDist })`: an edge / glove / bat-pad, a thick edge only if caught within 30 m. Then the fielders appeal (thick 1, thin 0.95, faint 0.7; your own catch always), or you may (bowling), or not out (batting, nobody went up) |
| `behind({ notOut, path, playerIsBatter })` | the keeper took a ball that beat the bat, batter in his ground | only if it passed within 30 cm (or a noise): fielders appeal (noise 0.6, close 0.42, near 0.12), else your window when within 12 cm or a noise. Not against you on easy |
| `batPad(ball, at, box, opts)` | an edge (`hit.edge`) then the pad within 0.15 s | deflects it (softer), logs the pad; if the projection says out and the fielders did not hear the edge (faint 0.1 … thick 0.75) → LBW appeal (`'appeal'`), else the fielders plan again (`replanAfterPad`, `'play'`) |

Phases: `window` (2.6 s; hint "APPEAL · press B", B swallowed when used) → `appeal` (1.7 s) → umpire's
call (`decision`: your review with A while it is up, or the AI's) → `review` (the board) → `final`.

Umpire: LBW = `umpireDecision`, with `batFirst` only if he heard it (`umpireHearsEdge`: misses a faint
edge 38%, thin 12%, thick 2% at medium accuracy 0.86). Caught = `umpireCaught`: an edge given (1 − miss);
no edge given out at noise 24%, close 8%, near 2.5%, clear 1%. All scaled by `(1 − accuracy) / 0.14`
(easy 0.8, medium 0.86, hard 0.92).

AI review (`aiWillReview`): LBW wrong 0.7 / right 0.07; caught, AI batting (given out) wrong 0.92 /
right 0.06; caught, AI fielding (given not out) wrong 0.6 / right 0.06. Only with reviews left.

Reviews: `new Reviews(CONFIG.match.reviews)` (2) per session = per innings; `settleReview(reviews, side,
result)`: lost unless `reviewKept` (overturned or umpire's call). HUD players line: "Reviews · you 2 ·
them 2" (`ui.setHud({ drs })`).

## 4. The board (drsView.js)

```js
drs.startLbw({ track, deliveryPath, onFieldOut, outcome, viewerPos, edge });   // edge: edgeEvidence(log, { review: 'lbw' }) or null
drs.startCaught({ edge, deliveryPath, onFieldOut, outcome, viewerPos, title }); // edge: edgeEvidence(log, { review: 'caught' })
drs.startThird({ kind: 'run_out', end: 'batting', margin, viewerPos });
```

The **screen** (2.4 × 1.35 m canvas, `drs.screen`) hangs beside the board on the side toward the middle
of the pitch (above the eye line: nothing on the pitch is behind it), turned in to the viewer; it is a
child of the board mesh, so `placeBoard` / `setBoardTransform` move it too, and `Game.prewarm()` (which
compiles and uploads `drs.group`) covers it. It is redrawn only when a frame steps.

Edge stage (`EDGE_T`), from 1.2 s: **Snicko** — the third umpire steps the frames (75 ms each away from
the bat, 0.3 s on the two either side, 1.0 s on the ball at the bat; cue `spike` on a contact frame);
SNICKO row; **Hot Spot** 0.55 s later (marks bloom in at +0.5 s, cue `mark`; HOT SPOT row at +1.3 s;
2.2 s in all). Then:

- LBW: ball tracking as before, shifted after the edge stage. Bat first: a BAT row ("INSIDE EDGE
  FIRST") and straight to NOT OUT, no tracking. Without the bat involved (it never came within 40 cm)
  there is no edge stage: tracking from 1.4 s as before (10.6 s).
- Caught: the delivery tube draws to the start of the Snicko window, then its tip goes with the frame
  being shown (on to the bat and past it); a ring marks the contact; decision after Hot Spot (~10 s).

Board colours: `BOARD_COLOUR` flips the law colours — red = bad for the batter (hitting / in line /
edge on a catch / no edge in an LBW), green = good for him. Cues: `stinger`, `chime:*`, `spike`,
`mark`, `out`, `not_out`. `skip()` jumps to the result.

## 5. Things you must do around it

- Freeze play while `drs.active` (ball dead, no next delivery, no bat collisions).
- `viewerPos` is sampled once at start; call `placeBoard()` again if the viewer moves ends.
- `hide()` clears `done`/`active` (so an `if (drs.done)` block runs once) but keeps `result`.

## 6. Known gaps

- No camera work: the viewer stays put; Snicko's "camera" and Hot Spot are drawn pictures on the screen
  (front-on Snicko frames are the real recorded ball and bat pose; Hot Spot's batter is a stylised
  silhouette with the bat upright, the marks at the true place on the bat / pad).
- The physics has no truly feathered edge: the thinnest edge still takes ~28% off the ball. "Faint" is
  geometric (how much of the ball overlapped the bat), which is what Snicko / Hot Spot show.
- Your bat's contact assist pulls contacts toward the middle (magnet), so your own edges are mostly
  "thick"; the AI's bat has no assist.
- A bat-pad deflection replans the fielders (`field.onHit` again); a catch you were already under is kept.
- Body contacts other than the pads are not simulated (the pad box is the only body collider); `body`
  is a pad strike above the knee roll.
- Right-handers only: off = +X is hard-wired.
