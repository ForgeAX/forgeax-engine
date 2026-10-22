import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { samplerContribution } from '../assets/asset-decoders';
import { gpuDrivenMaterialResourceClass } from '../extract/gpu-driven';
import { prepareBatchExecution } from '../gpu-driven/batch-execution';
import { batchVisibleSpan } from '../gpu-driven/batch-layout';
import { BatchSources } from '../gpu-driven/batch-members';
import {
  BatchTopology,
  type GpuDrivenBatch,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { MeshBatchProjection } from '../gpu-driven/mesh-batches';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import type { Node } from '../scene/frame-tree';
import { TreeFrame } from '../scene/frame-tree-list';
import { RenderScene } from '../scene/render-scene';
import { testAssets } from './helpers/runtime-assets';

const receipt = createStandardPbrArtifactReceipt();
interface StaticResourceClassEntry {
  readonly texture: number;
  readonly sampler: number;
  readonly textureAsset: TextureAsset;
  readonly samplerAsset: SamplerAsset;
}
function staticTextureAsset(index: number): TextureAsset {
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
    format: 'rgba8unorm',
    data: new Uint8Array([index & 0xff, 127, 255 - (index & 0xff), 255]),
    colorSpace: 'srgb',
    mips: { kind: 'none' },
  };
}
function staticSamplerAsset(): SamplerAsset {
  return {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  };
}
function staticResourceClassFixture(
  world: World,
  count: number,
): readonly StaticResourceClassEntry[] {
  testAssets(world).installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const samplerAsset = staticSamplerAsset();
  return Array.from({ length: count }, (_, index) => {
    const textureAsset = staticTextureAsset(index);
    return {
      texture: testAssets(world).create(textureAsset).unwrap(),
      sampler: testAssets(world).create(samplerAsset).unwrap(),
      textureAsset,
      samplerAsset,
    };
  });
}
function prepared(overrides: Partial<PreparedGpuDrivenDraw> = {}): PreparedGpuDrivenDraw {
  return {
    identity: { material: 'forgeax::default-standard-pbr', geometry: 'cube', deformation: 'rigid' },
    receiptGeneration: receipt.generation,
    receiptIdentity: receipt.receiptIdentity,
    directEntry: receipt.directEntry,
    sceneIndexEntry: receipt.sceneIndexEntry,
    materialRow: receipt.materialRow,
    resourceSlots: receipt.resourceSlots,
    uvSets: receipt.uvSets,
    vertexInputs: receipt.vertexInputs,
    alphaMask: receipt.alphaMask,

    topology: 'triangle-list',
    indexed: true,
    first: 0,
    count: 36,
    baseVertex: 0,
    ...overrides,
  };
}
const materials = new Map<string, MaterialResource>();
function snapshot(
  entityKey: number,
  drawPrepared: PreparedGpuDrivenDraw,
  material: Partial<MaterialSnapshot> = {},
): RenderableSnapshot {
  const value = {
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: drawPrepared.identity.material,
    passes: [
      {
        name: 'forward',
        program: { module: drawPrepared.identity.material },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    textureHandles: new Map(
      receipt.resourceSlots
        .filter((slot) => slot.kind === 'texture')
        .map((slot, index) => [slot.parameter, index + 1]),
    ) as never,
    samplerHandles: new Map(
      receipt.resourceSlots
        .filter((slot) => slot.kind === 'sampler')
        .map((slot, index) => [slot.parameter, index + 101]),
    ) as never,
    ...material,
  } as MaterialSnapshot;
  const key = JSON.stringify(value, (_key, field) => (field instanceof Map ? [...field] : field));
  const resource = materials.get(key) ?? new MaterialResource(value);
  materials.set(key, resource);
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material: resource,
    materials: [resource],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: drawPrepared.first,
        count: drawPrepared.count,
        baseVertex: drawPrepared.baseVertex,
        materialSlot: 0,
        topology: drawPrepared.topology,
        pipelineClass: 'prepared-standard-pbr',
        materialResourceClass: JSON.stringify({
          textures: drawPrepared.resourceSlots.filter((slot) => slot.kind === 'texture').length,
          samplers: drawPrepared.resourceSlots.filter((slot) => slot.kind === 'sampler').length,
          video: 0,
        }),
        geometry: {
          receipt: {
            identity: `${drawPrepared.identity.geometry}:${JSON.stringify(drawPrepared.vertexInputs)}`,
            vertexInputs: drawPrepared.vertexInputs,
            topology: drawPrepared.topology,
            indexed: drawPrepared.indexed,
          },
          draw: {
            kind: drawPrepared.indexed ? 'indexed' : 'non-indexed',
            first: drawPrepared.first,
            count: drawPrepared.count,
            baseVertex: drawPrepared.baseVertex,
            topology: drawPrepared.topology,
          },
          deformation: drawPrepared.identity.deformation,
        },
      },
    ],
  };
}
function updateSnapshot(value: RenderableSnapshot) {
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    snapshot: value,
  };
}
function updateInstances(value: RenderableSnapshot) {
  if (value.instances === undefined) throw new Error('expected Instances payload');
  return {
    kind: 'update' as const,
    worldId: value.worldId,
    entityKey: value.entityKey,
    instances: value.instances,
  };
}
function withInstances(value: RenderableSnapshot, instanceCount: number): RenderableSnapshot {
  const transforms = new Float32Array(instanceCount * 16);
  for (let index = 0; index < instanceCount; index += 1) {
    const offset = index * 16;
    transforms[offset] = 1;
    transforms[offset + 5] = 1;
    transforms[offset + 10] = 1;
    transforms[offset + 15] = 1;
  }
  return {
    ...value,
    instances: {
      transforms,
      instanceCount,
      cacheKey: value.entityKey,
      archVersion: 0,
      revision: instanceCount,
    },
  };
}
function execution(topology: BatchTopology): SubmissionPlan {
  return topology.query(topology.sourcePlan(), undefined);
}
function topologyFor(...snapshots: readonly RenderableSnapshot[]): BatchTopology {
  const projection = new RenderScene();
  projection.apply(snapshots.map((snapshot) => updateSnapshot(snapshot)));
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  return topology;
}
function resourceClassSnapshot(
  entityKey: number,
  drawPrepared: PreparedGpuDrivenDraw,
  resourceIndex: number,
  resources?: readonly StaticResourceClassEntry[],
): RenderableSnapshot {
  const resource = resources?.[resourceIndex];
  const material = {
    textureHandles: new Map([
      ['baseColorTexture', resource?.texture ?? resourceIndex + 1],
    ]) as never,
    samplerHandles: new Map([
      ['baseColorTexture', resource?.sampler ?? resourceIndex + 1001],
    ]) as never,
  } satisfies Partial<MaterialSnapshot>;
  const value = snapshot(entityKey, drawPrepared, material);
  const draw = value.gpuDrivenDraws?.[0];
  if (draw === undefined) throw new Error('resource-class fixture draw is missing');
  return {
    ...value,
    gpuDrivenDraws: [
      {
        ...draw,
        materialResourceClass: gpuDrivenMaterialResourceClass(value.material.snapshot),
      },
    ],
  };
}
function executionFor(batch: GpuDrivenBatch) {
  const binding = required(batch.binding);
  const material = binding.material.snapshot;
  const shaderId = material.materialShaderId ?? 'forgeax::default-standard-pbr';
  const selectedReceipt = createStandardPbrArtifactReceipt(
    binding.geometry.deformation === 'skin',
    binding.geometry.receipt.vertexInputs.some((input) => input.semantic === 'color'),
  );
  return prepareBatchExecution(
    binding.geometry,
    material,
    {
      kind: 'forward',
      shaderId,
      ...(material.renderState === undefined ? {} : { renderState: material.renderState }),
    },
    () =>
      shaderId === 'game::custom-shader'
        ? undefined
        : {
            material: shaderId,
            pass: 'forward',
            program: createMaterialShaderProgram('synthetic'),
            layoutIdentity: selectedReceipt.reflection.layoutIdentity,
            bindings: [],
            deps: [],
            vertexInputs: selectedReceipt.vertexInputs as unknown as readonly Readonly<
              Record<string, unknown>
            >[],
            receipt: selectedReceipt,
          },
  ).unwrap();
}
describe('PBR prepared GPU-driven batch topology', () => {
  it('splits opposite model winding and rejoins after a transform-only update', () => {
    const projection = new RenderScene();
    const topology = new BatchTopology();
    const a = snapshot(1, prepared());
    const b = snapshot(2, prepared());
    topology.apply(projection.apply([a, b].map(updateSnapshot)));
    expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(1);
    const world = new Float32Array(b.transform.world);
    world[0] = -1;
    world[4] = 0.35;
    const mirrored = projection.apply([{ kind: 'update', worldId: 0, entityKey: 2, world }]);
    expect(mirrored.contentUpdatedSlots).toHaveLength(1);
    topology.apply(mirrored);
    expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(2);
    expect(
      new Set(
        topology
          .query(topology.sourcePlan(), undefined)
          .batches.map((batch) => batch.key.reflected === true),
      ).size,
    ).toBe(2);
    world[12] = 1;
    const translated = projection.apply([{ kind: 'update', worldId: 0, entityKey: 2, world }]);
    expect(translated.contentUpdatedSlots).toHaveLength(0);
    topology.apply(translated);
    expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(2);
    world[0] = 1;
    topology.apply(projection.apply([{ kind: 'update', worldId: 0, entityKey: 2, world }]));
    expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(1);
    expect(a.material.snapshot.renderState).toBeUndefined();
    expect(b.material.snapshot.renderState).toBeUndefined();
  });
  it('preserves surviving ranges across removal, recycling and bounded growth', () => {
    const projection = new RenderScene();
    const values = Array.from({ length: 32 }, (_, i) =>
      snapshot(i + 1, prepared({ first: i * 36 })),
    );
    projection.apply(values.map(updateSnapshot));
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const original = topology.query(topology.sourcePlan(), undefined);
    const remove = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    topology.apply(remove);
    const afterRemoval = topology.query(topology.sourcePlan(), undefined);
    expect([...afterRemoval.batches]).toEqual(original.batches.slice(1));
    topology.apply(projection.apply([updateSnapshot(snapshot(100, prepared({ first: 9999 })))]));
    const recycled = topology.query(topology.sourcePlan(), undefined);
    expect(recycled.batches.at(0)?.visibleBase).toBe(original.batches.at(0)?.visibleBase);
    expect(recycled.batches.at(0)?.indirectOffset).toBe(original.batches.at(0)?.indirectOffset);
    expect(recycled.batches.at(0)?.generation).not.toBe(original.batches.at(0)?.generation);
    const source = values[16];
    if (source === undefined) throw new Error('missing fixture row');
    topology.apply(projection.apply([updateSnapshot(withInstances(source, 63))]));
    const within = topology.query(topology.sourcePlan(), undefined);
    const oldBatch = recycled.batches.find(
      (batch) => batch.key.first === source.gpuDrivenDraws?.[0]?.first,
    );
    const withinBatch = within.batches.find((batch) => batch.batchId === oldBatch?.batchId);
    expect(withinBatch?.visibleBase).toBe(oldBatch?.visibleBase);
    expect(withinBatch?.indirectOffset).toBe(oldBatch?.indirectOffset);
    expect(withinBatch?.visibleCapacity).toBe(63);
    topology.apply(projection.apply([updateSnapshot(withInstances(source, 65))]));
    const grown = topology.query(topology.sourcePlan(), undefined);
    for (const batch of within.batches) {
      const next = grown.batches.find((entry) => entry.batchId === batch.batchId);
      if (batch.batchId !== oldBatch?.batchId) expect(next).toBe(batch);
      else {
        expect(next?.visibleAllocationCapacity).toBe(128);
        expect(next?.indirectOffset).toBe(batch.indirectOffset);
      }
    }
    const sorted = [...grown.batches].sort((a, b) => a.visibleBase - b.visibleBase);
    sorted.forEach((batch, index) => {
      const next = sorted[index + 1];
      if (next !== undefined)
        expect(batch.visibleBase + batchVisibleSpan(batch)).toBeLessThanOrEqual(next.visibleBase);
    });
    expect(original.batches.at(0)?.candidates).toHaveLength(1);
  });
  it('retains sparse ranges and shrinks only the changed LOD window without mutating retained plans', () => {
    const projection = new RenderScene();
    const values = Array.from({ length: 64 }, (_, i) =>
      snapshot(i + 1, prepared({ first: i * 36 })),
    );
    projection.apply(values.map(updateSnapshot));
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.query(topology.sourcePlan(), undefined);
    topology.apply(
      projection.apply(
        values
          .slice(0, 63)
          .map((value) => ({ kind: 'remove' as const, worldId: 0, entityKey: value.entityKey })),
      ),
    );
    const compact = topology.query(topology.sourcePlan(), undefined);
    expect(compact.visibleCapacity).toBe(4096);
    expect(compact.batches.at(0)?.indirectOffset).toBe(before.batches.at(63)?.indirectOffset);
    expect(topology.inspect().windowCompactions).toBe(0);
    expect(before.batches.at(63)?.visibleBase).toBe(63 * 64);
    const source = values[63];
    if (source === undefined) throw new Error('missing fixture row');
    const lod = {
      ...source,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.25 }],
    };
    topology.apply(projection.apply([updateSnapshot(withInstances(lod, 1024))]));
    const large = topology.query(topology.sourcePlan(), undefined);
    expect(batchVisibleSpan(required(large.batches.at(0)))).toBe(2048);
    topology.apply(projection.apply([updateSnapshot(withInstances(lod, 1))]));
    const small = topology.query(topology.sourcePlan(), undefined);
    expect(batchVisibleSpan(required(small.batches.at(0)))).toBe(128);
    expect(small.batches.at(0)?.indirectOffset).toBe(0);
    expect(topology.inspect().windowCompactions).toBe(0);
  });
  it('keeps deferred and forward-only material identities in shared geometry bindings', () => {
    const plan = execution(
      topologyFor(
        snapshot(1, prepared(), { deferredPass: true }),
        snapshot(2, prepared(), { deferredPass: false }),
      ),
    );
    expect(plan.batches).toHaveLength(2);
    expect(
      plan.batches
        .map((batch) => executionFor(batch))
        .map((execution) => execution.route === 'gpu' && execution.material.deferredPass),
    ).toEqual([true, false]);
  });
  it('admits alpha hash through shared material execution', () => {
    const plan = execution(
      topologyFor(
        snapshot(1, prepared()),
        snapshot(2, prepared(), { paramSnapshot: { alphaHash: 1 } }),
      ),
    );
    const selected = executionFor(required(plan.batches.at(1)));
    expect(selected.route).toBe('gpu');
    if (selected.route === 'gpu') {
      expect(selected.material.paramSnapshot?.alphaHash).toBe(1);
      expect(selected.prepared.alphaMask).toEqual(receipt.alphaMask);
    }
  });
  it('shares source geometry while opaque and Alpha Mask keep separate accepted materials', () => {
    const plan = execution(
      topologyFor(
        snapshot(1, prepared()),
        snapshot(2, prepared(), { paramSnapshot: { alphaCutoff: 0.5 } }),
      ),
    );
    expect(plan.candidateCount).toBe(2);
    expect(plan.batches).toHaveLength(2);
    const mask = executionFor(required(plan.batches.at(1)));
    expect(mask.route).toBe('gpu');
    if (mask.route === 'gpu') {
      expect(mask.material.paramSnapshot?.alphaCutoff).toBe(0.5);
      expect(mask.prepared.identity.material).toBe('forgeax::default-standard-pbr');
    }
  });
  it('keeps colored and uncolored ABI variants in separate prepared batches', () => {
    const coloredReceipt = createStandardPbrArtifactReceipt(false, true);
    const colored = prepared({
      receiptIdentity: coloredReceipt.receiptIdentity,
      vertexInputs: coloredReceipt.vertexInputs,
    });
    const topology = topologyFor(snapshot(1, prepared()), snapshot(2, colored));
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(2);
    expect(topology.query(topology.sourcePlan(), undefined).batches).toHaveLength(2);
    expect(
      new Set(
        topology
          .query(topology.sourcePlan(), undefined)
          .batches.map((batch) => batch.binding?.geometry.receipt.vertexInputs.length),
      ),
    ).toEqual(new Set([receipt.vertexInputs.length, coloredReceipt.vertexInputs.length]));
    expect(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.map((batch) => executionFor(batch).route),
    ).toEqual(['gpu', 'gpu']);
  });
  it('keeps numeric edits in place and patches only resource identity changes', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1, prepared()))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const stableRevision = topology.inspect().revision;
    const numeric = projection.apply([
      {
        kind: 'update',
        worldId: 0,
        entityKey: 1,
        world: snapshot(1, prepared()).transform.world,
      },
    ]);
    expect(topology.apply(numeric)).toBe(false);
    expect(topology.inspect().revision).toBe(stableRevision);
    const resourceChanged = projection.apply([
      {
        ...updateSnapshot(
          snapshot(1, prepared(), { textureHandles: new Map([['baseColorTexture', 99 as never]]) }),
        ),
      },
    ]);
    expect(topology.apply(resourceChanged)).toBe(true);
    expect(topology.inspect().patches).toBe(1);
    expect(topology.inspect().candidateCount).toBe(1);
  });
  it('patches one resource candidate while retaining unrelated batch membership', () => {
    const projection = new RenderScene();
    const first = resourceClassSnapshot(1, prepared(), 0);
    const second = resourceClassSnapshot(2, prepared(), 0);
    const control = resourceClassSnapshot(3, prepared(), 1);
    projection.apply([updateSnapshot(first), updateSnapshot(second), updateSnapshot(control)]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.query(topology.sourcePlan(), undefined);
    const changed = resourceClassSnapshot(2, prepared(), 2);
    const delta = projection.apply([updateSnapshot(changed)]);
    expect(topology.apply(delta)).toBe(true);
    const after = topology.query(topology.sourcePlan(), undefined);
    expect(after.candidateCount).toBe(before.candidateCount);
    expect(topology.inspect()).toMatchObject({ revision: 2, patches: 1, rebuilds: 1 });
    expect(after.batches).toHaveLength(3);
    const beforeIdentities = before.batches.map((batch) => batch.key.materialResourceClass);
    for (const identity of beforeIdentities) {
      expect(
        after.batches.find((batch) => batch.key.materialResourceClass === identity)?.candidates,
      ).toHaveLength(1);
    }
  });
  it('keeps material fallback in execution and excludes morph geometry from indirect membership', () => {
    const blend = snapshot(2, prepared(), {
      transparent: true,
      renderState: { blend: { color: {}, alpha: {} } },
    });
    const morph = { ...snapshot(3, prepared()), morph: {} as never };
    const custom = snapshot(4, prepared(), { materialShaderId: 'game::custom-shader' });
    const topology = topologyFor(snapshot(1, prepared()), blend, morph, custom);
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(3);
    expect(topology.inspect().ineligible).toBe(1);
    expect(
      topology
        .query(topology.sourcePlan(), undefined)
        .batches.map((batch) => executionFor(batch).route),
    ).toEqual(['gpu', 'direct', 'direct']);
  });
  it('keeps stencil-authored material execution on the direct reference path', () => {
    const plan = execution(
      topologyFor(
        snapshot(1, prepared()),
        snapshot(2, prepared(), {
          renderState: {
            stencil: { compare: 'always', passOp: 'replace' },
            stencilWriteMask: 0xff,
          },
        }),
      ),
    );
    expect(plan.candidateCount).toBe(2);
    expect(plan.batches.map((batch) => executionFor(batch).route)).toEqual(['gpu', 'direct']);
  });
  it('keeps source submesh identity independently of material execution eligibility', () => {
    const source = snapshot(1, prepared());
    const first = required(source.gpuDrivenDraws?.[0]);
    const custom = snapshot(2, prepared(), { materialShaderId: 'game::custom-shader' }).material;
    const plan = execution(
      topologyFor({
        ...source,
        materials: [custom, source.material],
        gpuDrivenDraws: [
          { ...first, drawItemIndex: 10, materialSlot: 0 },
          {
            ...first,
            drawItemIndex: 20,
            first: 12,
            materialSlot: 1,
            geometry: { ...first.geometry, draw: { ...first.geometry.draw, first: 12 } },
          },
        ],
      }),
    );
    expect(plan.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([10, 20]);
    expect(plan.batches.map((batch) => executionFor(batch).route)).toEqual(['direct', 'gpu']);
    expect(plan.batches.at(1)?.binding?.geometry.draw.first).toBe(12);
    expect(plan.batches.at(0)?.candidates).toBe(plan.batches.at(1)?.candidates);
  });
  it('moves members to the batch of their new LOD chain when the chain changes', () => {
    const initial = {
      ...snapshot(1, prepared()),
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.5 }],
      lodHysteresis: 0.08,
      instances: {
        transforms: new Float32Array([
          ...new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
          ...new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        ]),
        instanceCount: 2,
        cacheKey: 1,
        archVersion: 1,
      },
    };
    const projection = new RenderScene();
    projection.apply([updateSnapshot(initial)]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.query(topology.sourcePlan(), undefined);
    const allocationsBefore = topology.inspect().membershipAllocations ?? 0;
    const batchBefore = before.batches.at(0);
    expect(batchBefore).toBeDefined();
    if (batchBefore === undefined) return;
    const updated = projection.apply([
      {
        ...updateSnapshot({
          ...initial,
          lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.25 }],
          lodHysteresis: 0.2,
        }),
      },
    ]);
    // A batch shares one LOD chain across members, so the chain is part of
    // membership: an authored chain edit regroups instead of patching content.
    expect(topology.apply(updated)).toBe(true);
    const after = topology.query(topology.sourcePlan(), undefined);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.batches).toHaveLength(1);
    expect(after.batches.at(0)?.candidates).toHaveLength(2);
    expect(after.batches.at(0)?.lod?.coverages).toEqual([1, 0.25]);
    expect(after.batches.at(0)?.lod?.hysteresis).toBe(0.2);
    expect(topology.inspect()).toMatchObject({ contentPatches: 0, patches: 1 });
    expect(topology.inspect().membershipAllocations ?? 0).toBeGreaterThan(allocationsBefore);
  });
  it('adopts shared numeric values without changing geometry membership or retained material snapshots', () => {
    const source = snapshot(1, prepared(), { materialHandle: 2000 });
    const topology = topologyFor(source);
    const before = topology.query(topology.sourcePlan(), undefined);
    const material = source.material;
    const accepted = material.snapshot;
    material.adopt({ ...accepted, baseColor: vec3.create(0.5, 1, 1) });
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(before);
    expect(topology.query(topology.sourcePlan(), undefined).batches.at(0)?.binding?.material).toBe(
      material,
    );
    expect(material.snapshot.baseColor[0]).toBe(0.5);
    expect(accepted.baseColor[0]).toBe(1);
    expect(topology.inspect().contentPatches).toBe(0);
  });
  it.each([
    { materialHandle: 73 },
    { standardTextureMask: 8 },
    { paramSnapshot: { transmission: 0.5 } },
  ])('reprepares a stable batch when admission or binding facts change: %j', (material) => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1, prepared()))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.query(topology.sourcePlan(), undefined).batches.at(0);
    if (before === undefined) throw new Error('expected a prepared batch');
    const edited = projection.apply([updateSnapshot(snapshot(1, prepared(), material))]);
    expect(topology.apply(edited)).toBe(true);
    expect(
      topology.query(topology.sourcePlan(), undefined).batches.at(0)?.binding?.material.snapshot,
    ).toMatchObject(material);
    expect(before.binding?.material.snapshot).not.toMatchObject(material);
  });
  it('admits static Skin membership without a palette address or bind-pose bound', () => {
    const draw = prepared({ identity: { ...prepared().identity, deformation: 'skin' } });
    const { localAabb: _bounds, ...base } = snapshot(1, draw);
    const source = { ...base, skinBinding: { skeleton: 1, joints: [2] } };
    const projection = new RenderScene();
    projection.apply([updateSnapshot(source)]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(1);
    expect(topology.inspect().ineligible).toBe(0);
  });
  it('updates candidate membership for Instances count transitions', () => {
    const projection = new RenderScene();
    const initial = withInstances(snapshot(1, prepared()), 1);
    projection.apply([updateSnapshot(initial)]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(1);
    const sameCount = projection.apply([updateInstances(withInstances(initial, 1))]);
    expect(sameCount.instanceUpdatedSlots).toHaveLength(1);
    expect(topology.apply(sameCount)).toBe(false);
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(1);
    const expanded = projection.apply([updateInstances(withInstances(initial, 3))]);
    expect(topology.apply(expanded)).toBe(true);
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(3);
    const empty = projection.apply([updateInstances(withInstances(initial, 0))]);
    expect(topology.apply(empty)).toBe(true);
    expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(0);
    expect(topology.inspect().ineligible).toBe(1);
  });
  it.each([
    1, 16, 256,
  ])('keeps 100k prepared PBR candidates in %i resource-identity batches', (resourceClassCount) => {
    const world = new World();
    const resources = staticResourceClassFixture(world, resourceClassCount);
    for (const resource of resources) {
      expect(testAssets(world).read(resource.texture as never)).toMatchObject({
        ok: true,
        value: { kind: 'texture', shape: { viewDimension: '2d' } },
      });
      expect(testAssets(world).read(resource.sampler as never)).toMatchObject({
        ok: true,
        value: { kind: 'sampler' },
      });
    }
    // Shared author facts are prepared once per resource class; every entity
    // still traverses the real scene admission and topology construction.
    const templates = resources.map((_, index) =>
      resourceClassSnapshot(0, prepared(), index, resources),
    );
    const candidates = Array.from({ length: 100000 }, (_, entityKey) => ({
      ...required(templates[entityKey % resourceClassCount]),
      entityKey,
    }));
    const topology = topologyFor(...candidates);
    const plan = topology.query(topology.sourcePlan(), undefined);
    const inspection = topology.inspect();
    const resourceIdentities = new Set(
      plan.batches.map((batch) => batch.key.materialResourceClass),
    );
    expect(plan.candidateCount).toBe(100000);
    expect(plan.batches).toHaveLength(resourceClassCount);
    expect(plan.batches.reduce((total, batch) => total + batch.candidates.length, 0)).toBe(100000);
    expect(inspection).toMatchObject({
      candidateCount: 100000,
      batchCount: resourceClassCount,
      ineligible: 0,
    });
    expect(resourceIdentities).toHaveLength(resourceClassCount);
    expect(topology.query(topology.sourcePlan(), undefined)).toBe(plan);
    expect(topology.inspect().revision).toBe(1);
  }, 30000);
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing required fixture value');
  return value;
}
it('looks up an instanced batch once per draw while preserving candidate order and epochs', () => {
  const projection = new RenderScene();
  projection.reset([withInstances(snapshot(100, prepared()), 1024)]);
  const topology = new BatchTopology();
  const original = Map.prototype.get;
  const get = vi.spyOn(Map.prototype, 'get');
  let lookups = 0;
  get.mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
    if (typeof key === 'string' && key.startsWith('{"drawItemIndex":')) lookups++;
    return original.call(this, key);
  });
  try {
    topology.rebuild(projection.slotsSnapshot());
  } finally {
    get.mockRestore();
  }
  expect(lookups).toBe(1);
  const plan = topology.query(topology.sourcePlan(), undefined);
  expect(plan.candidateCount).toBe(1024);
  expect(plan.batches.at(0)?.contentEpoch).toBe(1023);
  expect(plan.batches.at(0)?.candidates.map((row) => row.instanceOrdinal)).toEqual(
    Array.from({ length: 1024 }, (_, i) => i),
  );
  topology.apply(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 100 }]));
  expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(0);
});
it.each([
  1000, 10000,
])('publishes one removed member without enumerating %i unrelated batch groups', (count) => {
  const projection = new RenderScene();
  projection.reset(
    Array.from({ length: count }, (_, index) =>
      snapshot(index + 1, prepared({ first: index * 36 })),
    ),
  );
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const before = topology.query(topology.sourcePlan(), undefined);
  const removed = Math.floor(count / 2) + 1;
  const delta = projection.apply([{ kind: 'remove', worldId: 0, entityKey: removed }]);
  const groups = (
    topology as unknown as {
      batches: Map<unknown, unknown>;
    }
  ).batches;
  const values = vi.spyOn(groups, 'values').mockImplementation(() => {
    throw new Error('global batch enumeration');
  });
  try {
    topology.apply(delta);
    const after = topology.query(topology.sourcePlan(), undefined);
    expect(after.candidateCount).toBe(count - 1);
    expect(after.batches.length).toBe(count - 1);
    expect(before.candidateCount).toBe(count);
  } finally {
    values.mockRestore();
  }
});
it.each([1000, 10000])('removes one member without copying the other %i group members', (count) => {
  const projection = new RenderScene();
  projection.reset(Array.from({ length: count }, (_, index) => snapshot(index + 1, prepared())));
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const before = topology.query(topology.sourcePlan(), undefined);
  const delta = projection.apply([
    { kind: 'remove', worldId: 0, entityKey: Math.floor(count / 2) + 1 },
  ]);
  const sort = vi.spyOn(Array.prototype, 'sort').mockImplementation(() => {
    throw new Error('whole retained group sort');
  });
  try {
    topology.apply(delta);
    const after = topology.query(topology.sourcePlan(), undefined);
    expect(after.candidateCount).toBe(count - 1);
    expect(before.candidateCount).toBe(count);
    expect(before.batches.at(0)?.candidates.length).toBe(count);
  } finally {
    sort.mockRestore();
  }
});
it('preserves the surviving physical execution window when unrelated batches retire', () => {
  const projection = new RenderScene();
  const values = Array.from({ length: 64 }, (_, index) =>
    snapshot(index + 1, prepared({ first: index * 36 })),
  );
  projection.reset(values);
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const before = topology.query(topology.sourcePlan(), undefined);
  const retained = required(before.batches.at(63));
  topology.apply(
    projection.apply(
      values.slice(0, 63).map((value) => ({
        kind: 'remove' as const,
        worldId: 0,
        entityKey: value.entityKey,
      })),
    ),
  );
  const after = topology.query(topology.sourcePlan(), undefined);
  const surviving = required(after.batches.at(0));
  expect(surviving.batchId).toBe(retained.batchId);
  expect(surviving.generation).toBe(retained.generation);
  expect(surviving.visibleBase).toBe(retained.visibleBase);
  expect(surviving.indirectOffset).toBe(retained.indirectOffset);
  expect(surviving.candidates).toBe(retained.candidates);
  expect(topology.inspect().windowCompactions).toBe(0);
});
it.each([
  -1,
  0.5,
  Number.NaN,
])('rejects weighted membership with invalid instance count %s', (instanceCount) => {
  const projection = new RenderScene();
  projection.reset([withInstances(snapshot(1, prepared()), 1)]);
  const slot = required(projection.slotsSnapshot().at(0));
  const topology = new BatchTopology();
  expect(() =>
    topology.rebuild([
      {
        ...slot,
        snapshot: {
          ...slot.snapshot,
          instances: { ...required(slot.snapshot.instances), instanceCount },
        },
      },
    ]),
  ).toThrowError(RangeError);
});
it('rejects stale cached plans after partial source membership publication and rebuilds from the baseline', () => {
  const projection = new RenderScene();
  projection.reset([snapshot(1, prepared())]);
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  const before = topology.query(topology.sourcePlan(), undefined);
  const delta = projection.apply([
    updateSnapshot(snapshot(2, prepared({ first: 36 }))),
    updateSnapshot(snapshot(3, prepared({ first: 72 }))),
  ]);
  const groups = (
    topology as unknown as {
      batches: Map<unknown, unknown>;
    }
  ).batches;
  const original = groups.set;
  const cause = new Error('injected second source-group admission failure');
  let calls = 0;
  const set = vi.spyOn(groups, 'set').mockImplementation((key, value) => {
    if (++calls === 2) throw cause;
    return original.call(groups, key, value);
  });
  try {
    expect(() => topology.apply(delta)).toThrow(cause);
  } finally {
    set.mockRestore();
  }
  expect(() => topology.query(topology.sourcePlan(), undefined)).toThrow(cause);
  expect(() => topology.apply(projection.apply([]))).toThrow(cause);
  expect(before.candidateCount).toBe(1);
  topology.rebuild(projection.slotsSnapshot());
  expect(topology.query(topology.sourcePlan(), undefined).candidateCount).toBe(3);
  expect(before.batches).toHaveLength(1);
});
it('keeps authored order independent of stable draw IDs through swaps, replacement and retirement', () => {
  const projection = new RenderScene();
  projection.reset([snapshot(1, prepared())]);
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  topology.query(topology.sourcePlan(), undefined);
  const source = required(
    (
      topology as unknown as {
        cachedPlan: SubmissionPlan | undefined;
      }
    ).cachedPlan,
  );
  const member = required(source.batches.at(0));
  const binding = required(member.binding);
  const authored = required(binding.source);
  const template = required(authored.draws[0]);
  let revision = source.revision;
  const planFor = (ids: readonly number[]): SubmissionPlan => {
    const draws = ids.map((id) =>
      Object.freeze({
        ...template,
        sourceDrawIndex: id,
        binding: Object.freeze({ ...template.binding, drawItemIndex: id }),
        key: Object.freeze({ ...template.key, drawItemIndex: id }),
      }),
    );
    const next = Object.freeze({
      ...member,
      binding: Object.freeze({
        ...binding,
        source: Object.freeze({ ...authored, draws: Object.freeze(draws) }),
      }),
      contentEpoch: ++revision,
    });
    return {
      ...source,
      revision,
      batches: new TreeFrame<GpuDrivenBatch>().with(next, 0, next.batchId, next.candidates.length),
    };
  };
  const windows = new MeshBatchProjection();
  const first = windows.query(planFor([20, 10]), undefined);
  expect(first.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([20, 10]);
  const old20 = required(first.batches.at(0)),
    old10 = required(first.batches.at(1));
  const swapped = windows.query(planFor([10, 20]), undefined);
  expect(swapped.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([10, 20]);
  expect(swapped.batches.at(0)).toMatchObject({
    batchId: old10.batchId,
    generation: old10.generation,
    visibleBase: old10.visibleBase,
    indirectOffset: old10.indirectOffset,
  });
  expect(swapped.batches.at(1)).toMatchObject({
    batchId: old20.batchId,
    generation: old20.generation,
    visibleBase: old20.visibleBase,
    indirectOffset: old20.indirectOffset,
  });
  const replaced = windows.query(planFor([30, 20]), undefined);
  expect(replaced.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([30, 20]);
  const last = windows.query(planFor([20]), undefined);
  expect(last.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([20]);
  expect(last.batches.at(0)).toMatchObject({
    batchId: old20.batchId,
    generation: old20.generation,
    visibleBase: old20.visibleBase,
    indirectOffset: old20.indirectOffset,
  });
  expect(first.batches.map((batch) => batch.binding?.drawItemIndex)).toEqual([20, 10]);
});
describe('bounded tree publication reads', () => {
  /** Install read-only observers while this owner constructs nodes, before sealing.
   * Frozen getters return captured data; no test can rewrite a published root. */
  let nodeReads = new WeakMap<
    object,
    {
      reads: number;
    }
  >();
  let restoreFreeze: (() => void) | undefined;
  beforeEach(() => {
    nodeReads = new WeakMap();
    const freeze = Object.freeze;
    const spy = vi.spyOn(Object, 'freeze').mockImplementation((value) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        Object.hasOwn(value, 'priority') &&
        Object.hasOwn(value, 'queue') &&
        !Object.isFrozen(value)
      ) {
        const observation = { reads: 0 };
        nodeReads.set(value, observation);
        for (const key of Object.keys(value)) {
          const descriptor = required(Object.getOwnPropertyDescriptor(value, key));
          if (!('value' in descriptor)) throw new Error('Expected owner-created data node');
          const captured: unknown = descriptor.value;
          Object.defineProperty(value, key, {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            get() {
              observation.reads++;
              return captured;
            },
          });
        }
      }
      return freeze(value);
    });
    restoreFreeze = () => spy.mockRestore();
  });
  afterEach(() => restoreFreeze?.());
  function observeTree<T>(root: Node<T> | undefined) {
    const observations: {
      reads: number;
    }[] = [];
    const collect = (node: Node<T> | undefined): void => {
      if (node === undefined) return;
      const observation = nodeReads.get(node);
      if (observation === undefined) throw new Error('Expected sealed owner node');
      observations.push(observation);
      collect(node.left);
      collect(node.right);
    };
    collect(root);
    return {
      reset() {
        for (const observation of observations) observation.reads = 0;
      },
      get nodes() {
        return observations.filter((value) => value.reads > 0).length;
      },
      get reads() {
        return observations.reduce((sum, value) => sum + value.reads, 0);
      },
    };
  }
  it.each([
    1000, 10000,
  ])('bounds publication work and preserves windows through an actual removal query among %i groups', (count) => {
    const scene = new RenderScene();
    scene.reset(
      Array.from({ length: count }, (_, i) => snapshot(i + 1, prepared({ first: i * 36 }))),
    );
    const topology = new BatchTopology();
    topology.rebuild(scene.slotsSnapshot());
    topology.sourcePlan();
    const source = () =>
      required(
        (
          topology as unknown as {
            cachedPlan: SubmissionPlan | undefined;
          }
        ).cachedPlan,
      );
    const initial = source();
    if (!BatchSources.isFixed(initial.batches)) throw new Error('Missing source tree');
    const observed = observeTree(initial.batches.root);
    observed.reset();
    const physical = new MeshBatchProjection();
    const before = physical.query(initial, undefined);
    expect(observed.nodes).toBe(count); // Cold full traversal authenticates the counter.
    const survivor = required(before.batches.at(-1));
    observed.reset();
    topology.apply(
      scene.apply([{ kind: 'remove', worldId: 0, entityKey: Math.floor(count / 2) + 1 }]),
    );
    topology.sourcePlan();
    expect(observed.nodes).toBeGreaterThan(0);
    expect(observed.nodes).toBeLessThan(128);
    expect(observed.reads).toBeLessThan(4096);
    const afterSource = source();
    observed.reset();
    const after = physical.query(afterSource, undefined);
    // The retained task projection re-joins only the edited sources: the
    // removal is observed through the bounded source diff, not a roster walk.
    expect(observed.nodes).toBeGreaterThan(0);
    expect(observed.nodes).toBeLessThan(128);
    expect(after.candidateCount).toBe(count - 1);
    expect(after.batches.at(-1)).toBe(survivor);
    expect(before.batches.length).toBe(count);
  });
  it.each([
    1000, 10000,
  ])('visits bounded member nodes for one removal among %i shared members', (count) => {
    const scene = new RenderScene();
    scene.reset(Array.from({ length: count }, (_, i) => snapshot(i + 1, prepared())));
    const topology = new BatchTopology();
    topology.rebuild(scene.slotsSnapshot());
    const before = topology.query(topology.sourcePlan(), undefined);
    // All existing aliases, including the old published candidates, retain the
    // same instrumented nodes. New copied path nodes are not part of this count.
    const groups = (
      topology as unknown as {
        batches: Map<
          string,
          {
            members: TreeFrame<unknown>;
          }
        >;
      }
    ).batches;
    const group = required(groups.values().next().value);
    const observed = observeTree(group.members.root);
    observed.reset();
    expect(
      before.batches.at(0)?.candidates.map((candidate) => candidate.primitiveIndex),
    ).toHaveLength(count);
    expect(observed.nodes).toBe(count); // Actual old publication also sees these getters.
    observed.reset();
    topology.apply(
      scene.apply([{ kind: 'remove', worldId: 0, entityKey: Math.floor(count / 2) + 1 }]),
    );
    const after = topology.query(topology.sourcePlan(), undefined);
    const visited = observed.nodes,
      reads = observed.reads;
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThan(128);
    expect(reads).toBeLessThan(4096);
    expect(after.candidateCount).toBe(count - 1);
    expect(before.candidateCount).toBe(count);
    expect(after.batches.at(0)?.candidates.at(-1)).toBe(before.batches.at(0)?.candidates.at(-1));
  });
});
it.each([
  'indirect allocation',
  'window installation',
] as const)('fails closed after a partial physical %s and restores a clean baseline', (fault) => {
  const scene = new RenderScene();
  scene.reset([snapshot(1, prepared())]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const old = topology.query(topology.sourcePlan(), undefined);
  const projection = (
    topology as unknown as {
      meshBatches: MeshBatchProjection;
    }
  ).meshBatches;
  const ranges = (
    projection as unknown as {
      indirectRanges: {
        allocate(count: number): number;
      };
    }
  ).indirectRanges;
  const cause = new Error('injected physical publication failure');
  topology.apply(
    scene.apply([
      updateSnapshot(snapshot(2, prepared({ first: 36 }))),
      updateSnapshot(snapshot(3, prepared({ first: 72 }))),
    ]),
  );
  let restore: () => void;
  if (fault === 'indirect allocation') {
    const allocate = ranges.allocate;
    let calls = 0;
    const spy = vi.spyOn(ranges, 'allocate').mockImplementation((count) => {
      if (++calls === 2) throw cause;
      return allocate.call(ranges, count);
    });
    restore = () => spy.mockRestore();
  } else {
    const set = Map.prototype.set;
    let calls = 0;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (typeof value === 'object' && value !== null && 'levelCapacity' in value && ++calls === 2)
        throw cause;
      return set.call(this, key, value);
    });
    restore = () => spy.mockRestore();
  }
  try {
    expect(() => topology.query(topology.sourcePlan(), undefined)).toThrow(cause);
  } finally {
    restore();
  }
  expect(() => topology.query(topology.sourcePlan(), undefined)).toThrow(cause);
  expect(() => topology.apply(scene.apply([]))).toThrow(cause);
  topology.rebuild(scene.slotsSnapshot());
  const recovered = topology.query(topology.sourcePlan(), undefined);
  expect(recovered.candidateCount).toBe(3);
  expect(recovered.batches.length).toBe(3);
  const live = [...recovered.batches];
  expect(new Set(live.map((row) => row.batchId)).size).toBe(3);
  expect(new Set(live.map((row) => row.visibleBase)).size).toBe(3);
  expect(new Set(live.map((row) => row.indirectOffset)).size).toBe(3);
  expect(recovered.visibleCapacity).toBe(192);
  expect(old.candidateCount).toBe(1);
  expect(old.batches.length).toBe(1);
  expect(old.batches.at(0)?.visibleBase).toBe(0);
});
it('keeps fixed member and candidate facts across small and paged extent transitions', () => {
  const scene = new RenderScene();
  const initial = withInstances(snapshot(1, prepared()), 1);
  scene.reset([initial]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const first = topology.query(topology.sourcePlan(), undefined);
  const candidate = required(first.batches.at(0)?.candidates.at(0));
  const held = [{ count: 1, plan: first }];
  let retiredTail: object | undefined;
  for (const count of [64, 65, 1, 129, 64]) {
    topology.apply(scene.apply([updateInstances(withInstances(initial, count))]));
    const plan = topology.query(topology.sourcePlan(), undefined);
    const batch = required(plan.batches.at(0));
    expect(plan.candidateCount).toBe(count);
    expect(batch.candidates.at(0)).toBe(candidate);
    expect(batch.candidates.map((value) => value.instanceOrdinal)).toEqual(
      Array.from({ length: count }, (_, ordinal) => ordinal),
    );
    expect(batch.members?.at(0)?.instanceCount).toBe(count);
    if (count === 65) retiredTail = required(batch.candidates.at(64));
    if (count === 129) expect(batch.candidates.at(64)).not.toBe(retiredTail);
    held.push({ count, plan });
  }
  for (const { count, plan } of held) {
    expect(plan.candidateCount).toBe(count);
    expect(plan.batches.at(0)?.candidates.length).toBe(count);
    expect(plan.batches.at(0)?.members?.at(0)?.instanceCount).toBe(count);
    expect(plan.batches.at(0)?.candidates.at(0)).toBe(candidate);
  }
});
it('retains the nonzero boundary page across shrink and regrowth', () => {
  const scene = new RenderScene();
  const initial = withInstances(snapshot(1, prepared()), 129);
  scene.reset([initial]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const first = topology.query(topology.sourcePlan(), undefined);
  const original = required(first.batches.at(0));
  const survivor = required(original.candidates.at(64));
  const removed65 = required(original.candidates.at(65));
  const removed128 = required(original.candidates.at(128));
  const held = [{ count: 129, plan: first }];
  for (const count of [65, 128, 129]) {
    topology.apply(scene.apply([updateInstances(withInstances(initial, count))]));
    const plan = topology.query(topology.sourcePlan(), undefined);
    const candidates = required(plan.batches.at(0)).candidates;
    expect(candidates.length).toBe(count);
    expect(candidates.at(64)).toBe(survivor);
    expect(candidates.map((value) => value.instanceOrdinal)).toEqual(
      Array.from({ length: count }, (_, ordinal) => ordinal),
    );
    if (count > 65) expect(candidates.at(65)).not.toBe(removed65);
    if (count > 128) expect(candidates.at(128)).not.toBe(removed128);
    held.push({ count, plan });
  }
  for (const { count, plan } of held) {
    expect(plan.batches.at(0)?.candidates.length).toBe(count);
    expect(plan.batches.at(0)?.candidates.at(64)).toBe(survivor);
  }
  expect(first.batches.at(0)?.candidates.at(65)).toBe(removed65);
  expect(first.batches.at(0)?.candidates.at(128)).toBe(removed128);
});
it('keeps an unrelated member fixed while another extent crosses zero and singleton boundaries', () => {
  const scene = new RenderScene();
  const inputs = prepared();
  const initial = withInstances(snapshot(1, inputs), 1);
  scene.reset([initial, snapshot(2, inputs)]);
  const topology = new BatchTopology();
  topology.rebuild(scene.slotsSnapshot());
  const first = topology.query(topology.sourcePlan(), undefined);
  const original = required(first.batches.at(0)?.candidates.at(0));
  const anchor = required(first.batches.at(0)?.candidates.at(1));
  const held = [{ count: 1, plan: first }];
  let current = original;
  let wasEmpty = false;
  for (const count of [2, 1, 0, 1, 65, 1]) {
    topology.apply(scene.apply([updateInstances(withInstances(initial, count))]));
    const plan = topology.query(topology.sourcePlan(), undefined);
    const candidates = required(plan.batches.at(0)).candidates;
    expect(plan.candidateCount).toBe(count + 1);
    expect(candidates.length).toBe(count + 1);
    expect(candidates.at(-1)).toBe(anchor);
    if (count === 0) {
      expect(candidates.at(0)).toBe(anchor);
      wasEmpty = true;
    } else {
      const next = required(candidates.at(0));
      if (wasEmpty) {
        expect(next).not.toBe(current);
        current = next;
        wasEmpty = false;
      } else expect(next).toBe(current);
      expect(next.instanceOrdinal).toBe(0);
      expect(candidates.at(count - 1)?.instanceOrdinal).toBe(count - 1);
    }
    held.push({ count, plan });
  }
  for (const { count, plan } of held) {
    const candidates = required(plan.batches.at(0)).candidates;
    expect(candidates.length).toBe(count + 1);
    expect(candidates.at(-1)).toBe(anchor);
  }
  expect(first.batches.at(0)?.candidates.at(0)).toBe(original);
});
