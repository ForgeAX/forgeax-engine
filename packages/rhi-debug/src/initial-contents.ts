import type { RhiCallEvent, Tape } from './protocol/types';

export interface UnseededResource {
  readonly resourceId: string;
  readonly kind: 'buffer' | 'texture';
  readonly format: string | null;
  readonly sampleCount: number;
  /** Skipped by the capture's seed scope (`CaptureFrameOptions.seed`), not unavailable. */
  readonly omitted: boolean;
}

/** Missing bytes are a tape fact, not proof of divergence: a recorded producer
 * may initialize the resource before its first read. Never infer completeness
 * merely from a successful capture or replay. */
export function unseededResources(tape: Tape): readonly UnseededResource[] {
  return tape.bootstrap.flatMap((resource): UnseededResource[] => {
    if (resource.initialData.some((slice) => slice.byteLength > 0)) return [];
    const event = resource.create as unknown as RhiCallEvent;
    if (event.kind !== 'createBuffer' && event.kind !== 'createTexture') return [];
    return [
      {
        resourceId: resource.handleId,
        kind: event.kind === 'createBuffer' ? 'buffer' : 'texture',
        format: event.kind === 'createTexture' ? event.desc.format : null,
        sampleCount: event.kind === 'createTexture' ? (event.desc.sampleCount ?? 1) : 1,
        omitted: resource.seed === 'omitted',
      },
    ];
  });
}
