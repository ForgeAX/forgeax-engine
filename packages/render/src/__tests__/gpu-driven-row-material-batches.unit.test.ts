import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../gpu-driven/draw-selection';
import { MaterialResource } from '../material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';
import { RenderScene } from '../scene/render-scene';

const SHADER = 'forgeax::default-standard-pbr';

function material(index: number, values: Partial<MaterialSnapshot> = {}): MaterialResource {
  return new MaterialResource({
    baseColor: vec3.create((index % 97) / 97, (index % 89) / 89, (index % 83) / 83),
    metallic: 0,
    roughness: (index % 11) / 11,
    materialShaderId: SHADER,
    passes: [
      {
        name: 'forward',
        program: { module: SHADER },
        renderState: { tags: { LightMode: 'Forward' } },
      },
    ],
    paramSnapshot: { roughness: (index % 11) / 11 },
    ...values,
  } as MaterialSnapshot);
}

function row(entityKey: number, resource: MaterialResource): RenderableSnapshot {
  const draw = { kind: 'indexed' as const, first: 0, count: 36, baseVertex: 0 };
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material: resource,
    materials: [resource],
    materialBindingSources: ['renderer-override'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        ...draw,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'cube|rigid',
        materialResourceClass: 'unused',
        geometry: {
          receipt: { identity: 'cube', vertexInputs: [], topology: 'triangle-list', indexed: true },
          draw: { ...draw, topology: 'triangle-list' },
          deformation: 'rigid',
        },
      },
    ],
  } as unknown as RenderableSnapshot;
}

const update = (value: RenderableSnapshot) => ({
  kind: 'update' as const,
  worldId: value.worldId,
  entityKey: value.entityKey,
  snapshot: value,
});

function scene(resources: readonly MaterialResource[]) {
  const projection = new RenderScene();
  const topology = new BatchTopology();
  topology.apply(
    projection.apply(resources.map((resource, index) => update(row(index + 1, resource)))),
  );
  let frame = new MaterialFrame(undefined);
  for (const resource of resources) frame = frame.with(resource);
  topology.adoptMaterials(frame, projection.slotAt);
  return { projection, topology, frame };
}

