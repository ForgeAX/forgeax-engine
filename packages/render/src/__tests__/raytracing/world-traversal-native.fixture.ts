import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { rebuildCardOwnerIndex } from '../../raytracing/card-owner-index';
import { packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { sceneFieldSourceEpoch } from '../../raytracing/scene-field-projection';

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  return value as Record<string, unknown>;
}

function array(value: unknown, length: number): unknown[] {
  assert(Array.isArray(value));
  assert.equal(value.length, length);
  return value;
}

function uint(value: unknown, maximum = 0xffff_ffff): number {
  assert(typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum);
  return value;
}

function floats(value: unknown, length: number): number[] {
  const buffer = new ArrayBuffer(length * 4);
  const view = new DataView(buffer);
  return array(value, length).map((word, index) => {
    view.setUint32(index * 4, uint(word), true);
    const number = view.getFloat32(index * 4, true);
    assert(Number.isFinite(number), 'Original source must contain finite f32 values');
    return number;
  });
}

function rows(value: unknown) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= 1024);
  return value.map((entry) => {
    const row = object(entry);
    const instanceId = uint(row.id);
    assert(instanceId > 0);
    floats(row.originalInverseF32Bits, 16);
    floats(row.originalAxisScalesF32Bits, 3);
    return {
      instanceId,
      geometryId: uint(row.geometryId),
      mask: uint(row.mask, 255),
      transform: floats(row.transformF32Bits, 16),
      surfaceCoverage: 'opaque' as const,
    };
  });
}

/** Rust owns authored inputs; these are the ordinary production cook/pack functions. */
export async function prepareNativeWorldParity(value: unknown) {
  const source = object(value);
  assert.equal(source.format, 'native-world-parity-inputs/2');
  assert.equal(source.floatEncoding, 'f32-to-bits-u32');
  const positions = new Float32Array(
    array(source.verticesF32Bits, 8).flatMap((vertex) => floats(vertex, 3)),
  );
  const indices = new Uint32Array(array(source.indices, 36).map((index) => uint(index, 7)));
  const sampling = object(source.originalDenseSampling);
  const voxelSize = floats([sampling.spacingF32Bits], 1)[0];
  assert(voxelSize !== undefined && voxelSize > 0);
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const originSpacing = floats(source.gridOriginSpacingF32Bits, 4);
  const ranges = floats(source.gridRangesF32Bits, 4);
  const dimensions = array(source.gridDimensions, 3).map((dimension) => uint(dimension, 128));
  const [x, y, z, spacing] = originSpacing;
  const [dx, dy, dz] = dimensions;
  const [maxDistance, coverageDistance] = ranges;
  assert(x !== undefined && y !== undefined && z !== undefined && spacing !== undefined);
  assert(dx && dy && dz && maxDistance !== undefined && coverageDistance !== undefined);
  const expectedNames = ['furnished', 'partitioned-visible', 'partitioned-masked'];
  const coordinates = [0, 1, 2].map((axis) =>
    Array.from(positions).filter((_, index) => index % 3 === axis),
  );
  const bounds = {
    min: coordinates.map((axis) => Math.min(...axis)) as [number, number, number],
    max: coordinates.map((axis) => Math.max(...axis)) as [number, number, number],
  };
  const pack = (value: unknown, headerOnly = false) => {
    const instances = rows(value).map((row) => ({
      ...row,
      surfaceCoverage: headerOnly ? ('unavailable' as const) : ('opaque' as const),
      field: headerOnly ? { missing: true as const, bounds } : field,
    }));
    return packGlobalSdfComposition(
      instances,
      { origin: [x, y, z], dimensions: [dx, dy, dz], spacing, maxDistance, coverageDistance },
      { capacity: instances.length, index: false, sourceEpoch: sceneFieldSourceEpoch(0).unwrap() },
    ).unwrap();
  };
  const scenes = array(source.scenes, 3).map((entry, index) => {
    const scene = object(entry);
    assert.equal(scene.name, expectedNames[index]);
    const packed = pack(scene.instances);
    const instanceIds = new Set(rows(scene.instances).map((row) => row.instanceId));
    const cardOwners = array(scene.cardOwners, packed.sources.length * 6).map((owner) => {
      const id = uint(owner, 0xffff_fffe);
      assert(instanceIds.has(id), 'Authored Card owner must belong to the same scene');
      return id;
    });
    // Rust authors the physical Card order. Only the production owner builds
    // the search directory and links; native code never recreates that index.
    const projection = new Uint8Array(cardOwners.length * 80);
    const projectionView = new DataView(projection.buffer);
    cardOwners.forEach((owner, card) => {
      projectionView.setUint32(card * 80 + 64, owner, true);
    });
    rebuildCardOwnerIndex(projection, cardOwners.length);
    const cardOwnerIndex = new Uint8Array(cardOwners.length * 8);
    for (let card = 0; card < cardOwners.length; card++)
      cardOwnerIndex.set(projection.subarray(card * 80 + 72, card * 80 + 80), card * 8);
    const { data } = packed;
    assert(
      packed.sourceExpected,
      'The admitted production source must publish its independent tuple',
    );
    assert(data.voxels.every((byte) => byte === 0));
    return {
      name: expectedNames[index],
      instanceCount: array(scene.instances, packed.sources.length).length,
      instances: Array.from(data.instances),
      fields: Array.from(data.fields),
      bounds: Array.from(data.bounds),
      settings: Array.from(data.settings),
      sourceExpected: Array.from(packed.sourceExpected),
      cardOwners,
      cardOwnerIndex: Array.from(cardOwnerIndex),
      digests: Object.fromEntries(
        ['instances', 'fields', 'bounds', 'settings', 'cardOwnerIndex'].map((name) => {
          if (name === 'cardOwnerIndex')
            return [name, createHash('sha256').update(cardOwnerIndex).digest('hex')];
          const bytes = data[name as 'instances' | 'fields' | 'bounds' | 'settings'];
          return [name, createHash('sha256').update(bytes).digest('hex')];
        }),
      ),
      // Preserve the builder's zero-initialized voxel allocation without copying
      // three multi-megabyte arrays of zeroes into a JSON transport.
      voxelBytes: data.voxels.byteLength,
    };
  });
  const controls = array(source.headerControl, 2);
  const one = pack(controls.slice(0, 1), true).data.bounds;
  const two = pack(controls, true).data.bounds;
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  return {
    format: 'native-world-parity-canonical/3',
    source,
    scenes,
    headerControl: {
      one: Array.from(one),
      two: Array.from(two),
      oneSha256: digest(one),
      twoSha256: digest(two),
    },
  };
}
