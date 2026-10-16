import { createApp } from '@forgeax/engine-app/browser';
import { createProfiler, buildProfileModel, validateProfileCapture } from '@forgeax/engine-profiler';
import {
  Update,
  World,
} from '@forgeax/engine-ecs';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import {
  Camera,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  SpotLight,
  TONEMAP_ACES_FILMIC,
  perspective,
} from '@forgeax/engine-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  PERF_WORKLOAD_SEED,
  DIRECTIONAL_LIGHT_CAST_SHADOW,
  DIRECTIONAL_LIGHT_COLOR,
  DIRECTIONAL_LIGHT_DIRECTION,
  DIRECTIONAL_LIGHT_INTENSITY,
  type WorkloadOptions,
  cubePositions,
  mulberry32,
  parseWorkloadOptions,
  positionsChecksum,
  workloadFingerprint,
  yawQuaternion,
} from './workload';

const PROFILE_FRAME_LIMIT = 180;
const PROFILE_EVENT_LIMIT = 8192;
const CUBE_SCALE = [0.32, 0.32, 0.32] as const;
const FIXED_DELTA_SECONDS = 1 / 60;

function errorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const record = error as { readonly code?: unknown; readonly hint?: unknown; readonly message?: unknown };
  return `${String(record.code ?? 'unknown')}: ${String(record.hint ?? record.message ?? error)}`;
}

function errorDetailText(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const detail = (error as { readonly detail?: unknown }).detail;
  if (detail === undefined) return '';
  try {
    return `; detail: ${JSON.stringify(detail, (_key, value: unknown) => {
      if (typeof value !== 'object' || value === null) return value;
      const record = value as { readonly code?: unknown; readonly expected?: unknown; readonly hint?: unknown; readonly detail?: unknown };
      if (record.code !== undefined || record.expected !== undefined || record.hint !== undefined) {
        return {
          code: record.code,
          expected: record.expected,
          hint: record.hint,
          ...(record.detail === undefined ? {} : { detail: record.detail }),
        };
      }
      return value;
    })}`;
  } catch {
    return '; detail: <unserializable>';
  }
}

export interface PerfEvidence {
  readonly backend: 'webgpu';
  readonly bootstrapMs: number;
  readonly workloadFingerprint: string;
  readonly seed: number;
  readonly requestedCounts: WorkloadOptions;
  readonly postSpawn: {
    readonly cubeCount: number;
    readonly pointLightCount: number;
    readonly spotLightCount: number;
    readonly directionalBaseline: {
      readonly count: number;
      readonly direction: readonly [number, number, number];
      readonly color: readonly [number, number, number];
      readonly intensity: number;
      readonly shadowCasterCount: number;
    };
    readonly meshHandleMatches: number;
    readonly materialHandleMatches: number;
    readonly positionChecksum: string;
  };
  frameProgress: number;
  processedCubeCount: number;
  processedCubeTotal: number;
  cameraRotationRadians: number;
  frameIntervalsMs: number[];
  cubeUpdateSamplesMs: number[];
  appRendererErrors: Array<{ readonly code: string; readonly hint: string }>;
  profileCapture: unknown;
  profileSummary: unknown;
  profileOverhead: { readonly profilerEventObjectAllocations: number };
  rendererInspection: unknown;
}

