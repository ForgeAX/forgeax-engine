import type {
  EngineConfigurationDefinition,
  EngineSettings,
} from '@forgeax/engine-app/configuration';
import type { DevKitAppOptions } from '../plugin-build';
import type { BuildOptions } from '../types.js';

/** One-way migration of legacy project declarations into the constructor configuration. */
export function engineConfigurationForAppOptions(
  options: DevKitAppOptions,
  target: 'browser' | 'wechat',
): EngineConfigurationDefinition {
  if (options.configuration !== undefined) return options.configuration;
  const settings: EngineSettings = {
    ...(typeof options.canvasPixelRatio === 'number'
      ? { presentation: { canvasPixelRatio: options.canvasPixelRatio } }
      : {}),
    ...(options.renderPipelineCapacity === undefined
      ? {}
      : { execution: { renderPipelineCapacity: options.renderPipelineCapacity } }),
    ...(options.assetBudgetBytes === undefined
      ? {}
      : { assets: { assetBudgetBytes: options.assetBudgetBytes } }),
    ...(options.time === undefined ? {} : { simulation: { time: options.time } }),
    rendering: {
      ...(options.standardProfile === undefined ? {} : { profile: options.standardProfile }),
      ...(options.dynamicGeometryMeshBudgetBytes === undefined
        ? {}
        : {
            resources: { dynamicGeometryMeshBudgetBytes: options.dynamicGeometryMeshBudgetBytes },
          }),
      ...(options.textureMipSkip === undefined
        ? {}
        : { qualityLimits: { textureMipSkip: options.textureMipSkip } }),
      ...(target !== 'wechat' || options.wechat?.maxRenderShortSide === undefined
        ? {}
        : { view: { maxRenderShortSide: options.wechat.maxRenderShortSide } }),
    },
  };
  return { settings };
}

/** Desktop and WeChat admit the same live renderer profile change. */
export function nativeConfigurationControlSource(definition: string, store: string): string {
  return `createEngineConfigurationControl(${definition}, plan, {
    store: ${store},
    async apply(next) {
      const accepted = graphics.renderer.setProfile(projectEngineStartup(next).standardProfile);
      return accepted.ok ? ok(undefined) : err(new EngineConfigurationError('configuration-invalid', {
        path: 'rendering', reason: 'Renderer rejected the quality request', cause: accepted.error,
      }));
    },
  })`;
}

/** Generated startup reads actual selected device facts, including Render Worker readiness. */
export function materialBuildCapabilityGuard(profile: BuildOptions['materialProfile']): string {
  if (profile === undefined) return '';
  if (profile !== 'webgpu-storage') throw new Error('unsupported material build profile');
  return `const materialBuildCaps = workerExecution && typeof app.remoteEval === 'function'
      ? await app.remoteEval('const inspected = await execution.inspectRenderer({ fields: ["capabilities"] }); if (!inspected.ok) throw inspected.error; return inspected.value.capabilities;')
      : app.renderer.inspect({ fields: ['capabilities'] }).capabilities;
    if (materialBuildCaps?.backendKind !== 'webgpu' || materialBuildCaps.compute !== true || materialBuildCaps.storageBuffer !== true)
      throw new Error('forgeax: webgpu-storage validation build requires actual WebGPU compute/storage; fallback is unsupported');`;
}
