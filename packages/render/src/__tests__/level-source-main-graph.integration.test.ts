import type { CompiledRenderGraph } from '@forgeax/engine-render-graph';
import { assert, expect, it, onTestFinished, vi } from 'vitest';
import type { SourceViewPreparation } from '../assembly/source-view-preparation';
import * as graphOwner from '../record/graph-adoption';
import * as fault from '../record/gtao-candidate-preparation-fault';
import * as compiler from '../record/typed-frame-graph';
import type { RenderPipelineFrame } from '../render-pipeline';
import {
  levelInitialViewFixture,
  levelShaderManifestFixture,
} from './level-native-resources-fixture';

vi.mock('@forgeax/engine-render', () => import('../index'));
vi.mock('@forgeax/engine-render/internal', () => import('../internal'));

await levelShaderManifestFixture();

it.each([
  'post-allocation-rejection',
  'retired-before-accept',
] as const)('keeps exact native main graph responsibility after %s', async (mode) => {
  const f = await levelInitialViewFixture();
  let work: SourceViewPreparation | undefined;
  const restore: (() => void)[] = [];
  onTestFinished(async () => {
    const failures: unknown[] = [];
    for (const reset of restore) reset();
    try {
      if (work !== undefined) (await work.retire()).unwrap();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      for (let step = 0; f.candidate.inspect().phase !== 'retired' && step < 10000; step++) {
        const state = f.candidate.retireStep().unwrap();
        if (state.render?.pending !== undefined) await state.render.pending;
      }
      expect(f.candidate.inspect().phase).toBe('retired');
    } catch (cause) {
      failures.push(cause);
    }
    try {
      const closed = await f.close();
      if (!closed.ok) throw closed.error;
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Source main graph cleanup failed');
  });
  const composition = f.internals.sceneComposition;
  assert(composition);
  const begin = composition.beginStagedGroup.bind(composition);
  let source: ReturnType<typeof begin> | undefined;
  const capture = vi.spyOn(composition, 'beginStagedGroup').mockImplementation((...args) => {
    source = begin(...args);
    return source;
  });
  restore.push(() => capture.mockRestore());
  const native = f.internals.device.createComputePipeline.bind(f.internals.device);
  f.internals.device.createComputePipelineAsync = (descriptor) => native(descriptor);
  let prepared = f.candidate.step();
  for (let step = 0; prepared.ok && step < 10000; step++) {
    const pending = prepared.value.render?.pending;
    if (pending !== undefined) {
      await pending;
    }
    prepared = f.candidate.step();
  }
  assert(!prepared.ok && source?.ok);
  const staged = source.value;
  const owner = f.manager.currentOwner;
  const previous = owner.frameState.compiledFrameGraph;
  let held: graphOwner.PreparedViewGraph | undefined;
  const hold = graphOwner.holdPreparedViewGraph;
  const heldGraph = vi.spyOn(graphOwner, 'holdPreparedViewGraph').mockImplementation((...args) => {
    held = hold(...args);
    return held;
  });
  restore.push(() => heldGraph.mockRestore());
  let rejected: CompiledRenderGraph<RenderPipelineFrame> | undefined;
  if (mode === 'post-allocation-rejection') {
    const compile = compiler.compileSourceViewGraph;
    const compilation = vi.spyOn(compiler, 'compileSourceViewGraph').mockImplementation((input) => {
      const outcome = compile(input);
      if (outcome.kind !== 'failed') rejected = outcome.effects.rejectedGraph;
      return outcome;
    });
    restore.push(() => compilation.mockRestore());
    // Inject at the existing compiler boundary, after actual graph allocation.
    const injected = vi
      .spyOn(fault, 'consumeGtaoCandidatePreparationFault')
      .mockReturnValueOnce(true);
    restore.push(() => injected.mockRestore());
  }
  let retiredOnAdoption: ReturnType<graphOwner.PreparedViewGraph['retire']> | undefined;
  work = f.manager.prepareInitialSourceViews(staged.group, () => {
    // This is the exact post-storage.accept bookend, after all graph preparation yields.
    if (
      mode === 'retired-before-accept' &&
      owner.gpuDriven.resourceGeneration !== undefined &&
      held !== undefined &&
      retiredOnAdoption === undefined
    )
      retiredOnAdoption = held.retire();
    return staged.isCurrent();
  });
  if (mode === 'post-allocation-rejection') {
    let failed = false;
    try {
      for (let step = 0; step < 1000; step++) {
        const next = work.next();
        if (next.done) break;
        if (next.value instanceof Promise) await next.value;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    assert(rejected);
    (await work.retire()).unwrap();
    expect(rejected.isRetired()).toBe(true);
    (await rejected.retire()).unwrap();
  } else {
    let failed = false;
    try {
      for (let step = 0; step < 1000; step++) {
        const next = work.next();
        if (next.done) break;
        if (next.value instanceof Promise) await next.value;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    assert(held);
    expect(retiredOnAdoption).toBeDefined();
    (await retiredOnAdoption)?.unwrap();

    (await work.retire()).unwrap();
  }
  expect(owner.frameState.compiledFrameGraph).toBe(previous);
  expect(owner.frameState.unsubmittedCompiledFrameGraph).toBeUndefined();
  expect(composition.entry?.topology.captureResidencySelection().includes(staged.group)).toBe(
    false,
  );
}, 30000);
