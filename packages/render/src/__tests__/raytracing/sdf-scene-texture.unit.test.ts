import type { RhiDevice } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import {
  createSdfSceneTextureKernel,
  packSdfSceneTexture,
  planSdfSceneTexture,
  SDF_SCENE_TEXTURE_PROJECT_WGSL,
} from '../../raytracing/sdf-scene-texture';
import { queryTestDevice } from './global-sdf-query-device.fixture';

it('admits two canonical slots and seven raw field words without counting padding as source', () => {
  const result = planSdfSceneTexture(288, 28, 2, {
    maxTextureDimension2D: 1024,
    maxBytes: 384,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Authored projection must fit');
  expect(result.value).toEqual({
    width: 24,
    height: 1,
    texels: 24,
    bytes: 384,
    instanceWords: 72,
    fieldWords: 7,
    rowLimit: 2,
    logicalWords: 95,
  });
  const packed = packSdfSceneTexture(result.value, 7);
  expect(packed.ok).toBe(true);
  if (!packed.ok) throw new Error('Accepted epoch must pack');
  expect(Array.from(packed.value)).toEqual([72, 7, 2, 7, 24, 1, 95, 0]);
});

it('rejects truncated slots, address overflow and the caller allocation boundary', () => {
  for (const [instances, fields, count, dimension, budget] of [
    [287, 28, 2, 1024, 384],
    [288, 27, 2, 1024, 384],
    [288, 28, 3, 1024, 384],
    [288, 28, 2, 1024, 383],
    [288, 28, 2, 2, 384],
    [288, 2 ** 34, 2, 1024, 2 ** 40],
  ] as const) {
    expect(
      planSdfSceneTexture(instances, fields, count, {
        maxTextureDimension2D: dimension,
        maxBytes: budget,
      }).ok,
    ).toBe(false);
  }
});

it('accounts for the extra texture allocation of an existing full pool and slot capacity', () => {
  const result = planSdfSceneTexture(147_456, 16_777_216, 1024, {
    maxTextureDimension2D: 8192,
    maxBytes: 16_941_056,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Existing source pool must fit its explicit derived budget');
  expect(result.value.logicalWords).toBe(4_231_184);
  expect(result.value.width).toBe(1024);
  expect(result.value.height).toBe(1034);
  expect(result.value.bytes).toBe(16_941_056);
  for (const epoch of [0, -1, 1.5, Number.NaN, 2 ** 32])
    expect(packSdfSceneTexture(result.value, epoch).ok).toBe(false);
});

it('compiles the unsigned-word projection through the maintained shader producer', async () => {
  const result = await compileShader(SDF_SCENE_TEXTURE_PROJECT_WGSL, {
    id: 'sdf-scene-texture-projection',
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
});
it('rejects a projection whose second dispatch dimension exceeds the device limit', async () => {
  const device = await queryTestDevice();
  const limited: RhiDevice = Object.create(device);
  Object.defineProperty(limited, 'limits', {
    value: { ...device.limits, maxComputeWorkgroupsPerDimension: 2 },
  });
  const module = (
    await createShaderModule(limited, { code: SDF_SCENE_TEXTURE_PROJECT_WGSL })
  ).unwrap();
  const kernel = (await createSdfSceneTextureKernel(limited, module)).unwrap();
  const plan = planSdfSceneTexture(144, 4912, 1, {
    maxTextureDimension2D: 1024,
    maxBytes: 5120,
  }).unwrap();
  expect(plan.texels).toBe(320);
  const instances = device.createBuffer({ size: 144, usage: 140 }).unwrap();
  const fields = device.createBuffer({ size: 4912, usage: 140 }).unwrap();
  const params = device.createBuffer({ size: 32, usage: 76 }).unwrap();
  const texture = device
    .createTexture({
      size: { width: plan.width, height: plan.height },
      format: 'rgba32uint',
      usage: 15,
    })
    .unwrap();
  try {
    const view = device.createTextureView(texture, { dimension: '2d' }).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    const pass = encoder.beginComputePass({});
    const result = kernel.record(
      pass,
      {
        instances: { buffer: instances, size: 144 },
        fields: { buffer: fields, size: 4912 },
      },
      { buffer: params, size: 32 },
      view,
      plan,
    );
    pass.end();
    expect(result.ok).toBe(false);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    expect(device.totalDispatchCount).toBe(0);
  } finally {
    device.destroyTexture(texture);
    for (const buffer of [instances, fields, params]) device.destroyBuffer(buffer);
  }
});
