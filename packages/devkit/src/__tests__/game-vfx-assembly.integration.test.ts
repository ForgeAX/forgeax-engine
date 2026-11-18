// @perf-budget-skip: generated project composition and native World lifecycle.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { EngineConfigurationError, withEngineSettings } from '@forgeax/engine-app';
import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { VFX_GPU_RUNTIME_RESOURCE_KEY } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { transformWithOxc } from 'vite';
import { expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

it.each([
  {
    name: 'default slabs with native view commands',
    search: '',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'unknown graph uses native view commands',
    search: '?forgeax-vfx-view-graph=unknown',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'explicit slabs with transient graph',
    search: '?forgeax-vfx-instance-arena=slabs&forgeax-vfx-view-graph=transient',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'raw individual with monolithic graph',
    search:
      '?forgeax-vfx-instance-arena=individual&forgeax-vfx-view-graph=monolithic&forgeax-vfx-planning=raw',
    isolateViewGraph: false,
    instanceArenas: false,
    nativePlanning: false,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'individual with transient graph',
    search: '?forgeax-vfx-instance-arena=individual&forgeax-vfx-view-graph=transient',
    isolateViewGraph: true,
    instanceArenas: false,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'unknown arena uses slabs in native bootstrap',
    search:
      '?forgeax-vfx-instance-arena=unknown&forgeax-vfx-view-graph=transient&forgeax-render-pipeline-capacity=unknown',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'tauri',
  },
  ...(['declarations', 'retained', 'unknown'] as const).map((mode) => ({
    name: `resource admission ${mode}`,
    search: `?forgeax-vfx-resources=${mode}`,
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: mode !== 'declarations',
    renderPipelineCapacity: 3,
    target: 'browser' as const,
  })),
  {
    name: 'explicit native planning',
    search: '?forgeax-vfx-planning=native',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'explicit continuous Render Worker tasks',
    search: '?forgeax-render-task-yield=none&forgeax-render-pipeline-capacity=2',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 2,
    target: 'browser',
  },
  {
    name: 'explicit cooperative Render Worker tasks',
    search: '?forgeax-render-task-yield=completion',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'four-publication pipeline experiment',
    search: '?forgeax-render-pipeline-capacity=4',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 4,
    target: 'browser',
  },
  {
    name: 'prepared Feature task checkpoint',
    search: '?forgeax-render-task-yield=features&forgeax-render-pipeline-capacity=3',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'browser',
  },
  {
    name: 'raw planning in native bootstrap',
    search: '?forgeax-vfx-planning=raw&forgeax-render-pipeline-capacity=3',
    isolateViewGraph: true,
    instanceArenas: true,
    nativePlanning: false,
    retainedResources: true,
    renderPipelineCapacity: 3,
    target: 'tauri',
  },
] as const)('assembles the same generated VFX selections in source and Render realms: $name', async ({
  search,
  isolateViewGraph,
  instanceArenas,
  nativePlanning,
  retainedResources,
  renderPipelineCapacity,
  target,
}) => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-game-vfx-'));
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'package.json'), '{"name":"game-vfx"}');
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'game-vfx',
        name: 'Game VFX',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, 'serve', '/', { target });
    const generated = config.root ?? '';
    const assemblySource = await readFile(resolve(generated, 'game-vfx.ts'), 'utf8');
    const code = (
      await transformWithOxc(
        assemblySource.replace(/^import .*;\n/, '').replace('export function', 'function'),
        'game-vfx.ts',
        { lang: 'ts' },
      )
    ).code;
    const capturedOptions: Parameters<typeof createVfxRuntimeHost>[0][] = [];
    const captureRuntimeHost = (options: Parameters<typeof createVfxRuntimeHost>[0]) => {
      capturedOptions.push(options);
      return createVfxRuntimeHost(options);
    };
    const createGameVfx = runInNewContext(`${code}\ncreateGameVfx`, {
      createVfxRuntimeHost: captureRuntimeHost,
    });
    expect(createGameVfx().feature.viewGraph).toBe('transient');
    expect(capturedOptions.at(-1)?.instanceArenas).toBe(true);
    expect(capturedOptions.at(-1)?.nativePlanning).toBe(true);
    expect(capturedOptions.at(-1)?.retainedResources).toBe(true);
    for (const enabled of [false, true]) {
      createGameVfx({
        instanceArenas: enabled,
        nativePlanning: enabled,
        retainedResources: enabled,
      });
      expect(capturedOptions.at(-1)?.instanceArenas).toBe(enabled);
      expect(capturedOptions.at(-1)?.nativePlanning).toBe(enabled);
      expect(capturedOptions.at(-1)?.retainedResources).toBe(enabled);
    }
    capturedOptions.length = 0;
    const bootstrapSource = await readFile(resolve(generated, 'execution-bootstrap.ts'), 'utf8');
    const bootstrapCode = (
      await transformWithOxc(
        bootstrapSource
          .slice(bootstrapSource.indexOf('export default async function'))
          .replace('export default ', '')
          .replaceAll('import.meta.env.DEV', 'false'),
        'execution-bootstrap.ts',
        { lang: 'ts' },
      )
    ).code;
    const featureSource = await readFile(resolve(generated, 'game-render-features.ts'), 'utf8');
    const featureCode = (
      await transformWithOxc(
        featureSource.replace(/^import .*;$/gm, '').replace('export function', 'function'),
        'game-render-features.ts',
        { lang: 'ts' },
      )
    ).code;
    const createGameRenderFeatures = runInNewContext(
      `${featureCode}\ncreateGameRenderFeatures`,
      {},
    );
    const bootstrap = runInNewContext(`${bootstrapCode}\nexecutionBootstrap`, {
      createGameVfx,
      createGameRenderFeatures,
      createRuntimePackOptions: async () => ({}),
      runtimeBinding: { scopeId: 'fixture' },
      createPrograms: () => ({}),
      crypto: { randomUUID: () => 'fixture' },
      root: null,
      audioPlugin: () => ({}),
      skinningPlugin: () => ({}),
    });
    const page = await readFile(resolve(generated, 'main.ts'), 'utf8');
    const taskSelection = page.match(/^const renderTaskYield = .*;$/m)?.[0];
    expect(taskSelection).toBeDefined();
    expect(
      runInNewContext(
        `const query = new URLSearchParams(location.search); ${taskSelection}; renderTaskYield`,
        {
          URLSearchParams,
          location: { search },
        },
      ),
    ).toBe(
      ['completion', 'features'].includes(
        new URLSearchParams(search).get('forgeax-render-task-yield') ?? '',
      )
        ? new URLSearchParams(search).get('forgeax-render-task-yield')
        : 'none',
    );
    expect(page).toMatch(/diagnostics: \{[\s\S]*?renderTaskYield,/);
    const capacitySelection = page.match(/^const renderPipelineCapacity = .*;$/m)?.[0];
    const diagnostics = page.match(/^\s*diagnostics: (\{[\s\S]*?^\s*\}),$/m)?.[1];
    expect(capacitySelection).toBeDefined();
    expect(diagnostics).toBeDefined();
    const diagnosticsStart = page.indexOf('const gpuPassTiming =');
    const diagnosticsEnd = page.indexOf('const profiler =', diagnosticsStart);
    const animationSelection = page.match(/^const animation = .*;$/m)?.[0];
    const workersSelection = page.match(/^const executionWorkers = .*;$/m)?.[0];
    expect(diagnosticsStart).toBeGreaterThan(0);
    expect(diagnosticsEnd).toBeGreaterThan(diagnosticsStart);
    expect(animationSelection).toBeDefined();
    expect(workersSelection).toBeDefined();
    const executionDiagnostics = runInNewContext(
      `const query = new URLSearchParams(location.search); ${animationSelection}\n${workersSelection}\n${page.slice(diagnosticsStart, diagnosticsEnd)}\n(${diagnostics})`.replaceAll(
        'import.meta.env.DEV',
        'false',
      ),
      {
        URLSearchParams,
        EngineConfigurationError,
        withEngineSettings,
        location: { search },
      },
    );
    expect(executionDiagnostics.renderPipelineCapacity).toBe(renderPipelineCapacity);
    expect(executionDiagnostics.renderTaskYield).toBe(
      new URLSearchParams(search).get('forgeax-render-task-yield') ?? 'none',
    );
    const selection = page.match(
      /const query = new URLSearchParams\(location.search\);\nconst isolateVfxViewGraph = .*;\nconst vfxInstanceArenas = .*;\nconst vfxNativePlanning = .*;\nconst vfxRetainedResources = .*;/,
    )?.[0];
    const payload = page.match(
      /bootstrapData: (\{ (?:programDeliveryChannel, )?isolateVfxViewGraph, vfxInstanceArenas, vfxNativePlanning, vfxRetainedResources \}),/,
    )?.[1];
    expect(selection).toBeDefined();
    expect(payload).toBeDefined();
    const data = runInNewContext(`${selection}\n(${payload})`, {
      location: { search },
      URLSearchParams,
      programDeliveryChannel: 'fixture',
    });
    expect(data.isolateVfxViewGraph).toBe(isolateViewGraph);
    expect(data.vfxInstanceArenas).toBe(instanceArenas);
    expect(data.vfxNativePlanning).toBe(nativePlanning);
    expect(data.vfxRetainedResources).toBe(retainedResources);
    const source = await bootstrap(structuredClone(data));
    const renderer = await bootstrap(structuredClone(data));
    expect(source.features[0].viewGraph).toBe(isolateViewGraph ? 'transient' : undefined);
    expect(renderer.features[0].viewGraph).toBe(source.features[0].viewGraph);
    expect(capturedOptions).toHaveLength(2);
    for (const options of capturedOptions) {
      expect(options.instanceArenas).toBe(instanceArenas);
      expect(options.nativePlanning).toBe(nativePlanning);
      expect(options.retainedResources).toBe(retainedResources);
      expect(options.isolateViewGraph).toBe(isolateViewGraph ? true : undefined);
    }
    const singleThreadCall = page.match(
      /\? (createGameVfx\(\{ isolateViewGraph: isolateVfxViewGraph, instanceArenas: vfxInstanceArenas, nativePlanning: vfxNativePlanning, retainedResources: vfxRetainedResources,[^\n]*?\}\)) : undefined;/,
    )?.[1];
    const previewFactory = page.match(/function makeVfxRuntimeHost\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(singleThreadCall).toBeDefined();
    expect(singleThreadCall).toContain('providers: gameFeatures.vfxProviders');
    expect(singleThreadCall).toContain('providersForWorld: gameFeatures.vfxProvidersForWorld');
    expect(previewFactory).toBeDefined();
    const pageContext = {
      location: { search },
      URLSearchParams,
      createGameVfx,
      createVfxRuntimeHost: captureRuntimeHost,
      gameFeatures: createGameRenderFeatures(),
    };
    const singleThread = runInNewContext(`${selection}\n${singleThreadCall}`, { ...pageContext });
    expect(capturedOptions.at(-1)?.instanceArenas).toBe(instanceArenas);
    expect(capturedOptions.at(-1)?.nativePlanning).toBe(nativePlanning);
    expect(capturedOptions.at(-1)?.retainedResources).toBe(retainedResources);
    expect(singleThread.feature.viewGraph).toBe(source.features[0].viewGraph);
    const preview = runInNewContext(`${selection}\n${previewFactory}\nmakeVfxRuntimeHost()`, {
      ...pageContext,
    });
    expect(capturedOptions.at(-1)?.instanceArenas).toBe(instanceArenas);
    expect(capturedOptions.at(-1)?.nativePlanning).toBe(nativePlanning);
    expect(capturedOptions.at(-1)?.retainedResources).toBe(retainedResources);
    expect(preview.feature.viewGraph).toBe(source.features[0].viewGraph);
    expect(source.features).toHaveLength(1);
    expect(renderer.features).toHaveLength(1);
    expect(source.features[0]).not.toBe(renderer.features[0]);
    expect(source.features[0].identity).toBe(renderer.features[0].identity);
    const world = new World();
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const plugin = source.plugins.find(
      (candidate: Plugin) => candidate.name === 'forgeax:game-vfx',
    );
    expect(plugin).toBeDefined();
    const context = await createWorldContext(world, [assetsPlugin(assets), plugin]);
    try {
      expect(world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(true);
      const selectedView = {
        position: new Float32Array([3, 4, 5]),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      };
      const frame = source.features[0]
        .extract({
          world,
          frameNumber: 1,
          views: [{ identity: 'main', selectedView }],
        })
        .unwrap();
      expect(frame.source).toBeDefined();
      expect(frame.source.camera).toBe(selectedView);
      expect(frame.source.intents).toEqual([]);
      expect(
        source.features[0].extract({ world, frameNumber: 2, views: [] }).unwrap().source,
      ).toBeUndefined();
    } finally {
      await context.fiber.dispose();
      expect(world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)).toBe(false);
    }
    expect(page).toContain(
      'createGameVfx({ isolateViewGraph: isolateVfxViewGraph, instanceArenas: vfxInstanceArenas, nativePlanning: vfxNativePlanning, retainedResources: vfxRetainedResources, dependencies: [], providers: gameFeatures.vfxProviders, providersForWorld: gameFeatures.vfxProvidersForWorld })',
    );
    expect(page).toContain('...(isolateVfxViewGraph ? { isolateViewGraph: true } : {})');
    expect(page).toContain('gameVfx.plugin');
    expect(page).toContain('gameVfx.feature');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
