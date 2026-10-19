import { type ComputePipelineDescriptor, ok } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { wrap } from '../recorder';

it('retains actual compute completion and records only its call-time descriptor', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    shader = (
      await rhi.createShaderModule(real, { code: '@compute @workgroup_size(1) fn actual() {}' })
    ).unwrap();
  const desc: ComputePipelineDescriptor = {
      layout: 'auto',
      compute: { module: shader, entryPoint: 'actual' },
    },
    pipeline = real.createComputePipeline(desc).unwrap();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (finish = resolve)),
    native = vi.fn(async () => {
      await gate;
      return ok(pipeline);
    });
  Object.assign(real, { createComputePipelineAsync: native });
  const adapter = (await rhi.requestAdapter()).unwrap(),
    debug = wrap(
      {
        requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
      },
      createShaderModule,
    ),
    device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap(),
    create = device.createComputePipelineAsync;
  if (create === undefined) throw Error('recorder dropped capability');
  const result = create(desc),
    observed = vi.fn();
  void Promise.resolve(result).then(observed);
  await Promise.resolve();
  expect(observed).not.toHaveBeenCalled();
  expect(debug.bootstrapEvents().filter((e) => e.kind === 'createComputePipeline')).toHaveLength(0);
  desc.compute.entryPoint = 'mutated-after-call';
  if (finish === undefined) throw Error('missing completion');
  finish();
  expect((await result).unwrap()).toBe(pipeline);
  const events = debug.bootstrapEvents().filter((e) => e.kind === 'createComputePipeline');
  expect(events).toHaveLength(1);
  expect(events[0]?.desc.compute.entryPoint).toBe('actual');
  expect(native).toHaveBeenCalledTimes(1);
});

it('preserves an immediate completed compute recipe through capture', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(real, { code: '@compute @workgroup_size(1) fn actual() {}' })
  ).unwrap();
  const desc: ComputePipelineDescriptor = {
    layout: 'auto',
    compute: { module: shader, entryPoint: 'actual' },
  };
  const pipeline = real.createComputePipeline(desc).unwrap();
  Object.assign(real, { createComputePipelineAsync: () => ok(pipeline) });
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap(
    {
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
    },
    createShaderModule,
  );
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();
  const ready = device.createComputePipelineAsync?.(desc);
  if (ready === undefined || !('ok' in ready)) throw Error('recorder delayed completed compute');
  expect(ready.unwrap()).toBe(pipeline);
  expect(debug.bootstrapEvents().filter((e) => e.kind === 'createComputePipeline')).toHaveLength(1);
});
