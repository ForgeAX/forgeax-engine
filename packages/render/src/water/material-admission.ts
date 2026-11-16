import type { ShaderEntryPointReads } from '@forgeax/engine-types';
import type { WaterError, WaterSystem } from '@forgeax/engine-water';
import { WATER_SYSTEM_RESOURCE } from '@forgeax/engine-water';
import { type MaterialProgramInputs, waterProgramEntryPoints } from '../material-program-inputs';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';

export function waterMaterialReadsBakedSource(inputs: MaterialProgramInputs | undefined): boolean {
  return (
    waterProgramEntryPoints(inputs)?.some((point) =>
      point.bindings.some((read) => read.group === 2 && read.binding === 24),
    ) === true
  );
}

export function requireWaterBodyBakedSources(
  water: WaterSystem,
  sources: readonly Readonly<{ guid: string; generation: number }>[],
  inputs: readonly MaterialProgramInputs[],
): void {
  if (!inputs.some(waterMaterialReadsBakedSource)) return;
  for (const source of sources) {
    if (water.hasBakedQueryGrid(source.guid, source.generation)) continue;
    throw {
      code: 'query-data-unavailable',
      expected:
        'a current-generation Baked source for every Body sampled by the candidate Water material',
      hint: 'publish the Body Baked grid, then retry the material replacement',
      detail: { bodyGuid: source.guid, bodyGeneration: source.generation },
    } satisfies WaterError;
  }
}

/** Project admitted reflection once into the closed feature binding value domain. */
export function waterMaterialEntryPointReferences(points: readonly ShaderEntryPointReads[]) {
  return Object.freeze(
    points.map((point) =>
      Object.freeze({
        name: point.name,
        stage: point.stage,
        bindings: Object.freeze(
          point.bindings.map((read) =>
            Object.freeze({
              group: read.group,
              binding: read.binding,
              ...(read.fields === undefined ? {} : { fields: read.fields }),
            }),
          ),
        ),
      }),
    ),
  );
}

/** Shared material resources admit a version before any existing binding observes it. */
export function requireWaterMaterialConsumers(
  scope: RenderResourceScope,
  material: MaterialSnapshot,
): void {
  const inputs = Object.values(material.materialProgramInputs ?? {});
  if (
    !inputs.some(waterMaterialReadsBakedSource) ||
    scope.world?.hasResource(WATER_SYSTEM_RESOURCE) !== true
  )
    return;
  const water = scope.world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const guid =
    material.materialHandle === undefined
      ? undefined
      : scope.sourceForAsset(material.materialHandle)?.guid;
  if (guid === undefined) return;
  requireWaterBodyBakedSources(water, water.materialSourceBodies(guid), inputs);
}

export function waterMaterialNeedsSourceSnapshot(material: MaterialSnapshot): boolean {
  return Object.values(material.materialProgramInputs ?? {}).some(
    (inputs) =>
      waterProgramEntryPoints(inputs)?.some((point) =>
        point.bindings.some((read) => read.group === 2 && read.binding >= 16 && read.binding <= 24),
      ) === true,
  );
}
