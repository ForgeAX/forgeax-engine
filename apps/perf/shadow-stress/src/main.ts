import type { AssetHandle } from '@forgeax/engine-types';
import { createApp } from '@forgeax/engine-app/browser';

import { defineComponent, type EntityHandle, Update } from '@forgeax/engine-ecs';
import {
  createCapsuleGeometry,
  createSphereGeometry,
  packInterleavedVertexAttributes,
} from '@forgeax/engine-geometry';
import { createProfiler } from '@forgeax/engine-profiler';
import {
  ANTIALIAS_TAA,
  Camera,
  CapsuleShadow,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  Instances,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  PointLightShadow,
  perspective,
  type CapsuleShadowInspection,
  type GpuDrivenProductionInspection,
  type RenderFrameCacheInspection,
  type ShadowRasterInspection,
  SpotLight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine-render';
import { TransparentSort } from '@forgeax/engine-render/authoring';
import { Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  cameraPose,
  pointLightPositions,
  characterPositions,
  DIRECTIONAL_CASCADE_COUNT,
  DIRECTIONAL_LIGHT_DIRECTION,
  groundHalfExtent,
  parseWorkloadOptions,
  SPOT_LIGHT_COUNT,
  spotLightPositions,
  debrisChunks,
  LOD_SCREEN_COVERAGE,
  LOD_SPHERE_RADIUS,
  lodGridPositions,
  occasionalPositions,
  occasionalPushFrame,
  spawnStormPositions,
  staticCasterChunks,
  transparentPositions,
  type WorkloadOptions,
  workloadFingerprint,
  writeMoverTransforms,
} from './workload';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const TAG = '[perf-shadow-stress]';
const ALPHA_BLEND = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;
const FIXED_DELTA_SECONDS = 1 / 60;
// Smoke default totals 60 frames (profile + sample + one settle frame);
// longer windows are opt-in through the query.
const DEFAULT_PROFILE_FRAMES = 30;
const DEFAULT_SAMPLE_FRAMES = 29;
const PROFILE_EVENT_LIMIT = 16_384;

const SwayJoint = defineComponent('ShadowStressSwayJoint', { phase: { type: 'f32', default: 0 } });

export interface ShadowRasterSample {
  readonly frame: number;
  readonly passCount: number;
  readonly drawCount: number;
  readonly viewCount: number;
  readonly staticLayerViewCount: number;
  /** Static-layer views re-rastered this frame. */
  readonly staticMissCount: number;
  /** Static-layer misses that re-rastered only dirty regions over retained depth. */
  readonly staticPartialCount: number;
  readonly texelCulled: number;
  /** Final-layer casters whose receivers the camera HZB hides (Deferred only). */
  readonly cameraCulled: number;
  readonly misses: readonly string[];
}

/** Per-frame GPU-driven production counters; the upload rows are the renderer's single choke points. */
export interface GpuDrivenSample {
  readonly frame: number;
  readonly planRebuildBatches: number;
  readonly planRebuildCandidates: number;
  readonly lodSelectionChanges: number;
  readonly filteredPlanBuilds: number;
  readonly preparedBatchBuilds: number;
  readonly filteredBatchBuilds: number;
  readonly sceneTableUploadBytes: number;
  readonly sharedInputUploadBytes: number;
  readonly batchUploadBytes: number;
  readonly paletteUploadBytes: number;
  readonly shadowCasterFlips: number;
  readonly shadowCasterPendingPromotions: number;
  /** Lifetime cache counters; the summary derives window hit rates from deltas. */
  readonly frameCaches: RenderFrameCacheInspection & {
    readonly residencyValidation: { readonly hits: number; readonly misses: number };
  };
}

export interface ShadowStressEvidence {
  readonly backend: 'webgpu';
  readonly workloadFingerprint: string;
  readonly options: WorkloadOptions;
  /** Unsampled frames before profiling, so caster classes reach steady state. */
  readonly warmupFrames: number;
  readonly profileFrames: number;
  readonly sampleFrames: number;
  readonly postSpawn: {
    readonly staticChunkCount: number;
    readonly staticCasterCount: number;
    readonly moverCount: number;
    readonly characterCount: number;
    readonly spotShadowCount: number;
    readonly directionalCascadeCount: number;
  };
  /** Workload Updates after the first ready presentation has completed. */
  frameProgress: number;
  /** Updates before the first ready GPU completion; never part of the sample window. */
  preparationFrames: number;
  preparationCompletedFrames: number;
  readyFrameId: number | null;
  completedFrames: number;
  pendingMeasuredFrames: number;
  simulationSeconds: number;
  appRendererErrors: Array<{ readonly code: string; readonly hint: string }>;
  profileCapture: unknown;
  profileOverhead: { readonly profilerEventObjectAllocations: number };
  shadowRasterSamples: ShadowRasterSample[];
  gpuDrivenSamples: GpuDrivenSample[];
  /** Last frames after the sampled window, which an opt-in RHI capture records. */
  trailingSamples: Array<{ readonly raster: ShadowRasterSample; readonly gpuDriven: GpuDrivenSample }>;
  capsuleShadow: CapsuleShadowInspection | null;
  /** Per-frame GPU durations keyed `passKind:passName`, plus the `TOTAL` sum; `gpuTiming=1` only. */
  gpuPassNanos: Record<string, number[]>;
}

declare global {
  interface Window {
    __forgeaxShadowStress?: ShadowStressEvidence;
  }
}

function errorText(error: unknown, depth = 0): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const record = error as {
    readonly code?: unknown;
    readonly hint?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
    readonly detail?: { readonly cause?: unknown };
  };
  const text = `${String(record.code ?? 'unknown')}: ${String(record.hint ?? record.message ?? error)}`;
  const cause = record.detail?.cause ?? record.cause;
  return cause === undefined || depth >= 4 ? text : `${text} <- ${errorText(cause, depth + 1)}`;
}

