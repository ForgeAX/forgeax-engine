import { createShaderModule, rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  concatParts,
  decodeTape,
  decodeTapeContainerIndex,
  digestBytes,
  encodeTape,
  encodeTapeParts,
  readTapePreamble,
  sliceParts,
  TAPE_PREAMBLE_BYTES,
} from '../protocol/codec';
import type { Tape } from '../protocol/types';
import { attachRecorder } from '../recorder/session';

function blob(seed: number, size: number) {
  const bytes = new Uint8Array(size).map((_, i) => (i * 13 + seed) & 255);
  return { hash: digestBytes(bytes), bytes, compression: 'none' as const };
}

function tape(blobs: Tape['blobs']): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: blobs.length },
    bootstrap: [],
    events: [],
    blobs,
  };
}

describe('streamed tape container', () => {
  const sample = tape([blob(1, 300), blob(2, 0), blob(3, 1024), blob(4, 7)]);

  it('encodes parts byte-identical to the contiguous container', () => {
    const parts = encodeTapeParts(sample).unwrap();
    const whole = encodeTape(sample).unwrap();
    expect(parts.byteLength).toBe(whole.byteLength);
    expect(concatParts(parts.parts, parts.byteLength)).toEqual(whole);
    // Payload parts borrow the blob buffers instead of copying them.
    expect(parts.parts.slice(1).map((part) => part.buffer)).toContain(
      sample.blobs[2]?.bytes.buffer,
    );
  });

  it('reuses content hashes as blob digests without changing the container', () => {
    const hashed = encodeTapeParts(sample, { contentHashes: true }).unwrap();
    const plain = encodeTape(sample).unwrap();
    expect(concatParts(hashed.parts, hashed.byteLength)).toEqual(plain);
  });

  it.each([1, 7, 64, 333, 1 << 20])('slices %i-byte windows that cover the container', (size) => {
    const { parts, byteLength } = encodeTapeParts(sample).unwrap();
    const whole = concatParts(parts, byteLength);
    let next = 0;
    for (const chunk of sliceParts(parts, size)) {
      expect(chunk.offset).toBe(next);
      expect(chunk.bytes.byteLength).toBeLessThanOrEqual(size);
      expect(chunk.bytes).toEqual(whole.subarray(next, next + chunk.bytes.byteLength));
      next += chunk.bytes.byteLength;
    }
    expect(next).toBe(byteLength);
  });

  it('decodes the index from the container prefix alone', () => {
    const whole = encodeTape(sample).unwrap();
    const preamble = readTapePreamble(whole.subarray(0, TAPE_PREAMBLE_BYTES)).unwrap();
    expect(preamble.byteLength).toBe(whole.byteLength);
    const index = decodeTapeContainerIndex(
      whole.subarray(0, preamble.indexEnd),
      whole.byteLength,
    ).unwrap();
    expect(index.payloadStart).toBe(preamble.indexEnd);
    for (const [i, entry] of index.blobs.entries()) {
      const source = sample.blobs[i];
      expect(entry.hash).toBe(source?.hash);
      expect(entry.digest).toBe(digestBytes(source?.bytes ?? new Uint8Array()));
      const start = index.payloadStart + entry.offset;
      expect(whole.subarray(start, start + entry.length)).toEqual(source?.bytes);
    }
    const truncated = decodeTapeContainerIndex(
      whole.subarray(0, preamble.indexEnd),
      whole.byteLength - 1,
    );
    expect(truncated.ok).toBe(false);
  });

  it('keeps the assembled capture valid after the recorder releases its pool', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const pending = attachment.captureFrame();
    (await attachment.frameBoundary()).unwrap();
    const buffer = device.createBuffer({ size: 256, usage: 8 | 4 }).unwrap();
    device.queue.writeBuffer(buffer, 0, new Uint8Array(256).fill(9));
    (await attachment.frameBoundary()).unwrap();
    const captured = (await pending).unwrap();
    const { bytes } = captured;
    expect(bytes.byteLength).toBe(captured.byteLength);
    expect(captured.digest).toBe(digestBytes(bytes));
    const streamed = [...captured.chunks(97)].map((chunk) => chunk.bytes);
    expect(concatParts(streamed, captured.byteLength)).toEqual(bytes);
    const decoded = decodeTape(bytes).unwrap();
    expect(decoded.blobs.some((entry) => entry.bytes.every((byte) => byte === 9))).toBe(true);
    (await attachment.dispose()).unwrap();
  });
});
