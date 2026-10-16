// @perf-budget-skip: real Preview configuration, Pack producer, and filesystem watcher.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStandaloneRuntimeAssetBinding, type Importer } from '@forgeax/engine-types';
import { pluginPack, type PluginPack } from '@forgeax/engine-vite-plugin-pack';

import previewConfig from '../vite.config';

vi.mock('@forgeax/engine-vite-plugin-pack', async (importOriginal) => {
  const native = await importOriginal<typeof import('@forgeax/engine-vite-plugin-pack')>();
  return { ...native, pluginPack: vi.fn(native.pluginPack) };
});

const previewRoot = dirname(fileURLToPath(new URL('../vite.config.ts', import.meta.url)));
const previewConfigSource = new URL('../vite.config.ts', import.meta.url);

async function loadPreviewConfig(): Promise<NonNullable<Parameters<typeof createServer>[0]>> {
  return await (typeof previewConfig === 'function'
    ? previewConfig({ command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false })
    : previewConfig);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the preview host refresh event.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function observeRefresh(configured: boolean): Promise<unknown[]> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-preview-refresh-'));
  await writeFile(join(root, 'package.json'), '{"name":"preview-refresh-fixture"}');
  const assets = join(root, 'assets');
  await mkdir(assets);
  const source = join(assets, 'behavior.pack.json');
  const packSource = (speed: number) => JSON.stringify({
    schemaVersion: '3.0.0', packageId: '01900000-0000-7000-8000-000000000161',
    assets: { 'plugin/root': { kind: 'plugin', payload: {
      module: { specifier: './behavior.ts' }, config: { speed },
    } } },
  });
  await writeFile(source, packSource(1));
  await writeFile(join(assets, 'behavior.ts'), 'export default { apply() {} };');
  const phase = (name: string): void => { console.info('[preview-refresh.phase]', JSON.stringify({ configured, name, nowMs: performance.now() })); };
  phase('load-config:start');
  const config = configured ? await loadPreviewConfig() : { plugins: [pluginPack({ roots: [assets] })] };
  phase('load-config:end');
  phase('create-server:start');
  const server = await createServer({
    ...config, configFile: false, root: previewRoot, logLevel: 'error',
    // This integration exercises producer publication, not dependency optimization.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, strictPort: true },
  });
  phase('create-server:end');
  const events: unknown[] = [];
  const ws = server.ws as unknown as { send(payload: unknown): void };
  const send = ws.send.bind(ws);
  ws.send = (payload: unknown): void => { events.push(payload); send(payload); };
  try {
    const pack = server.config.plugins.find((plugin) => plugin.name === 'forgeax:pack') as PluginPack;
    if (!pack) throw new Error('Preview must expose its Pack producer');
    phase('rebind:start');
    await pack.rebind(createStandaloneRuntimeAssetBinding('preview-refresh-test'), [assets]);
    phase('rebind:end');
    phase('pack-ready:start');
    await pack.ready();
    phase('pack-ready:end');
    phase('listen:start');
    await server.listen();
    phase('listen:end');
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('missing Preview server address');
    const binding = pack.runtimeBinding();
    if (!binding) throw new Error('missing Pack runtime binding');
    const response = await fetch(`http://localhost:${address.port}${binding.catalogUrl}`);
    expect(response.ok).toBe(true);
    phase('catalog-response');
    expect(await response.json()).toMatchObject({ authority: 'authoritative', entries: [expect.objectContaining({ kind: 'plugin' })] });
    events.length = 0;
    phase('watched-publication:start');
    await writeFile(source, packSource(2));
    // A negative reload assertion is meaningful only after the same successful
    // publication that triggers the configured policy, not after an arbitrary sleep.
    await waitFor(() => events.some((event) => typeof event === 'object' && event !== null &&
      'event' in event && event.event === 'forgeax:catalog-delta'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'custom', event: 'forgeax:catalog-delta',
      data: expect.objectContaining({ changed: expect.arrayContaining([expect.objectContaining({ kind: 'plugin' })]) }),
    }));
    if (configured) await waitFor(() => events.some((event) =>
      typeof event === 'object' && event !== null && 'type' in event && event.type === 'full-reload'), 1_000);
    phase('watched-publication:end');
    return events;
  } finally {
    phase('close:start');
    await server.close();
    phase('close:end');
    await rm(root, { recursive: true, force: true });
  }
}

