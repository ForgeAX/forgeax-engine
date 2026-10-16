import type { MaterialShaderArtifactReceipt } from '@forgeax/engine-shader';

export type GpuDrivenPreparationErrorCode =
  | 'missing-material-receipt'
  | 'material-abi-not-executable'
  | 'missing-uv'
  | 'reflection-mismatch'
  | 'vertex-input-mismatch'
  | 'alpha-mask-mismatch'
  | 'resource-not-ready'
  | 'stale-generation'
  | 'skin-receipt-mismatch'
  | 'shadow-ownership';

export type GpuDrivenPreparationReason =
  | 'material-receipt-missing'
  | 'material-abi-not-executable'
  | 'uv-set-missing'
  | 'reflection-receipt-mismatch'
  | 'vertex-semantic-mismatch'
  | 'alpha-mask-receipt-missing'
  | 'material-resource-missing'
  | 'generation-stale'
  | 'skin-address-missing'
  | 'shadow-ownership-missing';

/** Closed next action; AI callers never need to parse an error message. */
export type GpuDrivenRecoveryAction =
  | 'rebuild-producer'
  | 'route-cpu-lane'
  | 'retry-same-draw'
  | 'rebuild-generation'
  | 'stop-promotion';

export interface GpuDrivenPreparationErrorDetail {
  readonly reason: GpuDrivenPreparationReason;
  readonly owner: 'material' | 'geometry' | 'skin' | 'generation' | 'shadow';
  readonly expected?: string;
  readonly actual?: string;
  readonly expectedGeneration?: number;
  readonly actualGeneration?: number;
  readonly recovery?: GpuDrivenRecoveryAction;
}

const ERROR_POLICY: Readonly<
  Record<
    GpuDrivenPreparationErrorCode,
    {
      readonly expected: string;
      readonly hint: string;
      readonly recovery: GpuDrivenRecoveryAction;
    }
  >
> = {
  'missing-material-receipt': {
    expected: 'a producer-owned material program receipt is present',
    hint: 'cook and load the selected material program artifact, then retry preparation',
    recovery: 'rebuild-producer',
  },
  'material-abi-not-executable': {
    expected: 'the published material ABI fits the GPU Scene submission layout',
    hint: 'recook the material with a scene-index ABI supported by the GPU-driven owner or keep it on its authored lane',
    recovery: 'route-cpu-lane',
  },
  'missing-uv': {
    expected: 'the geometry exposes every UV set named by the material receipt',
    hint: 'repair the geometry UV semantic or route the draw to the CPU semantic lane',
    recovery: 'route-cpu-lane',
  },
  'reflection-mismatch': {
    expected: 'the loaded reflection receipt matches the artifact layout identity',
    hint: 'rebuild the material artifact and reflection from one source, then retry',
    recovery: 'rebuild-producer',
  },
  'vertex-input-mismatch': {
    expected: 'geometry vertex semantics match the material reflection receipt',
    hint: 'repair the geometry vertex semantic layout or route the draw to the CPU lane',
    recovery: 'route-cpu-lane',
  },
  'alpha-mask-mismatch': {
    expected: 'the Alpha Mask cutoff is present in the material receipt',
    hint: 'declare the pass coverage cutoff in the material schema and recook it',
    recovery: 'rebuild-producer',
  },
  'resource-not-ready': {
    expected: 'all material resource slots have resolved handles',
    hint: 'resolve the declared texture and sampler resources before recording',
    recovery: 'retry-same-draw',
  },
  'stale-generation': {
    expected: 'receipt and prepared inputs belong to the requested generation',
    hint: 'discard stale GPU facts, rebuild the producer receipt, and retry the same draw',
    recovery: 'rebuild-generation',
  },
  'skin-receipt-mismatch': {
    expected: 'skinned geometry has a current palette address receipt',
    hint: 'rebuild the Skin palette receipt for this generation before recording',
    recovery: 'rebuild-producer',
  },
  'shadow-ownership': {
    expected: 'every declared ShadowCaster pass has one GPU-compatible draw-item owner',
    hint: 'repair the ShadowCaster producer membership or keep the residual on its explicit CPU lane',
    recovery: 'route-cpu-lane',
  },
};

export class GpuDrivenPreparationError extends Error {
  readonly code: GpuDrivenPreparationErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GpuDrivenPreparationErrorDetail;

  constructor(code: GpuDrivenPreparationErrorCode, detail: GpuDrivenPreparationErrorDetail) {
    const policy = ERROR_POLICY[code];
    super(`[GpuDrivenPreparationError ${code}] ${policy.expected}`);
    this.name = 'GpuDrivenPreparationError';
    this.code = code;
    this.expected = policy.expected;
    this.hint = policy.hint;
    this.detail = Object.freeze({
      ...detail,
      recovery: detail.recovery ?? policy.recovery,
    });
  }
}

export interface GpuDrivenPreparedMaterial {
  readonly receipt: MaterialShaderArtifactReceipt;
  readonly resourceSlots: MaterialShaderArtifactReceipt['resourceSlots'];
  readonly uvSets: MaterialShaderArtifactReceipt['uvSets'];
  readonly vertexInputs: MaterialShaderArtifactReceipt['vertexInputs'];
  readonly alphaMask: MaterialShaderArtifactReceipt['alphaMask'];
}
