import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTape, encodeTape } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { createRawTapeProvider, RHITAPE_MIME, vitePluginRhiDebug } from '../index';

async function validTapeBytes(): Promise<Uint8Array> {
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  });
  if (!encoded.ok) throw new Error(encoded.error.hint);
  return encoded.value;
}

describe('raw .rhitape provider', () => {
  it('contains an interrupted upload inside the middleware and remains usable', async () => {
    let middleware!: (request: unknown, response: unknown, next: () => void) => Promise<void>;
    const plugin = vitePluginRhiDebug();
    if (typeof plugin.configureServer !== 'function') throw new Error('missing configureServer');
    plugin.configureServer.call(
      undefined as never,
      {
        middlewares: {
          use: (handler: typeof middleware) => {
            middleware = handler;
          },
        },
      } as never,
    );
    const response = { statusCode: 0, setHeader() {}, end() {} };
    const interrupted = {
      method: 'POST',
      url: '/__forgeax-debug/tape?runId=interrupted',
      headers: { 'content-type': RHITAPE_MIME },
      async *[Symbol.asyncIterator]() {
        yield new Uint8Array([82, 72, 73]);
        throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
      },
    };
    await expect(middleware(interrupted, response, () => {})).resolves.toBeUndefined();
    expect(response.statusCode).toBe(400);
    await middleware({ method: 'GET', url: interrupted.url }, response, () => {});
    expect(response.statusCode).toBe(405);
  });
  it('accepts one raw v7 body, validates it, and returns one digest-bearing artifact', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-provider-'));
    try {
      const bytes = await validTapeBytes();
      const provider = createRawTapeProvider({ rootDir });
      const result = await provider.accept({
        runId: 'raw-provider',
        contentType: RHITAPE_MIME,
        bytes,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        kind: 'rhi-tape',
        path: join(rootDir, '.forgeax-debug', 'raw-provider', 'frame.rhitape'),
      });
      expect(decodeTape(await readFile(result.value.path))).toMatchObject({ ok: true });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects non-raw MIME and invalid bytes before writing', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-invalid-'));
    try {
      const provider = createRawTapeProvider({ rootDir });
      const wrongMime = await provider.accept({
        runId: 'wrong-mime',
        contentType: 'application/json',
        bytes: await validTapeBytes(),
      });
      const invalidBytes = await provider.accept({
        runId: 'invalid-bytes',
        contentType: RHITAPE_MIME,
        bytes: new Uint8Array([1, 2, 3]),
      });

      expect(wrongMime.ok).toBe(false);
      expect(invalidBytes.ok).toBe(false);
      await expect(
        readFile(join(rootDir, '.forgeax-debug', 'wrong-mime', 'frame.rhitape')),
      ).rejects.toThrow();
      await expect(
        readFile(join(rootDir, '.forgeax-debug', 'invalid-bytes', 'frame.rhitape')),
      ).rejects.toThrow();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps debug flag enabled only for serve', () => {
    const plugin = vitePluginRhiDebug();
    expect(plugin.config).toBeTypeOf('function');
    if (typeof plugin.config !== 'function') return;
    expect(
      plugin.config?.call(undefined as never, {}, { command: 'serve', mode: 'development' }),
    ).toMatchObject({
      define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"1"' },
    });
    expect(
      plugin.config?.call(undefined as never, {}, { command: 'build', mode: 'production' }),
    ).toMatchObject({
      define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"' },
    });
  });
});
