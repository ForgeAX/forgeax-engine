import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { BootstrapResource, Tape } from '../protocol/types';
import type { ReplayBackend } from '../replay/session';
import { openReplay } from '../replay/session';

const buffer: BootstrapResource = {
  handleId: 'buffer:readback',
  kind: 'buffer',
  create: {
    kind: 'createBuffer',
    handleId: 'buffer:readback',
    desc: { size: 32, usage: 8 },
  },
  initialData: [],
};

const tape: Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [buffer],
  events: [],
  blobs: [],
};

async function backendWithDestroySpy(): Promise<{
  backend: ReplayBackend;
  destroy: ReturnType<typeof vi.fn>;
}> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(adapter.error.hint);
  const result = await adapter.value.requestDevice();
  if (!result.ok) throw new Error(result.error.hint);
  const base = result.value;
  const destroy = vi.fn((value) => base.destroyBuffer(value));
  const device = Object.create(base) as RhiDevice;
  Object.defineProperty(device, 'destroyBuffer', { configurable: true, value: destroy });
  return { backend: { device, createShaderModule }, destroy };
}

describe('Replay readback cleanup', () => {
  it('cleans staging resources when map/readback fails', async () => {
    const { backend, destroy } = await backendWithDestroySpy();
    const replay = await openReplay(tape, backend);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    const readback = await replay.value.readResource('buffer:readback', { offset: 4, size: 8 });
    expect(readback.ok).toBe(false);
    if (!readback.ok) expect(readback.error.code).toBe('readback-failed');
    expect(destroy).toHaveBeenCalled();
  });

  it('rejects a range that escapes the recorded buffer before GPU work', async () => {
    const replay = await openReplay(
      tape,
      await backendWithDestroySpy().then((value) => value.backend),
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    const readback = await replay.value.readResource('buffer:readback', { offset: 24, size: 16 });
    expect(readback.ok).toBe(false);
    if (!readback.ok) expect(readback.error.code).toBe('readback-failed');
  });
});
