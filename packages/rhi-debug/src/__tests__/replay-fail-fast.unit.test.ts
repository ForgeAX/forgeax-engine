import { type RhiDevice, RhiError, type RhiQueue } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { Tape } from '../protocol/types';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';

function baseEvents(): Tape['events'] {
  return [
    { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 16, usage: 8 } },
    {
      kind: 'writeBuffer',
      handleId: 'buf:1',
      bufferOffset: 0,
      dataHash: 'sha256:payload',
      size: 4,
    },
    { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
    { kind: 'beginComputePass', cmdHandleId: 'encoder:1', passHandleId: 'pass:1', desc: {} },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 1, y: 1, z: 1 },
    { kind: 'endComputePass', passHandleId: 'pass:1' },
    { kind: 'finish', cmdHandleId: 'encoder:1' },
    { kind: 'submit', cmdHandleIds: ['encoder:1'] },
  ];
}

function tape(events: Tape['events'] = baseEvents()): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 1 },
    bootstrap: [],
    events,
    blobs: [{ hash: 'sha256:payload', bytes: new Uint8Array([1, 2, 3, 4]), compression: 'none' }],
  };
}

async function device(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw new Error(result.error.hint);
  return result.value;
}

function failure(code: 'webgpu-runtime-error' | 'shader-compile-failed'): RhiError {
  return new RhiError({
    code,
    expected: 'the injected RHI operation succeeds',
    hint: 'fault fixture',
  });
}

function withDeviceOverrides(
  base: RhiDevice,
  overrides: Partial<Pick<RhiDevice, 'createBuffer' | 'createCommandEncoder'>> & {
    readonly queue?: RhiQueue;
  },
): RhiDevice {
  const result = Object.create(base) as RhiDevice;
  for (const [key, value] of Object.entries(overrides)) {
    Object.defineProperty(result, key, { configurable: true, value });
  }
  return result;
}

describe('ReplaySession fail-closed executor', () => {
  it('rejects an unenabled WGSL feature before creating replay resources', async () => {
    const shader = vi.fn(createShaderModule);
    const result = await openReplay(
      tape([
        {
          kind: 'createShaderModule',
          handleId: 'shader:1',
          wgslCode:
            'enable primitive_index; @fragment fn main(@builtin(primitive_index) p:u32) -> @location(0) u32 { return p; }',
        },
      ]),
      { device: await device(), createShaderModule: shader },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        code: 'replay-capability-mismatch',
        detail: { stage: 'replay', cause: 'missing device features: primitive-index' },
      });
    expect(shader).not.toHaveBeenCalled();
  });
  it('reports create failure with location and does not execute later work', async () => {
    const base = await device();
    const laterCreate = vi.fn(() => base.createBuffer({ size: 16, usage: 8 }));
    const failing = withDeviceOverrides(base, {
      createBuffer: vi.fn(() => err(failure('webgpu-runtime-error'))),
    });
    const backend: ReplayBackend = { device: failing, createShaderModule };
    const result = await openReplay(
      tape([
        { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 16, usage: 8 } },
        { kind: 'createBuffer', handleId: 'buf:2', desc: { size: 16, usage: 8 } },
        ...baseEvents().slice(2),
      ]),
      backend,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = await result.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok) {
      expect(inspection.error.code).toBe('replay-event-failed');
      if (inspection.error.code === 'replay-event-failed') {
        expect(inspection.error.detail?.eventIndex).toBe(0);
        expect(inspection.error.detail?.kind).toBe('createBuffer');
        expect(inspection.error.detail?.stage).toBe('create');
      }
    }
    expect(laterCreate).not.toHaveBeenCalled();
  });

  it('turns shader factory failure into the first terminal event error', async () => {
    const backend: ReplayBackend = {
      device: await device(),
      createShaderModule: async () => err(failure('shader-compile-failed')),
    };
    const result = await openReplay(
      tape([
        { kind: 'createShaderModule', handleId: 'shader:1', wgslCode: '@compute fn main() {}' },
        ...baseEvents(),
      ]),
      backend,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = await result.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok && inspection.error.code === 'replay-event-failed') {
      expect(inspection.error.detail?.eventIndex).toBe(0);
      expect(inspection.error.detail?.kind).toBe('createShaderModule');
      expect(inspection.error.detail?.stage).toBe('create');
      expect(inspection.error.detail?.cause).toContain('shader-compile-failed');
    }
  });

  it('stops at write failures before dispatch', async () => {
    const base = await device();
    const queue = Object.create(base.queue) as RhiQueue;
    Object.defineProperty(queue, 'writeBuffer', {
      configurable: true,
      value: vi.fn(() => err(failure('webgpu-runtime-error'))),
    });
    const backend: ReplayBackend = {
      device: withDeviceOverrides(base, { queue }),
      createShaderModule,
    };
    const result = await openReplay(tape(), backend);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspection = await result.value.inspectWork(0);
    expect(inspection.ok).toBe(false);
    if (!inspection.ok && inspection.error.code === 'replay-event-failed') {
      expect(inspection.error.detail?.eventIndex).toBe(1);
      expect(inspection.error.detail?.kind).toBe('writeBuffer');
      expect(inspection.error.detail?.stage).toBe('write');
    }
  });

  it('rejects stale generation reads after a new inspection reset', async () => {
    const result = await openReplay(tape(), { device: await device(), createShaderModule });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = await result.value.inspectWork(0);
    expect(first.ok).toBe(true);
    const generation = result.value.generation;
    expect(generation).toBeGreaterThan(0);
    expect((await result.value.dispose()).ok).toBe(true);
    expect((await result.value.dispose()).ok).toBe(true);
  });
});