function sampleShadowRaster(frame: number, raster: ShadowRasterInspection): ShadowRasterSample {
  const misses: string[] = [];
  let staticLayerViewCount = 0;
  let staticMissCount = 0;
  let staticPartialCount = 0;
  let texelCulled = 0;
  let cameraCulled = 0;
  for (const view of raster.views) {
    texelCulled += view.texelCulled ?? 0;
    cameraCulled += view.cameraCulled ?? 0;
    const layer = view.identity.layer === undefined ? '' : `.${view.identity.layer}`;
    if (layer !== '') staticLayerViewCount++;
    if (view.cache === 'miss') {
      if (view.identity.layer === 'static') staticMissCount++;
      if (view.dirtyRectCount !== undefined) staticPartialCount++;
      misses.push(`${view.identity.kind}${layer}:${view.identity.index}:${view.invalidationReason}`);
    }
  }
  return {
    frame,
    passCount: raster.passCount,
    drawCount: raster.drawCount,
    viewCount: raster.views.length - staticLayerViewCount,
    staticLayerViewCount,
    staticMissCount,
    staticPartialCount,
    texelCulled,
    cameraCulled,
    misses,
  };
}

function sampleGpuDriven(
  frame: number,
  scene: { readonly gpuDriven: GpuDrivenProductionInspection; readonly frameCaches: RenderFrameCacheInspection },
): GpuDrivenSample {
  const inspection = scene.gpuDriven;
  return {
    frame,
    planRebuildBatches: inspection.planRebuildBatches,
    planRebuildCandidates: inspection.planRebuildCandidates,
    lodSelectionChanges: inspection.lodSelectionChanges,
    filteredPlanBuilds: inspection.filteredPlanBuilds,
    preparedBatchBuilds: inspection.preparedBatchBuilds,
    filteredBatchBuilds: inspection.filteredBatchBuilds,
    sceneTableUploadBytes: inspection.sceneTableUploadBytes,
    sharedInputUploadBytes: inspection.sharedInputUploadBytes,
    batchUploadBytes: inspection.batchUploadBytes,
    paletteUploadBytes: inspection.paletteUploadBytes,
    shadowCasterFlips: inspection.shadowCasterFlips,
    shadowCasterPendingPromotions: inspection.shadowCasterPendingPromotions,
    frameCaches: {
      ...scene.frameCaches,
      residencyValidation: {
        hits: inspection.cpuValidationCacheHits,
        misses: inspection.cpuValidationScans,
      },
    },
  };
}

function sphere(widthSegments: number, heightSegments: number): MeshAsset {
  const mesh = createSphereGeometry(LOD_SPHERE_RADIUS, widthSegments, heightSegments);
  if (!mesh.ok) throw mesh.error;
  return mesh.value;
}

