"""Check sheets: video frames of a take (cropped to the batter, MediaPipe's 2D
skeleton drawn on: left limbs blue, right red) above the cleaned, retargeted
figure seen side-on (from the off side, bowler to the right) and front-on
(from the bowler, off side to the left).

Usage: python sheet.py <video> <posedir> <stick.json from build_video_shots --debug> <seg> <out.jpg> [n frames | t1,t2,...]
"""
import sys, json
import numpy as np, cv2

video, posedir, stick, seg, out = sys.argv[1:6]
seg = int(seg)
S = json.load(open(stick)); J = S['joints']; F = np.array(S['frames']); t0 = S['t0']; ev = S['events']
ix = {n: i for i, n in enumerate(J)}
if len(sys.argv) > 6 and ',' in sys.argv[6]:
    times = [float(v) for v in sys.argv[6].split(',')]
else:
    nn = int(sys.argv[6]) if len(sys.argv) > 6 else 8
    times = list(np.linspace(0, (len(F) - 1) / 30, nn))
d = np.load(f'{posedir}/seg_{seg:02d}.npz'); I = d['img']; fr = list(d['frames'])
cap = cv2.VideoCapture(video)
B = [('hips', 'spine'), ('spine', 'chest'), ('chest', 'neck'), ('neck', 'head'), ('chest', 'shoulderL'), ('shoulderL', 'elbowL'), ('elbowL', 'handL'),
     ('chest', 'shoulderR'), ('shoulderR', 'elbowR'), ('elbowR', 'handR'), ('hips', 'hipL'), ('hipL', 'kneeL'), ('kneeL', 'ankleL'), ('ankleL', 'heelL'), ('heelL', 'ballL'), ('ankleL', 'ballL'),
     ('hips', 'hipR'), ('hipR', 'kneeR'), ('kneeR', 'ankleR'), ('ankleR', 'heelR'), ('heelR', 'ballR'), ('ankleR', 'ballR')]
E2 = [(11, 12), (23, 24), (11, 23), (12, 24)]; EL = [(11, 13), (13, 15), (23, 25), (25, 27), (27, 29), (29, 31), (27, 31)]; ER = [(a + 1, b + 1) for a, b in EL]
f0 = int(round(t0 * 30))
idx = [fr.index(f) for f in range(f0, f0 + len(F)) if f in fr]
P = I[idx]
cx, cy = np.nanmedian(P[:, :, 0]), np.nanmedian(P[:, :, 1])
s = int(max(np.nanpercentile(P[:, :, 1], 99.5) - np.nanpercentile(P[:, :, 1], 0.5), np.nanpercentile(P[:, :, 0], 99.5) - np.nanpercentile(P[:, :, 0], 0.5)) * 0.62 + 50)
SZ = 200; SC = 70.0
cols = []
for t in times:
    k = min(len(F) - 1, int(round(t * 30)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, f0 + k); ok, im = cap.read()
    Pk = I[fr.index(f0 + k)]
    for es, c in ((E2, (0, 200, 0)), (EL, (255, 80, 0)), (ER, (0, 0, 255))):
        for a, b in es:
            cv2.line(im, (int(Pk[a, 0]), int(Pk[a, 1])), (int(Pk[b, 0]), int(Pk[b, 1])), c, 2)
    y0, x0 = int(max(0, cy - s)), int(max(0, cx - s))
    crop = cv2.resize(im[y0:int(cy + s), x0:int(cx + s)], (SZ, SZ))
    lab = min(ev, key=lambda e: abs(ev[e] - t)) if min(abs(ev[e] - t) for e in ev) < 0.02 else ''
    cv2.putText(crop, f'{t0 + t:.2f} {lab}', (3, 14), 0, 0.45, (0, 0, 0), 2); cv2.putText(crop, f'{t0 + t:.2f} {lab}', (3, 14), 0, 0.45, (255, 255, 255), 1)
    panels = [crop]
    Q = F[k]
    for view in ('side', 'front'):
        p = np.full((SZ, SZ, 3), 30, np.uint8)
        cv2.line(p, (0, SZ - 18), (SZ, SZ - 18), (60, 90, 60), 1)
        def pt(v):
            u = v[0] if view == 'side' else -v[2]
            return (int(SZ / 2 + u * SC), int(SZ - 18 - v[1] * SC))
        for xg in (-1, -0.5, 0, 0.5, 1):
            cv2.line(p, (int(SZ / 2 + xg * SC), SZ - 18), (int(SZ / 2 + xg * SC), SZ - 14), (90, 120, 90), 1)
        for a, b in B:
            c = (255, 140, 80) if a.endswith('L') or b.endswith('L') else (80, 80, 255) if a.endswith('R') or b.endswith('R') else (220, 220, 220)
            cv2.line(p, pt(Q[ix[a]]), pt(Q[ix[b]]), c, 2)
        cv2.putText(p, view, (3, 12), 0, 0.4, (200, 200, 200), 1)
        panels.append(p)
    cols.append(np.vstack(panels))
cv2.imwrite(out, np.hstack(cols))
