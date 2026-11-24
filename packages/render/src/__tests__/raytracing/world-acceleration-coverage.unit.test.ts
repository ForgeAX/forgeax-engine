import { writeFileSync } from 'node:fs';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  WorldAccelerationGeometryIds,
  worldAccelerationRoster,
} from '../../raytracing/renderer-world-acceleration';
import {
  deriveSdfSurfaceCoverage,
  type SdfSurfaceCoverage,
} from '../../raytracing/sdf-surface-coverage';
import { createWorldAcceleration } from '../../raytracing/world-acceleration';
import { createWorldAccelerationCoverage } from '../../raytracing/world-acceleration-coverage';
import { worldAccelerationCoverageWgsl } from './world-acceleration-coverage.fixture';

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mesh = {
  attributes: { position: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]) },
  indices: new Uint32Array([0, 1, 2]),
  submeshes: [{ topology: 'triangle-list', indexOffset: 0, indexCount: 3, vertexCount: 3 }],
};

function roster(
  coverages: readonly SdfSurfaceCoverage[],
  ids = new WorldAccelerationGeometryIds(),
) {
  return worldAccelerationRoster(
    {
      sources: coverages.map((_, firstInstance) => ({
        mesh,
        assetRevision: 7,
        firstInstance,
      })) as never,
      instances: coverages.map((surfaceCoverage, instanceId) => ({
        instanceId,
        geometryId: -1,
        mask: 255,
        transform,
        surfaceCoverage,
      })),
    },
    ids,
  );
}

describe('hardware World placement coverage', () => {
  it('exports the actual query for native Naga validation without a Web WGSL-writer roundtrip', () => {
    const output = process.env.FORGEAX_WORLD_COVERAGE_WGSL;
    if (output) writeFileSync(output, worldAccelerationCoverageWgsl());
    expect(worldAccelerationCoverageWgsl().includes('rayQueryGetCandidateIntersection')).toBe(true);
  });
  it('retains different effective coverage for two placements of the same whole Mesh', () => {
    const actual = roster(['opaque', 'unknown']);
    expect(actual.geometries).toHaveLength(1);
    expect(actual.instances[0]?.geometryId).toBe(actual.instances[1]?.geometryId);
    expect(actual.instances.map((instance) => instance.surfaceCoverage)).toEqual([
      'opaque',
      'unknown',
    ]);
    for (const geometry of actual.geometries) expect(geometry.indices).toBe(mesh.indices);
  });

  it('changes qualification on the same Mesh and material handle cutoff 0 -> .5 -> 0', () => {
    const ids = new WorldAccelerationGeometryIds();
    const states = [0, 0.5, 0].map((alphaCutoff) => {
      const coverage = deriveSdfSurfaceCoverage(
        mesh as never,
        [{ alphaCoverageOmitted: alphaCutoff > 0 }],
        1,
      ).unwrap();
      return roster([coverage], ids);
    });
    expect(states.map((state) => state.instances[0]?.surfaceCoverage)).toEqual([
      'opaque',
      'unknown',
      'opaque',
    ]);
    expect(states[0]?.instances[0]?.geometryId).toBe(states[2]?.instances[0]?.geometryId);
    expect(states[0]?.instances[0]?.geometryId).toBe(states[1]?.instances[0]?.geometryId);
  });

  it('snapshots partial primitive coverage without changing the full original index order', () => {
    const bits = new Uint32Array([1]);
    const actual = roster([{ kind: 'partial', opaquePrimitives: bits }]);
    bits[0] = 0;
    expect(actual.instances[0]?.surfaceCoverage).toBe('opaque');
    expect(actual.geometries[0]?.indices).toBe(mesh.indices);
  });

  it('does not admit a corrupt partial tail as an opaque hardware geometry', () => {
    const actual = roster([{ kind: 'partial', opaquePrimitives: new Uint32Array([2]) }]);
    expect(actual.geometries).toHaveLength(0);
    expect(actual.instances[0]?.geometryId).toBe(-1);
  });
});

