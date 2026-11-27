import type { GraphPreparationStep, RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { BindGroupLayout, PipelineLayout, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { type ShaderSource, shaderSourceDescriptor } from '@forgeax/engine-types';
import {
  type ComputeState,
  computePipelineError,
  createComputeStateForModule,
} from '../compute-graph-state';
import type { DeviceScope } from '../device/device-scope';
import type { NativeGraphInputs } from '../record/native-graph-inputs';
import type { RenderPipelineFrame } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';

type Variant =
  | 'seed'
  | 'seed_furthest'
  | 'seed_furthest_multisampled'
  | 'seed_furthest_resolve_msaa'
  | 'reduce'
  | 'reduce_furthest'
  | 'reduce_furthest_batch';
type Factory = NonNullable<RenderPipelineFrame['runtime']['shaderModuleFactory']>;
interface ProgramFacts {
  readonly source: string | ShaderSource;
  readonly factory: Factory;
  readonly createModule: Factory['createShaderModule'];
  readonly module: ShaderModule;
  readonly layout: string;
}
interface ReadyProgram extends ProgramFacts {
  readonly phase: 'ready';
  readonly qualified: boolean;
  readonly state: ComputeState;
}
type Progress =
  | { readonly phase: 'layout' }
  | { readonly phase: 'pipeline-layout'; readonly layout: BindGroupLayout }
  | {
      readonly phase: 'pipeline';
      readonly layout: BindGroupLayout;
      readonly pipelineLayout: PipelineLayout;
    }
  | { readonly phase: 'pending'; readonly completion: Promise<void> }
  | { readonly phase: 'failed'; readonly error: RhiError };
interface PreparingProgram extends ProgramFacts {
  readonly phase: 'preparing';
  progress: Progress;
  advancing: boolean;
  readonly current: () => boolean;
  readonly fallback?: ComputeState;
}
type Program = ReadyProgram | PreparingProgram;
function readyProgram(facts: ProgramFacts, state: ComputeState, qualified: boolean): ReadyProgram {
  return {
    phase: 'ready',
    qualified,
    source: facts.source,
    factory: facts.factory,
    createModule: facts.createModule,
    module: facts.module,
    layout: facts.layout,
    state,
  };
}
interface Programs {
  readonly device: RhiDevice;
  readonly entries: Map<Variant, Program>;
}

// These fixed immutable programs belong to the Renderer generation, never a Level or graph.
const scopedPrograms = new WeakMap<DeviceScope, Programs>();
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
function stageOf(variant: Variant): 'seed' | 'reduce' {
  return variant.startsWith('reduce') ? 'reduce' : 'seed';
}
function matches(prior: Program | undefined, facts: ProgramFacts): prior is Program {
  return (
    prior !== undefined &&
    prior.source === facts.source &&
    prior.factory === facts.factory &&
    prior.createModule === facts.createModule &&
    prior.module === facts.module &&
    prior.layout === facts.layout
  );
}
function pipelineFailure(cause: unknown): RhiError {
  return cause instanceof RhiError
    ? cause
    : Object.assign(computePipelineError('depth pyramid native creation'), { cause });
}

/** One original-owner native operation; shared compilation may outlive a cancelled caller. */
function advance(
  programs: Programs,
  variant: Variant,
  entry: PreparingProgram,
  entries: readonly unknown[],
): GraphPreparationStep {
  if (entry.advancing || !entry.current())
    throw computePipelineError('depth pyramid current native preparation');
  entry.advancing = true;
  try {
    const step = entry.progress,
      device = programs.device,
      label = `depth_pyramid_${stageOf(variant)}`;
    switch (step.phase) {
      case 'layout': {
        const layout = device
          .createBindGroupLayout({ label: `${label}.bind-group-layout`, entries: entries as never })
          .unwrap();
        if (!entry.current()) throw computePipelineError('depth pyramid current layout');
        entry.progress = { phase: 'pipeline-layout', layout };
        return;
      }
      case 'pipeline-layout': {
        const pipelineLayout = device
          .createPipelineLayout({
            label: `${label}.pipeline-layout`,
            bindGroupLayouts: [step.layout],
          })
          .unwrap();
        if (!entry.current()) throw computePipelineError('depth pyramid current pipeline layout');
        entry.progress = { phase: 'pipeline', layout: step.layout, pipelineLayout };
        return;
      }
      case 'pipeline': {
        const create = device.createComputePipelineAsync;
        if (create === undefined)
          throw computePipelineError('completion-qualified depth pyramid PSO');
        // The exact generation entry owns the receipt before a native callback can reenter.
        let complete: (() => void) | undefined;
        const completion = new Promise<void>((resolve) => {
          complete = resolve;
        });
        entry.progress = { phase: 'pending', completion };
        const fail = (cause: unknown) => {
          entry.progress = { phase: 'failed', error: pipelineFailure(cause) };
          complete?.();
        };
        try {
          const requested = create.call(device, {
            label,
            layout: step.pipelineLayout,
            compute: { module: entry.module, entryPoint: `depth_pyramid_${variant}` },
          });
          void Promise.resolve(requested)
            .then((result) => {
              if (!result.ok) {
                fail(result.error);
                return;
              }
              if (!entry.current()) {
                fail(computePipelineError('depth pyramid current completed PSO'));
                return;
              }
              programs.entries.set(
                variant,
                readyProgram(
                  entry,
                  {
                    label,
                    layout: step.layout,
                    pipeline: result.value,
                    bindGroups: entry.fallback?.bindGroups ?? new WeakMap(),
                  },
                  true,
                ),
              );
              complete?.();
            }, fail)
            .catch(fail);
        } catch (cause) {
          fail(cause);
        }
        return completion;
      }
      case 'pending':
        return step.completion;
      case 'failed':
        throw step.error;
    }
  } finally {
    entry.advancing = false;
  }
}

/** Source preparation uses the same scoped programs and real module/PSO completion. */
export function* prepareDepthPyramidProgram(
  inputs: NativeGraphInputs,
  source: string | ShaderSource,
  entries: readonly unknown[],
  variant: Variant,
  current: () => boolean,
  layoutIdentity = JSON.stringify(entries),
): Generator<GraphPreparationStep, { readonly state: ComputeState; isCurrent(): boolean }> {
  const factory = inputs.shaderModuleFactory;
  if (factory?.peekShaderModule === undefined)
    throw computePipelineError('depth pyramid module witness');
  const descriptor = shaderSourceDescriptor(source, `depth_pyramid_${stageOf(variant)}`);
  let module: ShaderModule | undefined;
  while (module === undefined) {
    if (!current() || !inputs.isCurrent())
      throw computePipelineError('depth pyramid current Source');
    const loaded = factory.createShaderModule(descriptor);
    if (loaded.ok) module = loaded.value;
    else {
      const pending = factory.pendingShaderModuleCompletion?.(loaded.error);
      if (pending === undefined) throw loaded.error;
      yield pending.then((result) => result.unwrap());
    }
  }
  const programs = scopedDepthPrograms(inputs.scope, inputs.device);
  const facts: ProgramFacts = {
    source,
    factory,
    createModule: factory.createShaderModule,
    module,
    layout: layoutIdentity,
  };
  let entry = programs.entries.get(variant);
  if (!matches(entry, facts) || (entry.phase === 'ready' && !entry.qualified)) {
    const fallback = matches(entry, facts) && entry.phase === 'ready' ? entry.state : undefined;
    const owned: PreparingProgram = {
      ...facts,
      phase: 'preparing',
      progress:
        fallback === undefined
          ? { phase: 'layout' }
          : { phase: 'pipeline-layout', layout: fallback.layout },
      ...(fallback === undefined ? {} : { fallback }),
      advancing: false,
      current: () =>
        inputs.scope.isAlive() &&
        scopedPrograms.get(inputs.scope) === programs &&
        programs.entries.get(variant) === owned &&
        factory.createShaderModule === facts.createModule &&
        factory.peekShaderModule?.(descriptor) === facts.module,
    };
    programs.entries.set(variant, owned);
    entry = owned;
  }
  while (entry.phase === 'preparing') {
    if (!current() || !inputs.isCurrent())
      throw computePipelineError('depth pyramid current Source program');
    yield advance(programs, variant, entry, entries);
    const actual = programs.entries.get(variant);
    if (!matches(actual, facts)) throw computePipelineError('depth pyramid exact prepared program');
    entry = actual;
  }
  const prepared = entry;
  const isCurrent = () =>
    inputs.isCurrent() &&
    programs.entries.get(variant) === prepared &&
    factory.createShaderModule === facts.createModule &&
    factory.peekShaderModule?.(descriptor) === module;
  if (!current() || !isCurrent())
    throw computePipelineError('depth pyramid current prepared program');
  return Object.freeze({ state: prepared.state, isCurrent });
}

/** Scope-less direct graph adapters retain their original graph-local lifetime. */
export function createDepthPyramidProgramResolver(
  preparedLayouts?: ReadonlyMap<readonly unknown[], string>,
) {
  let local: Programs | undefined;
  return (
    frame: RenderGraphFrame,
    source: string | ShaderSource,
    entries: readonly unknown[],
    variant: Variant,
  ): ComputeState => {
    const stage = stageOf(variant),
      runtime = (frame as RenderPipelineFrame).runtime;
    const factory = runtime?.shaderModuleFactory;
    if (factory === undefined) throw computePipelineError(`depth_pyramid_${stage} shader module`);
    const { device } = runtime;
    const scope = recordContext(runtime as { readonly deviceScope?: DeviceScope }).deviceScope;
    let programs: Programs;
    if (scope === undefined) {
      if (local?.device !== device) local = { device, entries: new Map() };
      programs = local;
    } else programs = scopedDepthPrograms(scope, device);
    const layout = preparedLayouts?.get(entries) ?? JSON.stringify(entries),
      createModule = factory.createShaderModule;
    const module = createModule.call(
      factory,
      shaderSourceDescriptor(source, `depth_pyramid_${stage}`),
    );
    if (!module.ok) throw module.error;
    if (scope !== undefined && (!scope.isAlive() || scopedPrograms.get(scope) !== programs))
      throw computePipelineError('depth pyramid live device scope');
    const facts: ProgramFacts = { source, factory, createModule, module: module.value, layout };
    const prior = programs.entries.get(variant);
    if (matches(prior, facts)) {
      if (prior.phase === 'ready') return prior.state;
      if (prior.fallback !== undefined) return prior.fallback;
      const step = advance(programs, variant, prior, entries);
      const completed = programs.entries.get(variant);
      if (matches(completed, facts) && completed.phase === 'ready') return completed.state;
      // Native compilation belongs to the shared generation, never a second synchronous PSO.
      void step;
      throw computePipelineError('depth pyramid native preparation pending');
    }
    const state = createComputeStateForModule(
      device,
      module.value,
      `depth_pyramid_${stage}`,
      entries,
      `depth_pyramid_${variant}`,
    );
    if (scope !== undefined && (!scope.isAlive() || scopedPrograms.get(scope) !== programs))
      throw computePipelineError('depth pyramid live device scope');
    if (factory.createShaderModule === createModule)
      programs.entries.set(variant, readyProgram(facts, state, false));
    return state;
  };
}
