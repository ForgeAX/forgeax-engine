import type { RenderFeaturePlan, RenderFeaturePlanContext } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import type { PublishedWorld } from './gpu-particle-feature.js';

export function vfxFrameAssetDependencies(source: PublishedWorld | undefined) {
  const dependencies = new Set<string | number>();
  if (source !== undefined) {
    for (const [key, material] of source.materials)
      dependencies.add(material.reference?.handle ?? key);
    for (const mesh of source.meshes.values()) if (typeof mesh === 'number') dependencies.add(mesh);
  }
  return [...dependencies];
}
export function vfxFrameRequiresPreparation(source: PublishedWorld | undefined): boolean {
  if (source !== undefined) {
    const world = source;
    for (const source of world.emitterState.values())
      if (source.preparePipelines === true) return true;
  }
  return false;
}
export function isEmptyVfxSource(source: PublishedWorld | undefined): boolean {
  return (
    source === undefined ||
    (source.emitterState.size === 0 &&
      source.intents.length === 0 &&
      source.retained.length === 0 &&
      (source.preparationPlayers?.length ?? 0) === 0)
  );
}
export function emptyVfxFramePlan(
  source: PublishedWorld | undefined,
  context: RenderFeaturePlanContext,
): import('@forgeax/engine-types').Result<RenderFeaturePlan, never> {
  const native = context.createNativePlan?.();
  const work = [native?.scope('frame') ?? { scope: 'frame' as const, resources: [], passes: [] }];
  const sourceFeedback =
    source === undefined
      ? []
      : [
          {
            runtimeId: source.runtimeId,
            renderGeneration: source.renderGeneration,
            visibility: [],
            acknowledged: [],
            published: [],
            missingRetained: [],
            missingIntents: [],
          },
        ];
  return ok<RenderFeaturePlan>(
    native === undefined ? { work, sourceFeedback } : native.finish(work, sourceFeedback),
  );
}