declare global {
  interface Window {
    __forgeaxPerf?: PerfEvidence;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('[perf-10k-cubes-lights] missing <canvas id="app">');

const params = new URLSearchParams(window.location.search);
// Short harnesses (the 60-frame Dawn smoke) close the profile window inside their frame budget.
const requestedProfileFrames = Number.parseInt(params.get('profileFrames') ?? '', 10);
const profileFrameLimit = requestedProfileFrames > 0 ? requestedProfileFrames : PROFILE_FRAME_LIMIT;
const parsed = parseWorkloadOptions(params);
if (!parsed.ok) {
  console.error(`[perf-10k-cubes-lights] ${parsed.error.code}: ${parsed.error.hint}`);
} else {
  void bootstrap(canvas, parsed.value);
}

async function bootstrap(target: HTMLCanvasElement, options: WorkloadOptions): Promise<void> {
  const bootstrapStart = performance.now();
  const profilerAllocations = { profilerEventObjectAllocations: 0 };
  const profilingEnabled = params.get('profile') !== '0';
  const profiler = profilingEnabled ? createProfiler({ allocationReport: profilerAllocations }) : undefined;
  const appResult = await createApp(
    target,
    {
      ...(profiler === undefined ? {} : { profiler }),
      standardProfile: {
        ...DEFAULT_STANDARD_PROFILE,
        lightCount: 32,
      },
      time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
    },
    forgeaxBundlerAdapter(),
  );
  if (!appResult.ok) {
    console.error(`[perf-10k-cubes-lights] createApp ${errorText(appResult.error)}`);
    return;
  }
  const app = appResult.value;
  const errors: PerfEvidence['appRendererErrors'] = [];
  app.onError((error) => {
    const record = {
      code: error.code,
      hint: `${error instanceof Error ? error.message : errorText(error)}${errorDetailText(error)}`,
    };
    errors.push(record);
    console.error(`[perf-10k-cubes-lights] engine error ${record.code}: ${record.hint}`);
  });
  const materialHandle = app.world.allocSharedRef('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        program: { module: 'forgeax::default-standard-pbr' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      },
    ],
    values: { baseColor: [0.34, 0.48, 0.72], metallic: 0.05, roughness: 0.58 },
  });
  const positions = cubePositions(options);
  for (let index = 0; index < options.cubeCount; index++) {
    const base = index * 3;
    app.world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [positions[base] ?? 0, positions[base + 1] ?? 0, positions[base + 2] ?? 0],
            quat: [0, 0, 0, 1],
            scale: CUBE_SCALE,
          },
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
  }

  app.world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [...DIRECTIONAL_LIGHT_DIRECTION],
        color: [...DIRECTIONAL_LIGHT_COLOR],
        intensity: DIRECTIONAL_LIGHT_INTENSITY,
        castShadow: DIRECTIONAL_LIGHT_CAST_SHADOW,
      },
    })
    .unwrap();

  const lightRandom = mulberry32(PERF_WORKLOAD_SEED ^ 0x9e3779b9);
  for (let index = 0; index < options.pointLightCount; index++) {
    const x = -18 + lightRandom() * 36;
    const y = -10 + lightRandom() * 20;
    const z = -18 + lightRandom() * 36;
    app.world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1] } },
      {
        component: PointLight,
        data: {
          color: [0.55 + lightRandom() * 0.45, 0.55 + lightRandom() * 0.45, 0.55 + lightRandom() * 0.45],
          intensity: 1.5 + lightRandom() * 1.5,
          range: 12,
        },
      },
    ).unwrap();
  }
  for (let index = 0; index < options.spotLightCount; index++) {
    const x = -18 + lightRandom() * 36;
    const y = -10 + lightRandom() * 20;
    const z = -18 + lightRandom() * 36;
    const length = Math.hypot(x, y, z) || 1;
    app.world.spawn(
      { component: Transform, data: { pos: [x, y, z], quat: [0, 0, 0, 1] } },
      {
        component: SpotLight,
        data: {
          direction: [-x / length, -y / length, -z / length],
          color: [0.65 + lightRandom() * 0.35, 0.65 + lightRandom() * 0.35, 0.65 + lightRandom() * 0.35],
          intensity: 2 + lightRandom() * 2,
          range: 16,
          innerConeDeg: 20,
          outerConeDeg: 40,
          castShadow: false,
        },
      },
    ).unwrap();
  }

  app.world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 80 }),
          clearColor: [0.005, 0.008, 0.02, 1],
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1.15,
        },
      },
    )
    .unwrap();

  const postSpawn = inspectSpawnedWorld(app.world, materialHandle);
  const evidence: PerfEvidence = {
    backend: 'webgpu',
    bootstrapMs: performance.now() - bootstrapStart,
    workloadFingerprint: workloadFingerprint(options),
    seed: PERF_WORKLOAD_SEED,
    requestedCounts: options,
    postSpawn,
    frameProgress: 0,
    processedCubeCount: 0,
    processedCubeTotal: 0,
    cameraRotationRadians: 0,
    frameIntervalsMs: [],
    cubeUpdateSamplesMs: [],
    appRendererErrors: errors,
    profileCapture: null,
    profileSummary: null,
    profileOverhead: profilerAllocations,
    rendererInspection: null,
  };
  Object.assign(globalThis, { __forgeaxPerf: evidence });
  const capture = profiler?.startCapture({ frameLimit: profileFrameLimit, eventLimit: PROFILE_EVENT_LIMIT });
  if (capture !== undefined && !capture.ok) {
    console.error(`[perf-10k-cubes-lights] profiler ${errorText(capture.error)}`);
    return;
  }
  let elapsed = 0;
  let lastFrameAt: number | undefined;
  app.world
    .addSystem(Update, {
      name: 'perf-10k-cubes-rotate',
      queries: [{ write: [Transform], with: [MeshFilter, MeshRenderer] }],
      fn: (_world, results) => {
        const frameAt = performance.now();
        if (lastFrameAt !== undefined) evidence.frameIntervalsMs.push(frameAt - lastFrameAt);
        lastFrameAt = frameAt;
        const start = performance.now();
        elapsed += FIXED_DELTA_SECONDS;
        let processed = 0;
        const spans = results[0]?.spans();
        if (spans === undefined || !spans.ok) {
          throw spans?.error ?? new Error('Transform query did not expose contiguous spans.');
        }
        for (const span of spans.value) {
          const quaternions = span.mut(Transform).quat;
          for (let index = 0; index < span.length; index += 1) {
            const angle = elapsed * (0.35 + (processed % 17) * 0.013) + processed * 0.0007;
            const half = angle * 0.5;
            const offset = index * 4;
            quaternions[offset] = 0;
            quaternions[offset + 1] = Math.sin(half);
            quaternions[offset + 2] = 0;
            quaternions[offset + 3] = Math.cos(half);
            processed += 1;
          }
        }
        evidence.frameProgress += 1;
        evidence.processedCubeCount = processed;
        evidence.processedCubeTotal += processed;
        if (evidence.cubeUpdateSamplesMs.length < 240) {
          evidence.cubeUpdateSamplesMs.push(performance.now() - start);
        }
        evidence.cameraRotationRadians = elapsed * 0.18;
        const latest = profiler?.latestCapture();
        if (latest !== undefined) {
          evidence.profileCapture = latest;
          const model = buildProfileModel(latest);
          evidence.profileSummary = model.ok
            ? { summary: model.value.summary, phases: model.value.phases }
            : model.error;
        }
        // Capture the previous frame's renderer-owned facts once, after the
        // profiler window has closed. Calling inspect() every frame would
        // perturb the workload we are measuring.
        if (evidence.frameProgress === profileFrameLimit + 1) {
          const inspection = app.renderer.inspect();
          evidence.rendererInspection = {
            frustumStats: inspection.frustumStats,
            visibilityStats: inspection.visibilityStats,
            renderScene: inspection.renderScene,
            standardLighting: inspection.standardLighting,
            perFramePassNames: inspection.perFramePassNames,
          };
        }
      },
    })
    .unwrap();
  app.world
    .addSystem(Update, {
      name: 'perf-center-camera-rotate',
      queries: [{ write: [Transform], with: [Camera] }],
      fn: (_world, results) => {
        const quaternion = yawQuaternion(evidence.cameraRotationRadians);
        for (const row of results[0] ?? []) row.mut(Transform).quat.set(quaternion);
      },
    })
    .unwrap();
  const started = app.start();
  if (!started.ok) {
    console.error(`[perf-10k-cubes-lights] app.start ${errorText(started.error)}`);
    return;
  }
  console.warn(
    `[perf-10k-cubes-lights] running fingerprint=${evidence.workloadFingerprint} Standard cubes=${options.cubeCount} pointLights=${options.pointLightCount} spotLights=${options.spotLightCount}`,
  );
}

