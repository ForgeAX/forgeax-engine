import type { RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
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
  readonly source: string;
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

/** Scope-less structural/direct graph adapters retain their original graph-local lifetime. */
export function createDepthPyramidProgramResolver() {
  let local: Programs | undefined;
  return (
    frame: RenderGraphFrame,
    source: string,
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
      if (!scope.isAlive()) throw computePipelineError('depth pyramid live device scope');
      let owned = scopedPrograms.get(scope);
      if (owned === undefined) {
        owned = { device, entries: new Map() };
        scopedPrograms.set(scope, owned);
        const retained = owned;
        // RHI pipelines/layouts have no explicit destroy operation. Release the
        // generation's JS roots; already submitted commands retain native use.
        scope._adopt('pipeline', retained, () => {
          retained.entries.clear();
          if (scopedPrograms.get(scope) === retained) scopedPrograms.delete(scope);
        });
      }
      if (owned.device !== device) throw computePipelineError('depth pyramid current device');
      programs = owned;
    }
    const layout = JSON.stringify(entries);
    const createModule = factory.createShaderModule;
    // Module invalidation may keep the same factory/method/source. The real
    // factory owns pending/error/replacement, even when a program was retained.
    const module = createModule.call(factory, { code: source, label: `depth_pyramid_${stage}` });
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
