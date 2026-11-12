import { openReplay, type ReplaySession, type V7Tape } from '@forgeax/engine-rhi-debug';
import { disposeDevice, rhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openViewerReplay } from '../viewer-context';

vi.mock('@forgeax/engine-rhi-debug', () => ({
  openReplay: vi.fn(),
  replayDeviceRequest: vi.fn(() => ({})),
  createRhiDebugError: vi.fn(),
}));
vi.mock('@forgeax/engine-rhi-webgpu', () => ({
  rhi: { requestAdapter: vi.fn() },
  createShaderModule: vi.fn(),
  disposeDevice: vi.fn(),
}));

const tape: V7Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
  bootstrap: [],
  events: [],
  blobs: [],
};

function prepare() {
  vi.stubGlobal('navigator', { gpu: {} });
  const device = {} as Parameters<typeof openReplay>[1]['device'];
  vi.spyOn(rhi, 'requestAdapter').mockResolvedValue(
    ok({ features: new Set(), limits: {}, requestDevice: async () => ok(device) }) as Awaited<
      ReturnType<typeof rhi.requestAdapter>
    >,
  );
  return device;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('viewer-owned replay backend lifecycle', () => {
  it('releases the fresh device only after resources drain and only once', async () => {
    const device = prepare();
    let drained!: () => void;
    const drain = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const session = { dispose: vi.fn(() => drain) } as unknown as ReplaySession;
    vi.mocked(openReplay).mockResolvedValue(ok(session));
    const replay = await openViewerReplay(tape);
    const first = replay.dispose();
    const second = replay.dispose();
    expect(disposeDevice).not.toHaveBeenCalled();
    drained();
    await Promise.all([first, second]);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  });

  it('releases a device rejected by replay admission', async () => {
    const device = prepare();
    vi.mocked(openReplay).mockResolvedValue(
      err({
        code: 'readback-failed',
        expected: 'valid tape',
        hint: 'recapture',
        detail: { stage: 'readback', cause: 'invalid tape' },
      }),
    );
    const replay = await openViewerReplay(tape);
    expect(replay.session).toBeNull();
    expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  });

  it('releases a device even when resource disposal rejects', async () => {
    const device = prepare();
    const failure = new Error('resource disposal failed');
    vi.mocked(openReplay).mockResolvedValue(
      ok({ dispose: vi.fn().mockRejectedValue(failure) } as unknown as ReplaySession),
    );
    const replay = await openViewerReplay(tape);
    await expect(replay.dispose()).rejects.toBe(failure);
    expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  });

  it('releases a device when replay admission throws without replacing its cause', async () => {
    const device = prepare();
    const failure = new Error('backend admission failed');
    vi.mocked(openReplay).mockRejectedValue(failure);
    await expect(openViewerReplay(tape)).rejects.toBe(failure);
    expect(disposeDevice).toHaveBeenCalledExactlyOnceWith(device);
  });
});