describe('preview host catalog refresh', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(pluginPack).mockClear();
  });

  it('routes on-demand environment readiness through the Preview constructor to real Pack consumption', async () => {
    vi.stubEnv('FORGEAX_DEV_PACK_READINESS', 'on-demand');
    await loadPreviewConfig();
    const configured = vi.mocked(pluginPack).mock.calls.at(-1)?.[0];
    if (configured === undefined) throw new Error('Preview did not construct its Pack producer');
    const root = await mkdtemp(join(tmpdir(), 'forgeax-preview-readiness-'));
    const assets = join(root, 'assets');
    await mkdir(assets);
    const guid = '01900000-0000-7000-8000-000000000162';
    await writeFile(join(assets, 'mesh.fixture'), 'real-source');
    await writeFile(join(assets, 'mesh.fixture.meta.json'), JSON.stringify({
      schemaVersion: '1.0.0', kind: 'external-asset-package', importer: 'fixture',
      source: 'mesh.fixture', importSettings: {},
      subAssets: [{ guid, sourceIndex: 0, kind: 'fixture-mesh' }],
    }));
    const importCalls = vi.fn();
    const importer: Importer = {
      key: 'fixture',
      async import(ctx) {
        importCalls();
        const source = await ctx.readSource();
        if (!source.ok) throw new Error('fixture source unreadable');
        return { ok: true, value: {
          assets: [{ guid, kind: 'fixture-mesh', payload: { kind: 'fixture-mesh', vertexCount: 3 }, refs: [],
            artifacts: { body: { mediaType: 'application/octet-stream', bytes: source.value } } }],
          sourceDependencies: [],
        } };
      },
    };
    const binding = createStandaloneRuntimeAssetBinding('preview-readiness');
    const pack = pluginPack({ ...configured, roots: [assets], importers: [importer], cookers: [],
      runtimeBinding: binding, ddc: { projectDdcRoot: join(root, '.forgeax', 'ddc', 'v2') } });
    const server = await createServer({ root, configFile: false, logLevel: 'silent', plugins: [pack],
      optimizeDeps: { noDiscovery: true }, server: { host: '127.0.0.1', port: 0 } });
    try {
      await pack.ready();
      await server.listen();
      const origin = server.resolvedUrls?.local[0];
      if (origin === undefined) throw new Error('fixture server did not expose an origin');
      const catalog = await fetch(new URL(binding.catalogUrl, origin));
      expect(catalog.status).toBe(200);
      expect((await catalog.json()).entries).toEqual([expect.objectContaining({ guid })]);
      expect(importCalls).not.toHaveBeenCalled();
      const imported = await fetch(new URL(`${binding.importUrlBase}/${guid}`, origin), { method: 'POST' });
      expect(imported.status).toBe(200);
      expect(importCalls).toHaveBeenCalledTimes(1);
      const [row] = await imported.json();
      const packageResponse = await fetch(new URL(row.packageUrl, origin));
      expect(packageResponse.status).toBe(200);
      const [asset] = (await packageResponse.json()).assets;
      const body = await fetch(new URL(asset.artifacts.body.path, packageResponse.url));
      expect(body.status).toBe(200);
      expect(await body.text()).toBe('real-source');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects invalid Preview readiness with the Import owner diagnostic', async () => {
    vi.stubEnv('FORGEAX_DEV_PACK_READINESS', 'lazy');
    await expect(loadPreviewConfig()).rejects.toMatchObject({
      code: 'producer-readiness-invalid', expected: "'before-consume' or 'on-demand'",
      hint: 'set producerReadiness to before-consume or on-demand', detail: { value: 'lazy' },
    });
  });
  it('uses the generated VFX catalog producer without an app-owned module map', async () => {
    const source = await readFile(previewConfigSource, 'utf8');
    expect(source).toContain('createParticleCodeNativeCookerFromRoots');
    expect(source).not.toContain('vfxModules');
  });
  it('reloads the configured host after a watched Pack publication', async () => {
    expect(await observeRefresh(true)).toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  }, 120_000);
  it('publishes the same change without reloading when the host has no policy', async () => {
    expect(await observeRefresh(false)).not.toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  }, 120_000);
});
