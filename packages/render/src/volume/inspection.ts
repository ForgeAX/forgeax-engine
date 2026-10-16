import type { TextureFormat } from '@forgeax/engine-rhi';
import type { VolumeRecoveryState, VolumeSelectedLightFacts } from './recovery';
import type { VolumetricFogResourceFacts } from './resources';

export type VolumetricFogInspectionStatus = 'off' | 'available' | 'unavailable' | 'degraded';

export type VolumetricFogResourceStage = 'none' | 'candidate' | 'accepted' | 'lkg' | 'recovering';

export interface VolumetricFogInspection {
  /** Owners in the last successfully submitted volume collection. */
  readonly ownerCount: number;
  readonly status: VolumetricFogInspectionStatus;
  readonly resourceStage: VolumetricFogResourceStage;
  readonly guid: string | undefined;
  readonly generation: number | undefined;
  readonly digest: string | undefined;
  readonly candidateGeneration: number | undefined;
  readonly candidateDigest: string | undefined;
  readonly lkgGeneration: number | undefined;
  readonly candidateFailure: VolumeRecoveryState['candidateFailure'];
  readonly deviceEpoch: number;
  readonly format: TextureFormat | undefined;
  readonly passCount: number;
  readonly sampleCount: number;
  readonly memoryBytes: number;
  readonly resourceFacts: VolumetricFogResourceFacts | undefined;
  readonly selectedLight: VolumeSelectedLightFacts | undefined;
  readonly candidateSelectedLight: VolumeSelectedLightFacts | undefined;
}

export interface VolumetricFogInspectionInput {
  readonly authored: boolean;
  readonly capability: 'available' | 'unavailable';
  readonly degraded?: boolean;
  readonly recovery?: VolumeRecoveryState;
  readonly acceptedDigest?: string;
  readonly format?: TextureFormat;
  readonly passCount?: number;
  readonly sampleCount?: number;
  readonly memoryBytes?: number;
  readonly resourceFacts?: VolumetricFogResourceFacts;
}

function resourceStage(input: VolumetricFogInspectionInput): VolumetricFogResourceStage {
  if (!input.authored || input.recovery === undefined) return 'none';
  if (input.recovery.status === 'candidate') return 'candidate';
  if (input.recovery.status === 'recovering') return 'recovering';
  if (input.recovery.status === 'degraded') return 'lkg';
  return 'accepted';
}

export function inspectVolumetricFog(input: VolumetricFogInspectionInput): VolumetricFogInspection {
  const recovery = input.recovery;
  const status: VolumetricFogInspectionStatus = !input.authored
    ? 'off'
    : input.capability === 'unavailable'
      ? 'unavailable'
      : input.degraded === true || recovery?.status === 'degraded'
        ? 'degraded'
        : 'available';
  return Object.freeze({
    ownerCount: 0,
    status,
    resourceStage: resourceStage(input),
    guid: recovery?.guid,
    generation: recovery?.generation,
    digest: input.acceptedDigest,
    candidateGeneration: recovery?.candidateGeneration,
    candidateDigest: recovery?.candidateDigest,
    lkgGeneration: recovery?.lkgGeneration,
    candidateFailure: recovery?.candidateFailure,
    deviceEpoch: recovery?.deviceEpoch ?? 0,
    format: input.format,
    passCount: input.passCount ?? 0,
    sampleCount: input.sampleCount ?? 0,
    memoryBytes: input.memoryBytes ?? 0,
    resourceFacts: input.resourceFacts,
    selectedLight: recovery?.selectedLight,
    candidateSelectedLight: recovery?.candidateSelectedLight,
  });
}
