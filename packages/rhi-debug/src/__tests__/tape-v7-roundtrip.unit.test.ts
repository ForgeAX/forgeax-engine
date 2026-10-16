import { describe, expect, it } from 'vitest';
import { decodeTape, encodeTape } from '../protocol/codec';
import type { Tape } from '../protocol/types';

const caps = {
  compute: true,
  indirectDrawing: true,
  storageBuffer: true,
};

function makeTape(compression: 'none' | 'gzip'): Tape {
  return {
    header: {
      formatVersion: 7,
      rhiCaps: caps,
      eventCount: 1,
      blobCount: 1,
    },
    bootstrap: [{ handleId: 'buf:1', kind: 'buffer', create: {}, initialData: [] }],
    events: [
      {
        kind: 'writeBuffer',
        handleId: 'buf:1',
        bufferOffset: 0,
        dataHash: 'sha256:payload',
        size: 4,
      },
    ],
    blobs: [
      {
        hash: 'sha256:payload',
        bytes: new Uint8Array([1, 2, 3, 4]),
        compression,
      },
    ],
  };
}

describe('v7 tape container', () => {
  it.each(['none', 'gzip'] as const)('round-trips %s with canonical bytes', (compression) => {
    const first = encodeTape(makeTape(compression));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const decoded = decodeTape(first.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const second = encodeTape(decoded.value);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Array.from(second.value)).toEqual(Array.from(first.value));
    expect(decoded.value.blobs[0]?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('preserves typed array blob bytes and digest identity', () => {
    const encoded = encodeTape(makeTape('none'));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeTape(encoded.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.blobs[0]?.bytes.constructor).toBe(Uint8Array);
    expect(decoded.value.blobs[0]?.hash).toBe('sha256:payload');
  });
});
