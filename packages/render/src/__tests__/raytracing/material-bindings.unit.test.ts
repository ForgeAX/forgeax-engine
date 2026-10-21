import { ok, type ParamSchemaEntry } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createSurfaceMaterialBindings,
  createSurfaceMaterialGroup,
} from '../../raytracing/material-bindings';
import { rayReferenceFailure } from '../../raytracing/scene';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { queryTestDevice } from './global-sdf-query-device.fixture';

it('refreshes texture and sampler bindings without replacing or damaging the retained material uniform', async () => {
  const device = await queryTestDevice();
  const texture = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 4 })
    .unwrap();
  const firstView = device.createTextureView(texture, {}).unwrap();
  const nextView = device.createTextureView(texture, {}).unwrap();
  const firstSampler = device.createSampler({ magFilter: 'nearest' }).unwrap();
  const nextSampler = device.createSampler({ magFilter: 'linear' }).unwrap();
  const schema: readonly ParamSchemaEntry[] = [
    { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
    { name: 'baseColorTexture', type: 'texture2d' },
  ];
  const material = createSurfaceMaterialBindings(device, schema, defaultMaterialSnapshot(), 2, () =>
    ok({ view: firstView, sampler: firstSampler }),
  ).unwrap();
  const allocate = vi.spyOn(device, 'createBuffer');
  const layout = vi.spyOn(device, 'createBindGroupLayout');
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const destroy = vi.spyOn(device, 'destroyBuffer');
  const group = vi.spyOn(device, 'createBindGroup');
  const unavailable = createSurfaceMaterialGroup(
    device,
    schema,
    material.uniform,
    material.layout,
    () => rayReferenceFailure('replacement texture is not ready'),
  );
  expect(unavailable.ok).toBe(false);
  expect(group).not.toHaveBeenCalled();
  const resolve = vi.fn(() => ok({ view: nextView, sampler: nextSampler }));
  const next = createSurfaceMaterialGroup(
    device,
    schema,
    material.uniform,
    material.layout,
    resolve,
  ).unwrap();
  expect(resolve).toHaveBeenCalledExactlyOnceWith('baseColorTexture');
  expect(next.group).not.toBe(material.group);
  expect(next.textureViews).toEqual([nextView]);
  expect(group.mock.calls[0]?.[0]).toEqual({
    layout: material.layout,
    entries: [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: material.uniform } } },
      { binding: 1, resource: { kind: 'sampler', value: nextSampler } },
      { binding: 2, resource: { kind: 'textureView', value: nextView } },
    ],
  });
  expect(allocate).not.toHaveBeenCalled();
  expect(layout).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  device.destroyBuffer(material.uniform);
  device.destroyTexture(texture);
});
