import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS, scanInventory } from '@forgeax/engine-pack/scanner';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import {
  authoredRuntimePackDeclarations,
  prepareAuthoredRuntimePacks,
} from '../authored-runtime-packs.js';
import { executionWorkerEntries } from '../execution-workers.js';
import { runtimePacksModule } from '../runtime-packs-source.js';

const packageId = '01900000-0000-7000-8000-000000000991';
const failureId = '01900000-0000-7000-8000-000000000992';
const generator = `
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { ok } from '@forgeax/engine/types';
const runtime = { export: 'generate', dependencies: [], outputs: { 'mesh/first': 'mesh', 'mesh/second': 'mesh' } };
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'), runtime, build: () => ok({}) });
export function generate() {
  if (typeof WorkerGlobalScope === 'undefined' || !(self instanceof WorkerGlobalScope))
    throw new Error('runtime generator must run in a Worker');
  const first = createBoxGeometry(2, 1, 1).unwrap();
  const second = createBoxGeometry(3, 1, 1).unwrap();
  return ok({ 'mesh/first': first, 'mesh/second': second });
}
`;

const entry = `
import { createApp } from '@forgeax/engine/app/browser';
import { createCatalogSource } from '@forgeax/engine/assets-runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine/pack/source';
import { rhi } from '@forgeax/engine/rhi-null';
import { createRuntimePackOptions } from './runtime-packs.ts';

globalThis.run = async () => {
  const guid = (key, owner = '${packageId}') => AssetGuid.format(AssetGuid.derive(definePackageId(owner), key));
  const manifest = 'data:application/json,' + encodeURIComponent(JSON.stringify({schemaVersion:'5.0.0',receipts:[],entryPoints:[],fragments:[],sources:{},entries:[],materialShaders:[]}));
  const opened = await createApp(document.querySelector('canvas'), {
    rhi,
    assetCatalog: createCatalogSource({ entries: [] }),
    runtimePacks: await createRuntimePackOptions('authored-test'),
    pluginPrograms: {
      sessionId: 'authored-test', contextId: 'main', sessionGeneration: 1, target: 'engine',
      definitions: new Map(), programs: new Map(), tools: new Map(),
    },
  }, { shaderManifestUrl: manifest });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error, (_key,value) =>
    value instanceof Error ? { ...value, message: value.message, stack: value.stack } : value));
  const app = opened.value;
  const producer = app.pluginContext.runtimePacks.producer;
  const before = (await app.assets.enumerateCatalog()).unwrap().map((row) => [row.guid, row.lifecycle, Boolean(row.publication)]);
  const start = performance.now();
  const first = guid('mesh/first');
  const second = guid('mesh/second');
  const loaded = await Promise.all([app.assets.load(first, 'mesh'), app.assets.load(second, 'mesh')]);
  const executions = producer.inspect().executions;
  const elapsedMs = performance.now() - start;
  const brokenGuid = guid('mesh/second', '${failureId}');
  const failure = await app.assets.load(brokenGuid, 'mesh');
  const afterFailure = (await app.assets.enumerateCatalog()).unwrap().find(row => row.guid === brokenGuid);
  return { before, first, second, loaded, executions, elapsedMs, failure, afterFailure };
};
`;

it('delivers an ordinary pack.ts and generates its sibling GUIDs in one Task Worker execution', async () => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-authored-runtime-pack-')));
  const repository = resolve(import.meta.dirname, '../../../../..');
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
    await symlink(
      resolve(repository, 'packages/engine'),
      resolve(root, 'node_modules/@forgeax/engine'),
      'dir',
    );
    await writeFile(resolve(root, 'geometry.pack.ts'), generator);
    await writeFile(
      resolve(root, 'invalid.pack.ts'),
      generator
        .replace(packageId, failureId)
        .replace(
          "return ok({ 'mesh/first': first, 'mesh/second': second });",
          "return ok({ 'mesh/first': first });",
        ),
    );
    const sourceSnapshot = createScriptablePackSourceSnapshot();
    const scan = await scanInventory([root], {
      scriptablePack: {
        ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
        metadataOnly: true,
        sourceSnapshot,
      },
    });
    if (!scan.ok) throw scan.error;
    await expect(
      prepareAuthoredRuntimePacks(root, scan.value.declarations, sourceSnapshot, 'wechat'),
    ).rejects.toMatchObject({ code: 'runtime-pack-task-worker-unavailable' });
    const { packs } = await prepareAuthoredRuntimePacks(
      root,
      scan.value.declarations,
      sourceSnapshot,
    );
    expect(packs.map(({ source }) => source.source)).toEqual([
      'geometry.pack.ts',
      'invalid.pack.ts',
    ]);
    await writeFile(
      resolve(root, 'runtime-packs.ts'),
      runtimePacksModule(authoredRuntimePackDeclarations(packs)),
    );
    await writeFile(resolve(root, 'main.ts'), entry);
    await writeFile(
      resolve(root, 'index.html'),
      '<canvas width="64" height="64"></canvas><script type="module" src="/main.ts"></script>',
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [executionWorkerEntries()],
    });
    await server.listen();
    const executablePath = process.env.FORGEAX_BROWSER_EXECUTABLE;
    const channel = process.env.FORGEAX_CHROME_CHANNEL;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath !== undefined
        ? { executablePath }
        : channel !== undefined
          ? { channel }
          : {}),
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5173/');
    const result = await page.evaluate(() => {
      const run = (globalThis as unknown as { run: () => Promise<Record<string, unknown>> }).run;
      return run();
    });
    expect(result.before).toEqual(
      expect.arrayContaining([
        [result.first, 'missing', false],
        [result.second, 'missing', false],
      ]),
    );
    expect(result.loaded).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(result.executions).toEqual([
      expect.objectContaining({
        status: 'current',
        request: 1,
        instance: expect.objectContaining({ packageId }),
      }),
    ]);
    expect(result.failure).toMatchObject({
      ok: false,
      error: {
        code: 'asset-package-invalid',
        detail: { reason: expect.stringContaining('runtime-pack-execution-failed') },
      },
    });
    expect(result.afterFailure).toMatchObject({ lifecycle: 'missing' });
    expect(result.afterFailure).not.toHaveProperty('publication');
  } finally {
    await browser?.close();
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
