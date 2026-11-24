import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  type MeshDistanceField,
} from '@forgeax/engine-geometry';
import { assert, expect, it, vi } from 'vitest';
import { SdfFieldUpload } from '../../raytracing/sdf-field-storage';
import {
  packSdfScene,
  packSdfSceneWithStaticFields,
  type SdfMeshInstance,
  type SdfSceneFieldPayload,
} from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

const ROW_BYTES = 144;
// Independent layout: four scene words, twenty header words and four coverage words per slot.
const SCENE_WORDS = 4;
const ROW_WORDS = 20;
const COVERAGE_WORDS = 4;
const CAPACITY = 3;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const moved = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 4, -2, 8, 1];

async function makeField(codec: 'sampled' | 'geometric'): Promise<MeshDistanceField> {
  if (codec === 'sampled') {
    return (
      await buildVisibilityDistanceField(sdfCubePositions, sdfCubeIndices, {
        voxelSize: 1,
        triangleSidedness: Array.from({ length: sdfCubeIndices.length / 3 }, () => 0),
      })
    ).unwrap();
  }
  const field = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  expect(field.policy.kind).toBe('signed-solid');
  return field;
}

function payloadFor(uploads: readonly SdfFieldUpload[]): SdfSceneFieldPayload {
  const offsets = new Map<SdfFieldUpload, number>();
  let wordLength = 0;
  for (const upload of uploads) {
    assert(!offsets.has(upload));
    offsets.set(upload, wordLength);
    wordLength += upload.length;
  }
  const initialization = Object.freeze({
    version: 'sdf-layout-integration-static/1',
    byteLength: wordLength * 4,
    copyInto(target: Uint8Array): boolean {
      if (target.byteLength !== wordLength * 4 || target.byteOffset % 4 !== 0) return false;
      const words = new Uint32Array(target.buffer, target.byteOffset, wordLength);
      for (const upload of uploads) {
        const offset = offsets.get(upload);
        if (offset === undefined) return false;
        upload.copyInto(words, offset);
      }
      return true;
    },
  });
  return { uploads, offsets, wordLength, initialization };
}

