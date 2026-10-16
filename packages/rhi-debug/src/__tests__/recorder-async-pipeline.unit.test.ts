import { ok, type RenderPipelineDescriptor } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { wrap } from '../recorder';

it('preserves native async completion and records the call-time descriptor once', async () => {
  const real = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (
    await rhi.createShaderModule(real, {
      code: '@vertex fn v() -> @builtin(position) vec4f { return vec4f(0); }',
    })
  ).unwrap();
  const desc: RenderPipelineDescriptor = {
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'v', buffers: [] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  };
  const pipeline = real.createRenderPipeline(desc).unwrap();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const createRenderPipelineAsync = vi.fn(async () => {
    await gate;
    return ok(pipeline);
  });
  Object.assign(real, { createRenderPipelineAsync });
  const adapter = (await rhi.requestAdapter()).unwrap();
  const debug = wrap({
    requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(real) }),
  });
  const device = (await (await debug.requestAdapter()).unwrap().requestDevice()).unwrap();
  const create = device.createRenderPipelineAsync;
  if (create === undefined) throw new Error('recorder dropped async capability');
  const promise = create(desc),
    completed = vi.fn();
  void promise.then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(debug.bootstrapEvents().filter((e) => e.kind === 'createRenderPipeline')).toHaveLength(0);
  if (desc.primitive !== undefined) desc.primitive.cullMode = 'front';
  if (finish === undefined) throw new Error('missing controlled completion');
  finish();
  expect((await promise).unwrap()).toBe(pipeline);
  const events = debug.bootstrapEvents().filter((e) => e.kind === 'createRenderPipeline');
  expect(events).toHaveLength(1);
  expect(events[0]?.desc.primitive?.cullMode).toBe('none');
  expect(createRenderPipelineAsync).toHaveBeenCalledTimes(1);
  expect(debug.lookupPipeline(device, pipeline)).toBe(events[0]?.handleId);
});
