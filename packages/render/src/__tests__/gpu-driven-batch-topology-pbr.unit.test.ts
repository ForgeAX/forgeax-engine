import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import type { SamplerAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { gpuDrivenMaterialResourceClass } from '../extract/gpu-driven';
import { BatchTopology, batchVisibleSpan } from '../gpu-driven/batch-topology';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';

const receipt = createStandardPbrArtifactReceipt();
const resourceClass = JSON.stringify({
  textures: receipt.resourceSlots.filter((slot) => slot.kind === 'texture').length,
  samplers: receipt.resourceSlots.filter((slot) => slot.kind === 'sampler').length,
  video: 0,
});

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
  const samplerAsset = staticSamplerAsset();
  return Array.from({ length: count }, (_, index) => {
    const textureAsset = staticTextureAsset(index);
    return {
      texture: Number(world.allocSharedRef('TextureAsset', textureAsset)),
      sampler: Number(world.allocSharedRef('SamplerAsset', samplerAsset)),
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
    skinPaletteAddress: receipt.skinPaletteAddress,
    topology: 'triangle-list',
    indexed: true,
    first: 0,
    count: 36,
    baseVertex: 0,
    ...overrides,
  };
}

function snapshot(
  entityKey: number,
  drawPrepared: PreparedGpuDrivenDraw,
  material: Partial<MaterialSnapshot> = {},
): RenderableSnapshot {
  const value = {
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialShaderId: 'forgeax::default-standard-pbr',
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
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material: value,
    materials: [value],
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
        prepared: drawPrepared,
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
        materialResourceClass: gpuDrivenMaterialResourceClass(value.material),
      },
    ],
  };
}