function skinnedCapsule(): MeshAsset {
  const capsule = createCapsuleGeometry(0.3, 1.2, 4, 12);
  if (!capsule.ok) throw capsule.error;
  const positions = capsule.value.attributes.position as Float32Array;
  const vertexCount = positions.length / 3;
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const upper = Math.min(1, Math.max(0, ((positions[vertex * 3 + 1] ?? 0) + 0.3) / 0.6));
    skinIndex[vertex * 4 + 1] = 1;
    skinWeight[vertex * 4] = 1 - upper;
    skinWeight[vertex * 4 + 1] = upper;
  }
  const attributes = { ...capsule.value.attributes, skinIndex, skinWeight };
  const packed = packInterleavedVertexAttributes(attributes, vertexCount);
  if (!packed.ok) throw packed.error;
  return { ...capsule.value, vertices: packed.value.vertices, attributes };
}

function skinnedMaterial(): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::pbr-skin' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
      {
        name: 'ShadowCaster',
        program: { module: 'forgeax::default-shadow-caster' },
        renderState: { tags: { LightMode: 'ShadowCaster' }, passKind: 'shadow-caster' },
      },
    ],
    values: {
      baseColor: [0.85, 0.4, 0.2, 1],
      metallic: 0.05,
      roughness: 0.6,
      emissive: [0, 0, 0],
      emissiveIntensity: 0,
      occlusionStrength: 1,
    },
  };
}

function profileDetail(raw: string | null): 'owner' | 'passes' | 'nested' {
  return raw === 'owner' || raw === 'nested' ? raw : 'passes';
}

