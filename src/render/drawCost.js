// What the draw costs the CPU (three.js r180 draws the scene once per eye: every
// material switch re-uploads that material's uniforms twice a frame), and the
// helpers that keep it down without changing a pixel.
//
// freezeStatic(root): a subtree that never moves keeps its matrices. Each
// object's local matrix is composed once and matrixAutoUpdate goes off, so
// scene.updateMatrixWorld() only checks two flags there instead of composing
// and multiplying every frame. Only for things built once and never moved
// (the stadium, the ground, the sky); an object added under a frozen parent
// later keeps its own auto update and still follows the (fixed) parent.
// The scene itself must not auto-update its own matrix (main.js), or it
// forces every world matrix below it every frame.
export function freezeStatic(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldNeedsUpdate = false;
  });
  return root;
}
