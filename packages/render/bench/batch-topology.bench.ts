import { vec3 } from '@forgeax/engine-math';
import {
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { bench, describe } from 'vitest';
import { BatchTopology } from '../src/gpu-driven/batch-topology';
import type { PreparedGpuDrivenDraw } from '../src/gpu-driven/prepared-draw';
import { MaterialResource } from '../src/material-resource';
import type { MaterialSnapshot, RenderableSnapshot } from '../src/render-system-extract';
import { RenderScene } from '../src/scene/render-scene';

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
  skinPaletteAddress: receipt.skinPaletteAddress,
  topology: 'triangle-list',
  indexed: true,
  first: 0,
  count: 36,
  baseVertex: 0,
};

const materialValues: readonly MaterialSnapshot[] = Array.from({ length: 32 }, (_, materialHandle) => ({
    baseColor: vec3.create(1, 1, 1),
    metallic: 0,
    roughness: 0.5,
    materialHandle,
    materialShaderId: prepared.identity.material,
    materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    paramSnapshot: Object.fromEntries(STANDARD_PIPELINE_PARAM_SCHEMA.map((entry) => [entry.name, 'default' in entry ? entry.default : undefined])),
    passes: [{ name: 'forward', program: { module: prepared.identity.material }, renderState: { tags: { LightMode: 'Forward' } } }],
    textureHandles: new Map(),
    samplerHandles: new Map(),
}));

function snapshot(entityKey: number, material: MaterialResource): RenderableSnapshot {
  return {
    assetHandle: 7,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [{
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
        draw: { kind: 'indexed', first: prepared.first, count: prepared.count, baseVertex: prepared.baseVertex, topology: prepared.topology },
        deformation: 'rigid',
      },
      prepared,
    }],
  };
}

function publication(): RenderableSnapshot[] {
  const materials = structuredClone(materialValues).map((value) => new MaterialResource(value));
  return Array.from({ length: 2000 }, (_, entityKey) => {
    const material = materials[entityKey % materials.length];
    if (material === undefined) throw new Error('Missing publication material');
    return snapshot(entityKey, material);
  });
}

// CPU preparation only: source projection and structured cloning are outside
// the timed path. This is not a backend throughput or displayed-FPS benchmark.
describe('BatchTopology 2000 published rigid draws', () => {
  const initial = publication();
  const projection = new RenderScene();
  projection.reset(initial);
  const topology = new BatchTopology();
  topology.rebuild(projection.slotsSnapshot());
  if (topology.query(topology.sourcePlan(), undefined).candidateCount !== 2000 || topology.query(topology.sourcePlan(), undefined).batches.length !== 32)
    throw new Error('Benchmark requires 2000 draws sharing 32 material resources');
  const deltas = [publication(), publication()].map((rows) =>
    projection.apply(rows.map((row) => ({ kind: 'update' as const, worldId: 0, entityKey: row.entityKey, snapshot: row }))),
  );
  let frame = 0;
  bench('equal cloned material/schema records', () => {
    const delta = deltas[frame++ % deltas.length];
    if (delta === undefined) throw new Error('missing publication delta');
    topology.apply(delta);
    topology.query(topology.sourcePlan(), undefined);
  }, { time: 1500, warmupTime: 500, iterations: 40 });
});