describe('row-material GPU batches', () => {
  it('batches unique same-class materials together and splits distinct bindings', () => {
    const unique = Array.from({ length: 256 }, (_, index) => material(index));
    const projection = new RenderScene();
    const topology = new BatchTopology();
    topology.apply(
      projection.apply(unique.map((resource, index) => update(row(index + 1, resource)))),
    );
    const plan = topology.sourcePlan();
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches.at(0)?.key.rowMaterial).toBe(true);
    expect(plan.candidateCount).toBe(256);

    const textured = material(1, { textureHandles: new Map([['baseColorTexture', 3]]) as never });
    expect(scene([...unique.slice(0, 4), textured]).topology.sourcePlan().batches).toHaveLength(2);
    const masked = material(2, { paramSnapshot: { alphaCutoff: 0.5 } });
    expect(scene([...unique.slice(0, 4), masked]).topology.sourcePlan().batches).toHaveLength(2);
  });

  it('moves the batch binding when its material loses the last member', () => {
    const resources = [material(0), material(1), material(2)];
    const { projection, topology } = scene(resources);
    const before = topology.sourcePlan().batches.at(0);
    expect(before?.binding?.material).toBe(resources[0]);
    topology.apply(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]));
    const after = topology.sourcePlan().batches;
    expect(after).toHaveLength(1);
    expect(after.at(0)?.batchId).toBe(before?.batchId);
    expect(after.at(0)?.binding?.material).not.toBe(resources[0]);
    expect(resources.slice(1)).toContain(after.at(0)?.binding?.material);
  });

  it('re-batches only the rows of a material whose class changed, never for value edits', () => {
    const resources = Array.from({ length: 64 }, (_, index) => material(index));
    const { projection, topology } = scene(resources);
    // Two rows share material 5; the class edit must visit exactly those rows.
    const shared = resources[5] as MaterialResource;
    topology.apply(projection.apply([update(row(1000, shared))]));
    let frame = new MaterialFrame(undefined);
    for (const resource of resources) frame = frame.with(resource);
    topology.adoptMaterials(frame, projection.slotAt);
    const checks = topology.inspect().membershipChecks;

    shared.adopt({ ...shared.snapshot, roughness: 0.9, paramSnapshot: { roughness: 0.9 } });
    frame = frame.with(shared);
    expect(topology.adoptMaterials(frame, projection.slotAt)).toBe(false);
    expect(topology.inspect().membershipChecks).toBe(checks);

    shared.adopt({ ...shared.snapshot, paramSnapshot: { roughness: 0.9, alphaCutoff: 0.5 } });
    frame = frame.with(shared);
    expect(topology.adoptMaterials(frame, projection.slotAt)).toBe(true);
    expect(topology.inspect().membershipChecks).toBe((checks ?? 0) + 2);
    const batches = topology.sourcePlan().batches;
    expect(batches).toHaveLength(2);
    expect([...batches].map((batch) => batch.candidates.length).sort((a, b) => a - b)).toEqual([
      2, 63,
    ]);
  });

  it('keeps the plan when the only material of its batch changes class', () => {
    const shared = material(0);
    const resources = Array.from({ length: 64 }, () => shared);
    const { projection, topology, frame } = scene(resources);
    const plan = topology.sourcePlan();
    const checks = topology.inspect().membershipChecks;
    shared.adopt({ ...shared.snapshot, paramSnapshot: { roughness: 0, alphaCutoff: 0.5 } });
    expect(topology.adoptMaterials(frame.with(shared), projection.slotAt)).toBe(false);
    expect(topology.inspect().membershipChecks).toBe(checks);
    expect(topology.sourcePlan()).toBe(plan);
    // A newcomer of the old class no longer joins the reclassed batch.
    topology.apply(projection.apply([update(row(1000, material(1)))]));
    expect(topology.sourcePlan().batches).toHaveLength(2);
  });

  it('keeps the batch when a row swaps between same-class materials', () => {
    const resources = [material(0), material(1), material(2), material(3)];
    const { projection, topology } = scene(resources);
    const before = topology.sourcePlan();
    topology.apply(projection.apply([update(row(1, resources[3] as MaterialResource))]));
    topology.apply(projection.apply([update(row(4, resources[2] as MaterialResource))]));
    const after = topology.sourcePlan();
    expect(after.batches).toHaveLength(1);
    expect(after.batches.at(0)?.batchId).toBe(before.batches.at(0)?.batchId);
    // Material 0 lost its only row; the binding follows a held material.
    expect(after.batches.at(0)?.binding?.material).not.toBe(resources[0]);
  });

  it('keeps Standard, default Unlit and incompatible binding classes separate', () => {
    const standard = [material(0), material(1)];
    const unlit = [
      material(2, { materialShaderId: 'forgeax::default-unlit' }),
      material(3, { materialShaderId: 'forgeax::default-unlit' }),
    ];
    const { topology } = scene([...standard, ...unlit]);
    const batches = [...topology.sourcePlan().batches];
    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.candidates.length)).toEqual([2, 2]);
    expect(
      new Set(batches.map((batch) => batch.binding?.material.snapshot.materialShaderId)),
    ).toEqual(new Set([SHADER, 'forgeax::default-unlit']));
  });

  it('retires a material from its group and re-admits a reused Scene slot by current class', () => {
    const first = material(0),
      second = material(1);
    const { projection, topology, frame } = scene([first, second]);
    const original = projection.slotsSnapshot().lookup(0, 1);
    topology.apply(projection.apply([{ kind: 'remove', worldId: 0, entityKey: 1 }]));
    first.adopt({ ...first.snapshot, paramSnapshot: { alphaCutoff: 0.5 } });
    topology.adoptMaterials(frame.with(first), projection.slotAt);
    topology.apply(projection.apply([update(row(3, first))]));
    const replacement = projection.slotsSnapshot().lookup(0, 3);
    expect(replacement?.slot).toBe(original?.slot);
    expect(replacement?.generation).not.toBe(original?.generation);
    const batches = [...topology.sourcePlan().batches];
    expect(batches).toHaveLength(2);
    expect(batches.every((batch) => batch.candidates.length === 1)).toBe(true);
    expect(new Set(batches.map((batch) => batch.binding?.material))).toEqual(
      new Set([first, second]),
    );
  });
});

it('selects both executed mesh groups when one material has different binding sources', () => {
  const resource = material(1);
  const a = row(1, resource);
  const b: RenderableSnapshot = {
    ...row(2, resource),
    assetHandle: 8,
    materialBindingSources: ['mesh-default'],
  };
  const projection = new RenderScene();
  const topology = new BatchTopology();
  topology.apply(projection.apply([update(a), update(b)]));
  const batches = topology.query(topology.sourcePlan(), undefined).batches;
  expect(batches).toHaveLength(2);
  expect(batches.at(0)?.binding?.rowGroup).not.toBe(batches.at(1)?.binding?.rowGroup);
  const selection = new GpuDrawSelection(batches);
  for (const source of [a, b]) {
    const draw = source.gpuDrivenDraws?.[0];
    const slot = projection.slotsSnapshot().find((slot) => slot.entityKey === source.entityKey);
    if (draw === undefined || slot === undefined) throw new Error('missing accepted source');
    expect(selection.owns(source, draw, 0)).toBe(true);
    expect(selection.ownsSlot(source, 0, slot.slot, slot.generation)).toBe(true);
  }
  const onlyA = new GpuDrawSelection(batches.filter((batch) => batch.binding?.assetHandle === 7));
  const drawB = b.gpuDrivenDraws?.[0];
  if (drawB === undefined) throw new Error('missing second source draw');
  expect(onlyA.owns(b, drawB, 0)).toBe(false);
});
