import { Mesh, Scene } from '@forgeax/engine/three';
import { it } from 'vitest';
import { saveBrowserEvidence } from './browser-evidence.fixture';
import { PROCEDURAL_RENDER_CASES } from './procedural-addons-render.fixture';
import { browserRendererFixture, comparePixels, displayPixels } from './render.fixture';
import { renderReference } from './webgpu-reference.fixture';

const rendererFor = browserRendererFixture();
function frozenMeshPoses(scene: Scene) {
  // MorphBlendMesh.clone() invokes a constructor requiring morph geometry.
  // The oracle renders the actual geometry/weights at the submitted world poses.
  const reference = new Scene();
  scene.updateMatrixWorld(true);
  scene.traverse((source) => {
    if (!(source instanceof Mesh)) return;
    const mesh = new Mesh(source.geometry, source.material).copy(source, false);
    mesh.matrix.copy(source.matrixWorld);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = true;
    reference.add(mesh);
  });
  return reference;
}
it.each(PROCEDURAL_RENDER_CASES)(
  '%s matches r187 and replays the native capture',
  { timeout: 120000 },
  async (_name, verify) => {
    await verify(rendererFor(), async (name, frame, scene, camera) => {
      const reference = await renderReference(frozenMeshPoses(scene), camera);
      await saveBrowserEvidence(`r187-round21-${name}`, frame, reference);
      comparePixels(displayPixels(frame), reference);
    });
  },
);
