import type {
  Asset,
  AssetDecoderContribution,
  AssetKind,
  WaterAdvancedSimulationSource,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import { validateWaterRuntimeAsset } from './validate.js';

type WaterKind = Extract<Asset['kind'], `water-${string}`>;
type WaterPayload<K extends WaterKind> = Extract<Asset, { readonly kind: K }>;

function oceanPatchReferences(
  config: NonNullable<WaterAdvancedSimulationSource['oceanPatchConfig']>,
): readonly (readonly [string, string])[] {
  switch (config.algorithm) {
    case 'ue-5.8.1-niagara-fft':
      return [[config.noiseTextureGuid, 'texture']];
    case 'mode-projected-gravity/1':
      return [];
  }
}

function contribution<K extends WaterKind>(kind: K): AssetDecoderContribution<WaterPayload<K>, K> {
  return {
    kind: { kind } as AssetKind<WaterPayload<K>, K>,
    consumer: 'Water',
    decoder: {
      ...(kind === 'water-body' || kind === 'water-zone'
        ? { references: 'deferred' as const }
        : {}),
      prepare(input, context) {
        const value = validateWaterRuntimeAsset(input);
        if (!value.ok || value.value.kind !== kind)
          return err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: value.ok ? `${kind} runtime payload` : value.error.expected,
              hint: value.ok
                ? 'repair the cooked water asset kind before publication'
                : value.error.hint,
            }),
          );
        const admittedAsset = value.value;
        const reference = (guid: string, targetKind: string) => context.reference(guid, targetKind);
        const captureReferences = (): readonly (readonly [string, string])[] => {
          const references: readonly (readonly [string, string])[] =
            admittedAsset.kind === 'water-body'
              ? [
                  [admittedAsset.surfaceMaterialGuid, 'material'],
                  ...(admittedAsset.zoneGuid
                    ? [[admittedAsset.zoneGuid, 'water-zone'] as const]
                    : []),
                  ...(admittedAsset.waveSetGuid
                    ? [[admittedAsset.waveSetGuid, 'water-wave-set'] as const]
                    : []),
                  ...(admittedAsset.customMeshOverrideGuid
                    ? [[admittedAsset.customMeshOverrideGuid, 'mesh'] as const]
                    : []),
                  ...(admittedAsset.collision.meshGuid
                    ? [[admittedAsset.collision.meshGuid, 'mesh'] as const]
                    : []),
                  ...[
                    admittedAsset.visibleMeshGuid,
                    admittedAsset.waterInfoMeshGuid,
                    admittedAsset.dilatedWaterInfoMeshGuid,
                    admittedAsset.brushShapeMeshGuid,
                    admittedAsset.collisionMeshGuid,
                  ]
                    .filter((guid): guid is string => !!guid)
                    .map((guid) => [guid, 'mesh'] as const),
                  ...(admittedAsset.riverSegmentMeshGuids ?? []).map(
                    (guid) => [guid, 'mesh'] as const,
                  ),
                  ...[
                    admittedAsset.riverToLakeTransitionMaterialGuid,
                    admittedAsset.riverToOceanTransitionMaterialGuid,
                    admittedAsset.waterInfoMaterialGuid,
                    admittedAsset.lodMaterialGuid,
                    admittedAsset.underwaterPostProcessMaterialGuid,
                  ]
                    .filter((guid): guid is string => !!guid)
                    .map((guid) => [guid, 'material'] as const),
                ]
              : admittedAsset.kind === 'water-zone'
                ? [
                    ...(admittedAsset.farMaterialGuid
                      ? [[admittedAsset.farMaterialGuid, 'material'] as const]
                      : []),
                  ]
                : admittedAsset.kind === 'water-brush-recipe'
                  ? [
                      [admittedAsset.baseTerrainGuid, 'terrain'],
                      ...admittedAsset.sourceBodyGuids.map((guid) => [guid, 'water-body'] as const),
                      ...admittedAsset.curves.map((guid) => [guid, 'texture'] as const),
                      ...admittedAsset.textures.map((guid) => [guid, 'texture'] as const),
                    ]
                  : admittedAsset.kind === 'water-simulation-recipe'
                    ? [
                        ...admittedAsset.materialGuids.map((guid) => [guid, 'material'] as const),
                        ...(admittedAsset.system === 'water-advanced' &&
                        admittedAsset.shallowStageConfig
                          ? admittedAsset.shallowStageConfig.materialGuids.map(
                              (guid) => [guid, 'material'] as const,
                            )
                          : []),
                        ...admittedAsset.textureGuids.map((guid) => [guid, 'texture'] as const),
                        ...(admittedAsset.system === 'fluid-simulation'
                          ? [[admittedAsset.impulseNoiseGuid, 'texture'] as const]
                          : []),
                        ...(admittedAsset.system === 'water-advanced' &&
                        admittedAsset.riverBakeConfig
                          ? [[admittedAsset.riverBakeConfig.sourceBodyGuid, 'water-body'] as const]
                          : []),
                        ...(admittedAsset.system === 'water-advanced' &&
                        admittedAsset.oceanPatchConfig
                          ? oceanPatchReferences(admittedAsset.oceanPatchConfig)
                          : []),
                      ]
                    : [];
          return references;
        };
        const references = captureReferences();
        for (const [guid, targetKind] of references) {
          const resolved = reference(guid, targetKind);
          if (!resolved.ok) return resolved;
        }
        return ok(value.value as WaterPayload<K>);
      },
      async decode({ envelope }) {
        const value = validateWaterRuntimeAsset(envelope.payload);
        if (!value.ok || value.value.kind !== kind)
          return err({
            code: 'asset-package-invalid',
            expected: value.ok ? `${kind} runtime payload` : value.error.expected,
            hint: value.ok ? 'repair the water asset kind in its Pack envelope' : value.error.hint,
            detail: { guid: envelope.guid, reason: 'invalid cooked water payload' },
          });
        return ok(value.value as WaterPayload<K>);
      },
    },
  };
}

export const waterBodyContribution = contribution('water-body');
export const waterZoneContribution = contribution('water-zone');
export const waterWaveSetContribution = contribution('water-wave-set');
export const waterBrushRecipeContribution = contribution('water-brush-recipe');
export const waterSimulationRecipeContribution = contribution('water-simulation-recipe');

export const waterAssetDecoderContributions = Object.freeze([
  waterBodyContribution,
  waterZoneContribution,
  waterWaveSetContribution,
  waterBrushRecipeContribution,
  waterSimulationRecipeContribution,
] as const);
