import { Update, type World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { detectMobilityInvalidKind } from './mobility-validation';

let nextId = 0;
/** Derived authoring stays beside World; only completed mesh data reaches the Renderer. */
export function registerRenderSourceSystems(world: World): () => void {
  const releaseTransforms = registerPropagateTransforms(world);
  const name = `renderDerived:${++nextId}`;
  const result = world.addSystem(Update, {
    name,
    queries: [],
    fn: (world) => {
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