describe('bounded placement bitmap ownership', () => {
  it('shares one immutable payload for 1024 same-Mesh same-pattern placements', () => {
    const table = new Uint32Array(12);
    const owner = createWorldAccelerationCoverage(table, 4, 8);
    const bits = new Uint32Array([1, 0]);
    const entries = Array.from({ length: 1024 }, () =>
      owner
        .acquire(7, 64, {
          kind: 'partial',
          opaquePrimitives: bits,
        })
        .unwrap(),
    );
    bits[0] = 0;
    expect(owner.words).toBe(2);
    expect(new Set(entries.map((entry) => entry.firstWord)).size).toBe(1);
    expect(Array.from(table.subarray(4, 6))).toEqual([1, 0]);
    expect(owner.pending().map((payload) => payload.data.byteLength)).toEqual([8]);
    owner.committed();
    const other = owner
      .acquire(7, 64, { kind: 'partial', opaquePrimitives: new Uint32Array([2, 0]) })
      .unwrap();
    expect(other.firstWord).not.toBe(entries[0]?.firstWord);
    expect(owner.words).toBe(4);
    for (const entry of entries) owner.release(entry);
    expect(owner.words).toBe(2);
    owner.release(other);
    expect(owner.words).toBe(0);
  });

  it('fails closed at its actual word capacity and reuses released space', () => {
    const owner = createWorldAccelerationCoverage(new Uint32Array(6), 4, 2);
    const a = owner
      .acquire(1, 64, { kind: 'partial', opaquePrimitives: new Uint32Array([1, 0]) })
      .unwrap();
    expect(
      owner.acquire(1, 64, { kind: 'partial', opaquePrimitives: new Uint32Array([2, 0]) }).ok,
    ).toBe(false);
    expect(owner.words).toBe(2);
    owner.release(a);
    expect(
      owner.acquire(1, 64, { kind: 'partial', opaquePrimitives: new Uint32Array([2, 0]) }).unwrap()
        .firstWord,
    ).toBe(4);
  });

  it('keeps one non-opaque BLAS while placement qualification changes, without repeated bitmap upload', async () => {
    const device = (
      await new RhiNullAdapter({
        rayQuery: {
          maxBlasGeometryCount: 4,
          maxBlasPrimitiveCount: 128,
          maxTlasInstanceCount: 2048,
          maxAccelerationStructuresPerShaderStage: 1,
        },
      }).requestDevice()
    ).unwrap();
    const blasDescriptors: unknown[] = [];
    const create = device.createBlas.bind(device);
    device.createBlas = (descriptor) => {
      blasDescriptors.push(descriptor);
      return create(descriptor);
    };
    const world = createWorldAcceleration(device, {
      maxInstances: 1024,
      maxTriangles: 64,
      maxBlasBuildsPerFrame: 1,
    }).unwrap();
    const geometry = {
      geometryId: 7,
      positions: mesh.attributes.position,
      indices: Uint32Array.from({ length: 64 * 3 }, (_, i) => i % 3),
    };
    const bits = new Uint32Array([1, 0]);
    for (let id = 0; id < 1024; id++)
      world
        .set(
          {
            instanceId: id,
            geometryId: 7,
            mask: 255,
            transform,
            surfaceCoverage: { kind: 'partial', opaquePrimitives: bits },
          },
          geometry,
        )
        .unwrap();
    bits[0] = 0;
    const frame = () => world.update(device.createCommandEncoder({}).unwrap()).unwrap();
    expect(frame()).toMatchObject({ blasBuilt: 1, tlasBuilt: 1, coverageBytesUploaded: 8 });
    expect(world.coverageWords).toBe(2);
    expect(blasDescriptors).toMatchObject([{ geometries: [{ opaque: false }] }]);
    expect(
      world.setCoverages([
        { index: 0, surfaceCoverage: 'opaque' },
        { index: 1, surfaceCoverage: { kind: 'partial', opaquePrimitives: new Uint32Array([1]) } },
      ]).ok,
    ).toBe(false);
    expect(frame()).toMatchObject({ rowsWritten: 0, coverageBytesUploaded: 0 });
    expect(world.coverageWords).toBe(2);
    world.setCoverage(0, { kind: 'partial', opaquePrimitives: new Uint32Array([1, 0]) }).unwrap();
    expect(frame()).toMatchObject({
      blasBuilt: 0,
      tlasBuilt: 0,
      rowsWritten: 0,
      coverageBytesUploaded: 0,
    });
    for (const surfaceCoverage of ['opaque', 'unknown', 'opaque'] as const) {
      world.setCoverage(0, surfaceCoverage).unwrap();
      expect(frame()).toMatchObject({ blasBuilt: 0, tlasBuilt: 0, coverageBytesUploaded: 0 });
    }
    world.move(1, transform).unwrap();
    expect(frame()).toMatchObject({ blasBuilt: 0, tlasBuilt: 1, coverageBytesUploaded: 0 });
    expect(blasDescriptors).toHaveLength(1);
    world.dispose();
  });
});
