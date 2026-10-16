import { buildMeshDistanceField } from '@forgeax/engine-geometry';
import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import { createSoftwareSdfQuery } from '../../raytracing/software-sdf-query';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

it('requires the complete frozen source roster and retires both query stages on failure', async () => {
  const device = await queryTestDevice();
  assert(device instanceof RhiNullDevice);
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const source = {
    instanceId: 1,
    geometryId: 3,
    mask: 255,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    field,
  };
  const composition = (
    await createGlobalSdfComposition(device, createShaderModule, [source], {
      origin: [-3, -3, -3],
      dimensions: [13, 13, 13],
      spacing: 0.5,
      maxDistance: 2,
      coverageDistance: 0.5,
    })
  ).unwrap();
  const ray = {
    origin: [0, 2, 0] as const,
    direction: [0, -1, 0] as const,
    tMin: 0,
    tMax: 4,
    mask: 255,
  };
  const live = () =>
    device.bookkeeper.allRecords().filter((r) => r.kind === 'Buffer' && !r.destroyed).length;
  const baseline = live();
  for (const detailDistance of [0, -1, NaN, Infinity, 1e-50]) {
    expect(
      (
        await createSoftwareSdfQuery(device, createShaderModule, composition, [source], [ray], {
          detailDistance,
        })
      ).ok,
    ).toBe(false);
    expect(live()).toBe(baseline);
  }
  for (const inputs of [[], [{ ...source, mask: 0 }], [{ ...source, instanceId: 2 }]]) {
    expect(
      (
        await createSoftwareSdfQuery(device, createShaderModule, composition, inputs, [ray], {
          detailDistance: 1,
        })
      ).ok,
    ).toBe(false);
    expect(live()).toBe(baseline);
  }
  expect(
    (
      await createSoftwareSdfQuery(
        device,
        createShaderModule,
        composition,
        [source],
        [{ ...ray, tMin: 1e10, tMax: 1e10 + 4096 }],
        { detailDistance: 0.01 },
      )
    ).ok,
  ).toBe(false);
  for (const failLabel of ['sdf.trace', 'global-sdf.query', 'sdf.continue-global']) {
    const result = await createSoftwareSdfQuery(
      device,
      async (d, desc) =>
        desc.label === failLabel
          ? err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'injected compile failure',
                hint: 'retry',
              }),
            )
          : createShaderModule(d, desc),
      composition,
      [source],
      [ray],
      { detailDistance: 0.25 },
    );
    expect(result.ok).toBe(false);
    expect(live()).toBe(baseline);
  }
  expect(
    (
      await createSoftwareSdfQuery(
        device,
        createShaderModule,
        composition,
        [source],
        [{ ...ray, mask: 1 }],
        { detailDistance: 1 },
      )
    ).ok,
  ).toBe(false);
  expect(live()).toBe(baseline);
  const built = (
    await createSoftwareSdfQuery(device, createShaderModule, composition, [source], [ray], {
      detailDistance: 0.25,
    })
  ).unwrap();
  expect(live()).toBe(baseline + 8);
  const encoder = device.createCommandEncoder({}).unwrap();
  built.record(encoder).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  built.dispose();
  built.dispose();
  expect(live()).toBe(baseline);
  expect(built.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  composition.dispose();
  expect(live()).toBe(0);
});
