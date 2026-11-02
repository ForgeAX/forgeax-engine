import type { FrameReceipt, FrameReceiptObservation } from '@forgeax/engine-render';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  captureVfxFrame,
  observeVfxGpu,
  saveVfxFailureFrame,
} from './vfx-failure-evidence.fixture';

describe('VFX failure evidence', () => {
  it('records the exact requested adapter and its device without a second selection', async () => {
    const device = {
      features: new Set(['shader-f16']),
      limits: { maxBufferSize: 1024 },
      addEventListener: vi.fn(),
    };
    const requestDevice = vi.fn(async () => device);
    const requestAdapter = vi.fn(async () => ({
      info: {
        vendor: 'test-vendor',
        architecture: 'test-architecture',
        device: 'test-device',
        description: 'same selected adapter',
      },
      features: new Set(['shader-f16']),
      limits: Object.create({ maxBufferSize: 2048 }),
      requestDevice,
    }));
    const observed = observeVfxGpu({ requestAdapter } as unknown as GPU);
    const options = { powerPreference: 'low-power' } as const;
    const adapter = await observed.provider.requestAdapter(options);
    if (adapter === null) throw new Error('missing test adapter');
    const descriptor: GPUDeviceDescriptor = {
      label: 'same-device',
      requiredFeatures: ['shader-f16'],
    };
    expect(await adapter.requestDevice(descriptor)).toBe(device);
    expect(requestAdapter).toHaveBeenCalledExactlyOnceWith(options);
    expect(requestDevice).toHaveBeenCalledExactlyOnceWith(descriptor);
    expect(device.addEventListener).toHaveBeenCalledWith('uncapturederror', expect.any(Function));
    expect(observed.adapters).toMatchObject([
      {
        info: { device: 'test-device' },
        limits: { maxBufferSize: 2048 },
        devices: [{ descriptor, limits: { maxBufferSize: 1024 } }],
      },
    ]);
  });

  it('brackets exactly one existing frame before resolving its tape', async () => {
    const events: string[] = [];
    const tape = { bytes: new Uint8Array([1, 2]) } as EncodedTape;
    let finish!: () => void;
    const recorder = {
      captureFrame: () => {
        events.push('capture');
        return new Promise((resolve) => {
          finish = () => resolve(ok(tape));
        });
      },
      frameBoundary: async () => {
        events.push('boundary');
        if (events.filter((value) => value === 'boundary').length === 2) finish();
        return ok(undefined);
      },
    } as unknown as RecorderAttachment;
    const result = await captureVfxFrame(recorder, async () => {
      events.push('original-step');
      return 17;
    });
    expect(events).toEqual(['capture', 'boundary', 'original-step', 'boundary']);
    expect(result).toEqual({ value: 17, tape });
  });

  it('retires an armed capture when the original frame fails', async () => {
    let retired = false;
    const recorder = {
      captureFrame: (options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => {
            retired = true;
            resolve({ ok: false, error: { code: 'capture-unavailable' } });
          });
        }),
      frameBoundary: async () => ok(undefined),
    } as unknown as RecorderAttachment;
    const cause = new Error('original frame failure');
    await expect(
      captureVfxFrame(recorder, async () => {
        throw cause;
      }),
    ).rejects.toBe(cause);
    expect(retired).toBe(true);
  });

  it('persists raw pixels and preserves missing identity as an unverified join', async () => {
    const files = new Map<string, Uint8Array>();
    const receipt: FrameReceipt = {
      frameId: 9,
      deviceGeneration: 2,
      graphGeneration: 4,
      presentation: 'ready',
      completed: Promise.resolve(ok(undefined)),
    };
    const observation = {
      domain: 'linear-hdr',
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      metadata: {
        frameId: 9,
        deviceGeneration: 2,
        graphGeneration: 4,
        format: 'rgba16float',
        width: 1,
        height: 1,
        bytesPerRow: 8,
        textureIdentity: 1,
        readbackIdentity: 2,
        footprint: { resourceCount: 1, bindGroupCount: 0 },
      },
    } as NonNullable<FrameReceiptObservation['observations']>[number];
    await saveVfxFailureFrame({
      name: 'before-assertion',
      write: (name, bytes) => {
        files.set(name, bytes);
      },
      receipt,
      observation,
      backend: {},
      state: { matrix: new Float32Array([2.05, 0.08]) },
    });
    expect(files.get('before-assertion.rgba')).toEqual(observation.bytes);
    const saved = JSON.parse(new TextDecoder().decode(files.get('before-assertion.json')));
    expect(saved.receipt.completed).toEqual({ ok: true });
    expect(saved.state.matrix).toEqual(Array.from(new Float32Array([2.05, 0.08])));
    expect(saved.receiptMatchesObservation).toBe(false);
    await saveVfxFailureFrame({
      name: 'joined',
      write: (name, bytes) => {
        files.set(name, bytes);
      },
      receipt: { ...receipt, backendId: 'webgpu' },
      observation: { ...observation, metadata: { ...observation.metadata, backendId: 'webgpu' } },
      backend: {},
      state: {},
    });
    expect(
      JSON.parse(new TextDecoder().decode(files.get('joined.json'))).receiptMatchesObservation,
    ).toBe(true);
  });
});
