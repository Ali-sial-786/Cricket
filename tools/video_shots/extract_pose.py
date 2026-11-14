"""Pose extraction for the labelled coaching video (tools/video_shots/index.json).

For every camera segment in the index: find the batter (a few full-frame
detections), fix a crop round him for the whole segment (more pixels for the
landmarker), then run MediaPipe Pose Landmarker (heavy, VIDEO mode, 30 fps) on
every frame. Keeps per frame the 33 landmarks in full-frame pixels (x, y, z,
visibility, presence) and the metric world landmarks (hip-centred, camera
axes). Output: <out>/seg_<k>.npz (img [n,33,5], world [n,33,4], frames [n], crop).

Usage: <venv>/bin/python extract_pose.py <video> <index.json> <model.task> <outdir> [segment ids...]
"""
import sys, json, os
import numpy as np, cv2
import mediapipe as mp
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision

video, index, model, out = sys.argv[1:5]
only = set(int(a) for a in sys.argv[5:])
segs = json.load(open(index))['segments']
os.makedirs(out, exist_ok=True)


def landmarker(mode):
    o = vision.PoseLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path=model, delegate=mpt.BaseOptions.Delegate.CPU),
                                     running_mode=mode, num_poses=1, min_pose_detection_confidence=0.3,
                                     min_pose_presence_confidence=0.3, min_tracking_confidence=0.3)
    return vision.PoseLandmarker.create_from_options(o)


def mpimg(bgr):
    return mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))


cap = cv2.VideoCapture(video)
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))


def frames(a, b):
    cap.set(cv2.CAP_PROP_POS_FRAMES, a)
    for f in range(a, b):
        ok, im = cap.read()
        if not ok:
            return
        yield f, im


for seg in segs:
    k, a, b = seg['id'], seg['f0'], seg['f1']
    if only and k not in only:
        continue
    # 1. where the batter is: full-frame detections on a few frames (the label box masked out)
    det = landmarker(vision.RunningMode.IMAGE)
    boxes = []
    for f in np.linspace(a + 2, b - 3, 10).astype(int):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(f)); ok, im = cap.read()
        r = det.detect(mpimg(im))
        if r.pose_landmarks:
            P = np.array([(p.x * W, p.y * H) for p in r.pose_landmarks[0]])
            boxes.append([P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max()])
    det.close()
    if not boxes:
        print('segment', k, 'no batter found'); continue
    B = np.median(np.array(boxes), axis=0)
    cx, cy = (B[0] + B[2]) / 2, (B[1] + B[3]) / 2
    side = max(B[2] - B[0], B[3] - B[1]) * 2.0 + 60          # room for the stride, the bat and a sweep
    side = min(side, H)
    x0 = int(np.clip(cx - side / 2, 0, W - side)); y0 = int(np.clip(cy - side / 2, 0, H - side)); s = int(side)
    # 2. every frame, VIDEO mode (the model's own temporal tracking)
    lm = landmarker(vision.RunningMode.VIDEO)
    IMG, WLD, FR = [], [], []
    for f, im in frames(a, b):
        crop = im[y0:y0 + s, x0:x0 + s]
        if s > 768:
            crop = cv2.resize(crop, (768, 768), interpolation=cv2.INTER_AREA)
        r = lm.detect_for_video(mpimg(crop), int(round(f * 1000 / 30)))
        if r.pose_landmarks:
            IMG.append([(x0 + p.x * s, y0 + p.y * s, p.z * s, p.visibility, p.presence) for p in r.pose_landmarks[0]])
            WLD.append([(p.x, p.y, p.z, p.visibility) for p in r.pose_world_landmarks[0]])
        else:
            IMG.append([(np.nan,) * 5] * 33); WLD.append([(np.nan,) * 4] * 33)
        FR.append(f)
    lm.close()
    np.savez_compressed(os.path.join(out, f'seg_{k:02d}.npz'), img=np.array(IMG, np.float32), world=np.array(WLD, np.float32),
                        frames=np.array(FR), crop=np.array([x0, y0, s]))
    miss = int(np.isnan(np.array(IMG)[:, 0, 0]).sum())
    print(f'segment {k}: frames {a}-{b} crop {x0},{y0} {s}px, missing {miss}', flush=True)
cap.release()
