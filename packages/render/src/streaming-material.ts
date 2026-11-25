import type { MaterialAsset } from '@forgeax/engine-types';
import { materialSurfaceModel } from './material-program-selection';
import {
  materialUsesSpriteGeometry,
  runtimeMaterialShaderIdForMaterial,
} from './material-resource';
import { isMediumMaterial } from './record/material-pass-selection';
import { standardTransmissionValue } from './transmission/projection';

export type StreamingMaterialRejection =
  | 'blended-material'
  | 'transmission-material'
  | 'medium-material'
  | 'sprite-material';

/** Content eligibility only; actual device, graph, bindings and pipelines still need staging. */
export function streamingMaterialRejection(
  material: MaterialAsset,
): StreamingMaterialRejection | undefined {
  const passes = material.passes ?? [];
  const surfaceModel = materialSurfaceModel(passes, material.surface?.model);
  const identity = {
    surfaceModel,
    materialShaderId: runtimeMaterialShaderIdForMaterial(passes, undefined),
  };
  if (isMediumMaterial(identity)) return 'medium-material';
  if (
    (standardTransmissionValue({
      ...identity,
      paramSnapshot:
        typeof material.values?.transmission === 'number'
          ? { transmission: material.values.transmission }
          : {},
    }) ?? 0) > 0
  )
    return 'transmission-material';
  if (materialUsesSpriteGeometry({ passes })) return 'sprite-material';
  for (const pass of passes) {
    if (pass.renderState?.blend !== undefined) return 'blended-material';
  }
  return undefined;
}
