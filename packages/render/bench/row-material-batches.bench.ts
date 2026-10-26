import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import { rhi } from '@forgeax/engine-rhi-null';
import { createStandardPbrArtifactReceipt, STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { bench, describe } from 'vitest';
import { Visibility, VisibilityStateValue } from '../src/components';
import { resolveVisibility } from '../src/extract/visibility';
import { BatchTopology, type SubmissionPlan } from '../src/gpu-driven/batch-topology';
import { GpuDrawSelection } from '../src/gpu-driven/draw-selection';
import type { PreparedGpuDrivenDraw } from '../src/gpu-driven/prepared-draw';
import { GpuScene } from '../src/gpu-scene';
import { MaterialResource } from '../src/material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../src/render-system-extract';
import { RenderScene } from '../src/scene/render-scene';

// CPU-only retained-render preparation at scale: RenderScene.apply ->
// GpuScene.sync (null RHI) -> BatchTopology.apply/query -> GpuDrawSelection.
// Not a GPU throughput or displayed-FPS benchmark. The identical file runs on
// the base commit: every API used here exists on both sides, and the structural
// difference (batch count) is printed, not asserted.

const ROWS = 10_000;
const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

const receipt = createStandardPbrArtifactReceipt();
const prepared: PreparedGpuDrivenDraw = {
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
};

function materialSnapshot(materialHandle: number): MaterialSnapshot {
  return {
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialHandle,
    materialShaderId: prepared.identity.material,
    materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    paramSnapshot: Object.fromEntries(
      STANDARD_PIPELINE_PARAM_SCHEMA.map((entry) => [entry.name, 'default' in entry ? entry.default : undefined]),
    ) as MaterialSnapshot['paramSnapshot'],
    passes: [
      { name: 'forward', program: { module: prepared.identity.material }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    textureHandles: new Map(),
    samplerHandles: new Map(),
  };
}

function row(entityKey: number, material: MaterialResource): RenderableSnapshot {
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, entityKey, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'prepared-standard-pbr',
        materialResourceClass: '{"textures":[],"samplers":[]}',
        geometry: {
          receipt: {
            identity: prepared.identity.geometry,
            vertexInputs: prepared.vertexInputs,
            topology: prepared.topology,
            indexed: prepared.indexed,
          },
          draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
          deformation: 'rigid',
        },
        prepared,
      },
    ],
  };
}

/** One retained frame loop: the stages a renderer runs each frame, minus recording. */
function fixture(materialCount: number) {
  const materials = Array.from({ length: materialCount }, (_, handle) => new MaterialResource(materialSnapshot(handle)));
  const available = GpuScene.create(device, ROWS).unwrap();
  if (available.status !== 'available') throw new Error('GpuScene unavailable');
  const gpu = available.scene;
  const scene = new RenderScene();
  const topology = new BatchTopology();
  const snapshots = Array.from({ length: ROWS }, (_, key) => row(key, materials[key % materialCount] as MaterialResource));
  const created = scene.apply(snapshots.map((snapshot) => ({ kind: 'update' as const, worldId: 0, entityKey: snapshot.entityKey, snapshot })));
  gpu.sync(created).unwrap();
  topology.apply(created);
  let plan: SubmissionPlan = topology.query(topology.sourcePlan(), undefined);
  let selection = new GpuDrawSelection(plan.batches);
  const frame = (delta: ReturnType<RenderScene['apply']>) => {
    gpu.sync(delta).unwrap();
    topology.apply(delta);
    const next = topology.query(topology.sourcePlan(), undefined);
    if (next !== plan) {
      plan = next;
      selection = new GpuDrawSelection(plan.batches);
    }
    return plan;
  };
  /** CPU recording asks the selection about every source draw. */
  const ownAll = (sel: GpuDrawSelection) => {
    let owned = 0;
    for (const snapshot of snapshots) if (sel.ownsAll(snapshot)) owned++;
    if (owned !== ROWS) throw new Error(`selection owns ${owned}/${ROWS}`);
  };
  ownAll(selection);
  return { materials, gpu, scene, snapshots, frame, ownAll, get plan() { return plan; }, get selection() { return selection; } };
}

const OPTIONS = { time: 1500, warmupTime: 500, iterations: 20 } as const;

for (const materialCount of [32, 256]) {
  describe(`${ROWS} rigid rows / ${materialCount} materials`, () => {
    const f = fixture(materialCount);
    let candidates = 0;
    for (const batch of f.plan.batches) candidates += batch.visibleCapacity;
    console.log(
      `ROWBATCH-STRUCT rows=${ROWS} materials=${materialCount} batches=${f.plan.batches.length} candidates=${f.plan.candidateCount} summedCapacity=${candidates}`,
    );
    const transforms = [0, 1].map((phase) =>
      f.snapshots.map((snapshot) => {
        const world = new Float32Array(snapshot.transform.world);
        world[13] = phase + 1;
        return world;
      }),
    );
    let frame = 0;

    bench(
      'steady: no changes, apply + query + retained selection',
      () => {
        f.frame(f.scene.apply([]));
      },
      OPTIONS,
    );

    bench(
      'cold selection: rebuild GpuDrawSelection + ownsAll over every row',
      () => {
        f.ownAll(new GpuDrawSelection(f.plan.batches));
      },
      OPTIONS,
    );

    bench(
      'transforms: every row world matrix changes',
      () => {
        const worlds = transforms[frame++ % 2] as Float32Array[];
        f.frame(
          f.scene.apply(f.snapshots.map((s, i) => ({ kind: 'update' as const, worldId: 0, entityKey: s.entityKey, world: worlds[i] as Float32Array }))),
        );
      },
      OPTIONS,
    );

    let edit = 0;
    bench(
      'material edit: one material numeric value changes',
      () => {
        const resource = f.materials[edit % materialCount] as MaterialResource;
        resource.adopt({ ...resource.snapshot, roughness: (edit++ % 100) / 100 });
        f.frame({ ...f.scene.apply([]), materialUpdates: [resource] });
      },
      OPTIONS,
    );
  });
}

describe(`${ROWS} Visibility entities / 1% intent toggles`, () => {
  const world = new World({ assets: new AssetRegistry() });
  const entities = Array.from(
    { length: ROWS },
    () => world.spawn({ component: Visibility, data: { state: VisibilityStateValue.visible } }).unwrap(),
  );
  resolveVisibility(world);
  const stride = 100;
  let frame = 0;
  const toggle = (state: number) => {
    for (let i = frame % stride; i < ROWS; i += stride)
      world.set(entities[i] as (typeof entities)[number], Visibility, { state }).unwrap();
  };
  bench(
    'steady: no Visibility change',
    () => {
      resolveVisibility(world);
    },
    OPTIONS,
  );
  bench(
    '1% of rows toggle hidden/visible',
    () => {
      toggle(frame % 2 === 0 ? VisibilityStateValue.hidden : VisibilityStateValue.visible);
      frame++;
      const snapshot = resolveVisibility(world);
      if (snapshot.effective(entities[0] as (typeof entities)[number]) === undefined) throw new Error('lost intents');
    },
    OPTIONS,
  );
});
