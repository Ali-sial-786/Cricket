// The test chart beside the Vision menu: black on white (the hardest case for the blur, and the
// easiest to judge), letters falling in size, a clock dial for astigmatism (the lines along your
// axis look sharpest), fine stripes and a cricket ball. Tune your settings until it reads best.
import * as THREE from 'three';

export function buildVisionChart() {
  const W = 1024, H = 1024;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#111'; c.strokeStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
  // letters (a row each size)
  const rows = [['E', 120], ['F P', 84], ['T O Z', 60], ['L P E D', 44], ['P E C F D', 32], ['E D F C Z P', 24], ['F E L O P Z D', 18]];
  let y = 80;
  for (const [txt, px] of rows) { c.font = `700 ${px}px Arial, sans-serif`; c.fillText(txt, W * 0.3, y); y += px * 1.25 + 8; }
  // clock dial: lines every 15 deg
  const cx = W * 0.75, cy = 230, R0 = 40, R1 = 190;
  c.lineWidth = 5;
  for (let a = 0; a < 180; a += 15) {
    const r = (a * Math.PI) / 180, dx = Math.cos(r), dy = -Math.sin(r);
    c.beginPath(); c.moveTo(cx + dx * R0, cy + dy * R0); c.lineTo(cx + dx * R1, cy + dy * R1);
    c.moveTo(cx - dx * R0, cy - dy * R0); c.lineTo(cx - dx * R1, cy - dy * R1); c.stroke();
  }
  c.font = '600 26px Arial, sans-serif';
  for (let a = 0; a < 180; a += 30) {               // the axis each line would be (TABO, as written on a prescription)
    const r = (a * Math.PI) / 180;
    c.fillText(String(a === 0 ? 180 : 180 - a), cx + Math.cos(r) * (R1 + 28), cy - Math.sin(r) * (R1 + 28));
  }
  // fine stripes
  let x = W * 0.55; const sy = 470;
  for (const p of [8, 6, 4]) {
    for (let i = 0; i < 10; i++) c.fillRect(x + i * 2 * p, sy, p, 120);
    x += 20 * p + 30;
  }
  // a cricket ball, its seam
  c.fillStyle = '#b3171d'; c.beginPath(); c.arc(W * 0.7, 800, 110, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#f2efe6'; c.lineWidth = 4;
  for (const o of [-12, 12]) { c.beginPath(); c.ellipse(W * 0.7 + o, 800, 30, 108, 0, 0, Math.PI * 2); c.stroke(); }
  c.fillStyle = '#111'; c.font = '600 30px Arial, sans-serif';
  c.fillText('Tune until this reads best', W * 0.3, H - 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  mesh.name = 'visionChart';
  mesh.visible = false;
  mesh.renderOrder = 29;
  return mesh;
}
