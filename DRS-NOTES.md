# DRS / LBW integration notes

Ported from courtside (`game/cricket/lbw.gd`, `drs.gd`, `umpire.gd`). New files only:

- `src/game/lbw.js` — pure LBW law, ball tracking, review rules, umpire error model.
- `src/render/drsView.js` — the presentation (ball tracking + third umpire).
- `tests/lbw.test.js` — 16 tests (`node --test tests/lbw.test.js`).

Frame is this repo's: batting stumps at the origin, ball travels +Z, **off = +X, leg = -X**
(courtside's X is mirrored; all zone tests were converted).

## 1. What to capture at pad impact

At the substep the ball first touches the batter's body/pad, **before** applying any deflection:

```js
const impactState = ball.clone();   // pos = impact point, vel/spin pre-deflection,
                                    // bounces + firstBounce intact, batted still false
const deliveryPath = flightSamples.slice();  // [{x,y,z}] release -> impact (see below)
const shotOffered = …;  // did the batter make a genuine attempt with the bat?
const batFirst   = …;   // had the ball touched the bat before the pad?
```

- `pitchPos` is optional: it defaults to `impactState.firstBounce` (set by `integrateFlight`).
  Pass it only if you track the bounce yourself.
- `deliveryPath`: record the ball position every frame (or every ~1/60 s) from release. Any
  density works (it is decimated to 126 points; the exact pitching point is spliced in). If
  you pass `null` the view draws straight lines release -> pitch -> impact from the machine's
  release point, which looks wrong for a bowled delivery, so do record it.
- `isLbwCandidate(ball, { batFirst, noBall })` is a cheap gate: unbatted ball moving +Z, in
  front of the stumps.
- `shotOffered` only matters when the impact is outside off. A reasonable proxy: bat speed
  above a threshold, or the bat within ~0.5 m of the ball's line, in the 0.3 s before impact.

## 2. Call sequence (LBW)

```js
import { trackLbw, umpireDecision, reviewOutcome, isLbwCandidate } from './game/lbw.js';
import { DRSView } from './render/drsView.js';
const drs = new DRSView(scene);              // once; builds nothing until first use

// on pad impact (appeal):
const track = trackLbw({ impactState, cfg: CONFIG });          // pitchPos optional
const onFieldOut = umpireDecision(track, { shotOffered, batFirst, rng, accuracy: 0.85 });
// … show the on-field decision; if the side it went against reviews:
const outcome = reviewOutcome(track, { onFieldOut, shotOffered, batFirst });
drs.startLbw({ track, deliveryPath, onFieldOut, outcome, viewerPos: headWorldPos });

// every frame while drs.active || drs.done:
drs.update(dt);
for (const cue of drs.takeCues()) playCue(cue);
if (drs.done) {
  const { out, umpiresCall, reviewKept } = drs.result;   // also on `outcome`
  if (!reviewKept) reviewsLeft[side]--;
  if (out) scoring.record({ wicket: 'lbw', … });
  drs.hide();                                  // removes everything from the scene
}
```

- No review: just apply `onFieldOut`. `lawOut(track, opts)` is the truth, `lbwDecision` gives
  `'out' | 'not_out' | 'umpires_call'`, `isMarginal(track)` says whether it was close (useful
  for a CPU side deciding to review: courtside reviews when truth != call, far more readily
  when marginal).
- `reviewOutcome` returns `{ out, umpiresCall, reviewKept, overturned, reason, rows }`.
  `rows` (`[{label, text, colour}]`) is what the board shows; the view needs it, so pass the
  whole object. `noBall: true` is accepted by `reviewOutcome` / `umpireDecision` too.
- `umpireDecision` error rate = `(1 - accuracy) × 2.6` on a marginal call, `× 0.12` on a clear
  one (halved when `batFirst`). Optional `givenRate` (courtside's `lbw_given = 0.6`): a ball
  that really is out is then given exactly that often, which leaves more for the bowling side
  to review. `rng` is any `() => [0,1)` (`makeRng()` works).
- `update()` is a no-op when nothing is showing, so it can be called unconditionally.

## 3. Third umpire (run-out / stumping)

```js
drs.startThird({ kind: 'run_out', end: 'bowling', margin, viewerPos });
```

`margin` (m) = how far the bat/foot was short of the popping crease when the wicket was
broken: `> 0` short = OUT, `0` on the line = OUT (the line is not safe), `< 0` = NOT OUT.
Pass `out: true|false` to override (e.g. airborne bat). Same `update / takeCues / done /
result / hide` loop; `result = { kind, out, umpiresCall: false, reviewKept: true }`.
Popping creases: batting end z = -1.22 (home is +Z of it), bowling end z = -18.90 (home is -Z).

## 4. Timeline, phases, cues

LBW, 10.6 s at `drs.speed = 1` (constants `LBW_T` at the top of drsView.js):

| t (s) | phase | what |
|---|---|---|
| 0 | `intro` | board "DECISION REVIEW", corridor fades in; cue `stinger`; ON-FIELD CALL row at 0.5 |
| 1.4 | `tracking` | delivery tube draws release -> pad (2.3 s); pitching spot pops as it passes |
| 3.7 | `pitching` | PITCHING row at 3.9 + `chime:<colour>`; spot takes the colour |
| 4.8 | `impact` | IMPACT row at 5.0 + chime; ring takes the colour |
| 5.9 | `wickets` | projection (pale blue, see-through) runs to the stumps (1.3 s); WICKETS row at 7.4 + chime; zone box and the ball in the plane of the stumps take the colour |
| 8.4 | `decision` | big OUT (red) / NOT OUT (green), "UMPIRE'S CALL / DECISION STANDS / DECISION OVERTURNED · REVIEW RETAINED / LOST"; cue `out` or `not_out` |
| 10.6 | `done` | `done = true`, `result` set; visuals stay until `hide()` |

Third umpire, 6.0 s: `intro` (stinger) -> `tracking` at 1.0 ("CHECKING…", crease pulses) ->
GROUNDING row + gap marker at 2.8 (`chime:red` if out, else `chime:green`) -> `decision` at
3.8 (`out` / `not_out`) -> `done` at 6.0.

Row colours: green = that condition for OUT is met, red = it is not, amber = umpire's call.

Suggested sounds: `stinger` = a short broadcast sting / low whoosh; `chime:green` a rising
two-note ping, `chime:red` a low falling tone, `chime:amber` a neutral single tone; `out` =
crowd roar + the wicket sting; `not_out` = crowd groan/applause depending on who is batting.
Mute or duck the crowd bed while `drs.active`.

Other API: `drs.skip()` (jump to the result; only the `out`/`not_out` cue is emitted),
`drs.speed`, `drs.placeBoard(viewerPos, { distance = 5, side = 0, offsetX = 2.6, height = 2.7,
scale = 1 })` (re-place any time; `side` +1 off / -1 leg / 0 auto), `drs.setBoardTransform(pos,
faceToward, scale)`, `drs.board` (the mesh), `drs.group` (everything), `drs.dispose()`.

## 5. Things you must do around it

- Freeze play while `drs.active` (ball dead, no next delivery, no bat collisions).
- Hide or ghost the batter/keeper during the LBW sequence if they block the view of the
  stumps (courtside hides all players during tracking). The view does not touch other objects.
- `viewerPos` is sampled once at start for board placement and mark scaling; if the player
  teleports/switches ends mid-review, call `placeBoard()` again.
- Board is 2.2 × 1.45 m; from the far end (20 m) pass `scale: 2.5` or put it nearer the viewer.
- `hide()` clears `done`/`active` (so a `if (drs.done)` block runs once) but keeps `result`.

## 6. Known gaps

- No slow-motion replay / Hot Spot / UltraEdge stages (courtside had "slowmo" and "hotspot"
  before tracking). `batFirst` is simply a red "BAT FIRST" row.
- No camera work: courtside cut between behind-the-bowler, side-on and a fly-in to the stumps;
  in VR the viewer stays put. From the bowler's end the wicket zone is 20 m away and small.
- The tube is drawn at true ball radius (so hitting/missing reads honestly); it is thin from
  20 m. Pitch/impact marks scale up with viewer distance, the tube does not.
- The projection uses the real physics after the pad, including a later bounce (a yorker-length
  full toss bounces before the stumps) and `seamDeg`, with no random seam. The Law says to
  assume the pre-impact path continues; courtside does the same as here.
- The pad/body collision itself, the appeal/review UI, review counts per innings, the
  no-ball check and the CPU's decision to review are not part of this port.
- Third umpire has no replay of the batter; it only marks the crease, the gap and the bat line
  across the pitch (the marker is 2 m wide, centred on middle stump, not at the bat's real x).
- Right-handers only: off = +X is hard-wired. A left-hander needs the off/leg labels swapped
  (or the inputs mirrored in X before `trackLbw`, and the drawing mirrored back).
- drsView.js was syntax-checked and smoke-run in node with a stubbed canvas (timeline, cues,
  geometry buffers); it has not been seen in a browser/headset, so colours, sizes and
  render order against the real scene are untested.
