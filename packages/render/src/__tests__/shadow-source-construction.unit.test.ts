import { err, ok, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import type { ProductionViewPreparation } from '../gpu-driven/production-initial-view';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { shadowSourceFixture, shadowSourceSnapshot } from './shadow-source-content.fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  device.createComputePipelineAsync = (descriptor) => device.createComputePipeline(descriptor);
  const factory = { createShaderModule: () => ok(module) };
  const first = shadowSourceFixture(device, factory),
    second = shadowSourceFixture(device, factory);
  const consumers = () =>
    err(
      new RhiError({
        code: 'rhi-descriptor-invalid',
        expected: 'no retained consumers in a cold physical View',
        hint: 'keep the fixture cold',
      }),
    );
  const prepare = (source = first, index = 0) =>
    first.pool.prepareSourceView(
      { kind: 'directional', index, layer: 'static' },
      source.input().sourcePlan,
      source.scene,
      () => true,
      consumers,
    );
  return { device, first, second, prepare };
}
async function finish(work: ProductionViewPreparation) {
  for (let count = 0; count < 200; count++) {
    const next = work.next();
    if (next.done) return next.value;
    if (next.value instanceof Promise) await next.value;
  }
  throw Error('Shadow construction did not finish');
}

it('consumes prepared layer membership through a new source wrapper without a first-show member walk', async () => {
  const f = await fixture(),
    input = f.first.input(),
    work = f.prepare();
  const storage = (await finish(work)).unwrap();
  const layer = f.first.pool.prepareSourceLayer(
    input.identity,
    input.sourcePlan,
    input.candidatePrimitiveIndices,
    f.first.scene,
  );
  const selections = vi.spyOn(MemberCandidates.prototype, 'selectMembers');
  const resources = f.first.scene.captureResources().unwrap();
  try {
    storage.accept().unwrap();
    const sourcePlan = Object.freeze({ ...input.sourcePlan });
    const updated = f.first.pool
      .update({ ...input, sourcePlan, inputReads: resources.inputReads() }, sourcePlan)
      .unwrap();
    resources.seal().unwrap();
    expect(updated.view).toBe(storage.view);
    expect(updated.plan.candidateCount).toBe(layer.plan.candidateCount);
    expect(selections).not.toHaveBeenCalled();
  } finally {
    resources.release();
    selections.mockRestore();
    layer.release();
    storage.release();
    f.first.dispose();
    f.second.dispose();
    (await work.settleRetirement()).unwrap();
  }
});

it('keeps a prepared new layer through another Source cancellation and an older ordinary record', async () => {
  const f = await fixture();
  const first = f.first.input(),
    oldReads = f.first.scene.captureResources().unwrap();
  f.first.pool.update({ ...first, inputReads: oldReads.inputReads() }, first.sourcePlan).unwrap();
  oldReads.seal().unwrap();
  oldReads.release();
  f.first.update(shadowSourceSnapshot(3, 0, 7));
  const target = f.first.input();
  const a = f.first.pool.prepareSourceLayer(
    target.identity,
    target.sourcePlan,
    target.candidatePrimitiveIndices,
    target.scene,
  );
  f.first.update(shadowSourceSnapshot(4, 3, 9));
  const other = f.first.input();
  const b = f.first.pool.prepareSourceLayer(
    other.identity,
    other.sourcePlan,
    other.candidatePrimitiveIndices,
    other.scene,
  );
  b.release();
  const selections = vi.spyOn(MemberCandidates.prototype, 'selectMembers');
  const resources = target.scene.captureResources().unwrap();
  try {
    const sourcePlan = Object.freeze({ ...target.sourcePlan });
    const updated = f.first.pool
      .update({ ...target, sourcePlan, inputReads: resources.inputReads() }, sourcePlan)
      .unwrap();
    resources.seal().unwrap();
    expect(updated.plan.candidateCount).toBe(a.plan.candidateCount);
    expect(selections).not.toHaveBeenCalled();
  } finally {
    selections.mockRestore();
    resources.release();
    a.release();
    b.release();
    f.first.dispose();
    f.second.dispose();
  }
});

it('replaces a cancelled physical role after its original Scene is disposed', async () => {
  const f = await fixture();
  const first = f.prepare();
  let second: ProductionViewPreparation | undefined;
  try {
    const initial = (await finish(first)).unwrap();
    initial.release();
    (await first.settleRetirement()).unwrap();
    f.first.scene.dispose();
    second = f.prepare(f.second);
    const replacement = (await finish(second)).unwrap();
    expect(replacement.isCurrent()).toBe(true);
    replacement.release();
    (await second.settleRetirement()).unwrap();
  } finally {
    first.return(
      err(
        new RhiError({
          code: 'internal-error',
          expected: 'fixture closed',
          hint: 'retire fixture',
        }),
      ),
    );
    second?.return(
      err(
        new RhiError({
          code: 'internal-error',
          expected: 'fixture closed',
          hint: 'retire fixture',
        }),
      ),
    );
    f.first.pool.dispose();
    f.first.scene.dispose();
    f.second.dispose();
  }
});

it('attempts ordinary View and static-depth disposal when a private construction fails', async () => {
  const f = await fixture();
  const resources = f.first.scene.captureResources().unwrap();
  const ordinary = f.first.pool
    .update({ ...f.first.input(), inputReads: resources.inputReads() })
    .unwrap().view;
  resources.seal().unwrap();
  f.first.pool._commitResourceReplacement();
  const work = f.prepare(f.first, 1);
  const storage = (await finish(work)).unwrap();
  const failure = new Error('injected original View disposal failure');
  const privateDispose = vi.spyOn(storage.view, 'dispose').mockImplementationOnce(() => {
    throw failure;
  });
  const ordinaryDispose = vi.spyOn(ordinary, 'dispose');
  const depthDispose = vi.spyOn(f.first.pool.staticLayers, 'dispose');
  try {
    expect(() => f.first.pool.dispose()).toThrow(AggregateError);
    expect(ordinaryDispose).toHaveBeenCalled();
    expect(depthDispose).toHaveBeenCalled();
    const settled = await work.settleRetirement();
    assert(!settled.ok);
  } finally {
    privateDispose.mockRestore();
    ordinaryDispose.mockRestore();
    depthDispose.mockRestore();
    storage.view.dispose();
    ordinary.dispose();
    f.first.pool.staticLayers.dispose();
    f.first.scene.dispose();
    f.second.dispose();
  }
});
