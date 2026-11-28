import { err, ok, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { PipelinePreparationCompletion } from '../record/render-context';
import type { VolumetricFogShaderSources } from '../render-contract';
import { prepareVolumePrograms } from '../volume/programs';
import { HDR_COLOR_ATTACHMENT_FORMAT } from './webgpu-ready-contract';

type VolumeEntry =
  | { readonly kind: 'idle'; readonly sources: VolumetricFogShaderSources }
  | {
      readonly kind: 'pending';
      readonly sources: VolumetricFogShaderSources;
      readonly completed: PipelinePreparationCompletion;
    }
  | { readonly kind: 'prepared'; readonly sources: VolumetricFogShaderSources }
  | { readonly kind: 'failed'; readonly error: RhiError };

export interface DeferredVolumePreparationDeps {
  readonly device: () => RhiDevice;
  readonly isCurrent: (scope: DeviceScope) => boolean;
  readonly shaderModuleFactory: (device: RhiDevice) => PipelineBuilderShaderModuleFactory;
}

function staleGenerationError(): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'volumetric fog preparation owns the current device generation',
    hint: 'prepare the effect again on the replacement Renderer device',
  });
}

function preparationFailure(cause: unknown): RhiError {
  return cause instanceof RhiError
    ? cause
    : new RhiError({
        code: 'shader-compile-failed',
        expected: 'volumetric fog prepares its shaders and pipelines',
        hint: `inspect the volumetric fog preparation cause: ${String(cause)}`,
      });
}

export function createDeferredVolumePreparation(deps: DeferredVolumePreparationDeps) {
  const entries = new WeakMap<DeviceScope, VolumeEntry>();

  const installFromBuild = async (
    scope: DeviceScope,
    device: RhiDevice,
    sources: VolumetricFogShaderSources,
    preparePipelines: boolean,
    isCurrent: () => boolean,
    ensureAlive: () => void,
  ): Promise<VolumetricFogShaderSources | undefined> => {
    ensureAlive();
    if (preparePipelines) {
      await prepareVolumePrograms(
        {
          device,
          deviceScope: scope,
          shaderModuleFactory: deps.shaderModuleFactory(device),
          isCurrent,
        },
        sources,
        HDR_COLOR_ATTACHMENT_FORMAT,
      );
      ensureAlive();
    }
    entries.set(scope, { kind: preparePipelines ? 'prepared' : 'idle', sources });
    return preparePipelines ? sources : undefined;
  };

  const sources = (scope: DeviceScope): VolumetricFogShaderSources | undefined => {
    const entry = entries.get(scope);
    return entry?.kind === 'prepared' ? entry.sources : undefined;
  };

  const pendingCompletion = (scope: DeviceScope): PipelinePreparationCompletion | undefined => {
    const entry = entries.get(scope);
    return entry?.kind === 'pending' ? entry.completed : undefined;
  };

  const request = (scope: DeviceScope): boolean => {
    const entry = entries.get(scope);
    if (entry === undefined) return false;
    if (entry.kind === 'failed') throw entry.error;
    if (entry.kind === 'prepared') return false;
    if (entry.kind === 'pending') return true;
    const targetSources = entry.sources;
    const device = deps.device();
    const isCurrent = (): boolean => deps.isCurrent(scope);
    const completed: PipelinePreparationCompletion = Promise.resolve()
      .then(async () => {
        if (!isCurrent()) throw staleGenerationError();
        await prepareVolumePrograms(
          {
            device,
            deviceScope: scope,
            shaderModuleFactory: deps.shaderModuleFactory(device),
            isCurrent,
          },
          targetSources,
          HDR_COLOR_ATTACHMENT_FORMAT,
        );
        if (!isCurrent()) throw staleGenerationError();
        entries.set(scope, { kind: 'prepared', sources: targetSources });
        return ok(undefined);
      })
      .catch((cause: unknown) => {
        const failure = preparationFailure(cause);
        if (isCurrent()) entries.set(scope, { kind: 'failed', error: failure });
        return err(failure);
      });
    entries.set(scope, { kind: 'pending', sources: targetSources, completed });
    return true;
  };

  return { installFromBuild, sources, pendingCompletion, request };
}
