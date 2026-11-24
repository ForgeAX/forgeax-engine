import { createShaderModule } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { GLOBAL_SDF_COMPOSE_WGSL, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { GLOBAL_SDF_TEXTURE_WGSL } from '../../raytracing/global-sdf-texture';
import { SDF_SCENE_TEXTURE_PROJECT_WGSL } from '../../raytracing/sdf-scene-texture';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import {
  createVisibilityControl,
  visibilityPlaneField,
  visibilityWallFields,
} from './irradiance-field-visibility.fixture';
import { FIELD_SEGMENT_TEST_WGSL, rayShaderTestImports } from './ray-shader-imports.fixture';

it('supplies a canonical wall packet while retaining the signed-solid unknown control', async () => {
  const fields = await visibilityWallFields();
  expect(fields.field.policy.kind).toBe('sampled-visibility');
  expect(fields.signedSolid.policy.kind).toBe('signed-solid');
  const grid = {
    origin: [-2, -2, -5] as const,
    dimensions: [17, 17, 17] as const,
    spacing: 0.25,
    maxDistance: 4,
    coverageDistance: 0.125,
  };
  const source = {
    instanceId: 7,
    geometryId: 9,
    mask: 255,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1],
  };
  const packed = (field: typeof fields.field | typeof fields.signedSolid) =>
    packGlobalSdfComposition([{ ...source, field }], grid, { sourceEpoch: 1 }).unwrap();
  const canonical = packed(fields.field),
    legacy = packed(fields.signedSolid);
  expect(new Uint32Array(canonical.data.instances.buffer)[35]).toBe(0x40000000);
  expect(new Uint32Array(legacy.data.instances.buffer)[35]).not.toBe(0x40000000);
  assert(fields.field.surface !== undefined);
  expect(fields.field.surface.indices).toHaveLength(12 * 3);
});

it.each([0, 1] as const)('authors a canonical analytic thin wall on axis %i', async (axis) => {
  const field = await visibilityPlaneField(axis, 2);
  expect(field.policy.kind).toBe('sampled-visibility');
  assert(field.surface !== undefined);
  expect(field.surface.indices).toHaveLength(36);
  const coordinates = Array.from(field.surface.positions).filter((_, i) => i % 3 === axis);
  expect(Math.min(...coordinates)).toBe(Math.fround(-0.02));
  expect(Math.max(...coordinates)).toBe(Math.fround(0.02));
  const packed = packGlobalSdfComposition(
    [
      {
        instanceId: 7,
        geometryId: 9,
        mask: 255,
        surfaceCoverage: 'opaque',
        field,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
    {
      origin: [-2, -2, -2],
      dimensions: [33, 33, 33],
      spacing: 0.125,
      maxDistance: 4,
      coverageDistance: 0.0625,
    },
    { sourceEpoch: 1 },
  ).unwrap();
  expect(new Uint32Array(packed.data.instances.buffer)[35]).toBe(0x40000000);
  expect(Array.from(new Uint32Array(packed.data.settings.buffer, 48, 4))).toEqual([
    packed.data.instances.byteLength / 4,
    packed.data.fields.byteLength / 4,
    1,
    1,
  ]);
});

it('reflects the canonical visibility projection bindings', async () => {
  const compiled = (
    await compileShader(SDF_SCENE_TEXTURE_PROJECT_WGSL, {
      id: 'actual-canonical-visibility-projection',
      computeEntry: 'projectSdfScene',
    })
  ).unwrap();
  expect(
    compiled.reflection.boundGlobals
      .filter((row) => (row.visibility & 4) !== 0)
      .map((row) => [row.group, row.binding]),
  ).toEqual([
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ]);
});

it('binds the canonical uint projection from the same packed source and accepted epoch', async () => {
  const compiled = (
    await compileShader(FIELD_SEGMENT_TEST_WGSL, {
      id: 'visibility-fixture-live-contract',
      imports: await rayShaderTestImports(),
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
  const expected = compiled.reflection.boundGlobals.filter(
    (row) => row.group === 1 && row.binding >= 4,
  );
  expect(expected.map((row) => row.binding).sort()).toEqual([4, 5, 6]);
  expect(expected.find((row) => row.binding === 6)).toMatchObject({
    sampleType: 'uint',
    viewDimension: '2d',
  });
  const base = await queryTestDevice();
  const device = Object.create(base) as typeof base;
  Object.defineProperty(device, 'limits', {
    value: { ...base.limits, maxTextureDimension2D: 8192 },
  });
  const modules = {
    compose: (await createShaderModule(device, { code: GLOBAL_SDF_COMPOSE_WGSL })).unwrap(),
    coarse: (await createShaderModule(device, { code: GLOBAL_SDF_TEXTURE_WGSL })).unwrap(),
    canonical: (
      await createShaderModule(device, { code: SDF_SCENE_TEXTURE_PROJECT_WGSL })
    ).unwrap(),
  };
  const control = await createVisibilityControl(device, modules, [], {
    origin: [-2, -2, -5],
    dimensions: [17, 17, 17],
    spacing: 0.25,
    maxDistance: 4,
    coverageDistance: 0.125,
  });
  try {
    expect(control.bindings.map((row) => row.binding)).toEqual([4, 5, 6]);
    expect(control.bindings.slice(0, 2).map((row) => row.binding)).not.toEqual(
      expected.map((row) => row.binding).sort(),
    );
    expect(Array.from(new Uint32Array(control.packed.data.settings.buffer, 48, 4))).toEqual(
      control.canonical.expected,
    );
    expect(control.canonical.expected[3]).toBe(1);
    expect(control.canonical.expected.slice(0, 2)).toEqual([
      control.input.instances.size / 4,
      control.input.fields.size / 4,
    ]);
    const encoder = device.createCommandEncoder().unwrap();
    const begin = vi.spyOn(encoder, 'beginComputePass');
    control.record(encoder);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(control.canonical.required()).toBe(true);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    control.canonical.submitted(1);
    expect(control.canonical.required()).toBe(false);
  } finally {
    control.dispose();
  }
});
