import type { CaseStatusInput, PipelineAuditObservation } from './status';

export interface IblCapabilityStatusInput {
  readonly rgba16floatRenderable: boolean;
  readonly lastKnownGood?: string | undefined;
}

export interface IblCapabilityStatusReport extends CaseStatusInput {
  readonly rgba16floatRenderable: boolean;
  readonly outputFormat: 'rgba16float' | null;
  readonly fallbackArtifact: 'white-cube' | null;
  readonly expectedImpact: string;
  readonly hint: string;
  readonly lastKnownGood: string;
}

const DEFAULT_LAST_KNOWN_GOOD = 'ibl-constant-environment@rgba16float';

export function projectIblCapabilityStatus(
  input: IblCapabilityStatusInput,
): IblCapabilityStatusReport {
  const lastKnownGood = input.lastKnownGood ?? DEFAULT_LAST_KNOWN_GOOD;
  if (input.rgba16floatRenderable) {
    return {
      capabilityStatus: 'supported',
      executionStatus: 'complete',
      verdict: 'passed',
      rgba16floatRenderable: true,
      outputFormat: 'rgba16float',
      fallbackArtifact: null,
      expectedImpact: 'HDR IBL producer is available for linear capture',
      hint: 'retain the named producer attachment and raw hash in the case report',
      lastKnownGood,
    };
  }
  return {
    capabilityStatus: 'degraded',
    executionStatus: 'notExecuted',
    verdict: 'failed',
    rgba16floatRenderable: false,
    outputFormat: null,
    fallbackArtifact: 'white-cube',
    expectedImpact: 'HDR IBL producer was not executed; white-cube fallback is not HDR evidence',
    hint: 'inspect rgba16floatRenderable, restore the capability, then retry from last-known-good',
    lastKnownGood,
  };
}

interface ReadyIblReadback {
  readonly status: 'ready';
  readonly bytes: Uint8Array;
  readonly format: string;
  readonly size: { readonly width: number; readonly height: number };
  readonly rawHash: string;
  readonly frameId: number;
  readonly lifetime: { readonly frameId: number; readonly state: PipelineAuditObservation['lifetime'] };
}

export interface IblRawEvidenceInput {
  readonly attachmentName: string;
  readonly layer: number;
  readonly capabilitySnapshot: { readonly rgba16floatRenderable: boolean };
  readonly fallbackArtifact: string | null;
  readonly lastKnownGood: string;
  readonly readback: ReadyIblReadback | { readonly status: 'failed' };
}

export interface IblRawEvidence {
  readonly status: 'ready' | 'failed';
  readonly attachmentName: string;
  readonly layer: number;
  readonly bytes: Uint8Array | null;
  readonly format: string | null;
  readonly size: { readonly width: number; readonly height: number } | null;
  readonly rawHash: string | null;
  readonly frameId: number | null;
  readonly lifetime: { readonly frameId: number; readonly state: PipelineAuditObservation['lifetime'] } | null;
  readonly capabilitySnapshot: { readonly rgba16floatRenderable: boolean };
  readonly fallbackArtifact: string | null;
  readonly lastKnownGood: string;
}

export function projectIblRawEvidence(input: IblRawEvidenceInput): IblRawEvidence {
  const ready = input.readback.status === 'ready' && input.capabilitySnapshot.rgba16floatRenderable;
  if (!ready || input.readback.status !== 'ready') {
    return {
      status: 'failed',
      attachmentName: input.attachmentName,
      layer: input.layer,
      bytes: null,
      format: null,
      size: null,
      rawHash: null,
      frameId: null,
      lifetime: null,
      capabilitySnapshot: input.capabilitySnapshot,
      fallbackArtifact: input.fallbackArtifact,
      lastKnownGood: input.lastKnownGood,
    };
  }
  return {
    status: 'ready',
    attachmentName: input.attachmentName,
    layer: input.layer,
    bytes: input.readback.bytes,
    format: input.readback.format,
    size: input.readback.size,
    rawHash: input.readback.rawHash,
    frameId: input.readback.frameId,
    lifetime: input.readback.lifetime,
    capabilitySnapshot: input.capabilitySnapshot,
    fallbackArtifact: input.fallbackArtifact,
    lastKnownGood: input.lastKnownGood,
  };
}
