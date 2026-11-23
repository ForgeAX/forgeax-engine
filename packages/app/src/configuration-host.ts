import { err, ok, type Result } from '@forgeax/engine-types';
import { EngineConfigurationError, resolveEngineStartup } from './configuration';
import type {
  EngineConfigurationDefinition,
  EngineConfigurationStore,
  EngineStartupPlan,
  HostDeviceFacts,
} from './configuration-types';
import type { CreateAppOptions } from './types';

export interface EngineConfigurationHost {
  readDeviceFacts(): HostDeviceFacts | Promise<HostDeviceFacts>;
  readonly store?: EngineConfigurationStore;
}

/** Internal constructor projection. The public definition remains the only policy input. */
export interface ConfiguredAppOptions extends CreateAppOptions {
  readonly sceneMaxRenderShortSide?: number;
  readonly startup?: EngineStartupPlan;
  readonly configurationObserver?: (
    kind: 'submitted' | 'completed',
    frame: import('./configuration-control').EngineConfigurationFrame,
  ) => void;
}

/** Read Host facts and preferences before any owned engine service is constructed. */
export async function prepareEngineStartup(
  definition: EngineConfigurationDefinition,
  host: EngineConfigurationHost,
): Promise<Result<EngineStartupPlan, EngineConfigurationError>> {
  try {
    const [facts, saved] = await Promise.all([host.readDeviceFacts(), host.store?.read()]);
    return resolveEngineStartup(definition, facts, saved);
  } catch (cause) {
    return err(
      new EngineConfigurationError('configuration-invalid', {
        path: 'configurationHost',
        reason: 'device facts or saved selection could not be read',
        cause,
      }),
    );
  }
}

/** One materialization of owned domain parameters, also used by native generated hosts. */
export function projectEngineStartup(
  plan: EngineStartupPlan,
  options: CreateAppOptions = {},
): CreateAppOptions & {
  readonly startup: EngineStartupPlan;
  readonly sceneMaxRenderShortSide?: number;
} {
  const settings = plan.settings;
  const rendering = settings.rendering;
  return {
    ...options,
    startup: plan,
    ...settings.presentation,
    ...settings.assets,
    ...(settings.simulation?.time === undefined ? {} : { time: settings.simulation.time }),
    ...(settings.simulation?.animation === undefined
      ? {}
      : { animation: settings.simulation.animation }),
    ...(rendering?.renderBackend === undefined ? {} : { renderBackend: rendering.renderBackend }),
    ...rendering?.resources,
    ...(rendering?.view?.maxRenderShortSide === undefined
      ? {}
      : { sceneMaxRenderShortSide: rendering.view.maxRenderShortSide }),
    standardProfile: plan.rendering.profile,
    textureMipSkip: plan.rendering.textureMipSkip,
    ...(options.execution === undefined
      ? {}
      : {
          execution: {
            ...options.execution,
            ...(settings.execution?.renderPipelineCapacity === undefined
              ? {}
              : {
                  diagnostics: {
                    ...options.execution.diagnostics,
                    renderPipelineCapacity: settings.execution.renderPipelineCapacity,
                  },
                }),
            ...(settings.execution?.workers === undefined
              ? {}
              : { workers: settings.execution.workers }),
          },
        }),
  };
}

export async function prepareConfiguredApp(
  options: CreateAppOptions | undefined,
  host: EngineConfigurationHost,
): Promise<Result<ConfiguredAppOptions | undefined, EngineConfigurationError>> {
  if (options?.configuration === undefined) return ok(options);
  for (const key of [
    'standardProfile',
    'textureMipSkip',
    'assetBudgetBytes',
    'dynamicGeometryMeshBudgetBytes',
    'staticShadowBudgetBytes',
    'featureTextureReadbackBudgetBytes',
    'time',
    'animation',
    'canvasPixelRatio',
    'outputColorSpace',
    'renderBackend',
  ] as const) {
    if (options[key] !== undefined)
      return err(
        new EngineConfigurationError('configuration-invalid', {
          path: key,
          reason: 'use the configuration domain field instead of a competing flat option',
        }),
      );
  }
  const plan = await prepareEngineStartup(options.configuration, host);
  if (!plan.ok) return plan;
  if (
    options.execution === undefined &&
    (plan.value.settings.execution?.taskWorkers !== undefined ||
      Object.values(plan.value.settings.execution?.workers ?? {}).includes(true))
  )
    return err(
      new EngineConfigurationError('configuration-domain-unavailable', {
        path: 'settings.execution',
        reason: 'Worker policy requires an execution bootstrap binding',
      }),
    );
  if (options.assets !== undefined && plan.value.settings.assets !== undefined)
    return err(
      new EngineConfigurationError('configuration-domain-unavailable', {
        path: 'settings.assets',
        reason: 'an existing borrowed AssetRegistry cannot receive constructor budgets',
      }),
    );
  return ok(projectEngineStartup(plan.value, options));
}
