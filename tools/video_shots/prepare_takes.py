"""Cut the pose tracks (extract_pose.py) into takes, repair, score and canonicalise them.

For every swing in every camera segment of index.json (a peak of the hands'
speed): a take from the settled stance before it to ~1 s after it. Per take:
  * left/right repair: legs and arms are relabelled frame by frame (Viterbi
    over 'as given' / 'swapped') so that each limb moves continuously, in the
    image (pixels, the camera is static) and in the model's 3D world;
  * canonical frame: bowler toward +X (the stance line of hips, shoulders and
    feet), +Y up, +Z the way a right-hander faces (the off side);
  * foot contacts from the image: a foot whose heel/ankle/toe hardly move in
    the picture is planted (static tripod cameras);
  * scores: visibility, relabelled frames, bone-length stability, jumps, legs
    crossed, how settled the stance is;
  * events: contact = fastest hands (sub-frame), top of the backlift, finish.
Writes takes.json (all takes, for scoring) and the chosen takes' data.

Usage: python prepare_takes.py <index.json> <posedir> <out.json> [selection.json]
(with selection.json only the chosen takes are written: tools/video_shots/takes.json)
"""
import sys, json
import numpy as np

index, posedir, outp = sys.argv[1:4]
IDX = json.load(open(index))
FPS = 30
KEEP = [0, 7, 8, 11, 12, 13, 14, 15, 16, 19, 20, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
LEGS = [(25, 26), (27, 28), (29, 30), (31, 32)]
ARMS = [(13, 14), (15, 16), (17, 18), (19, 20), (21, 22)]


def sm(x, s):
    x = np.asarray(x, float)
    if s < 0.3:
        return x.copy()
    r = int(np.ceil(3 * s)); k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2); k /= k.sum()
    pad = [(r, r)] + [(0, 0)] * (x.ndim - 1)
    xp = np.pad(x, pad, mode='edge')
    return np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 0, xp)


def swapped(P, pairs):
    Q = P.copy()
    for a, b in pairs:
        Q[..., a, :], Q[..., b, :] = P[..., b, :], P[..., a, :]
    return Q


def viterbi_swap(I2, pairs, scale):
    """Per frame: 0 = labels as given, 1 = this limb group's left/right swapped, so that each
    limb moves continuously in the picture (the camera is static)."""
    n = len(I2)
    idx = [j for p in pairs for j in p]
    cand = [(swapped(I2, pairs) if s else I2)[:, idx, :2] / scale for s in (0, 1)]
    cost = np.zeros((n, 2)); back = np.zeros((n, 2), int)
    cost[0] = [0, 0.5]                            # prefer the labels as given
    for t in range(1, n):
        for s in (0, 1):
            best = None
            for r in (0, 1):
                d = np.nansum((cand[s][t] - cand[r][t - 1]) ** 2)
                c = cost[t - 1, r] + d + (0.004 if s != r else 0) + (0.02 if s else 0)
                if best is None or c < best:
                    best, back[t, s] = c, r
            cost[t, s] = best
    st = np.zeros(n, int); st[-1] = int(np.argmin(cost[-1]))
    for t in range(n - 1, 0, -1):
        st[t - 1] = back[t, st[t]]
    return st


