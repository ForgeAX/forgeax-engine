import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  buildMeshAttributeMapForUvSets,
  deriveVertexLayoutProjection,
  unpackInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { buildProfileModel, createProfiler } from '@forgeax/engine-profiler';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { err, type MeshAsset, ok } from '@forgeax/engine-types';
import { bench, describe } from 'vitest';
import { createRenderer as constructRenderer } from '../../assembly/factory';
import {
  Camera,
  Lines,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointShapeValue,
  Points,
  perspective,
} from '../../index';
import { recordPointsLinesDraw } from '../../record/main-pass-geometry';
import { admitPointsLines } from '../admission';
import { PointsLinesExpansionCache } from '../expansion-cache';
import { type PointsLinesGpuResourceAdapter, PointsLinesPreparation } from '../prepare';
import { createPointsLinesLaneContract, createPointsLinesRecordPlan } from '../record';
import { createPreparedPointsLinesSnapshot as createPointsLinesSnapshot } from './snapshot-fixture';

const VERTEX_LAYOUT = deriveVertexLayoutProjection(buildMeshAttributeMapForUvSets(1));
const FLOATS_PER_VERTEX = VERTEX_LAYOUT.arrayStride / Float32Array.BYTES_PER_ELEMENT;
const POINT_COUNT = 10_000;
const SEGMENT_COUNT = 10_000;
const SAMPLE_COUNT = 30;
const BENCH_OPTIONS = { iterations: SAMPLE_COUNT } as const;

function buildMesh(topology: 'point-list' | 'line-list'): MeshAsset {
  const vertexCount = topology === 'point-list' ? POINT_COUNT : SEGMENT_COUNT * 2;
  const vertices = new Float32Array(vertexCount * FLOATS_PER_VERTEX);
  for (let index = 0; index < vertexCount; index += 1) {
    const offset = index * FLOATS_PER_VERTEX;
    vertices[offset] = (index % 100) / 50 - 1;
    vertices[offset + 1] = Math.floor(index / 100) / 100 - 1;
    vertices[offset + 2] = 0;
  }
  const indices = topology === 'line-list' ? new Uint32Array(vertexCount) : undefined;
  if (indices !== undefined) {
    for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  }
  const attributes = unpackInterleavedVertexAttributes(vertices, VERTEX_LAYOUT);
  if (attributes === undefined) throw new Error('Benchmark vertices must match their layout');
  return {
    kind: 'mesh',
    vertices,
    ...(indices === undefined ? {} : { indices }),
    attributes,
    aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: topology === 'line-list' ? vertexCount : 0,
        vertexCount,
        topology,
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'points-lines-bench' }],
  };
}

function snapshot(component: 'Points' | 'Lines') {
  return createPointsLinesSnapshot({
    worldId: 0,
    entityKey: component === 'Points' ? 10 : 11,
    component,
    meshHandle: 99,
    meshGeneration: 1,
    materialHandle: 100,
    materialGeneration: 1,
    style:
      component === 'Points'
        ? { kind: 'points', size: 8, sizeUnits: 'pixels', shape: 'circle' }
        : { kind: 'lines', width: 3 },
    layer: 0,
    visible: true,
    sourceBounds: [-1, -1, 0, 1, 1, 0],
    viewport: { width: 1280, height: 720, dpr: 1 },
    projection: new Float32Array(16),
  });
}

const MATERIAL = Materials.unlit([0.1, 0.9, 1, 1]);

function manifestUrl(): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
}

function buildDirectMesh(): MeshAsset {
  const vertices = new Float32Array(POINT_COUNT * FLOATS_PER_VERTEX);
  for (let index = 0; index < POINT_COUNT; index += 1) {
    const offset = index * FLOATS_PER_VERTEX;
    vertices[offset] = (index % 100) / 50 - 1;
    vertices[offset + 1] = Math.floor(index / 100) / 100 - 1;
  }
  const indices = new Uint32Array(Math.floor(POINT_COUNT / 3) * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  const attributes = unpackInterleavedVertexAttributes(vertices, VERTEX_LAYOUT);
  if (attributes === undefined) throw new Error('Benchmark vertices must match their layout');
  return {
    kind: 'mesh',
    vertices,
    indices,
    attributes,
    aabb: new Float32Array([-1, -1, 0, 1, 1, 0]),
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: POINT_COUNT,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'points-lines-direct-baseline' }],
  };
}

type RealRoute = {
  readonly renderer: Awaited<ReturnType<typeof constructRenderer>>;
  readonly profiler: ReturnType<typeof createProfiler>;
  readonly pointsLines: {
    readonly world: World;
    readonly lease: import('../../render-contract').RenderWorldLease;
  };
  readonly direct: {
    readonly world: World;
    readonly lease: import('../../render-contract').RenderWorldLease;
  };
};

