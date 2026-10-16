import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import type { GameHost } from '@forgeax/engine-app';
import type { Context } from '@forgeax/engine-plugin';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  Skylight,
} from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

export interface DeepAgentFeedbackBootstrapOptions {
  readonly uiRoot?: GameHost['uiRoot'];
  readonly fixture?: string;
}

/** Build the focused scene selected by the URL fixture. */
export function bootstrap(world: World, options: DeepAgentFeedbackBootstrapOptions = {}): () => void {
  const owned: EntityHandle[] = [];
  let witness: HTMLElement | undefined;
  const uiRoot = options.uiRoot;
  const fixture = options.fixture ?? 'baseline';
  if (uiRoot !== undefined && uiRoot.querySelector('[data-forgeax-focused-ui]') === null) {
    witness = document.createElement('div');
    witness.dataset.forgeaxFocusedUi = 'true';
    witness.textContent = 'Focused Agent feedback: Engine Skylight witness mounted.';
    uiRoot.appendChild(witness);
  }
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.78, 0.24, 0.08, 1],
      metallic: 0.1,
      roughness: 0.3,
    }),
  );
  try {
  owned.push(world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], scale: [1.35, 1.35, 1.35] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap());
  owned.push(world
    .spawn(
      { component: Transform, data: { pos: [0, -1.7, 0], scale: [3.5, 0.15, 3.5] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap());
  owned.push(world
    .spawn(
      { component: Camera, data: { fov: Math.PI / 4, aspect: 16 / 9, near: 0.01, far: 100 } },
      { component: Transform, data: { pos: [0, 0, 6] } },
    )
    .unwrap());
  owned.push(world
    .spawn({ component: DirectionalLight, data: { direction: [-0.4, -0.8, -1], intensity: 1.2 } })
    .unwrap());
  // Omitting equirect deliberately selects the immediate solid-color fallback.
  owned.push(world
    .spawn({ component: Skylight, data: { color: [0.72, 0.82, 1], intensity: 0.65 } })
    .unwrap());

  if (fixture === 'point-shadow-recipe') {
    // The light, caster (cube), and receiver (ground) are already explicit
    // scene entities above. Add one renderer-owned point-shadow request to
    // keep this fixture small and make the atlas admission observable.
    owned.push(world
      .spawn(
        { component: Transform, data: { pos: [1.8, 2.6, 2.2] } },
        { component: PointLight, data: { color: [1, 0.72, 0.4], intensity: 18, range: 12 } },
        { component: PointLightShadow, data: { mapSize: 256, nearPlane: 0.1, farPlane: 25 } },
      )
      .unwrap());
  }
  } catch (cause) {
    try { dispose(); } catch (cleanup) { throw new AggregateError([cause, cleanup], 'scene creation and cleanup failed'); }
    throw cause;
  }
  function dispose(): void {
    const failures: unknown[] = [];
    for (const entity of owned.splice(0).reverse()) {
      try { world.despawn(entity).unwrap(); } catch (cause) { failures.push(cause); }
    }
    world.sharedRefs.release(material).unwrap();
    witness?.remove();
    if (failures.length) throw new AggregateError(failures, 'scene cleanup failed');
  }
  let disposed = false;
  return () => { if (!disposed) { disposed = true; dispose(); } };

}

export default {
  name: 'deep-agent-feedback-scene', inject: ['world'],
  apply(ctx: Context) {
    if (!ctx.world) throw new Error('deep-agent-feedback requires world');
    const world = ctx.world;
    ctx.effect(() => bootstrap(world));
  },
};