function nonNegativeInteger(raw: string | null, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function positiveInteger(raw: string | null, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error(`${TAG} missing <canvas id="app">`);
const params = new URLSearchParams(window.location.search);
const parsed = parseWorkloadOptions(params);
if (!parsed.ok) {
  console.error(`${TAG} ${parsed.error.code}: ${parsed.error.hint}`);
} else {
  void bootstrap(canvas, parsed.value);
}

async function bootstrap(target: HTMLCanvasElement, options: WorkloadOptions): Promise<void> {
  const profileFrames = positiveInteger(params.get('profileFrames'), DEFAULT_PROFILE_FRAMES);
  const sampleFrames = positiveInteger(params.get('sampleFrames'), DEFAULT_SAMPLE_FRAMES);
  const warmupFrames = nonNegativeInteger(params.get('warmupFrames'), 0);
  const profilerAllocations = { profilerEventObjectAllocations: 0 };
  const profiler = createProfiler({ allocationReport: profilerAllocations });
  const appResult = await createApp(
    target,
    {
      profiler,
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        renderPath: options.renderPath,
        gpuOcclusion: options.gpuOcclusion,
      },
      ...(options.gpuPassTiming ? { gpuPassTiming: {} } : {}),
      time: { fixedDeltaSeconds: FIXED_DELTA_SECONDS, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
    },
    forgeaxBundlerAdapter(),
  );
  if (!appResult.ok) {
    console.error(`${TAG} createApp ${errorText(appResult.error)}`);
    return;
  }
  const app = appResult.value;
  const assets = app.assets;
  if (assets === undefined) throw new Error('App asset service is unavailable');
  const gpuPassNanos: Record<string, number[]> = {};
  if (options.gpuPassTiming) {
    app.renderer.subscribe((event) => {
      if (event.kind !== 'frame-submitted') return;
      void app.renderer.observe(event.receipt, { include: ['timings'] }).then((observed) => {
        const timings = observed.ok ? observed.value.timings : undefined;
        if (timings === undefined || (timings.status !== 'complete' && timings.status !== 'partial')) return;
        const perPass: Record<string, number> = { TOTAL: 0 };
        for (const pass of timings.frame.passes) {
          if (pass.status !== 'measured') continue;
          const key = `${pass.passKind}:${pass.passName}`;
          perPass[key] = (perPass[key] ?? 0) + pass.durationNanoseconds;
          perPass.TOTAL = (perPass.TOTAL ?? 0) + pass.durationNanoseconds;
        }
        for (const [key, nanos] of Object.entries(perPass)) (gpuPassNanos[key] ??= []).push(nanos);
      });
    });
  }
  const world = app.world;
const primitiveCube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  const errors: ShadowStressEvidence['appRendererErrors'] = [];
  app.onError((error) => {
    const record = { code: error.code, hint: errorText(error) };
    errors.push(record);
    console.error(`${TAG} engine error ${record.code}: ${record.hint}`);
  });

  const groundMaterial = assets.create(Materials.standard({ baseColor: [0.62, 0.64, 0.6, 1], roughness: 0.9 })).unwrap();
  const staticMaterial = assets.create(Materials.standard({ baseColor: [0.34, 0.48, 0.72, 1], roughness: 0.55 })).unwrap();
  const moverMaterial = assets.create(Materials.standard({ baseColor: [0.9, 0.75, 0.25, 1], roughness: 0.4 })).unwrap();

  const groundExtent = groundHalfExtent(options.camera);
  const declaredStatic = options.mobilityStatic
    ? [{ component: Mobility, data: { kind: MobilityKindValue.static } }]
    : [];
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [0, -0.05, 0], quat: [0, 0, 0, 1], scale: [groundExtent * 2, 0.1, groundExtent * 2] },
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [groundMaterial] } },
      ...declaredStatic,
    )
    .unwrap();

  const chunks = staticCasterChunks(options);
  for (const transforms of chunks) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [staticMaterial] } },
        { component: Instances, data: { transforms } },
        ...declaredStatic,
      )
      .unwrap();
  }

  for (const transforms of debrisChunks(options)) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
        { component: MeshFilter, data: { assetHandle: primitiveCube } },
        { component: MeshRenderer, data: { materials: [staticMaterial] } },
        { component: Instances, data: { transforms } },
        ...declaredStatic,
      )
      .unwrap();
  }

  const moverTransforms = new Float32Array(options.moverCount * 16);
  writeMoverTransforms(moverTransforms, options.moverCount, 0);
  const mover: EntityHandle | undefined =
    options.moverCount === 0
      ? undefined
      : world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
            { component: MeshFilter, data: { assetHandle: primitiveCube } },
            { component: MeshRenderer, data: { materials: [moverMaterial] } },
            { component: Instances, data: { transforms: moverTransforms } },
          )
          .unwrap();

  const occasional: EntityHandle[] = [];
  const occasionalBase = occasionalPositions(options.occasionalCount);
  for (let index = 0; index < options.occasionalCount; index++) {
    const pos: [number, number, number] = [
      occasionalBase[index * 3] ?? 0,
      occasionalBase[index * 3 + 1] ?? 0,
      occasionalBase[index * 3 + 2] ?? 0,
    ];
    occasional.push(
      world
        .spawn(
          { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.8, 0.8, 0.8] } },
          { component: MeshFilter, data: { assetHandle: primitiveCube } },
          { component: MeshRenderer, data: { materials: [moverMaterial] } },
        )
        .unwrap(),
    );
  }

  if (options.transparentCount > 0) {
    const transparentMaterial = assets.create(Materials.standard({
        baseColor: [0.3, 0.8, 0.9, 0.45],
        roughness: 0.3,
        renderState: { blend: ALPHA_BLEND, depthWriteEnabled: false },
        queue: 3000,
      })).unwrap();
    const configured = TransparentSort.configure(world, { mode: TransparentSort.distance, yzAlpha: 1 });
    if (!configured.ok) throw configured.error;
    const transparent = transparentPositions(options.transparentCount);
    for (let index = 0; index < options.transparentCount; index++) {
      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [transparent[index * 3] ?? 0, transparent[index * 3 + 1] ?? 0, transparent[index * 3 + 2] ?? 0],
              quat: [0, 0, 0, 1],
              scale: [0.7, 0.7, 0.7],
            },
          },
          { component: MeshFilter, data: { assetHandle: primitiveCube } },
          { component: MeshRenderer, data: { materials: [transparentMaterial] } },
        )
        .unwrap();
    }
  }

  if (options.lodGridSide > 0) {
    if (assets === undefined) {
      console.error(`${TAG} the LOD grid needs an App AssetRegistry to catalog the lower LOD meshes`);
      return;
    }
    const lodMeshes = [assets.create(sphere(12, 8)).unwrap(), assets.create(sphere(6, 4)).unwrap()] as const;
    const lodMesh = assets.create({
      ...sphere(32, 24),
      lods: [
        { mesh: lodMeshes[0], screenCoverage: LOD_SCREEN_COVERAGE[0] },
        { mesh: lodMeshes[1], screenCoverage: LOD_SCREEN_COVERAGE[1] },
      ],
    }).unwrap();
    const grid = lodGridPositions(options.lodGridSide);
    for (let index = 0; index < grid.length / 3; index++) {
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [grid[index * 3] ?? 0, grid[index * 3 + 1] ?? 0, grid[index * 3 + 2] ?? 0], quat: [0, 0, 0, 1] },
          },
          { component: MeshFilter, data: { assetHandle: lodMesh } },
          { component: MeshRenderer, data: { materials: [staticMaterial] } },
        )
        .unwrap();
    }
  }

  if (options.characterCount > 0) {
    const mesh: AssetHandle<'mesh'> = assets.create(skinnedCapsule()).unwrap();
    const material = assets.create(skinnedMaterial()).unwrap();
    const inverseBindMatrices = new Float32Array(32);
    for (const base of [0, 16]) {
      inverseBindMatrices[base] = 1;
      inverseBindMatrices[base + 5] = 1;
      inverseBindMatrices[base + 10] = 1;
      inverseBindMatrices[base + 15] = 1;
    }
    const skeleton = assets.create({
      kind: 'skeleton',
      inverseBindMatrices,
      jointCount: 2,
      bounds: new Float32Array([-1.5, -1.5, -1.5, 1.5, 1.5, 1.5]),
      // Authored rather than fitted: the procedural capsule has no interior
      // cylinder rows, so a per-joint point cloud would not span the limb.
      shadowCapsules: {
        joints: new Uint16Array([0, 1]),
        shapes: new Float32Array([0, -0.6, 0, 0, 0, 0, 0.28, 0, 0, 0, 0, 0.6, 0, 0.28]),
      },
    }).unwrap();
    const positions = characterPositions(options.characterCount);
    for (let index = 0; index < options.characterCount; index++) {
      const pos: [number, number, number] = [
        positions[index * 3] ?? 0,
        positions[index * 3 + 1] ?? 0,
        positions[index * 3 + 2] ?? 0,
      ];
      const root = world.spawn({ component: Transform, data: { pos, quat: [0, 0, 0, 1] } }).unwrap();
      const upper = world
        .spawn(
          { component: Transform, data: { pos, quat: [0, 0, 0, 1] } },
          { component: SwayJoint, data: { phase: index * 0.7 } },
        )
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
          {
            component: Skin,
            data: { skeleton, joints: new Uint32Array([root as unknown as number, upper as unknown as number]) },
          },
          ...(options.capsuleShadow ? [{ component: CapsuleShadow, data: {} }] : []),
        )
        .unwrap();
    }
  }

  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [...DIRECTIONAL_LIGHT_DIRECTION],
        intensity: 2.5,
        castShadow: true,
        cascadeCount: DIRECTIONAL_CASCADE_COUNT,
        mapSize: 2048,
        shadowDistance: 90,
      },
    })
    .unwrap();
  const spots = spotLightPositions();
  for (let index = 0; index < SPOT_LIGHT_COUNT; index++) {
    const pos: [number, number, number] = [spots[index * 3] ?? 0, spots[index * 3 + 1] ?? 0, spots[index * 3 + 2] ?? 0];
    const length = Math.hypot(pos[0], pos[1], pos[2]);
    world
      .spawn(
        { component: Transform, data: { pos, quat: [0, 0, 0, 1] } },
        {
          component: SpotLight,
          data: {
            direction: [-pos[0] / length, -pos[1] / length, -pos[2] / length],
            color: [1, 0.92, 0.8],
            intensity: 40,
            range: 40,
            innerConeDeg: 20,
            outerConeDeg: 35,
            castShadow: true,
            mapSize: 1024,
          },
        },
      )
      .unwrap();
  }

  const points = pointLightPositions(options.pointCount);
  for (let index = 0; index < options.pointCount; index++) {
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [points[index * 3] ?? 0, points[index * 3 + 1] ?? 0, points[index * 3 + 2] ?? 0],
            quat: [0, 0, 0, 1],
          },
        },
        { component: PointLight, data: { color: [0.8, 0.9, 1], intensity: 20, range: 25 } },
        { component: PointLightShadow, data: { farPlane: 25 } },
      )
      .unwrap();
  }

  const initialPose = cameraPose(options.camera, 0, options.lodOscillate);
  world
    .spawn(
      { component: Transform, data: { pos: initialPose.pos, quat: initialPose.quat } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 200 }),
          clearColor: [0.04, 0.05, 0.08, 1],
          tonemap: TONEMAP_ACES_FILMIC,
          ...(options.taa ? { antialias: ANTIALIAS_TAA } : {}),
        },
      },
    )
    .unwrap();

  const evidence: ShadowStressEvidence = {
    backend: 'webgpu',
    workloadFingerprint: workloadFingerprint(options),
    options,
    warmupFrames,
    profileFrames,
    sampleFrames,
    postSpawn: {
      staticChunkCount: chunks.length,
      staticCasterCount: chunks.reduce((total, chunk) => total + chunk.length / 16, 0),
      moverCount: options.moverCount,
      characterCount: options.characterCount,
      spotShadowCount: SPOT_LIGHT_COUNT,
      directionalCascadeCount: DIRECTIONAL_CASCADE_COUNT,
    },
    frameProgress: 0,
    preparationFrames: 0,
    preparationCompletedFrames: 0,
    readyFrameId: null,
    completedFrames: 0,
    pendingMeasuredFrames: 0,
    simulationSeconds: 0,
    appRendererErrors: errors,
    profileCapture: null,
    capsuleShadow: null,
    profileOverhead: profilerAllocations,
    shadowRasterSamples: [],
    gpuDrivenSamples: [],
    trailingSamples: [],
    gpuPassNanos,
  };
  Object.assign(globalThis, { __forgeaxShadowStress: evidence });

  const startProfile = (): boolean => {
    const capture = profiler.startCapture({
      frameLimit: profileFrames,
      eventLimit: PROFILE_EVENT_LIMIT,
      detail: profileDetail(params.get('profileDetail')),
    });
    if (capture.ok) return true;
    console.error(`${TAG} profiler ${errorText(capture.error)}`);
    errors.push({ code: 'profiler-start-failed', hint: errorText(capture.error) });
    return false;
  };
  app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    const measured = evidence.readyFrameId !== null;
    if (measured && event.receipt.presentation === 'pending') {
      errors.push({
        code: 'presentation-not-ready',
        hint: `Workload frame ${evidence.frameProgress}: ${event.receipt.presentationPendingReason?.code}`,
      });
    }
    void event.receipt.completed.then((result) => {
      if (!result.ok) {
        errors.push({ code: result.error.code, hint: errorText(result.error) });
        return;
      }
      if (!measured) {
        evidence.preparationCompletedFrames += 1;
        if (event.receipt.presentation === 'ready' && evidence.readyFrameId === null) {
          evidence.readyFrameId = event.frameId;
          // App retains its profiler session through the current frame.
          if (warmupFrames === 0) startProfile();
        }
      } else {
        evidence.completedFrames += 1;
        if (event.receipt.presentation !== 'ready') evidence.pendingMeasuredFrames += 1;
      }
    });
  });

  world
    .addSystem(Update, {
      name: 'shadow-stress-animate',
      queries: [
        { write: [Transform], read: [SwayJoint] },
        { write: [Transform], with: [Camera] },
      ],
      fn: (_world, results) => {
        if (evidence.readyFrameId === null) {
          evidence.preparationFrames += 1;
          return;
        }
        evidence.frameProgress += 1;
        evidence.simulationSeconds += FIXED_DELTA_SECONDS;
        const seconds = evidence.simulationSeconds;
        for (const row of results[0] ?? []) {
          const half = 0.25 * Math.sin(seconds * 2 + row.get(SwayJoint).phase);
          const quaternion = row.mut(Transform).quat;
          quaternion[0] = 0;
          quaternion[1] = 0;
          quaternion[2] = Math.sin(half);
          quaternion[3] = Math.cos(half);
        }
        if (options.camera !== 'static' || options.lodOscillate) {
          const pose = cameraPose(options.camera, seconds, options.lodOscillate);
          for (const row of results[1] ?? []) {
            const transform = row.mut(Transform);
            transform.pos.set(pose.pos);
            transform.quat.set(pose.quat);
          }
        }
        const frame = evidence.frameProgress;
        // The capture closes after its last rendered frame, so it becomes
        // readable during a later Update.
        if (evidence.profileCapture === null) {
          const latest = profiler.latestCapture();
          if (latest !== undefined) evidence.profileCapture = latest;
        }
        if (warmupFrames > 0 && frame === warmupFrames) startProfile();
        // Renderer inspection reflects the frame rendered before this Update.
        const sampled = frame - warmupFrames;
        if (sampled > 1 && sampled <= profileFrames + sampleFrames) {
          evidence.gpuDrivenSamples.push(sampleGpuDriven(frame - 1, app.renderer.inspect().renderScene));
        }
        if (sampled > profileFrames && sampled <= profileFrames + sampleFrames) {
          const inspection = app.renderer.inspect();
          evidence.shadowRasterSamples.push(sampleShadowRaster(frame - 1, inspection.shadowRaster));
          evidence.capsuleShadow = inspection.capsuleShadow ?? null;
        }
        if (sampled > profileFrames + sampleFrames) {
          const inspection = app.renderer.inspect();
          evidence.trailingSamples.push({
            raster: sampleShadowRaster(frame - 1, inspection.shadowRaster),
            gpuDriven: sampleGpuDriven(frame - 1, inspection.renderScene),
          });
          if (evidence.trailingSamples.length > 16) evidence.trailingSamples.shift();
        }
      },
    })
    .unwrap();
  if (mover !== undefined) {
    world
      .addSystem(Update, {
        name: 'shadow-stress-movers',
        queries: [{ write: [Instances] }],
        fn: (world) => {
          if (evidence.readyFrameId === null) return;
          const active = options.activeMoverCount;
          writeMoverTransforms(moverTransforms, options.moverCount, evidence.simulationSeconds, active);
          if (options.moverWrite === 'set') {
            world.set(mover, Instances, { transforms: moverTransforms }).unwrap();
          } else if (active > 0) {
            world
              .setArrayRange(mover, Instances, 'transforms', 0, moverTransforms.subarray(0, active * 16))
              .unwrap();
          }
        },
      })
      .unwrap();
  }

  if (occasional.length > 0) {
    const scale: [number, number, number] = [0.8, 0.8, 0.8];
    world
      .addSystem(Update, {
        name: 'shadow-stress-occasional',
        queries: [{ write: [Transform] }],
        fn: (world) => {
          if (evidence.readyFrameId === null) return;
          const period = options.occasionalPeriod;
          const frame = evidence.frameProgress % period;
          const lift = (Math.floor(evidence.frameProgress / period) % 2) * 0.2;
          for (let index = 0; index < occasional.length; index++) {
            if (occasionalPushFrame(index, occasional.length, period) !== frame) continue;
            const entity = occasional[index];
            if (entity === undefined) continue;
            const pos: [number, number, number] = [
              occasionalBase[index * 3] ?? 0,
              (occasionalBase[index * 3 + 1] ?? 0) + lift + 0.1,
              occasionalBase[index * 3 + 2] ?? 0,
            ];
            world.set(entity, Transform, { pos, quat: [0, 0, 0, 1], scale }).unwrap();
          }
        },
      })
      .unwrap();
  }
  if (options.spawnStormCount > 0) {
    let storm: EntityHandle[] = [];
    world
      .addSystem(Update, {
        name: 'shadow-stress-spawn-storm',
        queries: [],
        fn: (_world, _results, commands) => {
          if (evidence.readyFrameId === null) return;
          for (const entity of storm) commands.despawn(entity);
          const positions = spawnStormPositions(options.spawnStormCount, evidence.frameProgress);
          const next: EntityHandle[] = [];
          for (let index = 0; index < options.spawnStormCount; index++) {
            const pos: [number, number, number] = [
              positions[index * 3] ?? 0,
              positions[index * 3 + 1] ?? 0,
              positions[index * 3 + 2] ?? 0,
            ];
            next.push(
              commands.spawn(
                { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } },
                { component: MeshFilter, data: { assetHandle: primitiveCube } },
                { component: MeshRenderer, data: { materials: [moverMaterial] } },
              ),
            );
          }
          storm = next;
        },
      })
      .unwrap();
  }

  const started = app.start();
  if (!started.ok) {
    console.error(`${TAG} app.start ${errorText(started.error)}`);
    return;
  }
  console.warn(`${TAG} running ${evidence.workloadFingerprint}`);
}
