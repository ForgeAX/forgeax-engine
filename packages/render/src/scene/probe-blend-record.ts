export const PROBE_BLEND_RECORD_BYTE_SIZE = 160;
/** Dynamic-offset stride; 160B payload plus WebGPU's 256B alignment. */
export const PROBE_BLEND_RECORD_STRIDE = 256;

export const PROBE_BLEND_RECORD_CAPACITY = 64;
export const PROBE_BLEND_SENTINEL = -1;

export type ProbeBlendRecordSentinel =
  | 'capacity-exceeded'
  | 'no-active'
  | 'no-lkg'
  | 'outside-radius';

export interface ProbeBlendRecord {
  readonly objectKey: number;
  readonly generation: number;
  readonly localBlendFraction: number;
  readonly shPreblend: readonly number[];
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly candidate: boolean;
  readonly accepted: boolean;
  readonly lastKnownGood: boolean;
  readonly sentinel?: ProbeBlendRecordSentinel;
}

export function emptyProbeBlendRecord(
  objectKey = PROBE_BLEND_SENTINEL,
  sentinel: ProbeBlendRecordSentinel = 'no-lkg',
): ProbeBlendRecord {
  const bytes = new Uint8Array(PROBE_BLEND_RECORD_BYTE_SIZE);
  return {
    objectKey,
    generation: 0,
    localBlendFraction: 0,
    shPreblend: new Array<number>(27).fill(0),
    bytes,
    byteLength: bytes.byteLength,
    candidate: false,
    accepted: false,
    lastKnownGood: false,
    sentinel,
  };
}

export function probeBlendRecordOffset(objectKey: number): number {
  if (!Number.isInteger(objectKey) || objectKey < 0) {
    throw new Error('probe blend record requires a non-negative object key');
  }
  // Lane zero is reserved for the no-LKG sentinel. RenderScene slot identity
  // is the object index, so objectKey N always selects lane N+1.
  return (objectKey + 1) * PROBE_BLEND_RECORD_STRIDE;
}
