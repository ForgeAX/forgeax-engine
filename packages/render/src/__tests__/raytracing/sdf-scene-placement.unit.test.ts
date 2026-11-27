import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { expect, it, vi } from 'vitest';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  packSdfScene,
  repackSdfPlacementRow,
  type SdfMeshInstance,
} from '../../raytracing/sdf-query';
import { prepareSdfPlacements } from '../../raytracing/sdf-scene-placement';
import { SdfTransformCertificate } from '../../raytracing/sdf-transform-certificate';
import { authoredFarWorldBounds, authoredMissingBounds } from './sdf-placement-bounds.fixture';

vi.mock('@forgeax/engine-math', async (load) => {
  const actual = await load<typeof import('@forgeax/engine-math')>();
  return { ...actual, mat4: { ...actual.mat4, invert: vi.fn(actual.mat4.invert) } };
});

const pose = (x = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 3, 1]);
const missing = (transform = pose(4)): SdfMeshInstance => ({
  instanceId: 9,
  geometryId: 7,
  mask: 255,
  transform,
  field: { missing: true, bounds: authoredMissingBounds },
});
async function sampled() {
  return (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.5,
      triangleSidedness: [1],
    })
  ).unwrap();
}

it('prepares each pose once for raw rows and the identical surface residual coefficients', async () => {
  const field = await sampled(),
    source: SdfMeshInstance[] = [
      { instanceId: 1, geometryId: 2, mask: 255, transform: pose(), field },
      missing(),
      {
        instanceId: 3,
        geometryId: 2,
        mask: 255,
        transform: pose(8),
        field,
        surfaceCoverage: 'unavailable',
      },
    ];
  vi.mocked(mat4.invert).mockClear();
  const create = vi.spyOn(SdfTransformCertificate, 'create'),
    packed = packSdfScene(source).unwrap();
  try {
    expect(mat4.invert).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(packed.placementBounds[1]).toEqual(authoredFarWorldBounds);
    const words = new Uint32Array(
      packed.fields.buffer,
      packed.fields.byteOffset,
      packed.fields.byteLength / 4,
    );
    for (const row of [0, 2]) {
      const inverse = new Float32Array(packed.instances.buffer, row * 144, 16),
        certificate = create.mock.results[row]?.value;
      expect(certificate.ok).toBe(true);
      expect(
        certificate.value.validate(Float32Array.from(source[row]?.transform ?? []), inverse).ok,
      ).toBe(true);
      expect(new Float32Array(packed.fields.buffer, (4 + row * 20 + 18) * 4, 2)).toEqual(
        Float32Array.of(certificate.value.localRelative, certificate.value.localAbsolute),
      );
    }
    expect(words[6]).toBe(1);
    expect(words[46]).toBe(0);
    expect(Array.from(words.subarray(24, 44))).toEqual(Array(20).fill(0));
  } finally {
    create.mockRestore();
  }
});

it('retains immutable cold-composition facts and derives new facts after a pose edit', () => {
  const transform = pose(4),
    source = missing(transform),
    before = packSdfScene([source]).unwrap();
  transform[12] = 8;
  const after = packSdfScene([source]).unwrap(),
    edited = repackSdfPlacementRow(source, before.instances).unwrap();
  expect(edited.bytes).toEqual(after.instances);
  expect(before.placementBounds[0]).toEqual(authoredFarWorldBounds);
  expect(after.placementBounds[0]).toEqual({ min: [7, -1, 2.875], max: [9, 1, 3.125] });
  expect(Object.isFrozen(before.placementBounds)).toBe(true);
  const composition = packGlobalSdfComposition([source], {
    origin: [-2, -2, -2],
    dimensions: [4, 4, 4],
    spacing: 1,
    maxDistance: 8,
    coverageDistance: 0.5,
  }).unwrap();
  expect(composition.placementBounds).toEqual(after.placementBounds);
});

it('does not convert missing or unqualified coverage into a surface packet', async () => {
  const field = await sampled(),
    source: SdfMeshInstance[] = [
      missing(),
      {
        instanceId: 3,
        geometryId: 2,
        mask: 255,
        transform: pose(),
        field,
        surfaceCoverage: 'unavailable',
      },
    ],
    packed = packSdfScene(source).unwrap(),
    words = new Uint32Array(packed.instances.buffer);
  expect(words[20]).toBe(0xffffffff);
  expect(words[35]).toBe(0);
  expect(words[36 + 35]).toBe(0x40000000);
  expect(packed.surface.headers[4 + 2]).toBe(0);
  expect(packed.surface.headers[4 + 20 + 2]).toBe(0);
  expect(packed.placementBounds.every((bounds) => bounds !== undefined)).toBe(true);
});

it('keeps accepted missing fields when the optional candidate envelope is unavailable', () => {
  const transform = pose();
  transform[0] = 2;
  const source: SdfMeshInstance = {
      ...missing(transform),
      field: {
        missing: true,
        bounds: { min: [0, 0, 0], max: [3e38, 1, 1] },
      },
    },
    packed = packSdfScene([source]).unwrap();
  expect(packed.placementBounds).toEqual([undefined]);
  expect(new Uint32Array(packed.instances.buffer)[20]).toBe(0xffffffff);
  const prepared = prepareSdfPlacements([source]).unwrap();
  expect(prepared[0]?.certificate.ok).toBe(true);
});
