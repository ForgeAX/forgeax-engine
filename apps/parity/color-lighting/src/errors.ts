export type ColorLightingParityErrorCode = ColorLightingParityErrorDetail['code'];

export interface ProvenanceConflictDetail {
  readonly forgeaxImplementation: string;
  readonly threeImplementation: string;
}

export interface PrimaryCaptureMissingDetail {
  readonly missing: readonly ('forgeax' | 'threeWebGpu')[];
}

export interface CaptureEnvelopeInvalidDetail {
  readonly field: string;
  readonly role?: 'primary' | 'fallback';
}

export interface MetricDetail {
  readonly metric: 'analytic' | 'roi' | 'bytes';
  readonly actual: number;
  readonly budget: number;
}

export interface AggregateOnlyDetail {
  readonly fields: readonly string[];
}

export interface CapabilityDetail {
  readonly capability: string;
  readonly fallback?: string;
}

export interface StatusIncompleteDetail {
  readonly missing: readonly string[];
}

export type ObservationEvidenceOwner =
  | 'linearHdr'
  | 'finalDisplay'
  | 'provenance'
  | 'lifetime'
  | 'pipeline'
  | 'copy'
  | 'map';

export type ObservationEvidenceReason =
  | 'missing'
  | 'stale'
  | 'missing-pipeline'
  | 'copy-src'
  | 'invalid-format'
  | 'readback-failed';

export interface ObservationEvidenceMissingDetail {
  readonly code: 'observation-evidence-missing';
  readonly owner: ObservationEvidenceOwner;
  readonly reason: ObservationEvidenceReason;
}

export type ColorLightingParityErrorDetail =
  | ({ readonly code: 'provenance-conflict' } & ProvenanceConflictDetail)
  | ({ readonly code: 'primary-capture-missing' } & PrimaryCaptureMissingDetail)
  | ({ readonly code: 'capture-envelope-invalid' } & CaptureEnvelopeInvalidDetail)
  | ({ readonly code: 'aggregate-only-input' } & AggregateOnlyDetail)
  | ({ readonly code: 'metric-non-finite' | 'budget-exceeded' } & MetricDetail)
  | ({ readonly code: 'unsupported-capability' } & CapabilityDetail)
  | ObservationEvidenceMissingDetail
  | ({ readonly code: 'status-incomplete' } & StatusIncompleteDetail)
  | { readonly code: 'schema-invalid' | 'non-finite-value' | 'file-read-failed'; readonly path: readonly string[] };

export class ColorLightingParityError extends Error {
  readonly code: ColorLightingParityErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ColorLightingParityErrorDetail;

  constructor(
    code: ColorLightingParityErrorCode,
    expected: string,
    hint: string,
    detail: ColorLightingParityErrorDetail,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'ColorLightingParityError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

function observationEvidenceError(
  code: 'observation-evidence-missing',
  detail: ColorLightingParityErrorDetail,
): ColorLightingParityError {
  const observationDetail = detail as ObservationEvidenceMissingDetail;
  return new ColorLightingParityError(
    code,
    `fresh producer-owned ${observationDetail.owner} observation evidence`,
    `the ${observationDetail.owner} producer evidence is ${observationDetail.reason}; draw a fresh frame and repair that owner before rerunning`,
    observationDetail,
  );
}

export function parityError(
  code: ColorLightingParityErrorCode,
  detail: ColorLightingParityErrorDetail,
): ColorLightingParityError {
  switch (code) {
    case 'schema-invalid':
      return new ColorLightingParityError(code, 'valid SceneCase schema', 'fix the reported field and rerun the case', detail);
    case 'non-finite-value':
      return new ColorLightingParityError(code, 'finite numeric values', 'replace NaN or Infinity before comparison', detail);
    case 'file-read-failed':
      return new ColorLightingParityError(code, 'readable case input', 'check the case path and rerun the named case', detail);
    case 'provenance-conflict':
      return new ColorLightingParityError(code, 'different ForgeaX and Three implementations', 'use independent adapters before numerical diff', detail);
    case 'primary-capture-missing':
      return new ColorLightingParityError(code, 'ForgeaX and Three WebGPU primary captures', 'capture both primary outputs; fallback cannot replace Three WebGPU', detail);
    case 'capture-envelope-invalid':
      return new ColorLightingParityError(code, 'complete named capture envelope', 'restore the missing field before comparing pixels', detail);
    case 'aggregate-only-input':
      return new ColorLightingParityError(code, 'analytic and ROI metrics for this case', 'provide named per-case metrics; aggregate diff is diagnostic only', detail);
    case 'metric-non-finite':
      return new ColorLightingParityError(code, 'finite parity metrics', 'capture the case again and inspect the named metric', detail);
    case 'budget-exceeded':
      return new ColorLightingParityError(code, 'all metrics within the frozen case budget', 'inspect first divergence and rerun the named case', detail);
    case 'unsupported-capability':
      return new ColorLightingParityError(code, 'required backend capability', 'record explicit degradation or use the declared fallback path', detail);
    case 'observation-evidence-missing':
      return observationEvidenceError(code, detail);
    case 'status-incomplete':
      return new ColorLightingParityError(code, 'all required primary matrix entries executed', 'complete the missing entries; do not declare parity complete', detail);
  }
}