function makeRealScene(
  renderer: RealRoute['renderer'],
  meshes: { readonly points: MeshAsset; readonly lines: MeshAsset },
  component: 'points-lines' | 'direct',
): RealRoute['pointsLines'] {
  const assets = new AssetRegistry({ shaderRegistry: renderer.assetRegistry.shaderRegistry });
  const world = new World({ assets });
  const materialHandle = assets.create(MATERIAL).unwrap();
  if (component === 'points-lines') {
    const pointMeshHandle = assets.create(meshes.points).unwrap();
    const lineMeshHandle = assets.create(meshes.lines).unwrap();
    world
      .spawn(
        {
          component: Transform,
          data: { pos: [-0.5, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
        { component: Points, data: { size: 8, shape: PointShapeValue.circle } },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0.5, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
        { component: MeshFilter, data: { assetHandle: lineMeshHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
        { component: Lines, data: { width: 3 } },
      )
      .unwrap();
  } else {
    const meshHandle = assets.create(meshes.points).unwrap();
    for (const x of [-0.5, 0.5]) {
      world
        .spawn(
          { component: Transform, data: { pos: [x, 0, -2], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
          { component: MeshFilter, data: { assetHandle: meshHandle } },
          { component: MeshRenderer, data: { materials: [materialHandle] } },
        )
        .unwrap();
    }
  }
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { ...perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) } },
    )
    .unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  world.update().unwrap();
  return { world, lease: attached.value };
}

async function createRealRoute(): Promise<RealRoute> {
  const profiler = createProfiler();
  const renderer = await constructRenderer(
    { width: 1280, height: 720, getContext: () => null },
    { rhi, profiler },
    { shaderManifestUrl: manifestUrl() },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  return {
    renderer,
    profiler,
    pointsLines: makeRealScene(renderer, { points: POINT_MESH, lines: LINE_MESH }, 'points-lines'),
    direct: makeRealScene(
      renderer,
      { points: buildDirectMesh(), lines: buildDirectMesh() },
      'direct',
    ),
  };
}

function drawRealFrame(route: RealRoute, scene: RealRoute['pointsLines']): void {
  const drawn = route.renderer.draw({
    leases: [scene.lease],
    camera: { lease: scene.lease },
    environment: { lease: scene.lease },
  });
  if (!drawn.ok) throw drawn.error;
}

async function captureProfile(route: RealRoute, scene: RealRoute['pointsLines']) {
  const capture = route.profiler.startCapture({
    frameLimit: 1,
    eventLimit: 10_000,
    detail: 'nested',
  });
  if (!capture.ok) throw capture.error;
  drawRealFrame(route, scene);
  const finished = capture.value.finish();
  if (!finished.ok) throw finished.error;
  const model = buildProfileModel(finished.value);
  if (!model.ok) throw model.error;
  return model.value;
}

type BenchResource = { readonly geometryKey: string; readonly bytes: number };

const RESOURCE_ADAPTER: PointsLinesGpuResourceAdapter<BenchResource> = {
  create: (geometry) => ok({ geometryKey: geometry.key, bytes: 0 }),
  upload: (_resource, geometry) => ok(geometry.derivedBytes),
  validate: (_resource, geometry) =>
    geometry.expandedVertexCount > 0 && geometry.expandedIndexCount > 0
      ? ok(undefined)
      : err(new Error('benchmark expansion is not drawable')),
  destroy: () => undefined,
};

function prepareWorkload(
  component: 'Points' | 'Lines',
  mesh: MeshAsset,
  cache: PointsLinesExpansionCache,
  preparation = new PointsLinesPreparation({ cache, adapter: RESOURCE_ADAPTER }),
) {
  const authored =
    component === 'Points' ? { points: { size: 8, shape: 1 } } : { lines: { width: 3 } };
  const admission = admitPointsLines({
    entity: component === 'Points' ? 10 : 11,
    mesh,
    material: MATERIAL,
    ...authored,
  });
  if (!admission.ok) throw admission.error;
  const retained = snapshot(component);
  const prepared = preparation.prepare(retained, mesh);
  if (!prepared.ok) throw prepared.error;
  const plan = createPointsLinesRecordPlan(
    retained,
    prepared.value.geometry,
    createPointsLinesLaneContract('direct', 'webgpu'),
  );
  const draws: string[] = [];
  const pass = {
    draw: () => draws.push('draw'),
    drawIndexed: () => draws.push('drawIndexed'),
  } as unknown as RhiRenderPassEncoder;
  recordPointsLinesDraw(pass, plan);
  if (draws.length !== 1) throw new Error(`${component} record path emitted ${draws.length} draws`);
  return { geometry: prepared.value.geometry, plan, preparation, draws };
}

function preparePair(
  cache: PointsLinesExpansionCache,
  pointMesh: MeshAsset,
  lineMesh: MeshAsset,
  preparations?: {
    points?: PointsLinesPreparation<BenchResource>;
    lines?: PointsLinesPreparation<BenchResource>;
  },
) {
  const points = prepareWorkload('Points', pointMesh, cache, preparations?.points);
  const lines = prepareWorkload('Lines', lineMesh, cache, preparations?.lines);
  return { points, lines };
}

function validateWorkload(pointMesh: MeshAsset, lineMesh: MeshAsset): void {
  const cache = new PointsLinesExpansionCache();
  const pair = preparePair(cache, pointMesh, lineMesh);
  const primitiveCount = POINT_COUNT + SEGMENT_COUNT;
  if (pair.points.geometry === pair.lines.geometry) {
    throw new Error('Points and Lines must not share an expansion cache entry');
  }
  if (pair.points.geometry.expandedVertexCount !== POINT_COUNT * 4) {
    throw new Error('Points expansion vertex count mismatch');
  }
  if (pair.lines.geometry.expandedIndexCount !== SEGMENT_COUNT * 6) {
    throw new Error('Lines expansion index count mismatch');
  }
  if (pair.points.plan.drawCount !== 1 || pair.lines.plan.drawCount !== 1) {
    throw new Error('Visible Points and Lines must each record one draw');
  }
  if (
    pair.points.geometry.expandedVertexCount + pair.lines.geometry.expandedVertexCount >
    primitiveCount * 4
  ) {
    throw new Error('Expanded vertex bound exceeded');
  }
  if (
    pair.points.geometry.expandedIndexCount + pair.lines.geometry.expandedIndexCount >
    primitiveCount * 6
  ) {
    throw new Error('Expanded index bound exceeded');
  }
  const offPath = cache.getOrCreate(
    { ...snapshot('Points'), component: undefined, style: undefined },
    pointMesh,
  );
  if (offPath.derivedBytes !== 0 || offPath.expandedVertexCount !== 0) {
    throw new Error('Off-path geometry must remain exact-zero');
  }
  if (offPath.derivedBytes !== 0) throw new Error('off-path derived bytes changed');
}

const POINT_MESH = buildMesh('point-list');
const LINE_MESH = buildMesh('line-list');
validateWorkload(POINT_MESH, LINE_MESH);
const REAL_ROUTE = await createRealRoute();
const REAL_PROFILE = await captureProfile(REAL_ROUTE, REAL_ROUTE.pointsLines);
const recordedPointsLines = REAL_ROUTE.renderer.inspect().renderScene.pointsLines;
if (
  recordedPointsLines.length !== 2 ||
  recordedPointsLines.some((entry) => entry.drawCount === 0 || entry.refusal !== undefined) ||
  !recordedPointsLines.some((entry) => entry.pointCount === POINT_COUNT) ||
  !recordedPointsLines.some((entry) => entry.segmentCount === SEGMENT_COUNT)
) {
  throw new Error('Points/Lines benchmark must draw its complete authored workload');
}
const DIRECT_PROFILE = await captureProfile(REAL_ROUTE, REAL_ROUTE.direct);

function phaseDeltas(): Readonly<Record<string, number>> {
  const direct = new Map(
    DIRECT_PROFILE?.phases.map((phase) => [
      `${phase.source}:${phase.phase}`,
      phase.p95DurationMicros ?? 0,
    ]) ?? [],
  );
  return Object.fromEntries(
    REAL_PROFILE?.phases.map((phase) => {
      const key = `${phase.source}:${phase.phase}`;
      return [key, (phase.p95DurationMicros ?? 0) - (direct.get(key) ?? 0)];
    }) ?? [],
  );
}

// biome-ignore lint/suspicious/noConsole: benchmark emits machine-readable evidence
console.info(
  JSON.stringify({
    workload: { points: POINT_COUNT, segments: SEGMENT_COUNT, samples: SAMPLE_COUNT },
    route: 'Renderer.extract-prepare-record',
    baseline: 'same-Renderer.direct-mesh',
    phases: phaseDeltas(),
    gpuTiming: {
      status: 'blocked',
      reason: 'no adapter-qualified timestamp owner exists for this RhiNull runner',
    },
  }),
);
let sink = 0;

describe('Points/Lines 10k + 10k benchmark', () => {
  bench(
    'same-Renderer direct baseline',
    () => {
      drawRealFrame(REAL_ROUTE, REAL_ROUTE.direct);
      sink ^= REAL_ROUTE.renderer.inspect().frame.frameId;
    },
    BENCH_OPTIONS,
  );

  bench(
    'Renderer extract prepare record',
    () => {
      drawRealFrame(REAL_ROUTE, REAL_ROUTE.pointsLines);
      sink ^= REAL_ROUTE.renderer.inspect().renderScene.pointsLines?.length ?? 0;
    },
    BENCH_OPTIONS,
  );

  bench(
    'Renderer warm extract prepare record',
    () => {
      drawRealFrame(REAL_ROUTE, REAL_ROUTE.pointsLines);
      sink ^= REAL_ROUTE.renderer.inspect().renderScene.pointsLines?.length ?? 0;
    },
    BENCH_OPTIONS,
  );

  bench(
    'Renderer inspection after record',
    () => {
      sink ^= REAL_ROUTE.renderer.inspect().renderScene.pointsLines?.length ?? 0;
    },
    BENCH_OPTIONS,
  );

  void sink;
});
