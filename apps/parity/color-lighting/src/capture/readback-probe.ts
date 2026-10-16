export interface ReadbackProbeInput {
  readonly finalReadbackAvailable: boolean;
  readonly linearReadbackAvailable?: boolean;
  readonly namedAttachmentAvailable: boolean;
  readonly rawHashAvailable: boolean;
  readonly observations?: AttachmentEvidence;
}

export interface ReadbackProbe {
  readonly source: 'frame-receipt' | 'rhi-debug' | 'unavailable';
  readonly linearReadback: boolean;
  readonly finalReadback: boolean;
  readonly namedAttachment: boolean;
  readonly rawHash: boolean;
  readonly requiresRhiDebugExtension: boolean;
  readonly observations?: AttachmentEvidence;
}

export function probeReadback(input: ReadbackProbeInput): ReadbackProbe {
  const linearReadback = input.linearReadbackAvailable ?? false;
  const source = input.finalReadbackAvailable && linearReadback
    ? 'frame-receipt'
    : input.namedAttachmentAvailable && input.rawHashAvailable
      ? 'rhi-debug'
      : 'unavailable';
  return {
    source,
    linearReadback,
    finalReadback: input.finalReadbackAvailable,
    namedAttachment: input.namedAttachmentAvailable,
    rawHash: input.rawHashAvailable,
    requiresRhiDebugExtension: !input.namedAttachmentAvailable || !input.rawHashAvailable,
    ...(input.observations === undefined ? {} : { observations: input.observations }),
  };
}
import type { AttachmentEvidence } from './attachment-readback';
