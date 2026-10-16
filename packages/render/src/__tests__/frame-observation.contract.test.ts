import type { Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  type FrameObservationReadback,
  type FrameObservationSource,
  observeCurrentFrame,
} from '../record/frame.js';
import { validateGraphTargetCaptureReadback } from '../record/frame-snapshot';
import type { FrameObservationRequest, FrameReceipt } from '../render-contract';

const texture = {} as Texture;
const usage = 0x10 | 0x04 | 0x01;

function source(overrides: Partial<FrameObservationSource> = {}): FrameObservationSource {
  return {
    texture,
    descriptor: {
      texture,
      format: 'rgba16float',
      size: { width: 4, height: 2 },
      usage,
      sample: 1,
    },
    frameId: 12,
    pipelineId: 'forgeax::standard',
    backendId: 'webgpu',
    ...overrides,
  };
}

describe('render current-frame observation producer contract', () => {
  it('requires a receipt-bound request instead of a latest-frame getter', () => {
    const receipt = null as unknown as FrameReceipt;
    const request: FrameObservationRequest = { include: ['timings', 'draws'] };
    // M6 red snapshot: observe must be bound to the exact receipt and request.
    expect(receipt).toBeDefined();
    expect(request.include).toEqual(['timings', 'draws']);
  });

  it('observes only the producer-owned linear HDR target', async () => {
    const readback: FrameObservationReadback = vi.fn(async (lease) => {
      expect(lease.descriptor.format).toBe('rgba16float');
      return ok(new Uint8Array(4 * 2 * 8));
    });

    const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, source(), 12);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes.byteLength).toBe(64);
    expect(result.value.metadata).toMatchObject({
      format: 'rgba16float',
      size: { width: 4, height: 2 },
      frameId: 12,
      pipelineId: 'forgeax::standard',
      backendId: 'webgpu',
    });
    expect(readback).toHaveBeenCalledTimes(1);
  });

  it('fails closed for stale, missing, malformed, or final-canvas sources', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(64)));
    const cases: Array<[FrameObservationSource | undefined, string]> = [
      [undefined, 'observation-unavailable'],
      [source({ frameId: 11 }), 'observation-unavailable'],
      [
        source({ descriptor: { ...source().descriptor, format: 'bgra8unorm' } }),
        'observation-unavailable',
      ],
      [
        source({ descriptor: { ...source().descriptor, usage: 0x10 | 0x04 } }),
        'observation-unavailable',
      ],
    ];

    for (const [candidate, code] of cases) {
      const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, candidate, 12);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
    expect(readback).not.toHaveBeenCalled();
  });

  it('preserves the Standard producer identity without backend policy', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(64)));
    const urp = await observeCurrentFrame(
      { semantic: 'linear-hdr', readback },
      source({ pipelineId: 'forgeax::standard' }),
      12,
    );
    const hdrp = await observeCurrentFrame(
      { semantic: 'linear-hdr', readback },
      source({ pipelineId: 'forgeax::standard' }),
      12,
    );

    expect(urp.ok && hdrp.ok).toBe(true);
    if (urp.ok && hdrp.ok) {
      expect(urp.value.metadata.pipelineId).toBe('forgeax::standard');
      expect(hdrp.value.metadata.pipelineId).toBe('forgeax::standard');
      expect(urp.value.metadata.backendId).toBe(hdrp.value.metadata.backendId);
    }
  });

  it('does not treat a final-canvas readback as a linear attachment', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(4)));
    const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, undefined, 12);

    expect(result.ok).toBe(false);
    expect(readback).not.toHaveBeenCalled();
  });

  it('rejects empty fallback bytes unless the selected rows are neutral', () => {
    const bytes = new Uint8Array(256);
    expect(
      validateGraphTargetCaptureReadback({ bytes, expectedByteLength: bytes.byteLength }),
    ).toEqual({ ok: false, code: 'capture-readback-empty' });
    expect(
      validateGraphTargetCaptureReadback({
        bytes,
        expectedByteLength: bytes.byteLength,
        allowZero: true,
      }),
    ).toEqual({ ok: true });
  });
  it('validates every half-float encoding in both word lanes and an unaligned tail', () => {
    const storage = new Uint8Array(8);
    const bytes = storage.subarray(1, 7);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let bits = 0; bits <= 0xffff; bits += 1) {
      for (const offset of [0, 2, 4]) {
        bytes.fill(0);
        view.setUint16(offset, bits, true);
        const result = validateGraphTargetCaptureReadback({
          bytes,
          expectedByteLength: bytes.byteLength,
          allowZero: true,
        });
        const finite = (bits & 0x7c00) !== 0x7c00;
        if (result.ok !== finite)
          throw new Error(`half ${bits.toString(16)} at byte ${offset} misclassified`);
        if (!result.ok && result.code !== 'capture-readback-non-finite')
          throw new Error(`half ${bits.toString(16)} returned ${result.code}`);
      }
    }
  });
});