function words(bytes: Uint8Array) {
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function requireCommonRows(
  raw: Uint8Array,
  retained: Uint8Array,
  source: readonly SdfMeshInstance[],
) {
  const a = words(raw),
    b = words(retained);
  expect(raw.byteLength).toBe(CAPACITY * ROW_BYTES);
  expect(retained.byteLength).toBe(source.length * ROW_BYTES);
  for (const [row, instance] of source.entries()) {
    assert(!('missing' in instance.field));
    const at = row * 36;
    for (let word = 0; word < 36; word++) {
      if (word !== 20 && word !== 35) expect(b[at + word]).toBe(a[at + word]);
    }
    expect(Array.from(a.slice(at + 16, at + 20))).toEqual([
      instance.instanceId,
      instance.geometryId,
      0xffffffff,
      instance.mask,
    ]);
    expect(Array.from(a.slice(at + 21, at + 24))).toEqual(instance.field.dimensions);
    const sampled = instance.field.policy.kind === 'sampled-visibility';
    expect(a[at + 20]).toBe(
      sampled
        ? SCENE_WORDS + row * ROW_WORDS
        : SCENE_WORDS + CAPACITY * (ROW_WORDS + COVERAGE_WORDS),
    );
    expect(b[at + 20]).toBe(0);
    // Sample-only mode1 is not a canonical surface row. Geometric mode stays0.
    expect(a[at + 35]).toBe(sampled ? 0x40000000 : 0);
    expect(b[at + 35]).toBe(sampled ? 0x3f800000 : 0);
  }
}

function rawSampleSpan(
  raw: ReturnType<ReturnType<typeof packSdfScene>['unwrap']>,
  field: MeshDistanceField,
  sampleWords: number,
) {
  const view = new DataView(
    raw.instances.buffer,
    raw.instances.byteOffset,
    raw.instances.byteLength,
  );
  let first = view.getUint32(80, true);
  if (field.policy.kind === 'sampled-visibility') {
    const fields = words(raw.fields);
    expect(first).toBe(SCENE_WORDS);
    expect(fields[first + 5]).toBe(sampleWords);
    first = fields[first + 4] ?? 0;
    expect(first).toBe(SCENE_WORDS + CAPACITY * (ROW_WORDS + COVERAGE_WORDS));
  }
  expect(first + sampleWords).toBeLessThanOrEqual(raw.fields.byteLength / 4);
  return raw.fields.subarray(first * 4, (first + sampleWords) * 4);
}

// Independent source brick and packed SNORM address decoding. No production sampler.
function texelAddress(field: MeshDistanceField, index: number) {
  const [nx, ny] = field.dimensions;
  const x = index % nx,
    y = Math.floor(index / nx) % ny,
    z = Math.floor(index / (nx * ny));
  const brick =
    (Math.floor(z / 4) * Math.ceil(ny / 4) + Math.floor(y / 4)) * Math.ceil(nx / 4) +
    Math.floor(x / 4);
  const local = ((z % 4) * 4 + (y % 4)) * 4 + (x % 4);
  const offset = field.bricks[brick];
  assert(offset !== undefined);
  return { brick, local, source: offset + local };
}

function requireDecodedSamples(bytes: Uint8Array, field: MeshDistanceField) {
  const packed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source = new DataView(
    field.values.buffer,
    field.values.byteOffset,
    field.values.byteLength,
  );
  const count = field.dimensions[0] * field.dimensions[1] * field.dimensions[2];
  for (let index = 0; index < count; index++) {
    const address = texelAddress(field, index);
    if (field.policy.kind === 'sampled-visibility') {
      const first = packed.getUint32(address.brick * 4, true);
      const actual = packed.getInt16(first * 4 + address.local * 2, true);
      const value = source.getFloat32(address.source * 4, true);
      const expected =
        Math.max(-32767, Math.min(32767, Math.round((value / field.policy.distanceBand) * 32767))) |
        0;
      expect(actual).toBe(expected);
    } else {
      expect(packed.getUint32(index * 4, true)).toBe(source.getUint32(address.source * 4, true));
    }
  }
}

function requireOrderedUploads(field: MeshDistanceField, upload: SdfFieldUpload) {
  const second = SdfFieldUpload.capture(field).unwrap();
  const source = [upload, second].map((fieldUpload, row) => ({
    instanceId: row + 1,
    geometryId: 3,
    mask: 255,
    transform: identity,
    field,
    fieldUpload,
  }));
  const payload = payloadFor([upload, second]);
  expect(packSdfSceneWithStaticFields(source, 8, payload).ok).toBe(true);
  expect(
    packSdfSceneWithStaticFields(source, 8, {
      ...payload,
      uploads: [second, upload],
    }),
  ).toMatchObject({ ok: false });
}

function requireCanonicalGeometryGate(field: MeshDistanceField) {
  if (field.policy.kind !== 'sampled-visibility') return;
  const invalid = structuredClone(field);
  const surface = invalid.surface;
  assert(surface);
  const upload = SdfFieldUpload.capture(invalid).unwrap();
  const source = {
    instanceId: 17,
    geometryId: 4,
    mask: 255,
    transform: identity,
    field: invalid,
    fieldUpload: upload,
  };
  expect(packSdfScene([source]).ok).toBe(true);
  surface.indices[0] = surface.positions.length / 3;
  // Retained samples still exist, but they cannot qualify corrupted geometry.
  expect(packSdfScene([source])).toMatchObject({ ok: false });
  const retained = packSdfSceneWithStaticFields([source], 8, payloadFor([upload])).unwrap();
  expect(retained).not.toHaveProperty('surface');
}

it.each([
  'sampled',
  'geometric',
] as const)('joins raw and retained %s layouts without copying frame fields', async (codec) => {
  const field = await makeField(codec),
    upload = SdfFieldUpload.capture(field).unwrap();
  const privateWords = new Uint32Array(upload.length);
  upload.copyInto(privateWords, 0);
  const expectedSamples = new Uint8Array(privateWords.buffer);
  const payload = payloadFor([upload]);
  const source = [identity, moved].map((transform, row) => ({
    instanceId: row + 7,
    geometryId: 11,
    mask: 255,
    transform,
    field,
    fieldUpload: upload,
  }));
  const copies = vi.spyOn(SdfFieldUpload.prototype, 'copyInto');
  try {
    const raw = packSdfScene(source, 8, CAPACITY, 9).unwrap();
    expect(copies).toHaveBeenCalledOnce();
    copies.mockClear();
    const first = packSdfSceneWithStaticFields(source, 8, payload).unwrap();
    expect(copies).not.toHaveBeenCalled();
    expect(first.initialization).toBe(payload.initialization);
    expect(first).not.toHaveProperty('fields');
    requireCommonRows(raw.instances, first.instances, source);
    const samples = rawSampleSpan(raw, field, upload.length);
    expect(samples).toEqual(expectedSamples);
    requireDecodedSamples(samples, field);
    const originalRaw = raw.instances.slice(),
      originalRetained = first.instances.slice();
    const nextSource = source.map((row) => ({
      ...row,
      transform: moved.map((value, i) => (i === 12 ? value + 2 : value)),
    }));
    const nextRaw = packSdfScene(nextSource, 8, CAPACITY, 10).unwrap();
    expect(copies).toHaveBeenCalledOnce();
    copies.mockClear();
    const next = packSdfSceneWithStaticFields(nextSource, 8, payload).unwrap();
    expect(copies).not.toHaveBeenCalled();
    expect(next.initialization).toBe(first.initialization);
    expect(next.instances).not.toEqual(first.instances);
    expect(first.instances).toEqual(originalRetained);
    expect(raw.instances).toEqual(originalRaw);
    requireCommonRows(nextRaw.instances, next.instances, nextSource);
    expect(rawSampleSpan(nextRaw, field, upload.length)).toEqual(expectedSamples);
    const initialized = new Uint8Array(payload.initialization.byteLength);
    expect(next.initialization.copyInto(initialized)).toBe(true);
    expect(initialized).toEqual(expectedSamples);
    copies.mockClear();
    requireOrderedUploads(field, upload);
    expect(copies).not.toHaveBeenCalled();
  } finally {
    copies.mockRestore();
  }
  requireCanonicalGeometryGate(field);
});
