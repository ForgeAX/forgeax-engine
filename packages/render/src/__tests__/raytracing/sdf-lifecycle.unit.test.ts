import { RhiError } from '@forgeax/engine-rhi';
import { createShaderModule, RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { assert, expect, it } from 'vitest';
import { createSdfQuery, type SdfQueryOptions } from '../../raytracing/sdf-query';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import { prepareSdfCardsBaseFixture } from './sdf-cards.commands';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

it('releases partial and completed SDF/card allocations and rejects invalid snapshots', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  assert(device instanceof RhiNullDevice);
  const fixture = await prepareSdfCardsBaseFixture(),
    field = {
      ...fixture.field,
      bricks: Uint32Array.from(fixture.field.bricks),
      values: Float32Array.from(fixture.field.values),
    };
  const instance = {
    instanceId: 7,
    geometryId: 9,
    materialId: 0,
    mask: 255,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    positions: sdfCubePositions,
    indices: sdfCubeIndices,
  };
  const rays = [
    { origin: [0, 0, 3] as const, direction: [0, 0, -1] as const, tMin: 0, tMax: 20, mask: 255 },
  ];
  const failure = async () =>
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected: 'injected shader failure',
        hint: 'retry compilation',
      }),
    );
  const live = () =>
    device.bookkeeper
      .allRecords()
      .filter((r) => (r.kind === 'Buffer' || r.kind === 'Texture') && !r.destroyed);
  expect(live()).toHaveLength(0);
  for (const options of [
    null,
    [],
    { maxSteps: 0 },
    { maxSteps: 1025 },
    { visibilityExpansion: 'unknown' },
  ]) {
    const result = await createSdfQuery(
      device,
      createShaderModule,
      [{ ...instance, field }],
      rays,
      options as unknown as SdfQueryOptions,
    );
    expect(result.ok).toBe(false);
    expect(live()).toHaveLength(0);
  }
  expect((await createSdfQuery(device, failure, [{ ...instance, field }], rays)).ok).toBe(false);
  expect(live()).toHaveLength(0);
  const source = {
    instance,
    layout: fixture.layout,
    sections: [
      { indexOffset: 0, indexCount: instance.indices.length, material: { id: 0, ...fixture.card } },
    ],
  };
  expect((await createSurfaceCapture(device, failure, [source])).ok).toBe(false);
  expect(live()).toHaveLength(0);
  for (const resolution of [7, 513, 64.5, Number.NaN]) {
    expect(
      (
        await createSurfaceCapture(device, createShaderModule, [source], {
          kind: 'cards',
          resolution,
        })
      ).ok,
    ).toBe(false);
    expect(live()).toHaveLength(0);
  }
  const overBudget = await createSurfaceCapture(
    device,
    createShaderModule,
    Array.from({ length: 10 }, (_, i) => ({
      ...source,
      instance: { ...source.instance, instanceId: i },
    })),
    { kind: 'cards', resolution: 512 },
  );
  expect(overBudget.ok).toBe(false);
  if (!overBudget.ok) {
    expect(overBudget.error.code).toBe('ray-reference-limit');
    expect(overBudget.error.detail).toEqual({
      cause: 'capture exceeds texture extent or attachment byte budget',
    });
  }
  expect(live()).toHaveLength(0);
  expect(
    (
      await createSurfaceCapture(device, createShaderModule, [
        {
          ...source,
          sections: source.sections.map((s) => ({ ...s, material: { id: 0, ...fixture.ray } })),
        },
      ])
    ).ok,
  ).toBe(false);
  expect(live()).toHaveLength(0);
  for (const changed of [
    { ...instance, transform: new Array(16).fill(0) },
    { ...instance, mask: 256 },
  ])
    expect(
      (await createSdfQuery(device, createShaderModule, [{ ...changed, field }], rays)).ok,
    ).toBe(false);
  expect(
    (
      await createSdfQuery(
        device,
        createShaderModule,
        [
          { ...instance, field },
          { ...instance, field },
        ],
        rays,
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await createSdfQuery(
        device,
        createShaderModule,
        [{ ...instance, field: { ...field, values: new Float32Array(2) } }],
        rays,
      )
    ).ok,
  ).toBe(false);
  for (const sections of [
    [],
    [
      {
        indexOffset: 3,
        indexCount: instance.indices.length - 3,
        material: { id: 0, ...fixture.card },
      },
    ],
    [
      { indexOffset: 0, indexCount: 6, material: { id: 0, ...fixture.card } },
      {
        indexOffset: 3,
        indexCount: instance.indices.length - 3,
        material: { id: 0, ...fixture.card },
      },
    ],
  ]) {
    expect(
      (await createSurfaceCapture(device, createShaderModule, [{ ...source, sections }])).ok,
    ).toBe(false);
    expect(live()).toHaveLength(0);
  }
  const q = (
    await createSdfQuery(device, createShaderModule, [{ ...instance, field }], rays)
  ).unwrap();
  const cards = (await createSurfaceCapture(device, createShaderModule, [source])).unwrap();
  expect(live().length).toBeGreaterThan(0);
  q.dispose();
  cards.dispose();
  q.dispose();
  cards.dispose();
  expect(live()).toHaveLength(0);
  const encoder = device.createCommandEncoder({}).unwrap();
  expect(q.record(encoder).ok).toBe(false);
  expect(cards.record(encoder).ok).toBe(false);
});
