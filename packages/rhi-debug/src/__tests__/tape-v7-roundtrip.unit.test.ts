import { describe, expect, it } from 'vitest';
import { decodeTape, decodeTapeContainerIndex, encodeTape } from '../protocol/codec';
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
  it('compresses useful payloads and preserves incompressible GPU bytes without expansion', () => {
    let seed = 12345;
    const noise = Uint8Array.from({ length: 4096 }, () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed & 255;
    });
    const source = makeTape('none');
    const tape: Tape = {
      ...source,
      header: { ...source.header, blobCount: 2 },
      blobs: [
        { hash: 'sha256:zeros', bytes: new Uint8Array(4096), compression: 'none' },
        { hash: 'sha256:blocks', bytes: noise, compression: 'none' },
      ],
    };
    const encoded = encodeTape(tape, { compression: 'auto' }).unwrap();
    const index = decodeTapeContainerIndex(encoded, encoded.length).unwrap();
    expect(index.blobs.map((blob) => blob.compression)).toEqual(['gzip', 'none']);
    expect(index.blobs[1]?.length).toBe(noise.length);
    const decoded = decodeTape(encoded).unwrap();
    expect(decoded.blobs.map((blob) => blob.bytes)).toEqual(tape.blobs.map((blob) => blob.bytes));
    // A mixed container retains each blob's chosen representation on re-encode.
    expect(encodeTape(decoded).unwrap()).toEqual(encoded);
  });
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
