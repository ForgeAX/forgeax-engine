import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { executeScript } from '../execute';
import { buildIntrospectDoc } from '../introspect';

const rhiCapture = {
  captureFrame: async () =>
    ok({
      kind: 'rhi-tape' as const,
      digest: 'sha256:remote-contract',
      bytes: new Uint8Array([1, 2, 3]),
    }),
};

describe('remote RHI capture capability', () => {
  it('exposes capture only and returns the terminal artifact', async () => {
    const result = await executeScript('rhiCapture.captureFrame()', {
      world: {},
      renderer: {},
      assets: {},
      rhiCapture,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        ok: true,
        value: {
          kind: 'rhi-tape',
          digest: 'sha256:remote-contract',
          bytes: new Uint8Array([1, 2, 3]),
        },
      },
    });
  });

  it('introspects one capture capability without live replay roots', () => {
    const document = buildIntrospectDoc('127.0.0.1', 5732, {
      world: {},
      renderer: {},
      assets: {},
      rhiCapture,
    });

    expect(document).toMatchObject({
      roots: {
        rhiCapture: {
          available: true,
          type: 'RhiCapture',
          capability: 'rhi-capture-v1',
        },
      },
    });
    expect((document as { roots: Record<string, unknown> }).roots).not.toHaveProperty(
      'legacyCapture',
    );
  });
});
