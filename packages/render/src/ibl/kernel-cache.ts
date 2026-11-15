export const REFLECTION_PROBE_IBL_STAGES = ['raw', 'filtered', 'publish'] as const;
export type ReflectionProbeIblStage = (typeof REFLECTION_PROBE_IBL_STAGES)[number];

export interface IblKernelCache {
  readonly generation: number;
  readonly pipelineIdentity: object;
  readonly samplerIdentity: object;
  readonly brdfLutIdentity: object;
}

/** Fresh kernel identities; the renderer DeviceScope owns reuse and retirement. */
export function createIblKernelCache(generation: number): IblKernelCache {
  return {
    generation,
    pipelineIdentity: {},
    samplerIdentity: {},
    brdfLutIdentity: {},
  };
}

export interface ProbeIblOutput {
  readonly entityKey: number;
  readonly resolution: number;
  readonly deviceGeneration: number;
  readonly raw: object;
  readonly filtered: object;
  readonly rawGeneration: number;
  readonly filteredGeneration: number;
  readonly lkg: boolean;
}

export interface ProbeIblUpdate extends ProbeIblOutput {
  readonly stages: typeof REFLECTION_PROBE_IBL_STAGES;
  readonly nextStage: ReflectionProbeIblStage;
  readonly candidateGeneration: number;
}

export function createProbeIblOutput(input: {
  readonly entityKey: number;
  readonly resolution: number;
  readonly deviceGeneration: number;
}): ProbeIblOutput {
  return {
    ...input,
    raw: {},
    filtered: {},
    rawGeneration: 0,
    filteredGeneration: 0,
    lkg: true,
  };
}

export function beginProbeIblUpdate(output: ProbeIblOutput): ProbeIblUpdate {
  return {
    ...output,
    stages: REFLECTION_PROBE_IBL_STAGES,
    nextStage: 'raw',
    candidateGeneration: output.filteredGeneration + 1,
  };
}

export function publishProbeIblOutput(
  update: ProbeIblUpdate,
  result: { readonly stage: ReflectionProbeIblStage; readonly ok: boolean },
): ProbeIblOutput {
  if (!result.ok || result.stage !== update.nextStage) return update;
  if (result.stage === 'raw') {
    return {
      ...update,
      rawGeneration: update.candidateGeneration,
    };
  }
  if (result.stage === 'filtered') return update;
  return {
    ...update,
    filteredGeneration: update.candidateGeneration,
    lkg: true,
  };
}