describe('PBR prepared GPU-driven batch topology', () => {
  it('preserves surviving ranges across removal, recycling and bounded growth', () => {
    const projection = new RenderScene();
    const values = Array.from({ length: 32 }, (_, i) =>
      snapshot(i + 1, prepared({ first: i * 36 })),
    );
    projection.apply(values.map(updateSnapshot));
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const original = topology.plan();
    const remove = projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]);
    topology.apply(remove);
    const afterRemoval = topology.plan();
    expect(afterRemoval.batches).toEqual(original.batches.slice(1));
    topology.apply(projection.apply([updateSnapshot(snapshot(100, prepared({ first: 9999 })))]));
    const recycled = topology.plan();
    expect(recycled.batches[0]?.visibleBase).toBe(original.batches[0]?.visibleBase);
    expect(recycled.batches[0]?.indirectOffset).toBe(original.batches[0]?.indirectOffset);
    expect(recycled.batches[0]?.generation).not.toBe(original.batches[0]?.generation);
    const source = values[16];
    if (source === undefined) throw new Error('missing fixture row');
    topology.apply(projection.apply([updateSnapshot(withInstances(source, 63))]));
    const within = topology.plan();
    const oldBatch = recycled.batches.find(
      (batch) => batch.key.first === source.gpuDrivenDraws?.[0]?.first,
    );
    const withinBatch = within.batches.find((batch) => batch.batchId === oldBatch?.batchId);
    expect(withinBatch?.visibleBase).toBe(oldBatch?.visibleBase);
    expect(withinBatch?.indirectOffset).toBe(oldBatch?.indirectOffset);
    expect(withinBatch?.visibleCapacity).toBe(63);
    topology.apply(projection.apply([updateSnapshot(withInstances(source, 65))]));
    const grown = topology.plan();
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
    expect(original.batches[0]?.candidates).toHaveLength(1);
  });

  it('compacts sparse ranges and shrinks oversized LOD windows without mutating retained plans', () => {
    const projection = new RenderScene();
    const values = Array.from({ length: 64 }, (_, i) =>
      snapshot(i + 1, prepared({ first: i * 36 })),
    );
    projection.apply(values.map(updateSnapshot));
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.plan();
    topology.apply(
      projection.apply(
        values
          .slice(0, 63)
          .map((value) => ({ kind: 'remove' as const, worldId: 0, entityKey: value.entityKey })),
      ),
    );
    const compact = topology.plan();
    expect(compact.visibleCapacity).toBe(64);
    expect(compact.batches[0]?.indirectOffset).toBe(0);
    expect(topology.inspect().windowCompactions).toBe(1);
    expect(before.batches[63]?.visibleBase).toBe(63 * 64);
    const source = values[63];
    if (source === undefined) throw new Error('missing fixture row');
    const lod = {
      ...source,
      lods: [{ mesh: '00000000-0000-7000-8000-000000000001' as never, screenCoverage: 0.25 }],
    };
    topology.apply(projection.apply([updateSnapshot(withInstances(lod, 1024))]));
    const large = topology.plan();
    expect(batchVisibleSpan(required(large.batches[0]))).toBe(2048);
    topology.apply(projection.apply([updateSnapshot(withInstances(lod, 1))]));
    const small = topology.plan();
    expect(batchVisibleSpan(required(small.batches[0]))).toBe(128);
    expect(small.batches[0]?.indirectOffset).toBe(0);
    expect(topology.inspect().windowCompactions).toBe(2);
  });

  it('keeps deferred and forward-only materials in separate graph-owned batches', () => {
    const topology = topologyFor(
      snapshot(1, prepared(), { deferredPass: true }),
      snapshot(2, prepared(), { deferredPass: false }),
    );

    expect(topology.plan().batches).toHaveLength(2);
    expect(new Set(topology.plan().batches.map((batch) => batch.key.materialPass))).toEqual(
      new Set(['deferred', 'forward-only']),
    );
  });

  it('admits alpha hash through the masked shadow and depth batch', () => {
    const hash = snapshot(2, prepared(), { paramSnapshot: { alphaHash: 1 } });
    const plan = topologyFor(snapshot(1, prepared()), hash).plan();
    expect(plan.batches.map((batch) => batch.key.admission).sort()).toEqual([
      'alpha-mask',
      'opaque',
    ]);
  });

  it('groups only by prepared identity and admits opaque plus Alpha Mask', () => {
    const mask = snapshot(2, prepared(), { paramSnapshot: { alphaCutoff: 0.5 } });
    const topology = topologyFor(snapshot(1, prepared()), mask);
    const plan = topology.plan();

    expect(plan.candidateCount).toBe(2);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]?.key).toMatchObject({
      preparedIdentity: `forgeax::default-standard-pbr|cube|rigid|${receipt.receiptIdentity}|${receipt.generation}`,
      resourceIdentity: resourceClass,
    });
  });

  it('keeps colored and uncolored ABI variants in separate prepared batches', () => {
    const coloredReceipt = createStandardPbrArtifactReceipt(false, true);
    const colored = prepared({
      receiptIdentity: coloredReceipt.receiptIdentity,
      vertexInputs: coloredReceipt.vertexInputs,
    });
    const topology = topologyFor(snapshot(1, prepared()), snapshot(2, colored));

    expect(topology.plan().candidateCount).toBe(2);
    expect(topology.plan().batches).toHaveLength(2);
    expect(new Set(topology.plan().batches.map((batch) => batch.key.preparedIdentity))).toEqual(
      new Set([
        `forgeax::default-standard-pbr|cube|rigid|${receipt.receiptIdentity}|${receipt.generation}`,
        `forgeax::default-standard-pbr|cube|rigid|${coloredReceipt.receiptIdentity}|${coloredReceipt.generation}`,
      ]),
    );
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
          snapshot(1, prepared({ resourceSlots: receipt.resourceSlots.slice(0, 2) })),
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
    const before = topology.plan();
    const changed = resourceClassSnapshot(2, prepared(), 2);
    const delta = projection.apply([updateSnapshot(changed)]);
    expect(topology.apply(delta)).toBe(true);
    const after = topology.plan();
    expect(after.candidateCount).toBe(before.candidateCount);
    expect(topology.inspect()).toMatchObject({ revision: 2, patches: 1, rebuilds: 1 });
    expect(after.batches).toHaveLength(3);
    const beforeIdentities = before.batches.map((batch) => batch.key.resourceIdentity);
    for (const identity of beforeIdentities) {
      expect(
        after.batches.find((batch) => batch.key.resourceIdentity === identity)?.candidates,
      ).toHaveLength(1);
    }
  });

  it('routes Alpha Blend, morph and unsupported authoring out of the GPU lane', () => {
    const blend = snapshot(2, prepared(), {
      transparent: true,
      renderState: { blend: { color: {}, alpha: {} } } as never,
    });
    const morph = { ...snapshot(3, prepared()), morph: {} as never } as RenderableSnapshot;
    const custom = snapshot(4, prepared(), { materialShaderId: 'game::custom-shader' });
    const topology = topologyFor(snapshot(1, prepared()), blend, morph, custom);

    expect(topology.plan().candidateCount).toBe(1);
    expect(topology.inspect().ineligible).toBe(3);
  });

  it('keeps stencil-authored materials on the per-draw stencil reference path', () => {
    // Indirect GPU draws carry no setStencilReference; a stencil write such as
    // LearnOpenGL 4.2 `replace` with reference 1 would otherwise write 0.
    const stencil = snapshot(2, prepared(), {
      renderState: { stencil: { compare: 'always', passOp: 'replace' }, stencilWriteMask: 0xff },
    });
    const topology = topologyFor(snapshot(1, prepared()), stencil);

    expect(topology.plan().candidateCount).toBe(1);
    expect(topology.inspect().ineligible).toBe(1);
  });

  it('keeps the original draw index when an earlier draw is ineligible', () => {
    const source = snapshot(1, prepared());
    const first = source.gpuDrivenDraws?.[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const projection = new RenderScene();
    projection.apply([
      updateSnapshot({
        ...source,
        gpuDrivenDraws: [
          {
            ...first,
            prepared: prepared({ identity: { ...prepared().identity, deformation: 'skin' } }),
          },
          { ...first, first: 12, prepared: prepared({ first: 12 }) },
        ],
      }),
    ]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan().candidateCount).toBe(1);
    expect(topology.plan().batches[0]?.candidates[0]?.drawItemIndex).toBe(1);
    expect(topology.plan().batches[0]?.prepared?.first).toBe(12);
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
    const before = topology.plan();
    const allocationsBefore = topology.inspect().membershipAllocations ?? 0;
    const batchBefore = before.batches[0];
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
    const after = topology.plan();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.batches).toHaveLength(1);
    expect(after.batches[0]?.candidates).toHaveLength(2);
    expect(after.batches[0]?.lod?.coverages).toEqual([1, 0.25]);
    expect(after.batches[0]?.lod?.hysteresis).toBe(0.2);
    expect(topology.inspect()).toMatchObject({ contentPatches: 0, patches: 1 });
    expect(topology.inspect().membershipAllocations ?? 0).toBeGreaterThan(allocationsBefore);
  });

  it('keeps preparation when material row values change without changing draw admission', () => {
    const projection = new RenderScene();
    projection.apply([updateSnapshot(snapshot(1, prepared()))]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.plan();
    const batchBefore = before.batches[0];
    expect(batchBefore).toBeDefined();
    if (batchBefore === undefined) return;

    // A posed skin re-extracts fresh but equal MaterialSnapshot objects.
    const reextracted = projection.apply([updateSnapshot(snapshot(1, prepared()))]);
    expect(reextracted.contentUpdatedSlots).toHaveLength(1);
    expect(topology.apply(reextracted)).toBe(false);
    const after = topology.plan();
    expect(after).toBe(before);
    expect(after.batches[0]?.contentEpoch).toBe(batchBefore.contentEpoch);
    expect(topology.inspect().contentPatches).toBe(0);

    const edited = projection.apply([
      updateSnapshot(snapshot(1, prepared(), { baseColor: vec3.create(0.5, 1, 1) })),
    ]);
    expect(edited.contentUpdatedSlots).toHaveLength(1);
    expect(edited.contentUpdatedSlots[0]?.snapshot.material.baseColor[0]).toBe(0.5);
    expect(topology.apply(edited)).toBe(false);
    expect(topology.plan()).toBe(before);
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
    const before = topology.plan().batches[0];
    if (before === undefined) throw new Error('expected a prepared batch');
    const edited = projection.apply([updateSnapshot(snapshot(1, prepared(), material))]);
    expect(topology.apply(edited)).toBe(true);
    expect(topology.plan().batches[0]?.batchId).toBe(before.batchId);
    expect(topology.plan().batches[0]?.contentEpoch).toBeGreaterThan(before.contentEpoch);
  });

  it('reprepares skin admission when its palette buffer becomes available', () => {
    const draw = prepared({
      identity: { ...prepared().identity, deformation: 'skin' },
      skinPaletteAddress: { group: 2, binding: 1, stride: 64 },
    });
    const source = snapshot(1, draw);
    const skin = {
      storageOrUniform: 'storage',
      customDataStart: 0,
      bounds: new Float32Array([-1, -1, -1, 1, 1, 1]),
    } as NonNullable<RenderableSnapshot['skin']>;
    const projection = new RenderScene();
    projection.apply([updateSnapshot({ ...source, skin })]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    const before = topology.plan().batches[0];
    if (before === undefined) throw new Error('expected a prepared batch');
    expect(before).toBeDefined();
    expect(
      topology.apply(
        projection.apply([
          updateSnapshot({
            ...source,
            skin: { ...skin, buffer: {} as never },
          }),
        ]),
      ),
    ).toBe(true);
    expect(topology.plan().batches[0]?.batchId).toBe(before.batchId);
    expect(topology.plan().batches[0]?.contentEpoch).toBeGreaterThan(before.contentEpoch);
  });

  it('updates candidate membership for Instances count transitions', () => {
    const projection = new RenderScene();
    const initial = withInstances(snapshot(1, prepared()), 1);
    projection.apply([updateSnapshot(initial)]);
    const topology = new BatchTopology();
    topology.rebuild(projection.slotsSnapshot());
    expect(topology.plan().candidateCount).toBe(1);

    const sameCount = projection.apply([updateInstances(withInstances(initial, 1))]);
    expect(sameCount.instanceUpdatedSlots).toHaveLength(1);
    expect(topology.apply(sameCount)).toBe(false);
    expect(topology.plan().candidateCount).toBe(1);

    const expanded = projection.apply([updateInstances(withInstances(initial, 3))]);
    expect(topology.apply(expanded)).toBe(true);
    expect(topology.plan().candidateCount).toBe(3);

    const empty = projection.apply([updateInstances(withInstances(initial, 0))]);
    expect(topology.apply(empty)).toBe(true);
    expect(topology.plan().candidateCount).toBe(0);
    expect(topology.inspect().ineligible).toBe(1);
  });
  it.each([
    1, 16, 256,
  ])('keeps 100k prepared PBR candidates in %i resource-identity batches', (resourceClassCount) => {
    const world = new World();
    const resources = staticResourceClassFixture(world, resourceClassCount);
    for (const resource of resources) {
      expect(
        world.sharedRefs.resolve<'TextureAsset', TextureAsset>(resource.texture as never),
      ).toMatchObject({
        ok: true,
        value: { kind: 'texture', shape: { viewDimension: '2d' } },
      });
      expect(
        world.sharedRefs.resolve<'SamplerAsset', SamplerAsset>(resource.sampler as never),
      ).toMatchObject({
        ok: true,
        value: { kind: 'sampler' },
      });
    }
    const candidates = Array.from({ length: 100_000 }, (_, entityKey) =>
      resourceClassSnapshot(entityKey, prepared(), entityKey % resourceClassCount, resources),
    );
    const topology = topologyFor(...candidates);
    const plan = topology.plan();
    const inspection = topology.inspect();
    const resourceIdentities = new Set(plan.batches.map((batch) => batch.key.resourceIdentity));

    expect(plan.candidateCount).toBe(100_000);
    expect(plan.batches).toHaveLength(resourceClassCount);
    expect(plan.batches.reduce((total, batch) => total + batch.candidates.length, 0)).toBe(100_000);
    expect(inspection).toMatchObject({
      candidateCount: 100_000,
      batchCount: resourceClassCount,
      ineligible: 0,
    });
    expect(resourceIdentities).toHaveLength(resourceClassCount);
    expect(topology.plan()).toBe(plan);
    expect(topology.inspect().revision).toBe(1);
  }, 30_000);
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
    if (typeof key === 'string' && key.startsWith('{"assetHandle":')) lookups++;
    return original.call(this, key);
  });
  try {
    topology.rebuild(projection.slotsSnapshot());
  } finally {
    get.mockRestore();
  }
  expect(lookups).toBe(1);
  const plan = topology.plan();
  expect(plan.candidateCount).toBe(1024);
  expect(plan.batches[0]?.contentEpoch).toBe(1023);
  expect(plan.batches[0]?.candidates.map((row) => row.instanceOrdinal)).toEqual(
    Array.from({ length: 1024 }, (_, i) => i),
  );
  topology.apply(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 100 }]));
  expect(topology.plan().candidateCount).toBe(0);
});
