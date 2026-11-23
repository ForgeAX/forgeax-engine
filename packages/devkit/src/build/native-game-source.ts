import type { DevKitAppOptions } from '../plugin-build.js';
import type { ProjectFacts } from '../types.js';

export function nativeWasmPackages(physics: readonly ('2' | '3')[]) {
  const packageName = '@forgeax/engine-physics-rapier';
  return [
    {
      module: '@forgeax/engine-ui-blitz',
      wasm: ['pkg/ui_blitz_bg.wasm', 'wasm/ui.wasm'],
      evidence: [
        ['pkg/provenance.json', 'wasm/ui.provenance.json'],
        ['LICENSE', 'wasm/ui.LICENSE'],
      ],
    },
    {
      module: '@forgeax/engine-codec',
      wasm: ['pkg/basis_transcoder.wasm', 'wasm/basis_transcoder.wasm'],
      evidence: [['dist/basis-native-factory.provenance.json', 'wasm/basis.provenance.json']],
    },
    ...physics.map((dimension) => {
      const name = `wasm/rapier${dimension}d`;
      return {
        module: `${packageName}${dimension}d`,
        wasm: ['pkg/rapier.wasm', `${name}.wasm`] as const,
        evidence: [
          ['pkg/provenance.json', `${name}.provenance.json`],
          ['pkg/LICENSE', `${name}.LICENSE`],
        ] as const,
      };
    }),
  ] as const;
}

export function nativeGameSource(
  target: 'wechat' | 'desktop',
  physics: readonly ('2' | '3')[],
  facts: ProjectFacts,
): string {
  const startupTimeout = JSON.stringify(facts.startupTimeoutMs ?? null);
  return `import { activateExecutionRoot, gameHostPlugin } from '@forgeax/engine/app';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { scenePlugin } from '@forgeax/engine/scene';
import { skinningPlugin } from '@forgeax/engine/skinning';
import { renderComponentsPlugin } from '@forgeax/engine/render';
import { animationPlugin } from '@forgeax/engine/animation';
import { statePlugin } from '@forgeax/engine/state';
import { root as engineRoot } from 'virtual:forgeax/plugin-programs/engine';
import { createPrograms as frontendPrograms, root as frontendRoot } from 'virtual:forgeax/plugin-programs/frontend';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
${target === 'wechat' ? "import { createWechatWasmHost } from '@forgeax/engine/platform-wechat';" : ''}
import { initBasisTranscoder } from '@forgeax/engine/codec';
${physics.map((dimension) => `import { initializeNativeRapier${dimension}D } from '@forgeax/engine/physics-rapier${dimension}d/native';`).join('\n')}
export async function activate({ app, graphics, ui, canvas, gameProjection, generation, signal, active, wasm, input, saves, files, audio }) {
  const wasmHost = ${target === 'wechat' ? "name => createWechatWasmHost({ wx, WXWebAssembly }, 'payload/wasm/' + name + '.wasm.br').unwrap()" : 'wasm'};
  await initBasisTranscoder(wasmHost('basis_transcoder'));
  ${physics.map((dimension) => `const physics${dimension} = await initializeNativeRapier${dimension}D(wasmHost('rapier${dimension}d')); if (physics${dimension}.code) throw physics${dimension};`).join('\n')}
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const fibers = [];
  const channel = new MessageChannel();
  const assets = graphics.assets;
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true; lifetime.abort(); signal.removeEventListener('abort', abort);
    const failures = [];
    for (const fiber of fibers.reverse()) { try { await fiber.dispose(); } catch (error) { failures.push(error); } }
    channel.port1.close(); channel.port2.close();
    if (failures.length) throw new AggregateError(failures, ${JSON.stringify(`${target} game cleanup failed`)});
  };
  try {
  for (const plugin of [renderComponentsPlugin(), scenePlugin(), skinningPlugin(), animationPlugin(), statePlugin(), gameHostPlugin({ app, assets, canvas,
    drawingBufferSize: () => ({ width: canvas.width, height: canvas.height }),
    renderer: app.renderer, port: channel.port1, uiRoot: ui.document.querySelector('#game-ui'), gameProjection,
    startupTimeoutMs: ${startupTimeout},
    ...(saves === undefined ? {} : { saves }),
    ...(files === undefined ? {} : { files }),
    ...(audio === undefined ? {} : { audio }),
    controlMode: ${target === 'desktop' ? 'input.controlMode' : "{ read: () => 'touch', subscribe: () => () => {} }"},
    setPointerLockAllowed: allowed => input?.setPointerLockAllowed?.(allowed),
  })]) { const fiber = app.pluginContext.plugin(plugin); fibers.push(fiber); await fiber.await(); }
  if (engineRoot !== null) {
    const mounted = await activateExecutionRoot(app.pluginContext, { guid: engineRoot }, { signal: lifetime.signal, timeoutMs: ${startupTimeout} });
    fibers.push(mounted.fiber);
  }
  if (frontendRoot !== null && active()) {
    const frontend = app.pluginContext.isolate('assets').isolate('gameHost').isolate('pluginPrograms');
    const provider = frontend.plugin({ name: ${JSON.stringify(`${target}-frontend`)}, provide: ['assets', 'gameHost', 'pluginPrograms'], apply(ctx) {
      const runtime = app.pluginContext.runtimePacks;
      const reader = new AssetRegistry({ catalog: runtime.catalog, fetcher: runtime.fetcher, scopeId: runtimeBinding.scopeId });
      ctx.provide('assets', reader); ctx.effect(() => () => reader.dispose());
      ctx.provide('gameHost', { ...app.pluginContext.gameHost, port: channel.port2 });
      ctx.provide('pluginPrograms', frontendPrograms(${JSON.stringify(`${target}-`)} + generation, 'frontend', generation));
    } });
    fibers.push(provider); await provider.await();
    const mounted = await activateExecutionRoot(frontend, { guid: frontendRoot }, { signal: lifetime.signal, timeoutMs: ${startupTimeout} });
    fibers.push(mounted.fiber);
  }
  return { dispose: cleanup };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], ${JSON.stringify(`${target} game activation failed`)}, { cause: error }); }
    throw error;
  }
}
`;
}

