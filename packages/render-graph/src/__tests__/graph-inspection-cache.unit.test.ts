import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderGraphBuilder } from '../builder';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const builder = new RenderGraphBuilder();
  for (const label of ['first', 'second']) {
    const resource = builder.createBuffer(label, { size: 16 }).unwrap();
    builder
      .addCopyPass(`write-${label}`, { accesses: [{ resource, usage: 'copy-dst' }], encode() {} })
      .unwrap();
  }
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  return { device, graph };
}

it('reuses live inspection without recreating resource rows and refreshes after each release', async () => {
  const { device, graph } = await fixture();
  let complete: (() => void) | undefined;
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        complete = () => resolve(undefined);
      }),
  );
  const live = graph.inspect();
  expect(Object.isFrozen(live)).toBe(true);
  expect(Object.isFrozen(live.resourceAllocation)).toBe(true);
  for (let frame = 0; frame < 600; frame += 1) expect(graph.inspect()).toBe(live);
  const retiring = graph.retire();
  const pending = graph.inspect();
  expect(pending).not.toBe(live);
  expect(graph.inspect()).toBe(pending);
  expect(live.resourceAllocation?.liveBytes).toBe(32);
  expect(pending.resourceAllocation?.pendingRetirementBytes).toBe(32);
  const destroy = device.destroyBuffer.bind(device);
  let visits = 0;
  vi.spyOn(device, 'destroyBuffer').mockImplementation((buffer) => {
    if (visits++ === 1) {
      const partial = graph.inspect();
      expect(partial).not.toBe(pending);
      expect(partial.resourceAllocation).toMatchObject({
        pendingRetirementBytes: 16,
        retiredBytes: 16,
      });
      expect(partial.resources.map((row) => row.allocationState)).toEqual([
        'released',
        'pending-retirement',
      ]);
      expect(graph.inspect()).toBe(partial);
    }
    return destroy(buffer);
  });
  complete?.();
  expect((await retiring).ok).toBe(true);
  const released = graph.inspect();
  expect(released.resourceAllocation).toMatchObject({
    pendingRetirementBytes: 0,
    retiredBytes: 32,
  });
  expect(released.resources.map((row) => row.allocationState)).toEqual(['released', 'released']);
  expect(graph.inspect()).toBe(released);
  expect(pending.resourceAllocation?.pendingRetirementBytes).toBe(32);
  expect(released.passes).toBe(live.passes);
});

it.each([
  'refuse',
  'throw',
] as const)('keeps a failed %s token pending while refreshing released tokens', async (mode) => {
  const { device, graph } = await fixture();
  const live = graph.inspect();
  const destroy = device.destroyBuffer.bind(device);
  let visits = 0;
  vi.spyOn(device, 'destroyBuffer').mockImplementation((buffer) => {
    if (visits++ === 0) {
      if (mode === 'throw') throw new Error('owned test refusal');
      return { ok: false, error: { code: 'webgpu-runtime-error' } } as never;
    }
    return destroy(buffer);
  });
  expect((await graph.retire()).ok).toBe(false);
  const failed = graph.inspect();
  expect(failed).not.toBe(live);
  expect(failed.resourceAllocation).toMatchObject({
    liveBytes: 0,
    pendingRetirementBytes: 16,
    retiredBytes: 16,
  });
  expect(failed.resources.map((row) => row.allocationState)).toEqual([
    'pending-retirement',
    'released',
  ]);
  expect(graph.inspect()).toBe(failed);
});

it('keeps a rejected fence pending and never replaces its snapshot with released evidence', async () => {
  const { device, graph } = await fixture();
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockRejectedValue(new Error('owned fence refusal'));
  const live = graph.inspect();
  const retirement = graph.retire();
  const pending = graph.inspect();
  expect((await retirement).ok).toBe(false);
  expect(pending).not.toBe(live);
  expect(graph.inspect()).toBe(pending);
  expect(pending.resourceAllocation).toMatchObject({ pendingRetirementBytes: 32, retiredBytes: 0 });
});
