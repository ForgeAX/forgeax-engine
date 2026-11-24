import {
  buildMeshDistanceField,
  decodeMeshDistanceField,
  encodeMeshDistanceField,
  type MeshDistanceField,
  validateMeshDistanceField,
} from '@forgeax/engine-geometry';
import { assert, beforeAll, expect, it } from 'vitest';
import { SdfFieldUpload } from '../../raytracing/sdf-field-storage';
import { packSdfSceneWithStaticFields } from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

type GeometricField = Extract<
  Awaited<ReturnType<typeof buildMeshDistanceField>>,
  { ok: true }
>['value'];
let cube: GeometricField;
beforeAll(async () => {
  cube = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  assert(cube.policy.kind === 'signed-solid');
});

function changed(spacing: number, errorBound: number): GeometricField {
  assert(cube.policy.kind === 'signed-solid');
  return { ...cube, spacing, policy: { ...cube.policy, errorBound } };
}

function staticPack(field: MeshDistanceField, translation = 0, scale = 1) {
  const upload = SdfFieldUpload.capture(field).unwrap();
  return packSdfSceneWithStaticFields(
    [
      {
        instanceId: 0,
        geometryId: 0,
        mask: 255,
        field,
        fieldUpload: upload,
        transform: [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, translation, 0, 0, 1],
      },
    ],
    1,
    {
      wordLength: upload.length,
      uploads: [upload],
      offsets: new Map([[upload, 0]]),
      initialization: {
        version: 'field-properties/1',
        byteLength: upload.length * 4,
        copyInto(target) {
          if (target.byteLength !== upload.length * 4 || target.byteOffset % 4 !== 0) return false;
          upload.copyInto(new Uint32Array(target.buffer, target.byteOffset, upload.length), 0);
          return true;
        },
      },
    },
  );
}

it('rejects finite codec metadata that cannot be represented in a static GPU row', async () => {
  const source = changed(1e40, 1e40);
  expect(validateMeshDistanceField(source).ok).toBe(true);
  const bytes = (await encodeMeshDistanceField(source)).unwrap();
  const decoded = (await decodeMeshDistanceField(bytes, source.meshDigest)).unwrap();
  expect(staticPack(decoded)).toMatchObject({
    ok: false,
    error: { code: 'ray-reference-invalid' },
  });
});

it('rejects derived extent overflow while direct metadata remains finite f32', () => {
  const source = changed(1e38, 1e38);
  expect(validateMeshDistanceField(source).ok).toBe(true);
  expect(Number.isFinite(Math.fround(source.spacing))).toBe(true);
  expect(Number.isFinite(Math.fround(1e38))).toBe(true);
  // Small world scale keeps the derived world error finite; the lattice extent alone overflows.
  expect(staticPack(source, 0, 0.01)).toMatchObject({ ok: false });
});

it('rejects derived world-error overflow with representable spacing and extent', () => {
  const source = changed(cube.spacing, 1e38);
  expect(validateMeshDistanceField(source).ok).toBe(true);
  expect(
    Number.isFinite(Math.fround(source.origin[0] + (source.dimensions[0] - 1) * source.spacing)),
  ).toBe(true);
  expect(Number.isFinite(Math.fround(1e38))).toBe(true);
  expect(staticPack(source)).toMatchObject({ ok: false });
});

it('rejects positive spacing that rounds to zero in the GPU row', () => {
  const source = {
    ...changed(1e-46, 1),
    origin: [0, 0, 0] as const,
    bounds: { min: [0, 0, 0] as const, max: [1e-46, 1e-46, 1e-46] as const },
  };
  expect(validateMeshDistanceField(source).ok).toBe(true);
  expect(Math.fround(source.spacing)).toBe(0);
  expect(staticPack(source)).toMatchObject({ ok: false });
});

it.each([
  0, 1e-40, -1e-40,
])('retains the admitted finite row with translation %s', (translation) => {
  const packed = staticPack(cube, translation).unwrap();
  const view = new DataView(packed.instances.buffer);
  if (translation === 0) expect(Math.abs(view.getFloat32(48, true))).toBe(0);
  else expect(view.getFloat32(48, true)).toBe(Math.fround(-translation));
  expect(view.getFloat32(108, true)).toBeGreaterThan(0);
  for (let word = 24; word < 36; word++)
    expect(Number.isFinite(view.getFloat32(word * 4, true))).toBe(true);
});