function inspectSpawnedWorld(
  world: World,
  materialHandle: unknown,
): PerfEvidence['postSpawn'] {
  let cubeCount = 0;
  let meshHandleMatches = 0;
  let materialHandleMatches = 0;
  const positions: number[] = [];
  const cubeQuery = world.query({ read: [Transform, MeshFilter, MeshRenderer] }).unwrap();
  for (const row of cubeQuery) {
    const position = row.get(Transform).pos;
    positions.push(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
    cubeCount += 1;
    const mesh = row.get(MeshFilter);
    const renderer = row.get(MeshRenderer);
    if (mesh.assetHandle === HANDLE_CUBE) meshHandleMatches += 1;
    if (renderer.materials.length === 1 && renderer.materials[0] === materialHandle) {
      materialHandleMatches += 1;
    }
  }
  const pointLightCount = [...world.query({ with: [PointLight] }).unwrap()].length;
  const spotLightCount = [...world.query({ with: [SpotLight] }).unwrap()].length;
  const directionalRows = [...world.query({ read: [DirectionalLight] }).unwrap()];
  const directional = directionalRows[0]?.get(DirectionalLight);
  const direction: [number, number, number] = [
    directional?.direction[0] ?? 0,
    directional?.direction[1] ?? 0,
    directional?.direction[2] ?? 0,
  ];
  const color: [number, number, number] = [
    directional?.color[0] ?? 0,
    directional?.color[1] ?? 0,
    directional?.color[2] ?? 0,
  ];
  return {
    cubeCount,
    pointLightCount,
    spotLightCount,
    directionalBaseline: {
      count: directionalRows.length,
      direction,
      color,
      intensity: directional?.intensity ?? 0,
      shadowCasterCount: directionalRows.filter((row) => row.get(DirectionalLight).castShadow).length,
    },
    meshHandleMatches,
    materialHandleMatches,
    positionChecksum: positionsChecksum(positions),
  };
}

export function profileArtifactIsComplete(value: unknown): boolean {
  const result = validateProfileCapture(value);
  return result.ok && result.value.completeness.status === 'complete' && result.value.completeness.droppedEventCount === 0;
}
