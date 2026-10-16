import { describe, expect, it } from 'vitest';
import { createPreviewHost, type PreviewHostAdapter } from '../index.js';

function adapterWithCensus(census: {
  worlds: number;
  renderers: number;
  canvases: number;
  leases: number;
}): PreviewHostAdapter {
  let disposed = 0;
  return {
    open() {
      return {
        subject: { kind: 'fixture', guid: 'fixture:session' },
        snapshot: { revision: 0, digest: 'sha256:fixture' },
        loadAsset: async () => ({ guid: 'asset:fixture', bytes: 12 }),
        frame: async () => undefined,
        capture: async () => ({ digest: 'sha256:capture', bytes: 12 }),
        census: () => census,
        dispose: async () => {
          disposed += 1;
        },
        disposed: () => disposed,
      };
    },
  };
}

describe('preview host lexical session', () => {
  it('leases typed binding/frame/capture capabilities and disposes them once', async () => {
    const adapter = adapterWithCensus({ worlds: 0, renderers: 0, canvases: 0, leases: 0 });
    const host = createPreviewHost(adapter);
    const result = await host.withSession(
      {
        subject: { kind: 'mesh', guid: 'mesh:fixture' },
        snapshot: { revision: 1, digest: 'sha256:project' },
      },
      async (session) => {
        const asset = await session.loadAsset('mesh:fixture');
        await session.frame({ frame: 0, deltaSeconds: 0 });
        return { asset, capture: await session.capture() };
      },
    );

    expect(result.value.asset.guid).toBe('asset:fixture');
    expect(result.value.capture.digest).toBe('sha256:capture');
    expect(result.cleanup.census).toEqual({ worlds: 0, renderers: 0, canvases: 0, leases: 0 });
  });

  it('fails closed when a session leaves a live resource census', async () => {
    const host = createPreviewHost(
      adapterWithCensus({ worlds: 1, renderers: 0, canvases: 0, leases: 0 }),
    );

    await expect(
      host.withSession(
        {
          subject: { kind: 'material', guid: 'material:fixture' },
          snapshot: { revision: 1, digest: 'sha256:project' },
        },
        async () => 'result',
      ),
    ).rejects.toMatchObject({ code: 'preview-cleanup-live-resources' });
  });
});
