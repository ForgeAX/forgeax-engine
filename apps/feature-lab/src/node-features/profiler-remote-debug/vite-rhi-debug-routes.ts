import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeTape, encodeTape } from '@forgeax/engine/rhi-debug';
import {
  createRawTapeProvider,
  RAW_TAPE_ROUTE,
  RHITAPE_MIME,
  selectCaptureProvider,
  vitePluginRhiDebug,
} from '@forgeax/engine/vite-plugin-rhi-debug';
import { defineFeature } from '../../lab/feature';

type Middleware = (req: unknown, res: unknown, next: () => void) => Promise<void> | void;

interface Reply {
  status: number;
  body: string;
  nextCalled: boolean;
}

function emptyTapeBytes(): Uint8Array | string {
  const encoded = encodeTape({
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  });
  return encoded.ok ? encoded.value : encoded.error.hint;
}

async function drive(
  middleware: Middleware,
  method: string,
  url: string,
  type: string,
  bytes: Uint8Array,
): Promise<Reply> {
  const reply: Reply = { status: 0, body: '', nextCalled: false };
  const req = {
    method,
    url,
    headers: { 'content-type': type },
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end(chunk?: string | Uint8Array) {
      reply.status = res.statusCode;
      reply.body = typeof chunk === 'string' ? chunk : '';
    },
  };
  await middleware(req, res, () => {
    reply.nextCalled = true;
  });
  return reply;
}

export default defineFeature({
  title: 'Vite RHI-debug routes',
  catalog: 'Vite RHI-debug routes',
  kind: 'headless',
  summary:
    'vitePluginRhiDebug injects FORGEAX_ENGINE_RHI_DEBUG ("1" on serve, "0" on build) and mounts POST /__forgeax-debug/tape, which validates a raw .rhitape body and writes <root>/.forgeax-debug/<runId>/frame.rhitape.',
  expect:
    'serve define is "1" and build define is "0"; a valid v7 tape POST returns 200 with a sha256 digest and the file decodes; GET is 405; bad runId, wrong MIME and garbage bytes return structured 400 codes; other paths fall through.',
  async run(checks) {
    const plugin = vitePluginRhiDebug();
    checks.equal('plugin name', plugin.name, 'forgeax:rhi-debug');
    const config = plugin.config as (
      c: unknown,
      env: { command: string; mode: string },
    ) => {
      define: Record<string, string>;
    };
    checks.equal(
      'serve define',
      config({}, { command: 'serve', mode: 'development' }).define[
        'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG'
      ],
      '"1"',
    );
    checks.equal(
      'build define',
      config({}, { command: 'build', mode: 'production' }).define[
        'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG'
      ],
      '"0"',
    );

    const none = selectCaptureProvider([]);
    checks.equal('no provider', none.ok ? 'ok' : none.error.code, 'capture-target-unavailable');
    const two = selectCaptureProvider([{ id: 'a' }, { id: 'b' }]);
    checks.equal('two providers', two.ok ? 'ok' : two.error.code, 'capture-target-ambiguous');

    const tape = emptyTapeBytes();
    if (typeof tape === 'string') {
      checks.ok('encode empty v7 tape', false, tape);
      return;
    }
    const rootDir = await mkdtemp(join(tmpdir(), 'fl-rhi-routes-'));
    try {
      let middleware: Middleware | undefined;
      const configure = plugin.configureServer as (server: unknown) => void;
      const scoped = vitePluginRhiDebug({ rootDir });
      (scoped.configureServer as typeof configure)({
        middlewares: {
          use(fn: Middleware) {
            middleware = fn;
          },
        },
      });
      if (middleware === undefined) {
        checks.ok('middleware mounted', false);
        return;
      }
      const route = `${RAW_TAPE_ROUTE}?runId=lab-run`;
      const good = await drive(middleware, 'POST', route, RHITAPE_MIME, tape);
      checks.equal('valid tape status', good.status, 200);
      const ref = JSON.parse(good.body || '{}') as {
        kind?: string;
        digest?: string;
        path?: string;
      };
      checks.equal('artifact kind', ref.kind, 'rhi-tape');
      checks.ok('sha256 digest', /^sha256:[0-9a-f]{64}$/.test(ref.digest ?? ''), ref.digest);
      checks.equal(
        'artifact path',
        ref.path,
        join(rootDir, '.forgeax-debug', 'lab-run', 'frame.rhitape'),
      );
      await checks.run('written tape decodes', async () => {
        const decoded = decodeTape(new Uint8Array(await readFile(ref.path ?? '')));
        return decoded.ok ? `formatVersion ${decoded.value.header.formatVersion}` : false;
      });

      const get = await drive(middleware, 'GET', route, RHITAPE_MIME, tape);
      checks.equal('GET is 405', get.status, 405);
      const cases = [
        ['bad runId', `${RAW_TAPE_ROUTE}?runId=../x`, RHITAPE_MIME, tape, 'capture-run-id-invalid'],
        ['wrong MIME', route, 'application/octet-stream', tape, 'capture-mime-invalid'],
        [
          'garbage bytes',
          `${RAW_TAPE_ROUTE}?runId=junk`,
          RHITAPE_MIME,
          new Uint8Array([1, 2, 3]),
          'capture-tape-invalid',
        ],
      ] as const;
      for (const [name, url, type, bytes, code] of cases) {
        const reply = await drive(middleware, 'POST', url, type, bytes);
        const body = JSON.parse(reply.body || '{}') as { code?: string };
        checks.ok(name, reply.status === 400 && body.code === code, `${reply.status} ${body.code}`);
      }
      const other = await drive(middleware, 'GET', '/index.html', 'text/html', new Uint8Array());
      checks.ok('other paths fall through', other.nextCalled && other.status === 0);

      const provider = createRawTapeProvider({
        rootDir,
        writeFile: () => Promise.reject(new Error('disk full')),
      });
      const failed = await provider.accept({ runId: 'io', contentType: RHITAPE_MIME, bytes: tape });
      checks.equal(
        'write failure code',
        failed.ok ? 'ok' : failed.error.code,
        'capture-artifact-write-failed',
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
});
