import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderBundleCache } from '../render-bundle-cache';

async function fixture() {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const cache = new RenderBundleCache({ colorFormats: [] });
  const pass = () =>
    device.createCommandEncoder().unwrap().beginRenderPass({ colorAttachments: [] });
  return { device, cache, pass };
}

it('observes an unknown recording callback on hits and preserves its first error', async () => {
  const { device, cache, pass } = await fixture();
  const counters = { hits: 0, misses: 0 };
  let entries = 0;
  let count = 3;
  let failure: object | undefined;
  const trace: unknown[] = [];
  const record = (target: RhiRenderPassEncoder) => {
    entries += 1;
    trace.push(['before', entries, count]);
    target.draw(count);
    if (failure !== undefined) throw failure;
    trace.push(['after', entries]);
  };
  for (let frame = 0; frame < 4; frame++) cache.encode(device, pass(), record, counters);
  expect(entries).toBe(4);
  expect(counters.hits).toBe(2);
  expect(trace).toHaveLength(8);
  failure = { identity: 'author-callback-failure' };
  let caught: unknown;
  try {
    cache.encode(device, pass(), record, counters);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
  expect(entries).toBe(5);
  expect(trace.at(-1)).toEqual(['before', 5, 3]);
  failure = undefined;
  count = 7;
  const recovered = pass();
  const draw = vi.spyOn(recovered, 'draw');
  const execute = vi.spyOn(recovered, 'executeBundles');
  cache.encode(device, recovered, record, counters);
  expect(draw).toHaveBeenCalledWith(7);
  expect(execute).not.toHaveBeenCalled();
});

it('reads mutable indirect commands inside the retained physical buffer without rebuilding a bundle', async () => {
  const { device, cache, pass } = await fixture();
  const indirect = device.createBuffer({ size: 64, usage: 0x108 }).unwrap();
  const counters = { hits: 0, misses: 0 };
  const create = vi.spyOn(device, 'createRenderBundleEncoder');
  let records = 0;
  const writeAndRecord = (drawCount: number, offset: number) => {
    // Camera/culling changes the commands in an existing buffer. Bundle
    // command identity is its physical handle and offset, not these bytes.
    device.queue.writeBuffer(indirect, 0, new Uint32Array([drawCount, 1, 0, 0]));
    cache.encode(
      device,
      pass(),
      (target) => {
        records += 1;
        target.drawIndirect(indirect, offset);
      },
      counters,
    );
  };
  writeAndRecord(3, 0);
  writeAndRecord(5, 0);
  writeAndRecord(9, 0);
  writeAndRecord(11, 0);
  expect(records).toBe(4);
  expect(create).toHaveBeenCalledTimes(1);
  expect(counters.hits).toBe(2);
  writeAndRecord(11, 16);
  expect(counters.misses).toBe(3);
  expect(create).toHaveBeenCalledTimes(1);
  writeAndRecord(17, 16);
  expect(create).toHaveBeenCalledTimes(2);
  const fresh = device.createBuffer({ size: 64, usage: 0x108 }).unwrap();
  const p = pass();
  const draw = vi.spyOn(p, 'drawIndirect');
  cache.encode(device, p, (target) => target.drawIndirect(fresh, 16), counters);
  expect(draw).toHaveBeenCalledWith(fresh, 16);
});