def viterbi_legs(I2, scale):
    """Legs: the knees and the feet are relabelled separately (MediaPipe sometimes pairs one
    leg's knee with the other's ankle where the legs cross). Four states per frame (knee pair
    swapped?, foot pair swapped?); cost: every joint moving continuously in the picture and
    thigh and shin keeping their length."""
    n = len(I2)
    K = [(25, 26)]; Fp = [(27, 28), (29, 30), (31, 32)]
    states = [(0, 0), (1, 0), (0, 1), (1, 1)]
    cands = []
    for ks, fs in states:
        A = I2.copy()
        if ks: A = swapped(A, K)
        if fs: A = swapped(A, Fp)
        cands.append(A[:, [23, 24, 25, 26, 27, 28, 29, 30, 31, 32], :2] / scale)
    A0 = cands[0]
    th = np.median(np.r_[np.linalg.norm(A0[:, 0] - A0[:, 2], axis=1), np.linalg.norm(A0[:, 1] - A0[:, 3], axis=1)])
    sh = np.median(np.r_[np.linalg.norm(A0[:, 2] - A0[:, 4], axis=1), np.linalg.norm(A0[:, 3] - A0[:, 5], axis=1)])
    def data(A):
        t1 = np.linalg.norm(A[:, 0] - A[:, 2], axis=1); t2 = np.linalg.norm(A[:, 1] - A[:, 3], axis=1)
        s1 = np.linalg.norm(A[:, 2] - A[:, 4], axis=1); s2 = np.linalg.norm(A[:, 3] - A[:, 5], axis=1)
        return 0.02 * (((t1 - th) / th) ** 2 + ((t2 - th) / th) ** 2 + ((s1 - sh) / sh) ** 2 + ((s2 - sh) / sh) ** 2)
    D = [data(A) for A in cands]
    S = len(states)
    cost = np.zeros((n, S)); back = np.zeros((n, S), int)
    cost[0] = [D[s][0] + (0 if s == 0 else 0.5) for s in range(S)]
    for t in range(1, n):
        for s in range(S):
            best = None
            for r in range(S):
                d = np.sum((cands[s][t, 2:] - cands[r][t - 1, 2:]) ** 2)
                c = cost[t - 1, r] + d + (0.004 if s != r else 0)
                if best is None or c < best:
                    best, back[t, s] = c, r
            cost[t, s] = best + D[s][t] + (0.02 if s else 0)
    st = np.zeros(n, int); st[-1] = int(np.argmin(cost[-1]))
    for t in range(n - 1, 0, -1):
        st[t - 1] = back[t, st[t]]
    return [states[k] for k in st]


def agree_world(I, W, pairs):
    """MediaPipe's 3D pose can swap legs (or arms) where its 2D pose does not: per frame,
    give the 3D limbs the labels under which they project best onto the 2D ones
    (the world pose is camera-aligned: x right, y down, hip-centred)."""
    idx = [j for p in pairs for j in p]
    fixed = 0
    for t in range(len(I)):
        hc = (I[t, 23, :2] + I[t, 24, :2]) / 2
        a = I[t, idx, :2] - hc
        best = None
        for sw in (0, 1):
            Wt = swapped(W[t], pairs) if sw else W[t]
            b = Wt[idx, :2]
            k = np.sum(a * b) / max(np.sum(b * b), 1e-9)          # least-squares scale
            e = np.sum((a - k * b) ** 2)
            if best is None or e < best[0]:
                best = (e, sw)
        if best[1]:
            W[t] = swapped(W[t], pairs); fixed += 1
    return fixed


def drop_muddles(I, W, scale, joints, thr):
    """Frames where a limb's joints jump away from their neighbours' and back (MediaPipe
    muddling the legs where the bat crosses them): replaced by interpolation from the good
    frames either side, in the picture and in 3D. Returns the mask of replaced frames."""
    n = len(I)
    bad = np.zeros(n, bool)
    for j in joints:
        p = I[:, j, :2]
        for t in range(n):
            a, b = max(0, t - 7), min(n, t + 8)
            med = np.median(p[a:b], axis=0)
            if np.linalg.norm(p[t] - med) / scale > thr:
                bad[t] = True
    bad = bad | np.r_[False, bad[:-1]] | np.r_[bad[1:], False]
    good = np.flatnonzero(~bad)
    if len(good) < 2:
        return bad
    for arr in (I, W):
        for j in joints:
            for c in range(arr.shape[2]):
                arr[bad, j, c] = np.interp(np.flatnonzero(bad), good, arr[good, j, c])
    return bad


def label_at(seg, t):
    for a, b, lab in seg.get('labels', []):
        if a <= t < b:
            return lab
    return seg['label']


