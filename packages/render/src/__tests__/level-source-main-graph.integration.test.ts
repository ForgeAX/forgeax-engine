import { type CompiledRenderGraph, RenderGraphError } from '@forgeax/engine-render-graph';
import { err } from '@forgeax/engine-types';
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
  'superseded-during-hiz',
  'retired-during-resource-preparation',
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
  const owner = f.manager.currentOwner;
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
  const previous = owner.frameState.compiledFrameGraph;
  let held: graphOwner.PreparedViewGraph | undefined;
  let retiredOnAdoption: ReturnType<graphOwner.PreparedViewGraph['retire']> | undefined;
  const hold = graphOwner.holdPreparedViewGraph;
  const heldGraph = vi.spyOn(graphOwner, 'holdPreparedViewGraph').mockImplementation((...args) => {
    const lease = hold(...args);
    held = lease;
    if (mode === 'superseded-during-hiz') {
      const preparation = vi
        .spyOn(lease.installed.graph, 'prepareResources')
        .mockImplementationOnce(function* (current) {
          expect(current()).toBe(true);
          yield Promise.resolve().then(() => {
            owner.frameState.compiledFrameGraphGeneration++;
          });
          expect(current()).toBe(false);
          return err(
            new RenderGraphError({
              code: 'pass-preparation-failed',
              expected: 'the current AO depth pyramid seed',
              hint: 'inspect the original native preparation',
              detail: {
                passName: 'hzb-seed',
                passKind: 'compute',
                cause: Error('the prepared program lost its View'),
              },
            }),
          );
        });
      restore.push(() => preparation.mockRestore());
    } else if (mode === 'retired-during-resource-preparation') {
      const { graph } = lease.installed;
      const prepare = graph.prepareResources.bind(graph);
      const capture = vi.spyOn(graph, 'prepareResources').mockImplementation(function* (current) {
        const retirement = lease.retire();
        retiredOnAdoption = retirement;
        yield retirement.then((result) => result.unwrap());
        return yield* prepare(current);
      });
      restore.push(() => capture.mockRestore());
    }
    return lease;
  });
  restore.push(() => heldGraph.mockRestore());
  let rejected: CompiledRenderGraph<RenderPipelineFrame> | undefined;
  if (mode === 'post-allocation-rejection') {
    // Exercise the candidate allocation and rejection even when the live view already owns
    // all ordinary display ports required by this Source.
    const previousFault = owner.frameState.gtaoCandidatePreparationFailureGeneration;
    fault.armGtaoCandidatePreparationFault(owner.frameState, f.internals.deviceScope.generation);
    restore.push(() => {
      owner.frameState.gtaoCandidatePreparationFailureGeneration = previousFault;
    });
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
  const preparing = f.manager.prepareInitialSourceViews(staged.group, () => {
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
  work = preparing;
  const prepare = async () => {
    for (let step = 0; step < 1000; step++) {
      const next = preparing.next();
      if (next.done) return;
      if (next.value instanceof Promise) await next.value;
    }
  };
  if (mode === 'superseded-during-hiz') {
    await expect(prepare()).rejects.toMatchObject({
      code: 'rhi-descriptor-invalid',
      cause: { code: 'pass-preparation-failed', detail: { passName: 'hzb-seed' } },
    });
    expect(preparing.isObsolete()).toBe(true);
    (await preparing.retire()).unwrap();
  } else if (mode === 'post-allocation-rejection') {
    await expect(prepare()).rejects.toThrow();
    assert(rejected);
    (await work.retire()).unwrap();
    expect(rejected.isRetired()).toBe(true);
    (await rejected.retire()).unwrap();
  } else {
    if (mode === 'retired-during-resource-preparation') {
      await expect(prepare()).rejects.toMatchObject({ code: 'rhi-descriptor-invalid' });
      expect(preparing.isObsolete()).toBe(true);
      expect(staged.isCurrent()).toBe(true);
    } else await expect(prepare()).rejects.toThrow();
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
