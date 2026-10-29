import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { type ShaderSource, shaderSourceDescriptor } from '@forgeax/engine-types';
import {
  type ComputeState,
  computePipelineError,
  createComputeStateForModule,
} from '../compute-graph-state';
import type { DeviceScope } from '../device/device-scope';
import type { RenderPipelineFrame } from '../render-pipeline';

type Variant =
  | 'seed'
  | 'seed_furthest'
  | 'seed_furthest_multisampled'
  | 'reduce'
  | 'reduce_furthest';
type Factory = NonNullable<RenderPipelineFrame['runtime']['shaderModuleFactory']>;
interface Program {
  readonly source: string | ShaderSource;
  readonly factory: Factory;
  readonly createModule: Factory['createShaderModule'];
  readonly module: ShaderModule;
  readonly layout: string;
  readonly state: ComputeState;
}
interface Programs {
  readonly device: RhiDevice;
  readonly entries: Map<Variant, Program>;
}

// Five fixed variants, one current immutable program per live Renderer generation.
// Graph-owned texture views/buffers are never part of this retained owner.
const scopedPrograms = new WeakMap<DeviceScope, Programs>();

/** Generation ownership and disposal stay separate from per-program invalidation. */
function scopedDepthPrograms(scope: DeviceScope, device: RhiDevice): Programs {
  if (!scope.isAlive()) throw computePipelineError('depth pyramid live device scope');
  let owned = scopedPrograms.get(scope);
  if (owned === undefined) {
    owned = { device, entries: new Map() };
    scopedPrograms.set(scope, owned);
    const retained = owned;
    scope._adopt('pipeline', retained, () => {
      retained.entries.clear();
      if (scopedPrograms.get(scope) === retained) scopedPrograms.delete(scope);
    });
  }
  if (owned.device !== device) throw computePipelineError('depth pyramid current device');
  return owned;
}

/** Scope-less structural/direct graph adapters retain their original graph-local lifetime. */
export function createDepthPyramidProgramResolver(
  // Only producer-owned deeply frozen layout arrays may enter this metadata.
  preparedLayouts?: ReadonlyMap<readonly unknown[], string>,
) {
  let local: Programs | undefined;
  return (
    frame: RenderGraphFrame,
    source: string | ShaderSource,
    entries: readonly unknown[],
    variant: Variant,
  ): ComputeState => {
    const stage = variant === 'reduce' || variant === 'reduce_furthest' ? 'reduce' : 'seed';
    const runtime = (frame as RenderPipelineFrame).runtime;
    const factory = runtime?.shaderModuleFactory;
    if (factory === undefined) throw computePipelineError(`depth_pyramid_${stage} shader module`);
    const { device } = runtime;
    const scope = (runtime as { readonly deviceScope?: DeviceScope }).deviceScope;
    let programs: Programs;
    if (scope === undefined) {
      if (local?.device !== device) local = { device, entries: new Map() };
      programs = local;
    } else {
      programs = scopedDepthPrograms(scope, device);
    }
    const layout = preparedLayouts?.get(entries) ?? JSON.stringify(entries);
    const createModule = factory.createShaderModule;
    // Module invalidation may keep the same factory/method/source. The real
    // factory owns pending/error/replacement, even when a program was retained.
    const module = createModule.call(
      factory,
      shaderSourceDescriptor(source, `depth_pyramid_${stage}`),
    );
    if (!module.ok) throw module.error;
    if (scope !== undefined && (!scope.isAlive() || scopedPrograms.get(scope) !== programs))
      throw computePipelineError('depth pyramid live device scope');
    const prior = programs.entries.get(variant);
    if (
      prior !== undefined &&
      prior.source === source &&
      prior.factory === factory &&
      prior.createModule === createModule &&
      prior.module === module.value &&
      prior.layout === layout
    )
      return prior.state;
    const state = createComputeStateForModule(
      device,
      module.value,
      `depth_pyramid_${stage}`,
      entries,
      `depth_pyramid_${variant}`,
    );
    if (scope !== undefined && (!scope.isAlive() || scopedPrograms.get(scope) !== programs))
      throw computePipelineError('depth pyramid live device scope');
    // A failed factory/layout/PSO never replaces the last successful entry.
    if (factory.createShaderModule === createModule)
      programs.entries.set(variant, {
        source,
        factory,
        createModule,
        module: module.value,
        layout,
        state,
      });
    return state;
  };
}
