import type {
  EngineConfigurationDefinition,
  EngineSettings,
} from '@forgeax/engine-app/configuration';
import type { DevKitAppOptions } from '../plugin-build';

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