/** The native hosts both release installed resources in reverse order, even when one fails. */
export const releaseNativePlayerSource = `
async function releaseNativePlayer(releases, message, failures = []) {
  for (const release of releases.reverse()) {
    try { await release(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, message);
}
`;

/** Shared startup wiring emitted inline so native players keep their own lifecycle and imports. */
export function nativeHostSource(
  options: DevKitAppOptions,
  platform: { target: 'desktop' } | { target: 'wechat'; rhiDebug: boolean; cpuProfile: boolean },
) {
  const desktop = platform.target === 'desktop';
  const extension = desktop ? '.ts' : '';
  const packageUrl = desktop ? 'desktopPackageUrl' : "'https://forgeax.package/'";
  const rhi = desktop
    ? 'rhi: window.rhi,'
    : platform.rhiDebug
      ? 'rhi: recorder.backend.rhi, rhiInstrumentation: createRhiInstrumentation(recorder),'
      : 'rhi,';
  const readShaderManifest = desktop
    ? `async url => {
      const response = await fetcher(url);
      if (!response.ok) throw new Error('Cannot read shader resource: ' + url);
      return value(await decodeDocumentText(new Uint8Array(await response.arrayBuffer())));
    }`
    : 'async url => (await fetcher(url)).text()';
  const inputPlugins = 'inputBackendPlugin(input), inputPlugin()';
  const audioPlugins = desktop
    ? 'webAudioPlugin(audio, plan.settings.audio)'
    : 'audioBackendPlugin(audio)';
  return {
    imports: `import { createApp${desktop ? '' : ', createRecordGameSaves'}, inputPlugin, canvasAspectPlugin, createEngineConfigurationControl, createEngineConfigurationStore, EngineConfigurationError, prepareEngineStartup, projectEngineStartup } from '@forgeax/engine/app';
import { World } from '@forgeax/engine/ecs';
import { PHYSICS_STARTUP_OPTIONS } from '@forgeax/engine/physics';
import { animationPlugin } from '@forgeax/engine/animation';
import { err, ok } from '@forgeax/engine/types';
import { inputBackendPlugin } from '@forgeax/engine/input';
import { createCatalogSource } from '@forgeax/engine/assets-runtime';
import { createBlitzUi, gpuShaders } from '@forgeax/engine/ui-blitz';
import { constructRuntimeRendererHost } from '@forgeax/engine/runtime/internal/renderer-host';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrograms as enginePrograms } from 'virtual:forgeax/plugin-programs/engine';
import { runtimeBinding } from 'virtual:forgeax/pack-runtime';
import { authored, imports, programHost } from './${platform.target}-programs.ts';
import { createGameVfx } from './game-vfx${extension}';
import { createGameRenderFeatures } from './game-render-features${extension}';
const value = result => { if (!result.ok) throw result.error; return result.value; };`,
    graphics: `const gameFeatures = createGameRenderFeatures();
  const gameVfx = createGameVfx({ dependencies: ${JSON.stringify(options.vfxDependencies ?? [])}, providers: gameFeatures.vfxProviders, providersForWorld: gameFeatures.vfxProvidersForWorld });
  ${desktop ? 'const ' : ''}graphics = value(await constructRuntimeRendererHost(canvas, {
    ${rhi}
    standardProfile: configured.standardProfile,
    assetBudgetBytes: configured.assetBudgetBytes,
    textureMipSkip: configured.textureMipSkip,
    dynamicGeometryMeshBudgetBytes: configured.dynamicGeometryMeshBudgetBytes,
    maxRenderShortSide: configured.sceneMaxRenderShortSide,
    outputColorSpace: configured.outputColorSpace,
    featureTextureReadbackBudgetBytes: configured.featureTextureReadbackBudgetBytes,
    pipelineLibrary: ${JSON.stringify(options.pipelineLibrary)},
    backgroundPipelineLibrary: ${JSON.stringify(options.backgroundPipelineLibrary)},
    backgroundPipelineLibraryConcurrency: ${JSON.stringify(options.backgroundPipelineLibraryConcurrency)},
    features: [gameVfx.feature, ...gameFeatures.features],
    ${!desktop && platform.cpuProfile ? 'profiler,' : ''}
    ui: { kind: 'sparse-strips', shaders: gpuShaders, paint: time => ui.paintGpu(time) },
  }, {
    ...forgeaxBundlerAdapter(),
    shaderManifestUrl: ${packageUrl} + 'shaders/manifest.json',
    readShaderManifest: ${readShaderManifest},
  }));`,
    world: `const world = new World({ time: configured.time });
  if (plan.settings.simulation?.physics !== undefined)
    world.insertResource(PHYSICS_STARTUP_OPTIONS, plan.settings.simulation.physics);`,
    catalog: `const catalog = createCatalogSource({ url: ${packageUrl} + 'pack-index.json', fetch: fetcher });`,
    app: `platform, renderer: graphics.renderer, world, assets: graphics.assets, assetCatalog: catalog,
    pluginPrograms: enginePrograms(${desktop ? "'desktop-1', 'engine', 1" : "'wechat-' + identity, 'engine', identity"}),
    runtimePacks: { scopeId: runtimeBinding.scopeId, authored, imports, programHost${desktop ? ', tasks' : ''}, cache: runtimePackCache },
    plugins: [...(configured.animation === undefined ? [] : [animationPlugin(configured.animation)]), ${desktop ? `${audioPlugins}, audioPlugin(), ${inputPlugins}` : `${inputPlugins}, ${audioPlugins}, audioPlugin()`}, canvasAspectPlugin(() => canvas), gameVfx.plugin, ...gameFeatures.plugins],`,
  };
}
