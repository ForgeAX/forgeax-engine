import type { MaterialSnapshot } from '../render-system-extract';

/** Authored Surface identity survives content-addressed shader compilation. */
export function standardTransmissionValue(
  material: Pick<MaterialSnapshot, 'surfaceModel' | 'materialShaderId' | 'paramSnapshot'>,
): number | undefined {
  if (
    material.surfaceModel !== 'standard' &&
    material.materialShaderId !== 'forgeax::default-standard-pbr'
  )
    return undefined;
  const value = material.paramSnapshot?.transmission;
  return typeof value === 'number' ? value : undefined;
}

/** Shared material bindings that require the transmission backdrop. */
export interface TransmissionDemand {
  readonly activeCount: number;
  readonly needsRoughMips: boolean;
  readonly needsBackPass?: boolean;
}
