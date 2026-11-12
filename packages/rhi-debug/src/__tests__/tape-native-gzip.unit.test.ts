import zlib, { gunzipSync } from 'node:zlib';
import pako from 'pako';
import { expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import {
  decodeTape,
  decodeTapeContainerIndex,
  digestBytes,
  encodeTape,
  encodeTapeParts,
  TAPE_PREAMBLE_BYTES,
} from '../protocol/codec';
import type { Tape } from '../protocol/types';

function tape(bytes: Uint8Array): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 1 },
    bootstrap: [],
    events: [],
    blobs: [{ hash: 'complete-payload', bytes, compression: 'gzip' }],
  };
}

/** An ordinary v7 container carrying independently produced stored gzip bytes. */
function gzipContainer(stored: Uint8Array): Uint8Array {
  const source = tape(new Uint8Array());
  const preamble = encodeTape(source).unwrap().subarray(0, TAPE_PREAMBLE_BYTES);
  const json = new TextEncoder().encode(
    JSON.stringify({
      ...source,
      blobs: [
        {
          hash: 'complete-payload',
          offset: 0,
          length: stored.byteLength,
          compression: 'gzip',
          digest: digestBytes(stored),
        },
      ],
    }),
  );
  const result = new Uint8Array(preamble.byteLength + json.byteLength + stored.byteLength);
  result.set(preamble);
  const view = new DataView(result.buffer);
  view.setUint32(TAPE_PREAMBLE_BYTES - 8, json.byteLength, true);
  view.setUint32(TAPE_PREAMBLE_BYTES - 4, stored.byteLength, true);
  result.set(json, preamble.byteLength);
  result.set(stored, preamble.byteLength + json.byteLength);
  return result;
}

it('keeps compressed parts as ordinary owned byte arrays with copying slices', () => {
  const stored = encodeTapeParts(tape(new Uint8Array([1, 2, 3]))).unwrap().parts[1];
  if (stored === undefined) throw new Error('missing compressed payload');
  expect(Object.is(Object.getPrototypeOf(stored), Uint8Array.prototype)).toBe(true);
  expect(stored.buffer.byteLength).toBe(stored.byteLength);
  const before = stored[0];
  const copy = stored.slice();
  copy[0] = (copy[0] ?? 0) ^ 1;
  expect(stored[0]).toBe(before);
});

it('uses native gzip for actual Node container work without JavaScript codec calls', () => {
  const input = Uint8Array.from({ length: 16_391 }, (_, index) => (index * 17) & 255);
  const gzip = vi.spyOn(pako, 'gzip');
  const ungzip = vi.spyOn(pako, 'ungzip');
  const nativeGzip = vi.spyOn(zlib, 'gzipSync');
  const nativeUngzip = vi.spyOn(zlib, 'gunzipSync');
  try {
    const encoded = encodeTape(tape(input)).unwrap();
    const decoded = decodeTape(encoded).unwrap();
    expect(equalBytes(decoded.blobs[0]?.bytes, input)).toBe(true);
    expect(gzip).not.toHaveBeenCalled();
    expect(ungzip).not.toHaveBeenCalled();
    expect(nativeGzip).toHaveBeenCalledTimes(1);
    expect(nativeUngzip).toHaveBeenCalledTimes(1);
  } finally {
    gzip.mockRestore();
    ungzip.mockRestore();
    nativeGzip.mockRestore();
    nativeUngzip.mockRestore();
  }
});

it.each([
  0, 1, 31, 65_539,
])('keeps portable gzip compatibility for every byte of a %i-byte subview', (size) => {
  const backing = Uint8Array.from({ length: size + 9 }, (_, index) => (index * 73) & 255);
  const input = backing.subarray(3, size + 3);
  const encoded = encodeTape(tape(input)).unwrap();
  const index = decodeTapeContainerIndex(encoded, encoded.byteLength).unwrap();
  const blob = index.blobs[0];
  expect(blob).toBeDefined();
  if (blob === undefined) throw new Error('missing encoded blob');
  const stored = encoded.subarray(
    index.payloadStart + blob.offset,
    index.payloadStart + blob.offset + blob.length,
  );
  expect(equalBytes(pako.ungzip(stored), input)).toBe(true);
  expect(equalBytes(gunzipSync(pako.gzip(input)), input)).toBe(true);
  expect(
    equalBytes(decodeTape(gzipContainer(pako.gzip(input))).unwrap().blobs[0]?.bytes, input),
  ).toBe(true);
  expect(equalBytes(decodeTape(encoded).unwrap().blobs[0]?.bytes, input)).toBe(true);
});

it('retains structured digest and gzip validation failures', () => {
  const invalid = decodeTape(gzipContainer(new Uint8Array([1, 2, 3, 4])));
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) {
    expect(invalid.error.code).toBe('tape-invalid');
    expect(invalid.error.detail).toMatchObject({ stage: 'decode' });
  }
  const corrupted = gzipContainer(pako.gzip(new Uint8Array([1, 2, 3, 4])));
  corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
  const digest = decodeTape(corrupted);
  expect(digest.ok).toBe(false);
  if (!digest.ok) {
    expect(digest.error.code).toBe('tape-invalid');
    expect(digest.error.detail).toMatchObject({ stage: 'validate' });
  }
});
