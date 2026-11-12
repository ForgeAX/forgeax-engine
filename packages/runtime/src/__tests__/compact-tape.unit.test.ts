import { decodeTape, encodeTape, tapeArtifact, type V7Tape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { compactTape } from './compact-tape.fixture';

it('reuses one lazy compressed artifact without dropping any seed, event or payload', () => {
  const data = new Uint8Array(64 * 1024).fill(17);
  const tape: V7Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 1, blobCount: 1 },
    bootstrap: [{ handleId: 'buffer:fixture', kind: 'buffer', create: {}, initialData: [] }],
    events: [
      {
        kind: 'writeBuffer',
        handleId: 'buffer:fixture',
        bufferOffset: 0,
        dataHash: 'payload',
        size: data.byteLength,
      },
    ],
    blobs: [{ hash: 'payload', bytes: data, compression: 'none' }],
  };
  const artifact = { ...tapeArtifact([encodeTape(tape).unwrap()]), tape };
  const compressed = compactTape(artifact);
  expect(compactTape(artifact)).toBe(compressed);
  expect(compactTape(compressed)).toBe(compressed);
  expect(typeof Object.getOwnPropertyDescriptor(compressed, 'digest')?.get).toBe('function');
  expect(compressed.byteLength).toBeLessThan(artifact.byteLength / 4);
  const decoded = decodeTape(compressed.bytes).unwrap();
  expect(decoded.bootstrap).toEqual(tape.bootstrap);
  expect(decoded.events).toEqual(tape.events);
  expect(decoded.blobs[0]?.bytes).toEqual(data);
  expect(decoded.blobs[0]?.compression).toBe('gzip');
});

it('keeps an already compressed capture without decoding or encoding its payloads again', () => {
  const tape: V7Tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 1, blobCount: 2 },
    bootstrap: [],
    events: [{ kind: 'frameMark', frameIdx: 0 }],
    blobs: [
      { hash: 'compressible', bytes: new Uint8Array(64 * 1024), compression: 'none' },
      { hash: 'small', bytes: new Uint8Array([1, 2, 3]), compression: 'none' },
    ],
  };
  const artifact = {
    ...tapeArtifact([encodeTape(tape, { compression: 'auto' }).unwrap()]),
    get tape(): V7Tape {
      throw new Error('compressed evidence must stay encoded');
    },
  };
  const compacted = compactTape(artifact);
  expect(compacted).toBe(artifact);
  expect(compactTape(artifact)).toBe(artifact);
  const decoded = decodeTape(compacted.bytes).unwrap();
  expect(decoded.events).toEqual(tape.events);
  expect(decoded.blobs.map((blob) => blob.bytes)).toEqual(tape.blobs.map((blob) => blob.bytes));
  expect(decoded.blobs.map((blob) => blob.compression)).toEqual(['gzip', 'none']);
});
