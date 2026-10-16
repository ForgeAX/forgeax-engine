import type { BindGroupEntry, BindGroupLayout } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import {
  createStandardSurfaceLightingBindGroup,
  getOrCreateHdrpBuffers,
  resetHdrpBuffers,
} from '../hdrp-buffers';
import type { RenderSystemRuntime } from '../record/render-context';

it('binds the current Standard cluster allocation without a scene mesh or palette', async () => {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const fire = vi.fn();
  const runtime = { device, errorRegistry: { fire } } as unknown as RenderSystemRuntime;
  const grid = { x: 32, y: 16, z: 32 };
  const prepared = getOrCreateHdrpBuffers(runtime, grid);
  if (prepared?.kind !== 'storage') throw new Error('Expected Standard storage allocation');
  const entries: BindGroupEntry[][] = [];
  const create = device.createBindGroup.bind(device);
  device.createBindGroup = (descriptor) => {
    entries.push([...descriptor.entries]);
    return create(descriptor);
  };
  expect(
    createStandardSurfaceLightingBindGroup(runtime, {} as BindGroupLayout, grid),
  ).not.toBeNull();
  expect(entries).toHaveLength(1);
  expect(entries[0]?.map((entry) => entry.binding)).toEqual([3, 4, 5, 6, 7, 8]);
  expect(entries[0]?.slice(0, 4).map((entry) => entry.resource)).toEqual(
    [
      prepared.lightDataBuffer,
      prepared.clusterGridBuffer,
      prepared.lightIndexListBuffer,
      prepared.clusterUniformBuffer,
    ].map((buffer) => ({ kind: 'buffer', value: { buffer } })),
  );
  expect(getOrCreateHdrpBuffers(runtime, grid)).toBe(prepared);
  expect(fire).not.toHaveBeenCalled();
  resetHdrpBuffers(runtime);
});
