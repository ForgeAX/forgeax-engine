import { type ComputePipeline, err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';

const descriptor = {
  wgsl: '@compute @workgroup_size(1) fn main() {}',
  entryPoints: ['main'],
  bindings: [{ entries: [] }],
};
async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = rhi.createShaderModuleImmediate(device, { code: descriptor.wgsl }).unwrap();
  const sync = vi.spyOn(device, 'createComputePipeline');
  const completions: ((result: Result<ComputePipeline, RhiError>) => void)[] = [];
  const asyncCreate = vi.fn(
    () => new Promise<Result<ComputePipeline, RhiError>>((resolve) => completions.push(resolve)),
  );
  Object.assign(device, { createComputePipelineAsync: asyncCreate });
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let previous: ReturnType<typeof owner.beginFeature> | undefined;
  const session = (generation = 0) => {
    previous?.abortFrame().unwrap();
    previous = owner.beginFeature('compute-completion', generation);
    return previous;
  };
  const native = () =>
    device
      .createComputePipeline({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } })
      .unwrap();
  return { device, owner, sync, asyncCreate, completions, session, native };
}
it('waits for actual completion across aborted candidates and reuses the exact ready pipeline', async () => {
  const f = await fixture();
  try {
    const initial = f.session().prepareProgram('actual', descriptor, true);
    expect(initial.ok).toBe(false);
    if (initial.ok) throw Error('early ready');
    expect(initial.error).toMatchObject({ detail: { recovery: 'next-frame' } });
    expect(f.asyncCreate).toHaveBeenCalledTimes(1);
    expect(f.sync).not.toHaveBeenCalled();
    f.session().abortFrame().unwrap();
    expect(f.session().prepareProgram('actual', descriptor, true).ok).toBe(false);
    expect(f.asyncCreate).toHaveBeenCalledTimes(1);
    const pipeline = f.native(),
      finish = f.completions[0];
    if (finish === undefined) throw Error('missing native completion');
    finish(ok(pipeline));
    await Promise.resolve();
    const session = f.session(),
      program = session.prepareProgram('actual', descriptor, true).unwrap(),
      bindings = session.prepareBindings('bindings', { program, entries: [] }).unwrap();
    const pass = session
      .resolveComputePass('compute-completion', {
        program,
        bindings,
        dispatches: [{ entryPoint: 'main', workgroups: [1] }],
      })
      .unwrap();
    expect(pass.dispatches[0]?.pipeline).toBe(pipeline);
    session.prepareProgram('another-player', descriptor, true).unwrap();
    session.commitFrame();
    expect(f.asyncCreate).toHaveBeenCalledTimes(1);
    expect(f.sync).toHaveBeenCalledTimes(1);
  } finally {
    f.owner.dispose().unwrap();
  }
});
it('rejects failed native compilation and ignores completion from a disposed device generation', async () => {
  const f = await fixture();
  try {
    f.session().prepareProgram('old', descriptor, true);
    const stale = f.completions[0];
    f.session(1).prepareProgram('new', descriptor, true);
    const current = f.completions[1];
    if (stale === undefined || current === undefined) throw Error('missing device completions');
    stale(ok(f.native()));
    await Promise.resolve();
    expect(f.session(1).prepareProgram('new', descriptor, true).ok).toBe(false);
    current(
      err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'valid kernel',
          hint: 'real compiler rejected entry',
        }),
      ),
    );
    await Promise.resolve();
    const result = f.session(1).prepareProgram('new', descriptor, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw Error('failed compiler became ready');
    expect(result.error).toMatchObject({
      detail: { reason: expect.stringContaining('rhi-descriptor-invalid') },
    });
    expect(f.asyncCreate).toHaveBeenCalledTimes(2);
  } finally {
    f.owner.dispose().unwrap();
  }
});
it('preserves the ordinary synchronous path without an explicit preparation request', async () => {
  const f = await fixture();
  try {
    f.session().prepareProgram('ordinary', descriptor).unwrap();
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.asyncCreate).not.toHaveBeenCalled();
    expect(f.session().prepareProgram('ordinary', descriptor, true).ok).toBe(false);
    expect(f.asyncCreate).toHaveBeenCalledTimes(1);
  } finally {
    f.owner.dispose().unwrap();
  }
});

it('holds presentation pending for declared compute preparation until backend completion', async () => {
  const f = await fixture();
  const feature: RenderFeature<undefined> = {
    identity: 'host-compute-prepare',
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'compute-program',
                name: 'actual',
                preparePipelines: true,
                program: descriptor,
              },
            ],
            passes: [],
          },
        ],
      }),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const frame = () =>
    host.runFrame([
      {
        worlds: [],
        owner: 0,
        identity: 'main',
        render: true,
        frameNumber: 1,
        generation: 0,
        caps: f.device.caps,
        gpuWork: f.owner,
      },
    ]);
  try {
    const pending = frame();
    expect(pending.frame.preparationPending).toBe(true);
    expect(pending.frame.errors).toHaveLength(1);
    pending.onAborted();
    const finish = f.completions[0];
    if (finish === undefined) throw Error('missing actual backend completion');
    finish(ok(f.native()));
    await Promise.resolve();
    const ready = frame();
    expect(ready.frame.preparationPending).not.toBe(true);
    expect(ready.frame.errors).toEqual([]);
    expect(ready.frame.plans).toHaveLength(1);
    expect(ready.frame.plans[0]?.plan.passes).toEqual([]);
    ready.frame.onSubmitted();
    ready.onSubmitted();
  } finally {
    host.dispose();
    f.owner.dispose().unwrap();
  }
});
