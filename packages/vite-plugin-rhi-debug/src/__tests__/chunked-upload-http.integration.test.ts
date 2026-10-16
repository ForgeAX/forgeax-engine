import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTape, tapeArtifact, tapeDigest } from '@forgeax/engine-rhi-debug';
import { uploadTape } from '@forgeax/engine-rhi-debug/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vitePluginRhiDebug } from '../index';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;

function artifact() {
  const blobs = [3000, 1, 5000].map((size, index) => {
    const bytes = new Uint8Array(size).map((_, i) => (i * 17 + index) & 255);
    return { hash: tapeDigest(bytes), bytes, compression: 'none' as const };
  });
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: blobs.length },
    bootstrap: [],
    events: [],
    blobs,
  }).unwrap();
  return tapeArtifact([encoded]);
}

describe('uploadTape over the plugin HTTP routes', () => {
  let rootDir: string;
  let server: Server;
  let endpoint: string;
  let fault: ((req: IncomingMessage) => number | undefined) | undefined;
  const puts: number[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'forgeax-rhitape-http-'));
    let middleware!: Middleware;
    const plugin = vitePluginRhiDebug({ rootDir });
    if (typeof plugin.configureServer !== 'function') throw new Error('missing configureServer');
    plugin.configureServer.call(
      undefined as never,
      {
        middlewares: {
          use: (handler: Middleware) => {
            middleware = handler;
          },
        },
      } as never,
    );
    fault = undefined;
    puts.length = 0;
    server = createServer((req, res) => {
      if (req.method === 'PUT')
        puts.push(Number(new URL(req.url ?? '', 'http://x').searchParams.get('offset')));
      const status = fault?.(req);
      if (status !== undefined) {
        req.resume();
        req.on('end', () => {
          res.statusCode = status;
          res.end('{}');
        });
        return;
      }
      void middleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__forgeax-debug/tape`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });

  it('keeps the Crypto receiver when a browser upload generates its default run ID', async () => {
    const tape = artifact();
    const uuid = '00000000-0000-4000-8000-000000000001';
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(function (
      this: Crypto,
    ) {
      if (this !== globalThis.crypto) throw new TypeError('Illegal invocation');
      return uuid;
    });
    try {
      const result = await uploadTape(tape, { endpoint, chunkBytes: 1024 });
      expect(result).toMatchObject({
        ok: true,
        value: { digest: tape.digest, bytes: tape.byteLength },
      });
      if (!result.ok || result.value.path === undefined) throw new Error('missing uploaded tape');
      expect(result.value.path).toContain(`rhi-capture-${uuid}`);
      expect(new Uint8Array(await readFile(result.value.path))).toEqual(tape.bytes);
      expect(randomUUID).toHaveBeenCalledOnce();
    } finally {
      randomUUID.mockRestore();
    }
  });

  it('retries a transient 5xx and publishes the whole-container digest', async () => {
    const tape = artifact();
    let failed = false;
    fault = (req) => {
      if (req.method !== 'PUT' || failed) return undefined;
      failed = true;
      return 503;
    };
    const result = await uploadTape(tape, { endpoint, runId: 'retry', chunkBytes: 1024 });
    expect(result).toMatchObject({
      ok: true,
      value: { digest: tape.digest, bytes: tape.byteLength },
    });
    if (!result.ok || result.value.path === undefined) return;
    expect(new Uint8Array(await readFile(result.value.path))).toEqual(tape.bytes);
    expect(puts.length).toBe(Math.ceil(tape.byteLength / 1024) + 1);
  });

  it('resumes an interrupted upload by sending only the missing chunks', async () => {
    const tape = artifact();
    const chunkCount = Math.ceil(tape.byteLength / 1024);
    fault = (req) => (req.method === 'PUT' && puts.length > 3 ? 500 : undefined);
    const interrupted = await uploadTape(tape, {
      endpoint,
      runId: 'resume',
      chunkBytes: 1024,
      chunkAttempts: 1,
    });
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: 'browser-capture-upload-failed', detail: { stage: 'chunk', status: 500 } },
    });
    const held = puts.filter((_, i) => i < 3);
    fault = undefined;
    puts.length = 0;
    const resumed = await uploadTape(tape, { endpoint, runId: 'resume', chunkBytes: 1024 });
    expect(resumed).toMatchObject({ ok: true, value: { digest: tape.digest } });
    expect(puts.some((offset) => held.includes(offset))).toBe(false);
    expect(puts.length).toBe(chunkCount - held.length);
  });
});
