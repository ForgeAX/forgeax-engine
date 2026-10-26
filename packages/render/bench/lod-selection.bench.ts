import { mat4 } from '@forgeax/engine-math';
import { bench, describe } from 'vitest';
import type { GpuDrivenBatch, SubmissionPlan } from '../src/gpu-driven/batch-topology';
import * as lodModule from '../src/gpu-driven/production-raster-lod';
import type { CameraSnapshot } from '../src/render-contract';
import type { RenderSceneSlot } from '../src/scene/render-scene-types';

/**
 * Per-frame CPU cost of GPU-lane LOD preparation for 10k LOD candidates
 * (3 levels) with one main view and four shadow views, on camera-moving and
 * steady frames. The bench body is identical on the pre- and post-#4682 trees;
 * only `frameLodPrepare` differs, because the removed CPU projection exists
 * only before the change:
 *
 * - before: each frame ran `lodProjectionState` (main view: projected height
 *   per primitive, level selection per group, JSON fingerprint) and
 *   `shadowLodProjectionState` per shadow view, with no caching across frames.
 * - after: LOD selection lives only in the per-view GPU cull; the remaining CPU
 *   work is deriving each view's LOD camera constants from its matrix.
 *
 * GPU cost moved into the cull shader is not measured here.
 */
const N = 10_000;
const BATCHES = 10;
const SHADOW_VIEWS = 4;
const CAMERA_POSES = 64;
const OPTS = { iterations: 50, warmupIterations: 10 } as const;

interface BeforeApi {
  prepareLodProjectionPlan(plan: SubmissionPlan): unknown;
  lodProjectionState(
    prepared: { lodPlan: unknown },
    camera: CameraSnapshot,
    slotAt: (primitive: number) => RenderSceneSlot | undefined,
  ): unknown;
  shadowLodProjectionState(
    prepared: { lodPlan: unknown },
    matrix: Float32Array,
    main: unknown,
    slotAt: (primitive: number) => RenderSceneSlot | undefined,
  ): unknown;
}

const api = lodModule as unknown as Partial<BeforeApi> & {
  lodViewCameraFromMatrix(matrix: Float32Array): unknown;
};
const before =
  api.prepareLodProjectionPlan && api.lodProjectionState && api.shadowLodProjectionState
    ? (api as BeforeApi)
    : undefined;

function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) >>> 0;
    return s / 2 ** 32;
  };
}

const random = lcg(0x10d5e1);
const slots: RenderSceneSlot[] = [];
for (let i = 0; i < N; i++) {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = (random() - 0.5) * 400;
  world[13] = (random() - 0.5) * 40;
  world[14] = (random() - 0.5) * 400;
  slots.push({
    snapshot: {
      localAabb: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
      transform: { world },
    },
  } as unknown as RenderSceneSlot);
}
const slotAt = (primitive: number) => slots[primitive];

const batches: GpuDrivenBatch[] = [];
for (let b = 0; b < BATCHES; b++) {
  const per = N / BATCHES;
  batches.push({
    candidates: Array.from({ length: per }, (_, k) => ({
      primitiveIndex: b * per + k,
      instanceIndex: k,
    })),
    prepared: {
      identity: {
        material: b % 2 === 0 ? 'forgeax::default-standard-pbr' : 'custom',
        deformation: 'rigid',
      },
    },
    lod: {
      coverages: [1, 0.3, 0.05],
      hysteresis: 0.08,
      ranges: [
        { first: 12, count: 12, baseVertex: 0 },
        { first: 24, count: 6, baseVertex: 0 },
      ],
    },
  } as unknown as GpuDrivenBatch);
}
const plan = { revision: 1, batches, candidateCount: N, visibleCapacity: 0 } as SubmissionPlan;
// Built once, as the renderer caches the prepared plan across steady frames.
const prepared = { lodPlan: before?.prepareLodProjectionPlan(plan) };

function cameraPose(angle: number): CameraSnapshot {
  return {
    projection: 'perspective',
    fov: Math.PI / 3,
    position: new Float32Array([Math.cos(angle) * 150, 20, Math.sin(angle) * 150]),
    orthoTop: 1,
    orthoBottom: -1,
  } as unknown as CameraSnapshot;
}

function lightMatrix(angle: number, cascade: number): Float32Array {
  const half = 30 * 2 ** cascade;
  const eye = [Math.cos(angle) * 60, 80, Math.sin(angle) * 60];
  const view = mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 1, 0]);
  const proj = mat4.orthographic(mat4.create(), -half, half, -half, half, 0.1, 400);
  return new Float32Array(mat4.multiply(mat4.create(), proj, view));
}

const cameras = Array.from({ length: CAMERA_POSES }, (_, i) =>
  cameraPose((i / CAMERA_POSES) * Math.PI * 2),
);
const lights = Array.from({ length: CAMERA_POSES }, (_, i) =>
  Array.from({ length: SHADOW_VIEWS }, (_, c) => lightMatrix((i / CAMERA_POSES) * Math.PI * 2, c)),
);

/**
 * The per-frame CPU LOD preparation of the main view and `shadowCount`
 * shadow views at pose `pose`. Returns a value so the work cannot be elided.
 */
function frameLodPrepare(pose: number, shadowCount: number): unknown {
  const matrices = lights[pose] as Float32Array[];
  if (before === undefined) {
    // After #4682: the GPU cull selects levels; the CPU only derives each
    // shadow view's LOD camera constants from its matrix.
    let last: unknown;
    for (let v = 0; v < shadowCount; v++) last = api.lodViewCameraFromMatrix(matrices[v]!);
    return last;
  }
  const main = before.lodProjectionState(prepared, cameras[pose]!, slotAt);
  let last: unknown = main;
  for (let v = 0; v < shadowCount; v++) {
    api.lodViewCameraFromMatrix(matrices[v]!);
    last = before.shadowLodProjectionState(prepared, matrices[v]!, main, slotAt);
  }
  return last;
}

let sink: unknown;
let frame = 0;

describe(`LOD preparation, ${N} candidates, 3 levels`, () => {
  bench(
    'camera-moving frame, main view only',
    () => {
      sink = frameLodPrepare(frame++ % CAMERA_POSES, 0);
    },
    OPTS,
  );
  bench(
    'camera-moving frame, main + 4 shadow views',
    () => {
      sink = frameLodPrepare(frame++ % CAMERA_POSES, SHADOW_VIEWS);
    },
    OPTS,
  );
  bench(
    'steady frame, main view only',
    () => {
      sink = frameLodPrepare(0, 0);
    },
    OPTS,
  );
  bench(
    'steady frame, main + 4 shadow views',
    () => {
      sink = frameLodPrepare(0, SHADOW_VIEWS);
    },
    OPTS,
  );
});

void sink;
