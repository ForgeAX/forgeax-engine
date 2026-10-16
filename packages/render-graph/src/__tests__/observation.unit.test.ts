import type { Texture } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  type CurrentFrameObservationDescriptor,
  type CurrentFrameObservationLease,
  createCurrentFrameObservationLease,
  RenderGraphError,
} from '../observation.js';

const COPY_SRC = 0x01;
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_BINDING = 0x04;

const texture = {} as Texture;

function descriptor(
  overrides: Partial<CurrentFrameObservationDescriptor> = {},
): CurrentFrameObservationDescriptor {
  return {
    texture,
    format: 'rgba16float',
    size: { width: 32, height: 16 },
    usage: RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC,
    frameId: 7,
    ...overrides,
  };
}

function expectError(
  result: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe('current-frame observation lease', () => {
  it('accepts an opaque texture descriptor with a fresh frame lifetime', () => {
    const result = createCurrentFrameObservationLease(descriptor(), 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.descriptor).toEqual(descriptor());
    expect(result.value.state).toBe('active');
    expect(result.value.beginReadback().ok).toBe(true);
  });

  it('rejects missing or incompatible observation descriptors', () => {
    expectError(
      createCurrentFrameObservationLease(descriptor({ format: 'bgra8unorm' }), 7),
      'observation-invalid-format',
    );
    expectError(
      createCurrentFrameObservationLease(descriptor({ size: { width: 0, height: 16 } }), 7),
      'observation-invalid-size',
    );
    expectError(
      createCurrentFrameObservationLease(descriptor({ usage: RENDER_ATTACHMENT }), 7),
      'observation-missing-copy-src',
    );
    expectError(
      createCurrentFrameObservationLease(descriptor({ texture: undefined as never }), 7),
      'observation-absent',
    );
  });

  it('rejects stale frame descriptors before a lease is created', () => {
    expectError(
      createCurrentFrameObservationLease(descriptor({ frameId: 6 }), 7),
      'observation-stale',
    );
  });

  it('fails closed after retirement and exposes no graph key or policy', () => {
    const result = createCurrentFrameObservationLease(descriptor(), 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const lease: CurrentFrameObservationLease = result.value;
    lease.retire();
    expect(lease.state).toBe('retired');
    expectError(lease.beginReadback(), 'observation-retired');
    expect('graphKey' in lease).toBe(false);
    expect('pipelineId' in lease).toBe(false);
    expect('backendHandle' in lease).toBe(false);
  });

  it('keeps the graph package isolated from semantic owners', async () => {
    const source = await import('../observation.js');
    const sourceText = Object.keys(source).join(' ');
    expect(sourceText).not.toMatch(/linear-hdr|URP|HDRP|parity/i);
  });

  it('uses the structured RenderGraphError surface', () => {
    expect(
      new RenderGraphError({
        code: 'observation-stale',
        expected: 'current frame observation',
        hint: 'capture the current frame before the producer retires it',
      }),
    ).toBeInstanceOf(Error);
  });
});
