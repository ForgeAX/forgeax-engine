import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { Update, type World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import type { GpuResidencyCache } from '../device/gpu-residency';
import { glyphTextLayoutSystem } from '../glyph-text-layout-system';
import { tilemapChunkExtractSystem } from '../tilemap-chunk-extract-system';
import { detectMobilityInvalidKind } from './mobility-validation';

let nextId = 0;
/** Derived authoring stays beside World; only completed mesh data reaches the Renderer. */
export function registerRenderSourceSystems(
  world: World,
  assets: AssetRegistry,
  meshes: Pick<GpuResidencyCache, 'updateMesh'>,
): () => void {
  const releaseTransforms = registerPropagateTransforms(world);
  const name = `renderDerived:${++nextId}`;
  const result = world.addSystem(Update, {
    name,
    queries: [],
    fn: (world) => {
      tilemapChunkExtractSystem(world, (guid) => assets.lookup(guid));
      glyphTextLayoutSystem(world, meshes).unwrap();
      detectMobilityInvalidKind(world);
    },
  });
  if (!result.ok) {
    releaseTransforms();
    throw result.error;
  }
  return () => {
    world.removeSystem(Update, name).unwrap();
    releaseTransforms();
  };
}