takes = []
for seg in IDX['segments']:
    d = np.load(f"{posedir}/seg_{seg['id']:02d}.npz")
    I, W, FR = d['img'].astype(float), d['world'].astype(float), d['frames']
    n = len(FR)
    ok = ~np.isnan(I[:, 0, 0])
    # fill the odd missing frame
    for arr in (I, W):
        for j in range(33):
            for c in range(arr.shape[2]):
                v = arr[:, j, c]; m = np.isnan(v)
                if m.any() and (~m).any():
                    v[m] = np.interp(np.flatnonzero(m), np.flatnonzero(~m), v[~m])
    # body size in pixels: shoulders to ankles
    scale = np.nanmedian(np.linalg.norm((I[:, 11, :2] + I[:, 12, :2]) / 2 - (I[:, 27, :2] + I[:, 28, :2]) / 2, axis=1))
    # left/right repair over the whole segment
    LJ = [j for p in LEGS for j in p]; AJ = [j for p in ARMS for j in p]
    sl = np.zeros(n, int); sa = viterbi_swap(I, ARMS, scale)
    for t, (ks, fs) in enumerate(viterbi_legs(I, scale)):
        for flag, pairs in ((ks, [(25, 26)]), (fs, [(27, 28), (29, 30), (31, 32)])):
            if flag:
                I[t] = swapped(I[t], pairs); W[t] = swapped(W[t], pairs); sl[t] = 1
    for t in range(n):
        if sa[t]:
            I[t] = swapped(I[t], ARMS); W[t] = swapped(W[t], ARMS)
    mud = drop_muddles(I, W, scale, LJ, 0.07); mud |= drop_muddles(I, W, scale, LJ, 0.06)         # (arms move too fast through the swing for this; they are the bat's in the game)
    sl2 = viterbi_swap(I, LEGS, scale)                 # whole legs, once more over the repaired track
    for t in range(n):
        if sl2[t]:
            I[t] = swapped(I[t], LEGS); W[t] = swapped(W[t], LEGS)
    sl = sl | sl2
    wfix = np.zeros(n, int)
    for t in range(n):
        Wl = W[t].copy()
        agree_world(I[t:t + 1], W[t:t + 1], LEGS); agree_world(I[t:t + 1], W[t:t + 1], ARMS)
        wfix[t] = int(not np.allclose(Wl, W[t], equal_nan=True))
    hand = (W[:, 15, :3] + W[:, 16, :3]) / 2
    hv = sm(np.r_[0, np.linalg.norm(np.diff(hand, axis=0), axis=1) * FPS], 2)
    # activity: how fast the whole pose changes (body frame)
    act = sm(np.r_[0, np.nanmean(np.linalg.norm(np.diff(W[:, KEEP, :3], axis=0), axis=2), axis=1) * FPS], 3)
    peaks = [i for i in range(n) if hv[i] > 3.0 and hv[i] == hv[max(0, i - 25):i + 26].max()]
    for c in peaks:
        # stance: the stillest frame 0.6-1.6 s before the swing peak (latest one nearly as still)
        lo, hi = max(0, c - int(1.6 * FPS)), max(0, c - int(0.6 * FPS))
        if hi - lo < 5:
            continue
        best = act[lo:hi + 1].min()
        s = next(f for f in range(hi, lo - 1, -1) if act[f] <= best * 1.25 + 0.05)
        e = min(n - 1, c + int(1.0 * FPS))
        sel = slice(s, e + 1)
        Ii, Wi = I[sel], W[sel]
        m = e - s + 1
        # --- canonical frame from the stance (first 6 frames)
        st = slice(0, 6)
        Lv = (Wi[st, 23, :3] - Wi[st, 24, :3]).mean(0) + (Wi[st, 11, :3] - Wi[st, 12, :3]).mean(0) + 0.5 * (Wi[st, 27, :3] - Wi[st, 28, :3]).mean(0)
        up = np.array([0, -1.0, 0])
        X = Lv - up * Lv.dot(up); X /= np.linalg.norm(X)
        Z = np.cross(X, up)
        R = np.stack([X, up, Z])                     # rows: canonical axes in camera coords
        C = Wi[:, :, :3] @ R.T                        # (m,33,3) canonical, hip-centred, metres
        az = float(np.degrees(np.arctan2(X[0], -X[2])))   # 0: bowler toward the camera, +90: to the image's right
        # --- foot contacts from the image (static camera): heel, ankle, toe speeds, in body heights per second
        fv = {}
        for sd, js in (('L', (27, 29, 31)), ('R', (28, 30, 32))):
            p = sm(Ii[:, js, :2], 1.0)
            v = np.r_[0, np.median(np.linalg.norm(np.diff(p, axis=0), axis=2), axis=1)] * FPS / scale * 1.35   # ~metres/s
            fv[sd] = sm(v, 1.0)
        # --- scores
        vis = float(np.mean(Ii[:, [11, 12, 23, 24, 25, 26, 27, 28], 3]))
        visLow = float(np.mean(Ii[:, [25, 26, 27, 28], 3] < 0.5))
        bl = []
        for a, b in ((23, 25), (25, 27), (24, 26), (26, 28), (11, 13), (13, 15), (12, 14), (14, 16)):
            Lb = np.linalg.norm(Wi[:, a, :3] - Wi[:, b, :3], axis=1); bl.append(np.std(Lb) / np.mean(Lb))
        jump = float(np.max(np.linalg.norm(np.diff(Ii[:, KEEP, :2], axis=0), axis=2)) / scale)
        relab = int(np.sum(sl[sel] != sl[max(0, s - 1):e][:m]) + np.sum(sa[sel] != sa[max(0, s - 1):e][:m]))
        relabFrames = int(np.sum(sl[sel]) + np.sum(sa[sel]))
        crossed = float(np.mean(C[:, 27, 0] < C[:, 28, 0] - 0.05))
        pel = C[:, 23] - C[:, 24]; pyaw = np.unwrap(np.arctan2(pel[:, 2], pel[:, 0]))
        flip = float(np.max(np.abs(np.diff(pyaw)))) if m > 1 else 0
        thigh = np.median(np.linalg.norm(Wi[:, 23, :3] - Wi[:, 25, :3], axis=1)) + np.median(np.linalg.norm(Wi[:, 24, :3] - Wi[:, 26, :3], axis=1))
        shin = np.median(np.linalg.norm(Wi[:, 25, :3] - Wi[:, 27, :3], axis=1)) + np.median(np.linalg.norm(Wi[:, 26, :3] - Wi[:, 28, :3], axis=1))
        # --- events (frames in the take)
        hvi = hv[sel]
        ci = c - s
        y0, y1, y2 = hvi[max(ci - 1, 0)], hvi[ci], hvi[min(ci + 1, m - 1)]
        den = y0 - 2 * y1 + y2
        tc = (ci + (np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5) if abs(den) > 1e-6 else 0)) / FPS
        top = max(1, ci - int(0.6 * FPS))
        for i in range(top, max(top + 1, ci - 2)):
            if hvi[i] < hvi[top]:
                top = i
        fin = min(m - 1, ci + 4)
        while fin < m - 1 and hvi[fin] > hvi[ci] * 0.33:
            fin += 1
        t = FR[c] / FPS
        takes.append({
            'seg': seg['id'], 'view': seg['view'], 'label': label_at(seg, t), 'peak': round(float(t), 2),
            'f0': int(FR[s]), 'f1': int(FR[e]), 't0': round(FR[s] / FPS, 2), 't1': round(FR[e] / FPS, 2),
            'camAz': round(az), 'events': {'top': round(top / FPS, 3), 'contact': round(float(tc), 3), 'finish': round(fin / FPS, 3)},
            'score': {'vis': round(vis, 3), 'legVisLow': round(visLow, 3), 'boneCV': round(float(np.mean(bl)), 3), 'boneCVmax': round(float(np.max(bl)), 3),
                      'jump': round(jump, 3), 'relabels': relab, 'relabelledFrames': relabFrames, 'world3dFixed': int(wfix[sel].sum()), 'muddled': int(mud[sel].sum()), 'crossed': round(crossed, 3),
                      'pelvisFlip': round(flip, 2), 'stanceAct': round(float(best), 2), 'handPeak': round(float(hv[c]), 2)},
            'legLen': round(float((thigh + shin) / 2), 3),
            'joints': KEEP,
            'canon': np.round(C[:, KEEP], 4).tolist(),
            'img': np.round(Ii[:, KEEP, :2], 1).tolist(),
            'vis': np.round(Ii[:, KEEP, 3], 2).tolist(),
            'footV': {k: np.round(v, 3).tolist() for k, v in fv.items()},
            'pxScale': round(float(scale), 1),
        })
allTakes = takes
if len(sys.argv) > 4:
    sel = json.load(open(sys.argv[4]))['kept']
    takes = [{k: v for k, v in t.items() if k not in ('img', 'vis')} for t in takes if any(k['seg'] == t['seg'] and abs(k['peak'] - t['peak']) < 0.05 for k in sel)]
    for t in takes:
        t['canon'] = np.round(np.array(t['canon']), 3).tolist()
json.dump({'fps': FPS, 'takes': takes}, open(outp, 'w'))
takes = allTakes
for k in takes:
    s = k['score']
    print(f"{k['seg']:2d} {k['view']} {k['label'][:22]:22s} {k['t0']:6.2f}-{k['t1']:6.2f} pk {k['peak']:6.2f} az {k['camAz']:4d} vis {s['vis']:.2f} cv {s['boneCV']:.3f}/{s['boneCVmax']:.3f} jump {s['jump']:.2f} relab {s['relabels']:2d}/{s['relabelledFrames']:3d} cross {s['crossed']:.2f} flip {s['pelvisFlip']:.2f} still {s['stanceAct']:.2f} hand {s['handPeak']:.1f}")
