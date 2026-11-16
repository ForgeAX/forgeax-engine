import { WaterSceneReconcile, WaterContactProbes, WaterBuoyancy, WaterBuoyancyCompletion, WATER_SYSTEM_RESOURCE } from '@forgeax/engine/runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  configureRuntimeAssetCatalog,
  createRuntimeAssetImportTransport,
  runtimeBinding,
} from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine/app/browser';
import { EngineContent } from '@forgeax/engine/content';
import { defineSystem, type EntityHandle, FixedTime, FixedUpdate, Time, Update } from '@forgeax/engine/ecs';
import { InputFrameStartScan, INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine/input';
import { mat4, quat, vec3 } from '@forgeax/engine/math';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { PhysicsWorldResource, PhysicsSync, PhysicsSimulation,
  Collider,
  ColliderShapeValue,
  inspectPhysicsCapabilities,
  type PhysicsWorld,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import physics3d from '@forgeax/engine/physics-rapier3d';
import type { Plugin } from '@forgeax/engine/plugin';
import {
  buildProfileModel,
  createProfiler,
  type ProfileCapture,
  type ProfileCompletionCpuObservation,
  type ProfileModel,
  type ProfilerError,
  type RecorderSession,
} from '@forgeax/engine/profiler';
import {
  ANTIALIAS_TAA,
  Camera,
  createWaterFluidFeature,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  type FrameReceipt,
  inspectWaterRenderCapabilities,
  MeshFilter,
  MeshRenderer,
  perspective,
  type RenderInspection,
  renderFeatureTextureSource,
  ScreenSpaceReflection,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { createWaterInfoCaptureDeferralProbe } from '@forgeax/engine/render/internal';
import { inspectRhiDeviceFacts } from '@forgeax/engine/rhi';
import {
  WATER_BUOYANCY_RESOURCE,
  WATER_VISUAL_CONTACTS_RESOURCE,
  type WaterBuoyancyState,
  waterSceneSnapshot,
  waterSceneZoneSnapshot,
} from '@forgeax/engine/runtime';
import { ParticleEffectPlayer } from '@forgeax/engine/vfx';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
import {
  readPresentationWorldMatrix,
  sceneEntity,
  Transform,
  WaterBodyInstance,
  WaterContactProbeSet,
  WaterFluidSimulation,
  WaterPontoonSet,
  WaterShallowCollider,
  WaterZoneInstance,
  worldResolveSceneEntity,
} from '@forgeax/engine/scene';
import {
  cookWaterAsset,
  createWaterCapabilityReport,
  estimateWaterResourceBudget,
  rotateWaterVector,
  type WaterAdvancedSimulation,
  type WaterBudgetResource,
  type WaterCapabilitySelection,
  type WaterOceanPatch,
  WaterQueryFlags,
  type WaterSystem,
  type WaterVisualContactState,
  waterAdvancedOutputNames,
  waterOceanPatchOutputNames,
} from '@forgeax/engine/water';
import { COAST_SHIP_MASS_RIG } from '../assets/ship-rig';
import {
  COAST_FOAM_CAPTURE,
  COAST_FOAM_DECAY_PER_SECOND,
  COAST_MESH_PROFILES,
  COAST_SEED,
  COAST_SHIP_ROUTE,
  IRON_BALL_MASS_KG,
  IRON_BALL_RADIUS_M,
  SUN_DIRECTION,
  WATER_R8_PACKAGE,
} from './identity';
import { snapshotWaterBuoyancyStepForTrace } from './physics-trace';
import './style.css';

type Vector = [number, number, number];
type Mode =
  | 'Q0'
  | 'Q1'
  | 'Q2'
  | 'Q3'
  | 'Q4'
  | 'R1'
  | 'R5'
  | 'R6'
  | 'R7-shallow'
  | 'R7-bake'
  | 'R7-fft';
type View = 'near' | 'middle' | 'far' | 'underwater';
const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
};
const selections: Record<Mode, WaterCapabilitySelection> = {
  Q0: { quality: 'Q0', configuration: 'UE-R0' },
  Q1: { quality: 'Q1', configuration: 'UE-R0' },
  Q2: { quality: 'Q2', configuration: 'UE-R2' },
  Q3: { quality: 'Q3', configuration: 'UE-R0' },
  Q4: { quality: 'Q4', configuration: null },
  R1: { quality: null, configuration: 'UE-R1', subfeature: 'gpu-mesh' },
  R5: { quality: null, configuration: 'UE-R5', subfeature: 'async-buoyancy' },
  R6: { quality: null, configuration: 'UE-R6', subfeature: 'fluid-simulation' },
  'R7-shallow': { quality: null, configuration: 'UE-R7', subfeature: 'advanced-shallow' },
  'R7-bake': { quality: null, configuration: 'UE-R7', subfeature: 'river-bake' },
  'R7-fft': { quality: null, configuration: 'UE-R7', subfeature: 'ocean-fft' },
};
const regions: Record<string, Vector> = {
  ship: [0, 3, 0],
  island: [-16, 2, -62],
  shallows: [-8, 0, -38],
  ocean: [45, 0, -70],
};
const unavailableModes: Partial<Record<Mode, string>> = {
  'R7-bake':
    'The coast has no completed River Bake product, durable texture publication or query-grid binding. Runtime acceptance remains in r7-advanced-shallow-bake-fft.',
  'R7-fft':
    'The coast uses mode-projected gravity rather than the UE Niagara FFT recipe. UE FFT acceptance remains in r7-advanced-shallow-bake-fft.',
};
const unverifiedFaultPrerequisites = {
  'shared-curve-revision': {
    owner: 'WaterBrushRecipe and Terrain cook',
    prerequisite:
      'Author a shared elevation-curve reference in a saved Brush recipe, then publish its cooked Terrain closure and compare consumer generations.',
    status: 'unverified',
  },
  'terrain-cook-failure': {
    owner: 'Asset cook and Terrain publication',
    prerequisite:
      'Run an authored Terrain cook candidate, retain its structured rejection and verify that the prior Terrain, query and Physics outputs remain accepted.',
    status: 'unverified',
  },
} as const;
const json = (_: string, value: unknown): unknown =>
  value instanceof Error
    ? {
        name: value.name,
        message: value.message,
        ...Object.fromEntries(Object.entries(value)),
        ...(value.cause === undefined ? {} : { cause: value.cause }),
      }
    : value instanceof Set
      ? [...value]
      : value instanceof Map
        ? Object.fromEntries(value)
        : ArrayBuffer.isView(value)
          ? Array.from(value as unknown as ArrayLike<number>)
          : value;

const R8_PROFILE_LIMITS = Object.freeze({
  normal: Object.freeze({
    frameLimit: 900,
    eventLimit: 1_048_576,
    detail: 'passes' as const,
  }),
  nested: Object.freeze({
    frameLimit: 180,
    eventLimit: 1_048_576,
    detail: 'nested' as const,
  }),
});
const R8_PROFILE_SIDECAR_LIMIT = 8_192;
const R8_PROFILE_MAX_FRAME_LIMIT = 900;
const R8_PROFILE_MAX_EVENT_LIMIT = 1_048_576;
const R8_PROFILE_DEFAULT_FINISH_WAIT_MS = 5_000;
const R8_PROFILE_MAX_FINISH_WAIT_MS = 10_000;

type R8ProfileDetail = 'owner' | 'passes' | 'nested';
type R8ProfileCaptureRequest =
  | 'normal'
  | 'nested'
  | Readonly<{
      preset?: 'normal' | 'nested';
      frameLimit?: number;
      eventLimit?: number;
      detail?: R8ProfileDetail;
    }>;
type R8ProfileFinishResult =
  | { readonly ok: true; readonly value: R8ProfileExport }
  | { readonly ok: false; readonly error: unknown };

type R8FrameCompletion = Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'presentation'> & {
  readonly profileFrame?: FrameReceipt['profileFrame'];
};

type R8ProfileReceipt = {
  readonly captureId: string;
  readonly profileFrameId: number;
  readonly receiptFrameId: number;
  readonly deviceGeneration: number;
  readonly graphGeneration?: FrameReceipt['graphGeneration'];
  readonly renderPassCpuIdentities?: FrameReceipt['renderPassCpuIdentities'];
  readonly renderPassCpuIdentitiesComplete?: FrameReceipt['renderPassCpuIdentitiesComplete'];
  resultStatus: 'pending' | 'fulfilled' | 'rejected';
  status:
    | 'submitted'
    | 'completed'
    | 'presentation-pending'
    | 'generation-mismatch'
    | 'identity-mismatch'
    | 'missing'
    | 'ledger-evicted'
    | 'failed';
};

type R8GpuSidecar = Readonly<{
  captureId: string;
  profileFrameId: number;
  receiptFrameId: number;
  deviceGeneration: number;
  timingStatus: 'complete' | 'partial' | 'unavailable' | 'failed' | 'missing';
  executedPassCount: number | null;
  measuredPassCount: number | null;
  droppedPassCount: number | null;
  timings: unknown;
}>;

type R8ProfileRun = {
  readonly session: RecorderSession;
  readonly captureId: string;
  readonly detail: R8ProfileDetail;
  readonly receipts: R8ProfileReceipt[];
  readonly completionCpu: ProfileCompletionCpuObservation[];
  readonly expectedCompletionKeys: Set<string>;
  readonly observedCompletionKeys: Set<string>;
  readonly callbackCompletionKeys: Set<string>;
  readonly native: Record<string, unknown>[];
  readonly gpu: R8GpuSidecar[];
  readonly pendingReceipts: Map<string, R8ProfileReceipt>;
  finishPromise?: Promise<R8ProfileFinishResult>;
  releaseCompletionCpu?: (() => void) | undefined;
  releaseNative?: (() => void) | undefined;
  nativeAvailable: boolean;
  nativeFenceStartStep?: number;
  nativeFenceEndStep?: number;
  nativeFenceFailures: number;
  nativeObserverRows: number;
  nativeIndexGapCount: number;
  nativeFixedStepGapCount: number;
  nativeInvalidIdentityCount: number;
  nativeLastIndex?: number;
  nativeLastFixedStep?: number;
  nativeUnassociated: number;
  nativeDropped: number;
  gpuPending: number;
  readonly gpuTimingStatusCounts: Record<R8GpuSidecar['timingStatus'], number>;
  gpuUnmeasuredPasses: number;
  gpuDroppedPasses: number;
  gpuMissingMeasurementReceipts: number;
  cpuFinished: boolean;
  finalized: boolean;
  completionExpected: number;
  completionCallbacksActual: number;
  completionCpuActual: number;
  completionCpuUnassociated: number;
  completionCpuDuplicates: number;
  receiptExpected: number;
  receiptDropped: number;
  receiptLedgerEvicted: number;
  receiptFailures: number;
  readonly receiptResultCounts: Record<R8ProfileReceipt['resultStatus'], number>;
  readonly receiptStatusCounts: Record<R8ProfileReceipt['status'], number>;
  completionIdentityMismatch: number;
  completionDropped: number;
  gpuExpected: number;
  gpuFailed: number;
  gpuDropped: number;
};

type R8ProfileExport = Readonly<{
  version: 1;
  capture: ProfileCapture;
  model: ProfileModel;
  sidecars: Readonly<{
    receipts: readonly Readonly<R8ProfileReceipt>[];
    completionCpu: readonly ProfileCompletionCpuObservation[];
    nativePhysics: readonly Readonly<Record<string, unknown>>[];
    gpu: readonly R8GpuSidecar[];
    diagnostics: Readonly<{
      profileSourceFailure: Extract<
        ProfilerError,
        { readonly code: 'profile-source-failed' }
      > | null;
    }>;
    completeness: Readonly<Record<string, unknown>>;
  }>;
}>;

function appendBounded<T>(items: T[], item: T): boolean {
  if (items.length >= R8_PROFILE_SIDECAR_LIMIT) return false;
  items.push(item);
  return true;
}

type R8NativeFenceReader = () => number | undefined;

type R8GpuPassIdentity = Readonly<{
  viewId?: number;
  passName: string;
  passKind: string;
  executionIndex: number;
  status: 'measured' | 'unmeasured';
}>;

type R8GpuTimingFrameFacts = Readonly<{
  frameId: number;
  deviceGeneration: number;
  graphGeneration: number;
  executedPassCount: number;
  measuredPassCount: number;
  droppedPassCount: number;
  passes: readonly R8GpuPassIdentity[];
}>;

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function gpuTimingFrameFacts(value: unknown): R8GpuTimingFrameFacts | undefined {
  const observation = objectRecord(value);
  const frame = objectRecord(observation?.frame);
  if (frame === undefined) return undefined;
  const number = (name: string) =>
    typeof frame[name] === 'number' && Number.isSafeInteger(frame[name])
      ? (frame[name] as number)
      : undefined;
  const frameId = number('frameId');
  const deviceGeneration = number('deviceGeneration');
  const graphGeneration = number('graphGeneration');
  const executedPassCount = number('executedPassCount');
  const measuredPassCount = number('measuredPassCount');
  const droppedPassCount = number('droppedPassCount');
  if (
    frameId === undefined ||
    deviceGeneration === undefined ||
    graphGeneration === undefined ||
    executedPassCount === undefined ||
    measuredPassCount === undefined ||
    droppedPassCount === undefined ||
    !Array.isArray(frame.passes)
  )
    return undefined;
  const passes: R8GpuPassIdentity[] = [];
  for (const entryValue of frame.passes) {
    const entry = objectRecord(entryValue);
    const passName = entry?.passName;
    const passKind = entry?.passKind;
    const executionIndex = entry?.executionIndex;
    const viewId = entry?.viewId;
    const status = entry?.status;
    if (
      typeof passName !== 'string' ||
      typeof passKind !== 'string' ||
      typeof executionIndex !== 'number' ||
      !Number.isSafeInteger(executionIndex) ||
      (status !== 'measured' && status !== 'unmeasured') ||
      (viewId !== undefined && (typeof viewId !== 'number' || !Number.isSafeInteger(viewId)))
    )
      continue;
    passes.push({
      ...(viewId === undefined ? {} : { viewId: viewId as number }),
      passName,
      passKind,
      executionIndex,
      status,
    });
  }
  return {
    frameId,
    deviceGeneration,
    graphGeneration,
    executedPassCount,
    measuredPassCount,
    droppedPassCount,
    passes,
  };
}

function gpuPassIdentityKey(identity: R8GpuPassIdentity): string {
  return JSON.stringify([
    identity.viewId ?? null,
    identity.passName,
    identity.passKind,
    identity.executionIndex,
  ]);
}

function analyzeR8GpuIdentityJoin(run: R8ProfileRun) {
  const identityJoinApplicable = run.detail !== 'owner';
  let matchedReceipts = 0;
  let missingGpuReceipts = 0;
  let incompleteCpuIdentityReceipts = 0;
  let mismatchedGpuReceipts = 0;
  let cpuRows = 0;
  let matchedRows = 0;
  let unavailableCpuRows = 0;
  let unmatchedCpuRows = 0;
  let unmatchedGpuRows = 0;
  let duplicateCpuRows = 0;
  let duplicateGpuRows = 0;
  let expectedGpuReceipts = 0;
  const gpuByReceipt = new Map(
    run.gpu.map((sidecar) => [
      profileCompletionKey(
        sidecar.captureId,
        sidecar.profileFrameId,
        sidecar.receiptFrameId,
        sidecar.deviceGeneration,
      ),
      sidecar,
    ]),
  );
  for (const receipt of run.receipts) {
    if (receipt.status !== 'completed') continue;
    expectedGpuReceipts += 1;
    const key = profileCompletionKey(
      receipt.captureId,
      receipt.profileFrameId,
      receipt.receiptFrameId,
      receipt.deviceGeneration,
    );
    const gpu = gpuByReceipt.get(key);
    if (gpu === undefined) {
      missingGpuReceipts += 1;
      continue;
    }
    const frame = gpuTimingFrameFacts(gpu.timings);
    if (
      frame === undefined ||
      frame.frameId !== receipt.receiptFrameId ||
      frame.deviceGeneration !== receipt.deviceGeneration ||
      (receipt.graphGeneration !== undefined &&
        frame.graphGeneration !== receipt.graphGeneration) ||
      gpu.timingStatus !== 'complete' ||
      gpu.executedPassCount !== frame.executedPassCount ||
      gpu.measuredPassCount !== frame.measuredPassCount ||
      gpu.droppedPassCount !== frame.droppedPassCount ||
      frame.measuredPassCount !== frame.executedPassCount ||
      frame.passes.length !== frame.executedPassCount ||
      frame.passes.some((pass) => pass.status !== 'measured') ||
      frame.droppedPassCount !== 0
    ) {
      mismatchedGpuReceipts += 1;
      continue;
    }
    matchedReceipts += 1;
    const gpuPassKeys = new Set(frame.passes.map(gpuPassIdentityKey));
    duplicateGpuRows += frame.passes.length - gpuPassKeys.size;
    if (!identityJoinApplicable) continue;
const joinR8CpuAndGpuPassRows = () => {
    if (
      receipt.renderPassCpuIdentities === undefined ||
      receipt.renderPassCpuIdentitiesComplete !== true
    )
      incompleteCpuIdentityReceipts += 1;
    const cpuPassKeys = new Set<string>();
    for (const row of receipt.renderPassCpuIdentities ?? []) {
      cpuRows += 1;
      if (
        row.deviceGeneration !== receipt.deviceGeneration ||
        row.gpuIdentityStatus !== 'available' ||
        row.gpuIdentity === undefined
      ) {
        unavailableCpuRows += 1;
        continue;
      }
      const tuple: R8GpuPassIdentity = {
        ...(row.gpuIdentity.viewId === undefined ? {} : { viewId: row.gpuIdentity.viewId }),
        passName: row.gpuIdentity.passName,
        passKind: row.gpuIdentity.passKind,
        executionIndex: row.gpuIdentity.executionIndex,
        status: 'measured',
      };
      const tupleKey = gpuPassIdentityKey(tuple);
      if (cpuPassKeys.has(tupleKey)) duplicateCpuRows += 1;
      cpuPassKeys.add(tupleKey);
      if (gpuPassKeys.has(tupleKey)) matchedRows += 1;
      else unmatchedCpuRows += 1;
    }
    for (const tupleKey of gpuPassKeys) if (!cpuPassKeys.has(tupleKey)) unmatchedGpuRows += 1;};
joinR8CpuAndGpuPassRows();

  }
const completeR8GpuIdentityJoin = () => {
  const gpuFrameIntegrityComplete =
    run.receiptExpected === run.receipts.length &&
    run.gpuExpected === run.gpu.length &&
    run.gpuExpected === expectedGpuReceipts &&
    matchedReceipts === expectedGpuReceipts &&
    missingGpuReceipts === 0 &&
    mismatchedGpuReceipts === 0 &&
    duplicateGpuRows === 0;
  const identityJoinComplete =
    gpuFrameIntegrityComplete &&
    incompleteCpuIdentityReceipts === 0 &&
    unavailableCpuRows === 0 &&
    unmatchedCpuRows === 0 &&
    unmatchedGpuRows === 0 &&
    duplicateCpuRows === 0 &&
    duplicateGpuRows === 0;
  return Object.freeze({
    status: !identityJoinApplicable
      ? 'not-applicable'
      : identityJoinComplete
        ? 'complete'
        : 'partial',
    identityJoinApplicable,
    gpuFrameIntegrityStatus: gpuFrameIntegrityComplete ? 'complete' : 'partial',
    ...(identityJoinApplicable
      ? {}
      : { reason: 'owner detail does not record per-pass CPU identities' }),
    expectedReceipts: run.gpuExpected,
    eligibleReceiptRows: expectedGpuReceipts,
    matchedReceipts,
    missingGpuReceipts,
    incompleteCpuIdentityReceipts,
    mismatchedGpuReceipts,
    cpuRows,
    matchedRows,
    unavailableCpuRows,
    unmatchedCpuRows,
    unmatchedGpuRows,
    duplicateCpuRows,
    duplicateGpuRows,
  });};
return completeR8GpuIdentityJoin();

}

function captureNativeStepFence(
  run: R8ProfileRun,
  readCompletedStep: R8NativeFenceReader,
): number | undefined {
  try {
    const step = readCompletedStep();
    if (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0) return step;
  } catch {
    // Fence reads are diagnostic; retain their failure in the sidecar.
  }
  run.nativeFenceFailures += 1;
  return undefined;
}

function closeR8CpuCapture(run: R8ProfileRun, readCompletedStep: R8NativeFenceReader): void {
  if (run.cpuFinished) return;
  // Read the closing fence before releasing the native timing lease. The
  // profiler sink calls this at the exact explicit or automatic finish point.
  const endStep = captureNativeStepFence(run, readCompletedStep);
  if (endStep !== undefined) run.nativeFenceEndStep = endStep;
  run.cpuFinished = true;
  run.releaseNative?.();
  run.releaseNative = undefined;
}

function setR8ReceiptStatus(
  run: R8ProfileRun,
  receipt: R8ProfileReceipt,
  status: R8ProfileReceipt['status'],
): void {
  run.receiptStatusCounts[receipt.status] = Math.max(
    0,
    run.receiptStatusCounts[receipt.status] - 1,
  );
  receipt.status = status;
  run.receiptStatusCounts[status] += 1;
}

function profileCompletionKey(
  captureId: string,
  profileFrameId: number,
  receiptFrameId: number,
  deviceGeneration: number,
): string {
  return `${captureId}/${profileFrameId}/${deviceGeneration}/${receiptFrameId}`;
}

async function waitForR8ProfileDrain(run: R8ProfileRun, waitMs: number): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  while (run.pendingReceipts.size > 0 || run.gpuPending > 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
  // Let the profiler's completion listener run after its wrapped App callback.
  await Promise.resolve();
  return run.pendingReceipts.size === 0 && run.gpuPending === 0;
}

async function main() {
  const canvas = element<HTMLCanvasElement>('scene');
  let profileRun: R8ProfileRun | undefined;
  let latestProfileExport: R8ProfileExport | undefined;
  let readNativeCompletedStep: R8NativeFenceReader = () => undefined;
  const profiler = createProfiler({
    sink: {
      write(capture) {
        const run = profileRun;
        if (run !== undefined && capture.captureId === run.captureId)
          closeR8CpuCapture(run, readNativeCompletedStep);
      },
    },
  });
  let vfxCamera: EntityHandle | undefined;
  const vfxHost = createVfxRuntimeHost({
    camera: {
      read(world) {
        if (vfxCamera === undefined) return undefined;
        const transform = world.get(vfxCamera, Transform);
        const camera = world.get(vfxCamera, Camera);
        if (!transform.ok || !camera.ok) return undefined;
        const position = new Float32Array(transform.value.pos);
        const right = quat.transformVec3(vec3.create(), transform.value.quat, [1, 0, 0]);
        const up = quat.transformVec3(vec3.create(), transform.value.quat, [0, 1, 0]);
        const projection = mat4.perspectiveReverseZ(
          mat4.create(),
          camera.value.fov,
          camera.value.aspect,
          camera.value.near,
          camera.value.far,
        );
        const viewMatrix = mat4.lookAt(mat4.create(), position, target, [0, 1, 0]);
        return {
          position,
          right,
          up,
          viewProjection: mat4.multiply(mat4.create(), projection, viewMatrix),
        };
      },
    },
  });
  const waterInfoProbe = createWaterInfoCaptureDeferralProbe();
  let onReceiptCompleted: ((event: R8FrameCompletion) => void) | undefined;
  const profilePhysics3dPlugin: Plugin = {
    name: 'water-r8-profiled-physics',
    async apply(ctx) {
      await ctx.plugin(physics3d, { profileNativeStepTimings: true });
    },
  };
  element('state').textContent = '正在创建渲染器';
  const app = (
    await createApp(
      canvas,
      {
        // R8 retains at most four complete source flights and rejects larger
        // readback rosters before GPU allocation.
        featureTextureReadbackBudgetBytes: 64 * 1024 * 1024 * 4,
        plugins: [profilePhysics3dPlugin],
        features: [
          waterInfoProbe.feature,
          vfxHost.feature,
          createWaterFluidFeature({
            contactFoam: {
              resolution: COAST_FOAM_CAPTURE.resolution,
              decayPerSecond: COAST_FOAM_DECAY_PER_SECOND,
              strengthPerMps: 0.08,
            },
          }),
        ],
        uiRoot: element('controls-panel'),
        pointerLockAllowed: () => false,
        profiler,
        onFrameCompleted: (event) => onReceiptCompleted?.(event),
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
        gpuPassTiming: { maxPassesPerFrame: 512, retentionFrames: 8 },
        ...(__WATER_R8_SSR_IDENTITY__ === null ? {} : { ssrIdentity: __WATER_R8_SSR_IDENTITY__ }),
        ...(runtimeBinding ? { assetRuntimeBinding: runtimeBinding } : {}),
        pluginPrograms: {
          sessionId: crypto.randomUUID(),
          contextId: 'water-r8',
          sessionGeneration: 1,
          target: 'engine',
          tools: new Map(),
          definitions: new Map(),
          programs: new Map(),
        },
        time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4, maxDeltaSeconds: 0.1 },
      },
      {
        ...forgeaxBundlerAdapter(),
        importTransport: createRuntimeAssetImportTransport(runtimeBinding),
      },
    )
  ).unwrap();
  const { world, assets } = app;
  if (!assets) throw new Error('Asset registry unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(WATER_R8_PACKAGE, key));
  element('state').textContent = '正在载入海岸场景';
  const scene = (await assets.load(guid('scene/coast'), 'scene')).unwrap();
  element('state').textContent = '正在实例化场景';
  const root = assets.instantiate(scene, world).unwrap();
  const sourceKey = assets.sourceKeyOf(guid('scene/coast'));
  if (!sourceKey) throw new Error('Saved coast Scene has no accepted source key');
  const resolve = (key: string) =>
    worldResolveSceneEntity(world, root, sceneEntity(sourceKey, key)).unwrap();
  const ship = resolve('ship'),
    zone = resolve('zone'),
    oceanFoam = resolve('ocean-foam');
  let shipRigAdmission:
    | { kind: 'unrequested' }
    | { kind: 'queued' | 'ready'; candidateId: string } = { kind: 'unrequested' };
  const zoneAsset = (await assets.load(guid('zone/coast'), 'water-zone')).unwrap();
  const originalZone = assets.read(zoneAsset).unwrap();
  const bodies = await Promise.all(
    ['ocean'].map(async (type) => ({
      type,
      entity: resolve(type),
      handle: (await assets.load(guid(`body/${type}`), 'water-body')).unwrap(),
    })),
  );
  const originalBodies = bodies.map((body) => assets.read(body.handle).unwrap());
  const windSources = await Promise.all(
    ['breeze', 'q1'].map(async (name) => {
      const handle = (await assets.load(guid(`waves/${name}`), 'water-wave-set')).unwrap();
      return { handle, source: assets.read(handle).unwrap() };
    }),
  );
  const maximumWindStrength = 2.4;
  let windStrength = 1;
  let pendingWindStrength: number | undefined;
  let lastWindAdmissionMs = -Infinity;
  const applyWindStrength = (strength: number) => {
    const prepared = windSources.map(({ handle, source }) => {
      const steepnessScale = Math.min(
        1,
        0.85 / (source.waves.reduce((sum, wave) => sum + wave.steepness, 0) * maximumWindStrength),
      );
      const cooked = cookWaterAsset({
        kind: 'water-wave-set',
        waveSource: {
          kind: 'predefined',
          waves: source.waves.map((wave) => ({
            ...wave,
            amplitudeM: wave.amplitudeM * strength,
            steepness: wave.steepness * strength * steepnessScale,
          })),
        },
        depthMaskM: source.depthMaskM,
        maxWaveHeightM: source.maxWaveHeightM,
        timeSource: source.timeSource,
      }).unwrap();
      if (cooked.kind !== 'water-wave-set') throw new Error('Wind source did not cook a WaveSet');
      return { handle, cooked };
    });
    for (const { handle, cooked } of prepared) assets.replace(handle, cooked).unwrap();
    windStrength = strength;
    lastWindAdmissionMs = performance.now();
    record('wind-source-admitted', {
      strength,
      unit: 'authored-spectrum-multiplier',
      waveRevisions: windSources.map(({ handle }) => assets.revision(handle).unwrap()),
    });
  };
  const materials = await Promise.all(
    ['ocean', 'ocean-lod', 'far'].map((type) =>
      assets.load(guid(`material/water/${type}`), 'material').then((result) => result.unwrap()),
    ),
  );
  type WaterMaterialHandle = (typeof materials)[number];
  const qualityMaterialGuids = {
    Q3: {
      bodies: {
        ocean: {
          surface: EngineContent.water.materials.ocean,
          lod: EngineContent.water.materials['ocean-lod'],
        },
      },
      far: EngineContent.water.materials.far,
    },
    Q4: {
      bodies: {
        ocean: {
          surface: guid('material/water/ocean-q4-flat'),
          lod: guid('material/water/ocean-q4-flat'),
        },
      },
      far: guid('material/water/far-q4-flat'),
    },
  } as const;
  const q3Materials = {
    oceanSurface: (await assets.load(qualityMaterialGuids.Q3.bodies.ocean.surface, 'material')).unwrap(),
    oceanLod: (await assets.load(qualityMaterialGuids.Q3.bodies.ocean.lod, 'material')).unwrap(),
    far: (await assets.load(qualityMaterialGuids.Q3.far, 'material')).unwrap(),
  };
  const q4Materials = {
    ocean: (await assets.load(qualityMaterialGuids.Q4.bodies.ocean.surface, 'material')).unwrap(),
    far: (await assets.load(qualityMaterialGuids.Q4.far, 'material')).unwrap(),
  };
  const qualityMaterialHandles = {
    Q3: [q3Materials.oceanSurface, q3Materials.oceanLod, q3Materials.far],
    Q4: [q4Materials.ocean, q4Materials.far],
  } as const;
  const qualityMaterialRows = (mode: 'Q3' | 'Q4') => mode === 'Q3'
    ? [
        { slot: 'ocean-surface', guid: qualityMaterialGuids.Q3.bodies.ocean.surface, handle: q3Materials.oceanSurface },
        { slot: 'ocean-lod', guid: qualityMaterialGuids.Q3.bodies.ocean.lod, handle: q3Materials.oceanLod },
        { slot: 'far', guid: qualityMaterialGuids.Q3.far, handle: q3Materials.far },
      ]
    : [
        { slot: 'ocean', guid: qualityMaterialGuids.Q4.bodies.ocean.surface, handle: q4Materials.ocean },
        { slot: 'far', guid: qualityMaterialGuids.Q4.far, handle: q4Materials.far },
      ];
  const modeMaterialHandles = (mode: Mode) =>
    mode === 'Q3' || mode === 'Q4' ? qualityMaterialHandles[mode] : materials;
  const qualitySourceClosureAccepted = (mode: 'Q3' | 'Q4') =>
    qualityMaterialRows(mode).every(({ handle, guid: assetGuid }) => {
      const content = assets.read(handle).unwrap(),
        accepted = assets.source(handle).unwrap()?.publication,
        published = assets.catalogEntry(assetGuid)?.publication;
      return content.kind === 'material' &&
        accepted !== undefined &&
        published !== undefined &&
        accepted.generation === published.generation &&
        accepted.digest === published.digest &&
        accepted.outputSetDigest === published.outputSetDigest;
    });
  const qualitySourceVersion = (mode: 'Q3' | 'Q4') =>
    qualityMaterialRows(mode)
      .map(({ slot, handle }) => {
        const publication = assets.source(handle).unwrap()?.publication;
        return `${slot}:p${publication?.generation ?? 'missing'}:r${assets.revision(handle).unwrap()}`;
      })
      .join(',');
  const ironBallMesh = (await assets.load(guid('mesh/iron-ball'), 'mesh')).unwrap();
  const ironBallMaterial = (await assets.load(guid('material/iron-ball'), 'material')).unwrap();
  const localRecipe = (
    await assets.load(guid('fluid/coast-local'), 'water-simulation-recipe')
  ).unwrap();
  const originalLocalRecipe = assets.read(localRecipe).unwrap();
  const r7Recipe = (
    await assets.load(guid('fluid/coast-r7-shallow'), 'water-simulation-recipe')
  ).unwrap();
  const ironBallEntryEffect = (await assets.load(guid('effect/iron-ball-entry'), 'particle-effect')).unwrap();
  (await vfxHost.attachWorld({ world, assets })).unwrap();
  const vfxControl = vfxHost.acquireControl(world).unwrap();
  element('state').textContent = '正在载入环境';
  Object.assign(window, { __waterR8Boot: { app, assets, world, guid } });
  const skies = await Promise.all(
    ['day', 'sunset', 'overcast'].map((name) =>
      assets.load(guid(`environment/${name}`), 'equirect').then((result) => result.unwrap()),
    ),
  );
  const clearSkies = await Promise.all(
    ['day', 'sunset', 'overcast'].map((name) =>
      assets.load(guid(`environment/${name}-clear`), 'equirect').then((result) => result.unwrap()),
    ),
  );
  let cloudsEnabled = element<HTMLInputElement>('clouds').checked;
  const initialSky = (cloudsEnabled ? skies : clearSkies)[0]!;
  const sky = world
    .spawn({
      component: SkyboxBackground,
      data: { equirect: initialSky, mode: SKYBOX_MODE_CUBEMAP },
    })
    .unwrap();
  const ambient = world
    .spawn({
      component: Skylight,
      data: { equirect: initialSky, color: [1, 1, 1], intensity: 0.8 },
    })
    .unwrap();
  const sunlight = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: SUN_DIRECTION,
        color: [1, 0.97, 0.89],
        intensity: 2.4,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 3,
      },
    })
    .unwrap();
  let eye: Vector = [29, 10, 40],
    target: Vector = [-1, 5, -3],
    view: View = 'middle';
  const applySkyVariant = (index: number) => {
    const equirect = (cloudsEnabled ? skies : clearSkies)[index]!;
    world.set(sky, SkyboxBackground, { equirect }).unwrap();
    world.set(ambient, Skylight, { equirect }).unwrap();
  };
  const camera = world
    .spawn(
      {
        component: Transform,
        data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]) },
      },
      {
        component: Camera,
        data: {
          ...perspective({
            fov: Math.PI / 3.6,
            aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight),
            near: 0.06,
            far: 2200,
          }),
          clearColor: [0.42, 0.66, 0.76, 1],
          antialias: ANTIALIAS_TAA,
          tonemap: TONEMAP_ACES_FILMIC,
          exposure: 1,
        },
      },
      {
        component: ScreenSpaceReflection,
        data: { maxDistance: 180, thickness: 0.3, maxRoughness: 0.65, waterTemporal: 1 },
      },
    )
    .unwrap();
  vfxCamera = camera;
  const water = () => world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
  const buoyancy = () => world.getResource<WaterBuoyancyState>(WATER_BUOYANCY_RESOURCE);
  const physics = () => world.getResource<PhysicsWorld>(PhysicsWorldResource);
  readNativeCompletedStep = () => physics().getSolverClock?.().completedStep;
  const contacts = () => world.getResource<WaterVisualContactState>(WATER_VISUAL_CONTACTS_RESOURCE);
  const shipRoute = COAST_SHIP_ROUTE;
  const shipNavigation = {
    running: false,
    braking: false,
    path: 'circle' as 'circle' | 'straight',
    straightDirectionXZ: [1, 0] as readonly [number, number],
    speedMps: 6,
    loop: true,
    completedLaps: 0,
    distanceRadians: 0,
    previousAngle: undefined as number | undefined,
    lastCommand: undefined as
      | {
          fixedStep: number;
          forceN: Vector;
          torqueNm: Vector;
          radialErrorM: number;
          waterDragSource: {
            entity: number;
            generation: number;
            physicsStep: number;
            accelerationMps2: readonly number[];
          } | null;
          nativeDampingPerSecond: number;
          propulsionPowerW: number;
          yawPowerW: number;
        }
      | undefined,
  };
  let shipResetRequested = false;
  let fireRequested = false;
  let localSimulation: WaterOceanPatch | undefined;
  let r7Simulation: WaterAdvancedSimulation | undefined;
  let localBindingIdentity: string | undefined;
  const balls: {
    entity: EntityHandle;
    launch: { positionM: Vector; velocityMps: Vector; fixedStep?: number; timeSeconds?: number };
    entryPlayer: EntityHandle;
    entryRetireStep?: number;
    entry?: {
      fixedStep: number;
      bodyGeneration: number;
      positionM: readonly number[];
      normalYUp: readonly number[];
      velocityMps: readonly number[];
    };
    trajectory: {
      fixedStep: number;
      positionM: readonly number[];
      velocityMps: readonly number[];
    }[];
  }[] = [];
  const retireIronBall = (ball: (typeof balls)[number]) => {
    world.despawn(ball.entity).unwrap();
    world.despawn(ball.entryPlayer).unwrap();
  };
  const retireIronBalls = () => {
    for (const ball of balls) retireIronBall(ball);
    balls.length = 0;
  };
  window.addEventListener(
    'pagehide',
    () => {
      retireIronBalls();
      void vfxHost.detachWorld({ world });
    },
    { once: true },
  );
  water().setUnderwaterTraceFilterMask(0x0001_0002).unwrap();
  const position = (): Vector => {
    const matrix = readPresentationWorldMatrix(world, ship);
    return matrix
      ? [matrix[12]!, matrix[13]!, matrix[14]!]
      : [0, COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM, 0];
  };
  const applyCamera = () => {
    world
      .set(camera, Transform, {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, target, [0, 1, 0]),
      })
      .unwrap();
    world.set(camera, Camera, { projectionOffset: [0, 0] }).unwrap();
  };
  const setView = (next: View) => {
    view = next;
    const center = regions[element<HTMLSelectElement>('region').value] ?? regions.ship!;
    target = [...center];
    const offset: Vector =
      next === 'near'
        ? [21, 6, 29]
        : next === 'far'
          ? [75, 34, 96]
          : next === 'underwater'
            ? [8, -2.4 - center[1], 16]
            : [24, 7, 33];
    eye = center.map((v, i) => v + offset[i]!) as Vector;
    if (next === 'underwater') target = [center[0] - 3, -1.2, center[2] - 8];
    if (element<HTMLSelectElement>('region').value === 'ship') {
      if (next === 'middle') {
        eye = [7.5, 9.7, 32];
        target = [-1.2, 4.5, -3];
      } else if (next === 'near') {
        eye = [8, 6.5, 25];
        target = [-2, 3.2, 0];
      } else if (next === 'underwater') {
        eye = [5, -2.4, 8];
        target = [-13, 13, -12];
      }
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
      button.setAttribute('aria-pressed', String(button.dataset.view === next));
    applyCamera();
  };
  const errors: unknown[] = [],
    operations: Record<string, unknown>[] = [];
  const fixedTrace: unknown[] = [],
    cpuTrace: unknown[] = [],
    renderTrace: unknown[] = [],
    gpuTimings: unknown[] = [];
  const diagnostics = {
    enabled: false,
    startedAtMs: null as number | null,
    inspectionIntervalMs: 500,
  };
  let lastInspectionMs = -Infinity;
  const setDiagnostics = (enabled: boolean) => {
    diagnostics.enabled = enabled;
    diagnostics.startedAtMs = enabled ? performance.now() : null;
    lastInspectionMs = -Infinity;
    fixedTrace.length = 0;
    cpuTrace.length = 0;
    renderTrace.length = 0;
    gpuTimings.length = 0;
    completedFrameTimes.length = 0;
  };
  const record = (kind: string, detail: unknown) => {
    operations.push({ kind, wallTime: performance.now(), detail });
    if (operations.length > 100) operations.shift();
  };
  const message = (text: string) => {
    element('message').textContent = text;
    element('message').hidden = false;
  };
  let rollbackConfiguration: ((reason: unknown) => void) | undefined;
  const report = (error: unknown) => {
    const candidate = transaction !== undefined;
    errors.push(error);
    if (errors.length > 64) errors.shift();
    console.error(error);
    rollbackConfiguration?.(error);
    message(
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : String(error),
    );
    if (
      !candidate &&
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'app-system-update-failed'
    )
      app.pause();
  };
  app.onError(report);
  let requestedMode: Mode = 'Q0',
    activeMode: Mode = 'Q0';
  let meshProfile: keyof typeof COAST_MESH_PROFILES = 'coast64';
  let completedFrames = 0,
    completedReceipt:
      | Pick<FrameReceipt, 'frameId' | 'deviceGeneration' | 'graphGeneration'>
      | undefined;
  let latest: RenderInspection | undefined,
    lastRefresh = 0,
    modeRevision = 0;
  const configurationSnapshot = () => ({
    meshProfile,
    zone: assets.read(zoneAsset).unwrap(),
    bodies: bodies.map((body) => assets.read(body.handle).unwrap()),
    materials: materials.map((handle) => assets.read(handle).unwrap()),
    fluid: world.get(oceanFoam, WaterFluidSimulation).unwrap(),
    ssr: world.get(camera, ScreenSpaceReflection),
    asyncEnabled: buoyancy().asyncEnabled,
    useAsyncPath: world.get(ship, WaterPontoonSet).unwrap().useAsyncPath,
  });
  let transaction:
    | {
        revision: number;
        mode: Mode;
        previous: Mode;
        frameAfter: number;
        deviceGeneration: number;
        zoneRevision: number;
        zoneGenerationBefore: number;
        expectedZone: typeof originalZone;
        waveSetGuid: string;
        bodyRevisions: readonly number[];
        materialHandles: readonly WaterMaterialHandle[];
        materialRevisions: readonly number[];
        legacyFluidEnabled: boolean;
        asyncCompletedBefore: number;
        status: 'preparing' | 'awaiting-completion';
        blockers: readonly string[];
        before: ReturnType<typeof configurationSnapshot>;
        beforeGraph: unknown;
      }
    | undefined;
  let zoneRemoved = false,
    materialMissing = false,
    oceanChanged = false,
    smallResolution = false;
  const physicsFacts = () => inspectPhysicsCapabilities(physics());
  const bodySnapshot = (body: (typeof bodies)[number]) => waterSceneSnapshot(world, body.entity);
  const bodyEvidence = (snapshot: ReturnType<typeof bodySnapshot>) =>
    snapshot && {
      guid: snapshot.guid,
      sourceAssetGuid: snapshot.sourceAssetGuid,
      instanceEntity: snapshot.instanceEntity,
      sourceVersion: snapshot.sourceVersion,
      sourcePublication: snapshot.sourcePublication,
      sceneGeneration: snapshot.sceneGeneration,
      worldMatrixM: snapshot.worldMatrixM,
      binding: snapshot.binding,
      asset: {
        type: snapshot.asset.type,
        waveSetGuid: snapshot.asset.waveSetGuid,
        baseHeightM: snapshot.asset.baseHeightM,
        surfaceMaterialGuid: snapshot.asset.surfaceMaterialGuid,
        flags: snapshot.asset.flags,
      },
      outputs: snapshot.outputs,
      outputGenerations: snapshot.outputGenerations,
      outputReceipts: snapshot.outputReceipts,
      dirty: [...snapshot.dirty],
      dependencies: snapshot.dependencies.map((dependency) => ({
        guid: dependency.guid,
        kind: dependency.kind,
        field: dependency.field,
        status: dependency.status,
        failure: dependency.failure,
      })),
    };
  const transactionEvidence = (candidate: NonNullable<typeof transaction>) => {
    const { before: _before, ...evidence } = candidate;
    return evidence;
  };
  const lockConfiguration = (locked: boolean) => {
    for (const id of [
      'quality',
      'waves',
      'region',
      'water-color',
      'crests-enabled',
      'depth-foam-enabled',
      'contacts-enabled',
      'buoyancy-enabled',
    ])
      element<HTMLSelectElement | HTMLInputElement>(id).disabled = locked;
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fault]'))
      button.disabled = locked;
  };
  rollbackConfiguration = (reason) => {
    const failed = transaction;
    if (!failed) return;
    transaction = undefined;
    const failures: unknown[] = [];
    const restore = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    restore(() => {
      assets.replace(zoneAsset, failed.before.zone).unwrap();
    });
    for (const [index, body] of bodies.entries())
      restore(() => {
        assets.replace(body.handle, failed.before.bodies[index]!).unwrap();
      });
    for (const [index, handle] of materials.entries())
      restore(() => {
        assets.replace(handle, failed.before.materials[index]!).unwrap();
      });
    restore(() => {
      world.set(oceanFoam, WaterFluidSimulation, failed.before.fluid).unwrap();
    });
    restore(() => {
      const ssr = world.get(camera, ScreenSpaceReflection);
      if (failed.before.ssr.ok) {
        if (ssr.ok) world.set(camera, ScreenSpaceReflection, failed.before.ssr.value).unwrap();
        else
          world
            .addComponent(camera, {
              component: ScreenSpaceReflection,
              data: failed.before.ssr.value,
            })
            .unwrap();
      } else if (ssr.ok) world.removeComponent(camera, ScreenSpaceReflection).unwrap();
    });
    restore(() => {
      buoyancy().asyncEnabled = failed.before.asyncEnabled;
    });
    restore(() => {
      world.set(ship, WaterPontoonSet, { useAsyncPath: failed.before.useAsyncPath }).unwrap();
    });
    requestedMode = failed.previous;
    meshProfile = failed.before.meshProfile;
    element<HTMLSelectElement>('quality').value = failed.previous;
    lockConfiguration(false);
    record('configuration-rolled-back', {
      transaction: transactionEvidence(failed),
      reason,
      failures,
      restored: failures.length === 0,
    });
    element('transition').textContent = failures.length
      ? '候选配置失败，恢复未完成'
      : '候选配置失败，已恢复上一配置';
    if (failures.length) {
      errors.push(...failures);
      app.pause().unwrap();
    }
  };
  const renderFacts = (inspection: RenderInspection) => {
    const facts = inspectWaterRenderCapabilities(inspection);
    // Runtime asset-output readiness is not a completed CPU draw publication.
    return facts;
  };
  const completedCpuWaterMesh = (inspection: RenderInspection) => {
    const receipt = completedReceipt,
      renderer = renderFacts(inspection),
      acceptedZone = waterSceneZoneSnapshot(world, guid('zone/coast')),
      snapshots = bodies.map(bodySnapshot);
    if (
      !receipt ||
      receipt.frameId !== inspection.frame.frameId ||
      receipt.deviceGeneration !== inspection.frame.deviceGeneration ||
      renderer.gpuMesh ||
      !acceptedZone ||
      acceptedZone.asset.gpuMesh !== undefined
    )
      return undefined;
    const publication = inspection.waterGraph?.waterInfo?.find(
      (row) =>
        row.frameGeneration === receipt.frameId &&
        row.deviceGeneration === receipt.deviceGeneration &&
        snapshots.every(
          (snapshot) =>
            snapshot !== undefined &&
            row.rows.some(
              (info) =>
                info.bodyGuid === snapshot.guid &&
                info.bodyGeneration === snapshot.sceneGeneration &&
                info.outputGeneration === snapshot.outputGenerations.waterInfo &&
                info.zoneGuid === acceptedZone.guid &&
                info.zoneGeneration === acceptedZone.generation,
            ),
        ),
    );
    if (!publication || publication.unavailable.length > 0 || !renderer.waterInfo.active)
      return undefined;
    const mesh = water().zoneMeshView(acceptedZone.guid, publication.viewIdentity),
      raster = snapshots.filter((snapshot) => snapshot?.asset.flags.affectsWaterMesh);
    return mesh?.current &&
      mesh.zoneGeneration === acceptedZone.generation &&
      raster.every(
        (snapshot) =>
          snapshot !== undefined &&
          mesh.sourceGenerations[snapshot.guid] === snapshot.sceneGeneration &&
          mesh.waterMeshOutputGenerations[snapshot.guid] === snapshot.outputGenerations.waterMesh,
      )
      ? mesh
      : undefined;
  };
  const materialDrawEvidence = (
    inspection: RenderInspection,
    handles: readonly number[],
    revisions: readonly number[],
    requireDrawReceipt = false,
  ) => {
    const expected = new Map<number, number>(
      handles.flatMap((handle, index) => {
        const revision = revisions[index];
        return revision === undefined ? [] : [[handle, revision] as const];
      }),
    );
    return inspection.meshMaterialBindings.flatMap((draw) =>
      draw.bindings.flatMap((binding, index) => {
        const expectedRevision = expected.get(binding.handle),
          receipt = binding.drawReceipt,
          actualRevision = requireDrawReceipt
            ? binding.sourceRevision
            : draw.waterFoamInputs?.[index]?.inputs.sourceGeneration;
        return expectedRevision === undefined || (requireDrawReceipt && receipt === undefined)
          ? []
          : [{
              handle: binding.handle,
              expectedRevision,
              actualRevision,
              frameId: receipt?.frameId,
              deviceGeneration: receipt?.deviceGeneration,
              graphGeneration: receipt?.graphGeneration,
            }];
      }),
    );
  };
  const configurationEvidence = (
    candidate: NonNullable<typeof transaction>,
    receipt: FrameReceipt,
    inspection: RenderInspection,
  ) => {
    const blockers: string[] = [],
      acceptedZone = waterSceneZoneSnapshot(world, guid('zone/coast')),
      snapshots = bodies.map(bodySnapshot),
      facts = renderFacts(inspection);
const reviewConfigurationSourceReceipts = () => {
    if (
      receipt.frameId <= candidate.frameAfter ||
      receipt.deviceGeneration !== candidate.deviceGeneration ||
      inspection.frame.frameId !== receipt.frameId ||
      inspection.frame.deviceGeneration !== receipt.deviceGeneration
    )
      blockers.push('receipt-identity');
    if (
      !acceptedZone ||
      acceptedZone.sourceRevision !== candidate.zoneRevision ||
      acceptedZone.generation <= candidate.zoneGenerationBefore
    )
      blockers.push('zone-revision');
    const zoneSettings = (asset: typeof originalZone) => ({
      tessellationFactor: asset.tessellationFactor,
      tileSizeM: asset.tileSizeM,
      lodScale: asset.lodScale,
      extentM: asset.extentM,
      waterInfo: asset.waterInfo,
      gpuMesh: asset.gpuMesh ?? null,
      farMaterialGuid: asset.farMaterialGuid,
    });
    if (
      !acceptedZone ||
      JSON.stringify(zoneSettings(acceptedZone.asset)) !==
        JSON.stringify(zoneSettings(candidate.expectedZone))
    )
      blockers.push('effective-zone-settings');
    if (
      snapshots.some(
        (snapshot, index) =>
          !snapshot ||
          snapshot.sourceVersion !== String(candidate.bodyRevisions[index]) ||
          snapshot.asset.waveSetGuid !== candidate.waveSetGuid ||
          snapshot.binding.kind !== 'bound' ||
          snapshot.binding.zoneGeneration !== acceptedZone?.generation,
      )
    )
      blockers.push('body-revisions');
};
reviewConfigurationSourceReceipts();
    const publication =
      acceptedZone &&
      inspection.waterGraph?.waterInfo?.find(
        (row) =>
          row.frameGeneration === receipt.frameId &&
          row.deviceGeneration === receipt.deviceGeneration &&
          snapshots.every(
            (snapshot) =>
              snapshot !== undefined &&
              row.rows.some(
                (info) =>
                  info.bodyGuid === snapshot.guid &&
                  info.bodyGeneration === snapshot.sceneGeneration &&
                  info.outputGeneration === snapshot.outputGenerations.waterInfo &&
                  info.zoneGuid === acceptedZone.guid &&
                  info.zoneGeneration === acceptedZone.generation &&
                  row.targets.some(
                    (target) =>
                      target.targetName === info.targetName &&
                      target.graphResourceVersion.length > 0,
                  ),
              ),
          ),
      );
    if (!publication || publication.unavailable.length > 0 || !facts.waterInfo.active)
      blockers.push('submitted-water-info');
const reviewConfigurationMeshAndGraph = () => {
    const mesh =
      publication && acceptedZone
        ? water().zoneMeshView(acceptedZone.guid, publication.viewIdentity)
        : undefined;
    const raster = snapshots.filter((snapshot) => snapshot?.asset.flags.affectsWaterMesh);
    if (
      candidate.mode === 'R1'
        ? !facts.gpuMesh
        : !mesh?.current ||
          mesh.zoneGeneration !== acceptedZone?.generation ||
          !raster.every(
            (snapshot) =>
              snapshot !== undefined &&
              mesh.sourceGenerations[snapshot.guid] === snapshot.sceneGeneration &&
              mesh.waterMeshOutputGenerations[snapshot.guid] ===
                snapshot.outputGenerations.waterMesh,
          )
    )
      blockers.push('submitted-water-mesh');
const reviewConfigurationGraphMode = () => {
    if (
      candidate.mode === 'Q3' &&
      (facts.gpuMesh || candidate.expectedZone.gpuMesh !== undefined)
    )
      blockers.push('cpu-water-mesh-mode');
    if (candidate.mode === 'Q3' || candidate.mode === 'Q4') {
      const product = qualityMaterialGuids[candidate.mode];
      if (
        snapshots.some((snapshot) => {
          if (!snapshot) return true;
          const expected = product.bodies.ocean;
          return snapshot.asset.surfaceMaterialGuid !== expected.surface ||
            snapshot.asset.lodMaterialGuid !== expected.lod;
        }) || candidate.expectedZone.farMaterialGuid !== product.far
      )
        blockers.push('saved-appearance-product');
    }
    if (
      !facts.singleLayerOptics ||
      !facts.noWaterSceneCopy ||
      !facts.waterSurfaceDepthNormalVelocity ||
      !facts.deferredLighting ||
      !facts.captureSky ||
      (candidate.mode === 'Q2' ? facts.waterSurfaceSsr : !facts.waterSurfaceSsr)
    )
      blockers.push('mode-graph-closure');
    if (
      candidate.mode === 'R5' &&
      (buoyancy().async.execution !== 'worker-solver' ||
        buoyancy().async.completed <= candidate.asyncCompletedBefore)
    )
      blockers.push('async-completion');
};
reviewConfigurationGraphMode();
return mesh;
};
const mesh = reviewConfigurationMeshAndGraph();
const reviewConfigurationMaterialAndFluid = () => {
    const requiresMaterialDrawReceipt = candidate.mode === 'Q3' || candidate.mode === 'Q4',
      materialDraws = materialDrawEvidence(
        inspection,
        candidate.materialHandles,
        candidate.materialRevisions,
        requiresMaterialDrawReceipt,
      );
    if (
      materialDraws.length === 0 ||
      materialDraws.some(
        (draw) =>
          draw.actualRevision !== draw.expectedRevision ||
          (requiresMaterialDrawReceipt &&
            (draw.frameId !== receipt.frameId ||
              draw.deviceGeneration !== receipt.deviceGeneration ||
              draw.graphGeneration !== inspection.waterGraph?.generation)),
      )
    )
      blockers.push('submitted-material-revisions');
    const legacy = water().fluid.inspect()[`scene-entity:${oceanFoam}`];
    if (
      candidate.legacyFluidEnabled
        ? legacy?.kind !== 'active' ||
          legacy.deviceGeneration !== receipt.deviceGeneration ||
          !facts.fluidSimulation
        : legacy?.kind !== 'disabled'
    )
      blockers.push('legacy-fluid-composition');
return { materialDraws, legacy };
};
const { materialDraws, legacy } = reviewConfigurationMaterialAndFluid();
    candidate.blockers = blockers;
    const meshEvidence = mesh && (({ receipt: _receipt, ...evidence }) => evidence)(mesh);
    return blockers.length
      ? undefined
      : {
          zone: acceptedZone,
          bodies: snapshots.map(bodyEvidence),
          waterInfo: publication,
          mesh: meshEvidence,
          graph: facts.resourceClosure,
          async: { ...buoyancy().async },
          materialDraws,
          ...(candidate.mode === 'Q3'
            ? {
                cpuWaterMesh: mesh && {
                  publicationGeneration: mesh.publicationGeneration,
                  sourceGenerations: mesh.sourceGenerations,
                  waterMeshOutputGenerations: mesh.waterMeshOutputGenerations,
                },
              }
            : {}),
          ...(candidate.mode === 'Q4'
            ? {
                appearanceAdapter: {
                  kind: 'flat-transparent',
                  sourceVersion: qualitySourceVersion('Q4'),
                  frameId: receipt.frameId,
                  materialDraws,
                },
              }
            : {}),
          legacyFluid: legacy,
        };
  };
  const requiresFoamValidation = () =>
    materials.some((handle) => assets.read(handle).unwrap().staticSwitches?.waterFoam === true);
  const capabilities = (mode: Mode, inspection: RenderInspection) => {
    const settings = assets.read(zoneAsset).unwrap(),
      async = buoyancy().async,
      facts = renderFacts(inspection),
      cpuMesh = mode === 'Q3' && activeMode === 'Q3' && transaction === undefined
        ? completedCpuWaterMesh(inspection) !== undefined
        : false,
      q4Draws = mode === 'Q4' && activeMode === 'Q4' && transaction === undefined &&
        completedReceipt !== undefined &&
        completedReceipt.frameId === inspection.frame.frameId &&
        completedReceipt.deviceGeneration === inspection.frame.deviceGeneration
        ? materialDrawEvidence(
            inspection,
            qualityMaterialHandles.Q4,
            qualityMaterialHandles.Q4.map((handle) => assets.revision(handle).unwrap()),
            true,
          )
        : [],
      renderer = {
        ...facts,
        ...(mode === 'Q3' ? { cpuMesh: cpuMesh ? true : facts.cpuMesh } : {}),
        ...(mode === 'Q4'
          ? {
              appearanceAdapter: {
                kind: 'flat-transparent' as const,
                composed: facts.ready &&
                  qualitySourceClosureAccepted('Q4') &&
                  q4Draws.some((draw) =>
                    draw.actualRevision === draw.expectedRevision &&
                    draw.frameId === inspection.frame.frameId &&
                    draw.deviceGeneration === inspection.frame.deviceGeneration,
                  ),
                sourceVersion: qualitySourceVersion('Q4'),
              },
            }
          : {}),
      };
const completeR8CapabilityReport = () => {
    const report = createWaterCapabilityReport({
      ...selections[mode],
      parameterIdentity: JSON.stringify([
        sourceKey,
        COAST_SEED,
        mode,
        meshProfile,
        assets.revision(zoneAsset).unwrap(),
        windStrength,
        element<HTMLInputElement>('local-water-enabled').checked,
        assets.revision(localRecipe).unwrap(),
        assets.revision(r7Recipe).unwrap(),
        bodies.map((body) => assets.revision(body.handle).unwrap()),
        materials.map((handle) => [
          assets.revision(handle).unwrap(),
          assets.read(handle).unwrap().staticSwitches,
        ]),
        qualityMaterialHandles.Q3.map((handle) => assets.revision(handle).unwrap()),
        qualityMaterialHandles.Q4.map((handle) => assets.revision(handle).unwrap()),
      ]),
      format: settings.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
      width: settings.waterInfo.resolution.widthPx,
      height: settings.waterInfo.resolution.heightPx,
      layers: 1,
      basicDiOrBeachFoam: requiresFoamValidation(),
      reflectionMode: mode === 'Q2' ? 'disabled' : 'ssr',
      solverExecution: async.execution === 'worker-solver' ? 'worker-solver' : 'inline-solver',
      device: inspectRhiDeviceFacts(inspection.capabilities, inspection.limits ?? {}),
      renderer,
      physics: physicsFacts(),
      evidence: [],
    });
    return {
      ...report,
      composition: {
        base: selections[mode],
        local: element<HTMLInputElement>('local-water-enabled').checked
          ? mode === 'R7-shallow'
            ? 'ue-5.8.1-water-body'
            : 'mode-projected-gravity/1'
          : null,
        comparison: 'unvalidated-composed-coast',
      },
    };};
return completeR8CapabilityReport();

  };
  const logicalBudget = (inspection: RenderInspection) => {
    const rows: WaterBudgetResource[] = [],
      unknown: string[] = [];
    for (const [resourceIndex, resource] of (inspection.waterGraph?.resources ?? []).entries()) {
      const descriptor = resource.descriptor;
      const label = resource.label;
      const feature: WaterBudgetResource['feature'] = label?.includes('water-info')
        ? 'water-info'
        : label?.includes('ssr')
          ? 'ssr'
          : label?.includes('water-fluid')
            ? 'fluid'
            : label?.includes('water-advanced')
              ? 'advanced'
              : label?.includes('water-ocean')
                ? 'ocean'
                : label?.includes('water-gpu')
                  ? 'water-mesh'
                  : label?.includes('prepass') ||
                      label?.includes('water-normal') ||
                      label?.includes('water-mask') ||
                      label?.includes('water-wpo')
                    ? 'prepass'
                    : 'scene-copy';
      const base = {
        key:
          resource.physicalAllocationKey ??
          `${inspection.frame.deviceGeneration}/${inspection.waterGraph!.generation}/resource-${resourceIndex}`,
        feature,
        deviceGeneration: inspection.frame.deviceGeneration,
        graphResourceVersion: String(inspection.waterGraph!.generation),
        copies: 1,
        lastUseFence: null,
        state: 'active' as const,
      };
      if (descriptor.kind === 'texture') {
        const format = descriptor.format as Extract<
          WaterBudgetResource,
          { kind: 'texture' }
        >['format'];
        const row = {
          ...base,
          kind: 'texture' as const,
          format,
          width: descriptor.width,
          height: descriptor.height,
          layers: descriptor.depthOrArrayLayers,
          mips: descriptor.mipLevelCount,
          samples: descriptor.sampleCount as 1 | 4,
        };
        if (estimateWaterResourceBudget([row]).ok) rows.push(row);
        else if (label !== undefined) unknown.push(label);
      } else if (descriptor.kind === 'buffer')
        rows.push({ ...base, kind: 'buffer', size: descriptor.size, alignment: 1 });
      else if (label !== undefined) unknown.push(label);
    }
    const unique = [...new Map(rows.map((row) => [row.key, row])).values()];
    return {
      estimate: estimateWaterResourceBudget(unique),
      unknown,
      coverage: 'current-compiled-view-water-dependency-closure-only',
      lifetimeCoverage: {
        currentGraphState: 'assumed-active-for-descriptor-estimate',
        candidateBytes: null,
        previousAndRetiringBytes: null,
        allGenerationPeakBytes: null,
        lastUseFences: 'unmeasured',
      },
      generationAllocation: inspection.renderGraphGenerationAllocation ?? null,
      physicalVram: 'unmeasured',
      gpuMilliseconds: 'unmeasured',
    };
  };
  const readState = () => ({
    version: 1,
    scene: {
      sourceKey,
      guid: guid('scene/coast'),
      seed: COAST_SEED,
      fixedDeltaSeconds: 1 / 60,
      resolution: [canvas.width, canvas.height],
      camera: { eye, target },
      weather: element<HTMLSelectElement>('weather').value,
      cloudsEnabled,
      skyVariant: cloudsEnabled ? 'cloudy' : 'cloudless',
      skySourceGuid: guid(
        `environment/${element<HTMLSelectElement>('weather').value}${cloudsEnabled ? '' : '-clear'}`,
      ),
      exposure: Number(element<HTMLInputElement>('exposure').value),
      meshProfile: {
        name: meshProfile,
        ...COAST_MESH_PROFILES[meshProfile],
        effectiveTessellationFactor: assets.read(zoneAsset).unwrap().tessellationFactor,
      },
    },
    timeSeconds: world.getResource(Time).elapsed,
    shipDynamics: physics().getCommittedBodyDynamics?.(ship),
    shipMassRig: {
      ...COAST_SHIP_MASS_RIG,
      admission: shipRigAdmission,
      publication: physics().getDerivedPublication?.(ship),
    },
    shipNavigation: { ...shipNavigation, route: shipRoute },
    wind: {
      strength: windStrength,
      pending: pendingWindStrength ?? null,
      maximum: maximumWindStrength,
      unit: 'authored-spectrum-multiplier',
      sources: windSources.map(({ handle }) => ({
        revision: assets.revision(handle).unwrap(),
        payload: assets.read(handle).unwrap(),
      })),
    },
    localDisturbance: {
      model: requestedMode === 'R7-shallow' ? 'ue-5.8.1-water-body' : 'mode-projected-gravity/1',
      composition: 'additive-residual',
      cpuBuoyancyFeedback:
        requestedMode !== 'R7-shallow' && element<HTMLInputElement>('local-water-enabled').checked,
      feedbackAcceptance: 'unverified',
      config: assets.read(requestedMode === 'R7-shallow' ? r7Recipe : localRecipe).unwrap(),
      enabled: element<HTMLInputElement>('local-water-enabled').checked,
      state: (requestedMode === 'R7-shallow' ? r7Simulation : localSimulation)?.inspect() ?? null,
    },
    ironBalls: balls.map((ball) => ({
      ...ball,
      radiusM: IRON_BALL_RADIUS_M,
      massKg: IRON_BALL_MASS_KG,
      dynamics: physics().getCommittedBodyDynamics?.(ball.entity),
    })),
    requestedMode,
    activeMode,
    transaction: transaction ? transactionEvidence(transaction) : null,
    producerFaults: { waterInfoCapture: waterInfoProbe.inspect() },
    completedFrames,
    completedReceipt,
    capability: latest ? capabilities(requestedMode, latest) : null,
    budget: latest ? logicalBudget(latest) : null,
    bodies: bodies.map((body) => {
      const snapshot = bodySnapshot(body);
      return {
        type: body.type,
        source: assets.source(body.handle),
        runtimeAssetOutputStatus: {
          owner: 'Runtime.waterSceneSnapshot',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          snapshot: bodyEvidence(snapshot) ?? null,
        },
        waterSystemOutputStatus: {
          owner: 'WaterSystem.snapshot',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          snapshot: bodyEvidence(snapshot && water().snapshot(snapshot.guid)) ?? null,
        },
        query: snapshot
          ? water().queryBody(snapshot.guid, {
              positionM: regions[body.type] ?? [0, 0, 0],
              flags:
                WaterQueryFlags.ComputeLocation |
                WaterQueryFlags.ComputeDepth |
                WaterQueryFlags.IncludeWaves,
              timeSeconds: world.getResource(Time).elapsed,
              nativePhysics: {
                completedStep: physics().getSolverClock!().completedStep,
                timeSeconds: physics().getSolverClock!().simulationTimeSeconds,
              },
            })
          : null,
      };
    }),
    zones: water().zoneSnapshots(),
    views: latest?.waterGraph?.waterInfo?.map((publication) =>
      water().viewState(publication.viewIdentity),
    ),
    foamInputs: {
      contactHistory: { decayPerSecond: COAST_FOAM_DECAY_PER_SECOND },
      requiredValidation: requiresFoamValidation() ? 'V-16' : null,
      authoredMaterials: materials.map((handle) => ({
        handle,
        revision: assets.revision(handle).unwrap(),
        staticSwitches: assets.read(handle).unwrap().staticSwitches,
      })),
      submittedFrame: latest
        ? { frameId: latest.frame.frameId, deviceGeneration: latest.frame.deviceGeneration }
        : null,
      draws: latest?.meshMaterialBindings.filter((row) =>
        row.waterFoamInputs?.some((input) => input !== undefined),
      ),
    },
    rendererAcceptedMeshPublications: latest?.waterGraph?.waterInfo?.flatMap((publication) =>
      [...new Set(publication.rows.map((row) => row.zoneGuid))].map((zoneGuid) => {
        const mesh = water().zoneMeshView(zoneGuid, publication.viewIdentity);
        return {
          owner: 'WaterSystem.zoneMeshView',
          acceptedBy: 'Render completion feedback',
          sampledAfterCompletedReceipt: completedReceipt ?? null,
          waterInfoSubmittedFrame: {
            frameId: publication.frameGeneration,
            deviceGeneration: publication.deviceGeneration,
          },
          viewIdentity: publication.viewIdentity,
          zoneGuid,
          publication: mesh
            ? {
                generation: mesh.publicationGeneration,
                zoneGeneration: mesh.zoneGeneration,
                sourceGenerations: mesh.sourceGenerations,
                outputGenerations: mesh.waterMeshOutputGenerations,
                current: mesh.current,
                mesh: {
                  treeDepth: mesh.receipt.treeDepth,
                  selectedTileCount: mesh.receipt.selectedTileCount,
                  farInstanceCount: mesh.receipt.farInstanceCount,
                  tiles: mesh.receipt.instances,
                  draws: mesh.receipt.buckets.flatMap((bucket) =>
                    bucket.ownerDraws.map((draw) => ({
                      materialKey: bucket.materialKey,
                      ownerGuid: draw.ownerGuid,
                      indexCount: draw.indexCount,
                      instanceCount: draw.instances.length,
                    })),
                  ),
                },
              }
            : null,
        };
      }),
    ),
    unavailableModes,
    unverifiedFaultPrerequisites,
    buoyancy: buoyancy(),
    visualContacts: contacts(),
    composition: {
      optics: selections[activeMode],
      identity: `${activeMode}-optics${
        element<HTMLInputElement>('local-water-enabled').checked
          ? activeMode === 'R7-shallow'
            ? '+ue-5.8.1-water-body'
            : '+mode-projected-gravity/1'
          : ''
      }`,
      strictUncomposedUeR0: false,
      crest: {
        owner: 'Water surface material',
        domain:
          activeMode === 'R6' ? 'legacy-r6-wave-foam-history' : 'gerstner-horizontal-compression',
        amounts: materials.map(
          (handle) => assets.read(handle).unwrap().values?.surfaceCrestFoamAmount ?? 0,
        ),
        legacyR6Enabled: world.get(oceanFoam, WaterFluidSimulation).unwrap().enabled,
        legacyState: water().fluid.inspect()[`scene-entity:${oceanFoam}`] ?? null,
      },
      contact: {
        owner: 'WaterContactProbeSet',
        enabled: world.get(ship, WaterContactProbeSet).unwrap().enabled,
        amounts: materials.map(
          (handle) => assets.read(handle).unwrap().values?.contactFoamAmount ?? 1,
        ),
      },
      shore: {
        owner: 'SLW no-water scene depth',
        widthsCameraAxisM: materials.map(
          (handle) => assets.read(handle).unwrap().values?.sceneDepthFoamWidthM ?? 0,
        ),
        amounts: materials.map(
          (handle) => assets.read(handle).unwrap().values?.sceneDepthFoamAmount ?? 0,
        ),
      },
      parity: 'unvalidated-engine-composition',
    },
    timelines: { fixed: fixedTrace, cpu: cpuTrace, render: renderTrace, gpu: gpuTimings },
    diagnostics: {
      ...diagnostics,
      sampledInspectionFrame: latest?.frame ?? null,
      completedFrameTimes,
    },
    operations,
    errors,
    inspection: latest,
    liveRenderer: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
  });
  const applyCrestComposition = (mode: Mode) => {
    const enabled = element<HTMLInputElement>('crests-enabled').checked;
    for (const handle of materials) {
      const material = assets.read(handle).unwrap();
      assets
        .update(handle, {
          values: {
            ...material.values,
            surfaceCrestFoamAmount:
              enabled && mode !== 'R6' && material.staticSwitches?.waterOceanFoam === true ? 1 : 0,
          },
        })
        .unwrap();
    }
    const legacyFluidEnabled = enabled && mode === 'R6';
    world.set(oceanFoam, WaterFluidSimulation, { enabled: legacyFluidEnabled }).unwrap();
    return legacyFluidEnabled;
  };
  const setMode = (mode: Mode, nextMeshProfile = meshProfile) => {
    if (transaction) {
      message('正在等待候选配置完成帧');
      return;
    }
    const prerequisite = unavailableModes[mode];
    if (prerequisite) {
      element<HTMLSelectElement>('quality').value = requestedMode;
      record('configuration-unavailable', { mode, prerequisite, comparison: 'unvalidated' });
      message(prerequisite);
      return;
    }
    const current = app.renderer.inspect();
    const facts = inspectRhiDeviceFacts(current.capabilities, current.limits ?? {});
    if (
      mode === 'R1' &&
      [facts.compute, facts.indirectDraw, facts.storageBuffer].some(
        (status) => status !== 'supported',
      )
    ) {
      element<HTMLSelectElement>('quality').value = requestedMode;
      message('GPU 网格所需设备能力不可用');
      return;
    }
    if ((mode === 'Q3' || mode === 'Q4') && !qualitySourceClosureAccepted(mode)) {
      element<HTMLSelectElement>('quality').value = requestedMode;
      const missing = `${mode} saved appearance Pack closure is missing or stale`;
      record('configuration-unavailable', { mode, prerequisite: missing, comparison: 'unvalidated' });
      message(missing);
      return;
    }
const reviewAndAdmitR8ModeRequest = () => {
    if (mode === 'Q3') {
      const waterFormat = originalZone.waterInfo.format === 'rgba32f' ? 'rgba32float' : 'rgba16float',
        maximumDimension = facts.limits.maxTextureDimension2D ?? 0,
        maximumLayers = facts.limits.maxTextureArrayLayers ?? 0,
        q3DeviceReady = facts.compute === 'supported' &&
          facts.formats[waterFormat].renderSample === 'supported' &&
          facts.formats[waterFormat].arrayRenderSample === 'supported' &&
          facts.formats[waterFormat].storageSample === 'supported' &&
          facts.formats.depth32float.renderSample === 'supported' &&
          facts.formats.rg16float.renderSample === 'supported' &&
          originalZone.waterInfo.resolution.widthPx <= maximumDimension &&
          originalZone.waterInfo.resolution.heightPx <= maximumDimension &&
          maximumLayers >= 1;
      if (!q3DeviceReady || originalZone.gpuMesh !== undefined) {
        element<HTMLSelectElement>('quality').value = requestedMode;
        message('Q3 所需 CPU 网格与 WaterInfo 设备闭合不可用');
        record('configuration-unavailable', {
          mode,
          prerequisite: 'CPU WaterMesh source, compute, storage and texture limits must be admitted before the candidate frame',
          device: facts,
          comparison: 'unvalidated',
        });
        return;
      }
    }
    if (mode === 'Q4' && current.state !== 'alive') {
      element<HTMLSelectElement>('quality').value = requestedMode;
      message('Q4 外观适配需要就绪的 Renderer');
      return;
    }
const prepareR8ConfigurationCandidate = () => {
    const before = configurationSnapshot(),
      zoneGenerationBefore = waterSceneZoneSnapshot(world, guid('zone/coast'))?.generation ?? 0;
    const qualityProduct = mode === 'Q3' || mode === 'Q4' ? qualityMaterialGuids[mode] : undefined;
    const settings = {
      ...originalZone,
      ...(qualityProduct === undefined ? {} : { farMaterialGuid: qualityProduct.far }),
      tessellationFactor: COAST_MESH_PROFILES[nextMeshProfile].tessellationFactor,
      ...(mode === 'Q1'
        ? {
            tessellationFactor: 3,
            waterInfo: {
              ...originalZone.waterInfo,
              resolution: {
                widthPx: Math.max(1, Math.floor(originalZone.waterInfo.resolution.widthPx / 2)),
                heightPx: Math.max(1, Math.floor(originalZone.waterInfo.resolution.heightPx / 2)),
              },
            },
          }
        : {}),
      ...(mode === 'R1'
        ? {
            gpuMesh: {
              supersampling: 2 as const,
              msaaSamples: 4 as const,
              occlusion: 'disabled' as const,
            },
          }
        : {}),
    };
return { before, zoneGenerationBefore, qualityProduct, settings };
};
const { before, zoneGenerationBefore, qualityProduct, settings } = prepareR8ConfigurationCandidate();
const admitAndCommitR8ConfigurationRequest = () => {
    const candidate = assets.replace(zoneAsset, settings);
    if (!candidate.ok) {
      element<HTMLSelectElement>('quality').value = requestedMode;
      report(candidate.error);
      return;
    }
    requestedMode = mode;
    meshProfile = nextMeshProfile;
    transaction = {
      revision: ++modeRevision,
      mode,
      previous: activeMode,
      frameAfter: current.frame.frameId,
      deviceGeneration: current.frame.deviceGeneration,
      zoneRevision: assets.revision(zoneAsset).unwrap(),
      zoneGenerationBefore,
      expectedZone: settings,
      waveSetGuid: guid(`waves/${mode === 'Q1' ? 'q1' : 'breeze'}`),
      bodyRevisions: bodies.map((body) => assets.revision(body.handle).unwrap()),
      materialHandles: modeMaterialHandles(mode),
      materialRevisions: modeMaterialHandles(mode).map((handle) => assets.revision(handle).unwrap()),
      legacyFluidEnabled: false,
      asyncCompletedBefore: buoyancy().async.completed,
      status: 'preparing',
      blockers: [],
      before,
      beforeGraph: current.renderGraphGenerationAllocation,
    };
    lockConfiguration(true);
    try {
      for (const [index, body] of bodies.entries()) {
        const original = originalBodies[index]!,
          productBody = qualityProduct?.bodies.ocean,
          surfaceMaterialGuid = productBody?.surface ?? original.surfaceMaterialGuid,
          lodMaterialGuid = productBody?.lod ?? original.lodMaterialGuid!;
        assets.update(body.handle, {
          waveSetGuid: transaction.waveSetGuid,
          surfaceMaterialGuid,
          lodMaterialGuid,
        }).unwrap();
      }
      transaction.bodyRevisions = bodies.map((body) => assets.revision(body.handle).unwrap());
      const ssr = world.get(camera, ScreenSpaceReflection);
      if (mode === 'Q2') {
        if (ssr.ok) world.removeComponent(camera, ScreenSpaceReflection).unwrap();
      } else if (!ssr.ok)
        world
          .addComponent(camera, {
            component: ScreenSpaceReflection,
            data: { maxDistance: 180, thickness: 0.3, maxRoughness: 0.65, waterTemporal: 1 },
          })
          .unwrap();
      buoyancy().asyncEnabled = mode === 'R5';
      world.set(ship, WaterPontoonSet, { useAsyncPath: mode === 'R5' }).unwrap();
      transaction.legacyFluidEnabled = applyCrestComposition(mode);
      transaction.materialRevisions = transaction.materialHandles.map((handle) => assets.revision(handle).unwrap());
    } catch (error) {
      report(error);
      return;
    }
    record('configuration-requested', transactionEvidence(transaction));
    element('transition').textContent = '正在准备候选资源与图';
};
return admitAndCommitR8ConfigurationRequest();
};
return reviewAndAdmitR8ModeRequest();

  };
  const resetShip = () => {
    shipResetRequested = true;
    shipNavigation.running = false;
    shipNavigation.braking = false;
    shipNavigation.previousAngle = undefined;
    shipNavigation.distanceRadians = 0;
    shipNavigation.completedLaps = 0;
  };
  const fault = async (kind: string) => {
    if (transaction) {
      message('正在等待候选配置完成帧');
      return;
    }
    if (kind === 'zone') {
      if (zoneRemoved)
        world
          .addComponent(zone, { component: WaterZoneInstance, data: { zone: zoneAsset } })
          .unwrap();
      else world.removeComponent(zone, WaterZoneInstance).unwrap();
      zoneRemoved = !zoneRemoved;
    } else if (kind === 'water-info-delay') {
      const publication = latest?.waterGraph?.waterInfo?.[0];
      if (!publication) {
        record('water-info-delay-unavailable', { reason: 'no-completed-water-info' });
        return;
      }
      waterInfoProbe.deferNextCapture({
        viewIdentity: publication.viewIdentity,
        deviceGeneration: publication.deviceGeneration,
      });
      await fault('ocean');
      record('water-info-delay-requested', waterInfoProbe.inspect());
    } else if (kind === 'ocean') {
      const ocean = bodies[0]!,
        source = originalBodies[0]!;
      const replacement = oceanChanged
        ? source
        : assets
            .read((await assets.load(guid('body/ocean-edited'), 'water-body')).unwrap())
            .unwrap();
      assets.replace(ocean.handle, replacement).unwrap();
      assets
        .replace(
          localRecipe,
          oceanChanged
            ? originalLocalRecipe
            : assets
                .read(
                  (
                    await assets.load(guid('fluid/coast-local-edited'), 'water-simulation-recipe')
                  ).unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
      oceanChanged = !oceanChanged;
      record('ocean-source-replacement', {
        revision: assets.revision(ocean.handle).unwrap(),
        variant: oceanChanged ? guid('body/ocean-edited') : guid('body/ocean'),
      });
    } else if (kind === 'body') {
      const ocean = bodies[0]!,
        previous = ocean.entity;
      world.despawn(previous).unwrap();
      ocean.entity = world
        .spawn(
          { component: Transform, data: {} },
          {
            component: WaterBodyInstance,
            data: { body: ocean.handle },
          },
        )
        .unwrap();
      record('body-reuse', { previous, current: ocean.entity });
    } else if (kind === 'material') {
      materialMissing = !materialMissing;
      assets
        .update(bodies[0]!.handle, {
          surfaceMaterialGuid: materialMissing
            ? guid('material/missing-injection')
            : originalBodies[0]!.surfaceMaterialGuid,
        })
        .unwrap();
    } else if (kind === 'resize') {
      smallResolution = !smallResolution;
      canvas.style.width = smallResolution ? '75vw' : '100vw';
      canvas.style.height = smallResolution ? '75dvh' : '100dvh';
      applyCamera();
    } else if (kind === 'loss') {
      const before = app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] });
      if (before.state !== 'alive') {
        record('device-loss-unavailable', { before });
        message('渲染器当前状态不允许受控设备丢失');
        return;
      }
      const native = app.renderer.nativeDevice();
      if (!native.ok) {
        report(native.error);
        return;
      }
      native.value.destroy();
      await native.value.lost;
      record('device-loss-observed', {
        before,
        after: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
      });
      const recovery = await app.renderer.recover();
      record('device-recovery', {
        result: recovery,
        inspection: app.renderer.inspect({ fields: ['state', 'frame', 'recovery'] }),
      });
      if (!recovery.ok) report(recovery.error);
    }
    record('fault', {
      kind,
      zoneRemoved,
      oceanChanged,
      materialMissing,
      smallResolution,
      completedReceipt,
    });
  };
  const capture = async () => {
    if (!app.rhiCapture) throw new Error('RHI capture unavailable');
    const result = await app.rhiCapture.captureFrame();
    record(
      'rhi-capture',
      result.ok
        ? { ok: true, byteLength: result.value.byteLength, digest: result.value.digest }
        : result,
    );
    if (!result.ok) report(result.error);
    return result;
  };
  const refresh = () => {
    if (!latest || element('controls-panel').hidden) return;
    const capability = capabilities(requestedMode, latest),
      budget = logicalBudget(latest);
    element('implementation').textContent = capability.implementation;
    element('comparison').textContent = capability.comparison;
    element('requirements').textContent = capability.requirements
      .filter((row) => row.status !== 'supported')
      .map((row) => `${row.owner}.${row.name}: ${row.status}`)
      .join(' · ');
    element('mode-badge').textContent = `${activeMode} 光学${
      element<HTMLInputElement>('local-water-enabled').checked
        ? activeMode === 'R7-shallow'
          ? ' + R7 浅水'
          : ' + 色散水波'
        : ''
    }`;
    element('frame').textContent = String(completedFrames);
    element('memory').textContent = budget.estimate.ok
      ? `${(budget.estimate.value.concurrentBytes / 1048576).toFixed(1)} MiB · 当前图估算`
      : '未知';
    element('receipt').textContent = completedReceipt
      ? `D${completedReceipt.deviceGeneration} / F${completedReceipt.frameId}`
      : '--';
    if (element('facts').closest('details')?.open)
      element('facts').textContent = JSON.stringify(
        {
          capability,
          unknownBudgetResources: budget.unknown,
          budgetCoverage: budget.coverage,
          budgetLifetimeCoverage: budget.lifetimeCoverage,
          graphGenerationAllocation: budget.generationAllocation,
          async: buoyancy().async,
          shipPosition: position(),
          zone: water().zoneSnapshots(),
          unverifiedFaultPrerequisites,
          producerFaults: { waterInfoCapture: waterInfoProbe.inspect() },
        },
        json,
        2,
      );
  };
  let pointer: { x: number; y: number } | undefined;
  canvas.addEventListener('pointerdown', (event) => {
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    pointer = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', () => {
    pointer = undefined;
  });
  canvas.addEventListener('pointercancel', () => {
    pointer = undefined;
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer) return;
    const dx = event.clientX - pointer.x,
      dy = event.clientY - pointer.y;
    pointer = { x: event.clientX, y: event.clientY };
    const d = target.map((v, i) => v - eye[i]!),
      distance = Math.hypot(...d),
      yaw = Math.atan2(d[0]!, d[2]!) - dx * 0.004,
      pitch = Math.max(-1.5, Math.min(1.5, Math.asin(d[1]! / distance) - dy * 0.004));
    target = [
      eye[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
      eye[1] + Math.sin(pitch) * distance,
      eye[2] + Math.cos(yaw) * Math.cos(pitch) * distance,
    ];
    applyCamera();
  });
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const delta = target.map((v, i) => v - eye[i]!),
        distance = Math.hypot(...delta),
        amount = Math.max(-12, Math.min(12, -event.deltaY * 0.025));
      eye = eye.map((v, i) => v + (delta[i]! / distance) * amount) as Vector;
      applyCamera();
    },
    { passive: false },
  );
  world
    .addSystem(Update, defineSystem({
      name: 'waterR8CameraAndTrace',
      after: [WaterSceneReconcile, WaterContactProbes, InputFrameStartScan],
      queries: [],
      fn: () => {
const applyR8PendingWindRequest = () => {
        if (
          pendingWindStrength !== undefined &&
          !transaction &&
          performance.now() - lastWindAdmissionMs >= 100
        ) {
          const requested = pendingWindStrength;
          pendingWindStrength = undefined;
          applyWindStrength(requested);
        }
};
applyR8PendingWindRequest();
        if (
          !localSimulation ||
          localSimulation.recipe.contentVersion !== String(assets.revision(localRecipe).unwrap())
        ) {
          water().removeOceanPatch();
          const asset = assets.read(localRecipe).unwrap();
          if (asset.system !== 'water-advanced')
            throw new Error('The local recipe is not water-advanced');
          localSimulation = water()
            .requestOceanPatch({
              guid: guid('fluid/coast-local'),
              contentVersion: String(assets.revision(localRecipe).unwrap()),
              asset,
            })
            .unwrap();
        }

const reconcileR8ShallowSimulation = () => {
        const r7Selected = requestedMode === 'R7-shallow';
        const body = bodySnapshot(bodies[0]!);
        if (r7Selected && body && r7Simulation?.body.generation !== body.sceneGeneration) {
          if (r7Simulation) water().removeAdvancedSimulation(r7Simulation);
          const asset = assets.read(r7Recipe).unwrap();
          if (asset.system !== 'water-advanced')
            throw new Error('The R7 recipe is not water-advanced');
          r7Simulation = water()
            .createAdvancedSimulation(
              {
                guid: guid('fluid/coast-r7-shallow'),
                contentVersion: String(assets.revision(r7Recipe).unwrap()),
                asset,
              },
              body.guid,
            )
            .unwrap();
        } else if (!body && r7Simulation) {
          water().removeAdvancedSimulation(r7Simulation);
          r7Simulation = undefined;
        }
return { r7Selected, body };
};
const { r7Selected, body } = reconcileR8ShallowSimulation();
const rebindR8LocalMaterialInputs = () => {
        const bindingIdentity = r7Selected ? `r7:${body?.guid ?? ''}` : 'dispersive';
        if (bindingIdentity !== localBindingIdentity && (!r7Selected || body)) {
          const names =
            r7Selected && body
              ? waterAdvancedOutputNames(guid('fluid/coast-r7-shallow'), body.guid, world.identity)
              : waterOceanPatchOutputNames(guid('fluid/coast-local'), world.identity);
          for (const handle of materials) {
            const material = assets.read(handle).unwrap();
            if (material.staticSwitches?.waterShallowSimulation !== true) continue;
            assets
              .update(handle, {
                values: {
                  ...material.values,
                  waterShallowGridTexture: {
                    source: renderFeatureTextureSource(names.materialGrid),
                  },
                  waterShallowNormalTexture: {
                    source: renderFeatureTextureSource(names.materialNormal),
                  },
                  waterShallowFoamTexture: { source: renderFeatureTextureSource(names.foam) },
                  waterShallowMappingTexture: { source: renderFeatureTextureSource(names.mapping) },
                },
              })
              .unwrap();
          }
          localBindingIdentity = bindingIdentity;
          if (transaction)
            transaction.materialRevisions = materials.map((handle) =>
              assets.revision(handle).unwrap(),
            );
        }
};
rebindR8LocalMaterialInputs();
        const localEnabled = element<HTMLInputElement>('local-water-enabled').checked;
        localSimulation.setEnabled(!r7Selected && localEnabled);
        water()
          .configureOceanPatchQueries(
            !r7Selected && localEnabled && body
              ? {
                  worldIdentity: world.identity,
                  bodyGuid: body.guid,
                  bodyGeneration: body.sceneGeneration,
                  maximumAgeSeconds: 0.25,
                }
              : undefined,
          )
          .unwrap();
        localSimulation.update(world.getResource(Time).delta).unwrap();
        r7Simulation?.setEnabled(r7Selected && localEnabled);
        if (r7Selected && r7Simulation) {
          const dynamics = physics().getCommittedBodyDynamics?.(ship);
          if (dynamics?.ok) {
            const forward = rotateWaterVector(dynamics.value.rotation, [1, 0, 0]);
            const centerXZ = [
              Math.round((dynamics.value.positionM[0] + forward[0] * 8) * 2) / 2,
              Math.round((dynamics.value.positionM[2] + forward[2] * 8) * 2) / 2,
            ] as const;
            r7Simulation
              .update({
                deltaSeconds: world.getResource(Time).delta,
                timeSeconds: world.getResource(Time).elapsed,
                centerXZ,
                yawRadians: 0,
              })
              .unwrap();
          }
        }

const updateR8CameraControls = () => {
        if (element<HTMLInputElement>('follow').checked) {
          const p = position();
          eye = [p[0] + 29, p[1] + 9, p[2] + 40];
          target = [p[0], p[1] + 4, p[2]];
          applyCamera();
        } else if (document.activeElement === canvas) {
          const keyboard = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard,
            dt = world.getResource(Time).delta;
          const forward = target.map((v, i) => v - eye[i]!),
            length = Math.hypot(...forward),
            x = Number(keyboard.downCode('KeyD')) - Number(keyboard.downCode('KeyA')),
            z = Number(keyboard.downCode('KeyW')) - Number(keyboard.downCode('KeyS')),
            y = Number(keyboard.downCode('KeyE')) - Number(keyboard.downCode('KeyQ'));
          if (x || y || z) {
            const speed = dt * (keyboard.downCode('ShiftLeft') ? 35 : 12);
            const move: Vector = [
              ((forward[0]! * z - forward[2]! * x) / length) * speed,
              ((forward[1]! / length) * z + y) * speed,
              ((forward[2]! * z + forward[0]! * x) / length) * speed,
            ];
            eye = eye.map((v, i) => v + move[i]!) as Vector;
            target = target.map((v, i) => v + move[i]!) as Vector;
            applyCamera();
          }
        }
};
updateR8CameraControls();
        if (diagnostics.enabled || transaction) {
          cpuTrace.push({
            time: world.getResource(Time).elapsed,
            zones: water().zoneSnapshots(),
            bodies: bodies.map((body) => ({
              type: body.type,
              snapshot: bodyEvidence(bodySnapshot(body)),
            })),
          });
          if (cpuTrace.length > 180) cpuTrace.shift();
        }
const drawR8PontoonContactForceDiagnostics = () => {
        if (element<HTMLInputElement>('debug-pontoons').checked) {
          for (const step of buoyancy().steps) {
            if (!step.result.ok) continue;
            for (const pontoon of step.result.value.pontoons)
              app.debugDraw?.sphere(
                vec3.create(...pontoon.centerM),
                pontoon.radiusM,
                [1, 0.75, 0.1, 1],
                12,
              );
          }
        }
        if (element<HTMLInputElement>('debug-contacts').checked) {
          for (const { contact } of contacts().contacts) {
            for (let segment = 0; segment < 20; segment++) {
              const point = (index: number): Vector => [
                contact.positionM[0] + Math.cos((index * Math.PI) / 10) * contact.radiusM,
                contact.positionM[1] + 0.03,
                contact.positionM[2] + Math.sin((index * Math.PI) / 10) * contact.radiusM,
              ];
              app.debugDraw?.line(
                vec3.create(...point(segment)),
                vec3.create(...point(segment + 1)),
                [0.2, 1, 0.65, 1],
              );
            }
          }
        }
        if (element<HTMLInputElement>('debug-forces').checked) {
          for (const event of buoyancy().forceEvents) {
            const length = Math.hypot(...event.forceN);
            const scale = length === 0 ? 0 : Math.min(length / 12000, 8) / length;
            app.debugDraw?.arrow(
              vec3.create(...event.positionM),
              vec3.create(
                ...(event.positionM.map(
                  (value, axis) => value + event.forceN[axis]! * scale,
                ) as Vector),
              ),
              [1, 0.3, 0.12, 1],
            );
          }
        }
};
drawR8PontoonContactForceDiagnostics();
        const forceData = element('force-data');
        forceData.hidden = !element<HTMLInputElement>('debug-forces').checked;
        if (!forceData.hidden)
          forceData.textContent = buoyancy()
            .forceEvents.map(
              (event) =>
                `${event.pontoonId}: ${(Math.hypot(...event.forceN) / 1000).toFixed(1)} kN`,
            )
            .join('\n');
const drawR8WaterNormalDiagnostics = () => {
        if (element<HTMLInputElement>('debug-normals').checked) {
          const body = bodySnapshot(bodies[0]!);
          if (body !== undefined) {
            const center = position();
            for (let x = -4; x <= 4; x++)
              for (let z = -4; z <= 4; z++) {
                const sample = water().queryBody(body.guid, {
                  positionM: [center[0] + x * 2, 0, center[2] + z * 2],
                  timeSeconds: world.getResource(Time).elapsed,
                  expectedBodyGeneration: body.sceneGeneration,
                  nativePhysics: {
                    completedStep: physics().getSolverClock!().completedStep,
                    timeSeconds: physics().getSolverClock!().simulationTimeSeconds,
                  },
                  flags:
                    WaterQueryFlags.ComputeLocation |
                    WaterQueryFlags.ComputeNormal |
                    WaterQueryFlags.IncludeWaves,
                });
                if (
                  sample.ok &&
                  !sample.value.excluded &&
                  sample.value.surfaceM &&
                  sample.value.normalYUp
                )
                  app.debugDraw?.arrow(
                    vec3.create(...sample.value.surfaceM),
                    vec3.create(
                      ...(sample.value.surfaceM.map(
                        (value, axis) => value + sample.value.normalYUp![axis]! * 1.3,
                      ) as Vector),
                    ),
                    [0.2, 0.8, 1, 1],
                  );
              }
          }
        }};
drawR8WaterNormalDiagnostics();

      },
    }))
    .unwrap();
  world
    .addSystem(FixedUpdate, defineSystem({
      name: 'waterR8ShipMotion',
      after: [PhysicsSync],
      before: [WaterBuoyancy, PhysicsSimulation],
      queries: [],
      fn: () => {
        const owner = physics();
        if (shipRigAdmission.kind !== 'ready') {
          if (shipRigAdmission.kind === 'unrequested') {
            if (!owner.hasBody(ship)) return;
            if (!owner.prepareDerivedShapeCandidate || !owner.admitDerivedShapeCandidate)
              throw new Error('Ship mass rig requires explicit native mass admission');
            const candidate = owner
              .prepareDerivedShapeCandidate({
                entity: ship,
                sourceKey: 'water-r8:ship-mass-rig',
                revision: COAST_SHIP_MASS_RIG.revision,
                shapes: [],
                massProperties: COAST_SHIP_MASS_RIG.properties,
                velocityPolicy: 'preserve',
              })
              .unwrap();
            owner.admitDerivedShapeCandidate(candidate).unwrap();
            shipRigAdmission = { kind: 'queued', candidateId: candidate.candidateId };
            return;
          }
          const failure = owner.getDerivedFailure?.(ship);
          if (failure) throw failure.error;
          const publication = owner.getDerivedPublication?.(ship);
          if (publication?.candidateId !== shipRigAdmission.candidateId) return;
          // The first coefficient solve must see the admitted COM and inertia.
          world
            .set(ship, WaterPontoonSet, {
              enabled: element<HTMLInputElement>('buoyancy-enabled').checked,
            })
            .unwrap();
          shipRigAdmission = { ...shipRigAdmission, kind: 'ready' };
          record('ship-mass-rig-admitted', {
            publication,
            dynamics: owner.getCommittedBodyDynamics?.(ship),
          });
        }
const launchPendingR8IronBalls = () => {
        for (const ball of balls) {
          if (ball.launch.fixedStep !== undefined || !owner.setBodyMotion) continue;
          const accepted = owner.getCommittedBodyDynamics?.(ball.entity);
          if (!accepted?.ok) continue;
          owner
            .setBodyMotion(ball.entity, {
              position: ball.launch.positionM,
              rotation: [0, 0, 0, 1],
              linearVelocity: ball.launch.velocityMps,
              angularVelocity: [0, 0, 0],
            })
            .unwrap();
          ball.launch.fixedStep = accepted.value.nextFixedStep;
          ball.launch.timeSeconds =
            world.getResource(FixedTime).tick * world.getResource(FixedTime).delta;
          record('iron-ball-launched', { entity: ball.entity, ...ball.launch });
        }
};
launchPendingR8IronBalls();
const createRequestedR8IronBall = () => {
        if (fireRequested) {
          const accepted = owner.getCommittedBodyDynamics?.(ship);
          if (accepted?.ok) {
            const dynamics = accepted.value;
            const muzzle = rotateWaterVector(dynamics.rotation, [11.5, 2.8, 0]);
            const direction = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
            const horizontalLength = Math.max(0.001, Math.hypot(direction[0], direction[2]));
            const positionM = dynamics.positionM.map(
              (value, axis) => value + muzzle[axis]!,
            ) as Vector;
            const velocityMps: Vector = [
              (direction[0] / horizontalLength) * 11 + dynamics.linearVelocityMps[0],
              3.5 + dynamics.linearVelocityMps[1],
              (direction[2] / horizontalLength) * 11 + dynamics.linearVelocityMps[2],
            ];
            if (balls.length >= 8) retireIronBall(balls.shift()!);
            const entity = world
              .spawn(
                { component: Transform, data: { pos: positionM } },
                { component: MeshFilter, data: { assetHandle: ironBallMesh } },
                { component: MeshRenderer, data: { materials: [ironBallMaterial] } },
                {
                  component: RigidBody,
                  data: {
                    type: RigidBodyTypeValue.dynamic,
                    mass: IRON_BALL_MASS_KG,
                    ccdEnabled: true,
                  },
                },
                {
                  component: Collider,
                  data: {
                    shape: ColliderShapeValue.sphere,
                    radius: IRON_BALL_RADIUS_M,
                    collisionGroups: 0x0001ffff,
                  },
                },
                { component: WaterShallowCollider, data: { enabled: true } },
                {
                  component: WaterPontoonSet,
                  data: {
                    configurationVersion: 1,
                    anchorsM: [0, 0, 0],
                    radiiM: [IRON_BALL_RADIUS_M],
                    buoyancyCoefficientNPerM3: 9810,
                    maxBuoyantForceN: 20000,
                    dampingNPerMps: 500,
                    applyDrag: true,
                    overlapFilterMask: 0xffff0002,
                  },
                },
              )
              .unwrap();
            const entryPlayer = world
              .spawn(
                { component: Transform, data: { pos: positionM } },
                {
                  component: ParticleEffectPlayer,
                  data: {
                    effect: ironBallEntryEffect,
                    playing: false,
                    preparePipelines: true,
                    seed: COAST_SEED,
                    timeScale: 1,
                  },
                },
              )
              .unwrap();
            balls.push({ entity, entryPlayer, launch: { positionM, velocityMps }, trajectory: [] });
            fireRequested = false;
          }
        }
};
createRequestedR8IronBall();
const applyR8ShipNavigationCommand = () => {
        if (shipResetRequested) {
          retireIronBalls();
          if (!owner.setBodyMotion) return;
          owner
            .setBodyMotion(ship, {
              position: [0, COAST_SHIP_MASS_RIG.buoyancy.loadedRootYM, 0],
              rotation: [0, 0, 0, 1],
              linearVelocity: [0, 0, 0],
              angularVelocity: [0, 0, 0],
            })
            .unwrap();
          shipResetRequested = false;
          record('ship-reset', { physicsStep: world.getResource(FixedTime).tick });
          return;
        }
        if (!shipNavigation.running && !shipNavigation.braking) return;
        const committed = owner.getCommittedBodyDynamics?.(ship);
        if (!committed?.ok || !owner.applyBodyForceAtPoint || !owner.applyBodyTorque) return;
        const dynamics = committed.value;
const calculateR8ShipNavigationForces = () => {
        const dx = dynamics.positionM[0] - shipRoute.centerXZ[0];
        const dz = dynamics.positionM[2] - shipRoute.centerXZ[1];
        const radius = Math.max(1, Math.hypot(dx, dz));
        const angle = Math.atan2(dz, dx);
const trackR8CompletedShipLaps = () => {
        if (
          shipNavigation.path === 'circle' &&
          shipNavigation.running &&
          shipNavigation.previousAngle !== undefined
        ) {
          const delta = Math.atan2(
            Math.sin(shipNavigation.previousAngle - angle),
            Math.cos(shipNavigation.previousAngle - angle),
          );
          shipNavigation.distanceRadians += delta;
          const laps = Math.floor(Math.max(0, shipNavigation.distanceRadians) / (Math.PI * 2));
          if (laps > shipNavigation.completedLaps) {
            shipNavigation.completedLaps = laps;
            record('ship-lap-completed', { laps, physicsStep: dynamics.completedStep });
            if (!shipNavigation.loop) {
              shipNavigation.running = false;
              shipNavigation.braking = true;
            }
          }
        }
};
trackR8CompletedShipLaps();
        shipNavigation.previousAngle = angle;
        const radialErrorM = radius - shipRoute.radiusM;
        const correction = Math.max(-0.65, Math.min(0.65, radialErrorM * 0.06));
        const courseX =
          shipNavigation.path === 'straight'
            ? shipNavigation.straightDirectionXZ[0]
            : dz / radius - (dx / radius) * correction;
        const courseZ =
          shipNavigation.path === 'straight'
            ? shipNavigation.straightDirectionXZ[1]
            : -dx / radius - (dz / radius) * correction;
        const courseLength = Math.hypot(courseX, courseZ);
        const speed = shipNavigation.running ? shipNavigation.speedMps : 0;
        const buoyancyStep = buoyancy().steps.find((step) => step.entity === ship)?.result;
        const dragSource =
          buoyancyStep?.ok && buoyancyStep.value.rootGeneration === dynamics.generation
            ? buoyancyStep.value
            : undefined;
        const waterDrag = dragSource?.dragAccelerationMps2 ?? [0, 0, 0];
        const damping = world.get(ship, RigidBody).unwrap().linearDamping;
        const accelerationX =
          ((courseX / courseLength) * speed - dynamics.linearVelocityMps[0]) / 1.5 -
          waterDrag[0]! +
          damping * dynamics.linearVelocityMps[0];
        const accelerationZ =
          ((courseZ / courseLength) * speed - dynamics.linearVelocityMps[2]) / 1.5 -
          waterDrag[2]! +
          damping * dynamics.linearVelocityMps[2];
        const accelerationScale = Math.min(
          1,
          2.4 / Math.max(1e-6, Math.hypot(accelerationX, accelerationZ)),
        );
        const forceN: Vector = [
          accelerationX * accelerationScale * dynamics.massKg,
          0,
          accelerationZ * accelerationScale * dynamics.massKg,
        ];
        const forward = rotateWaterVector(dynamics.rotation, [1, 0, 0]);
        const yawError = Math.atan2(
          forward[2] * courseX - forward[0] * courseZ,
          forward[0] * courseX + forward[2] * courseZ,
        );
        const bodyInverse = [
          -dynamics.rotation[0],
          -dynamics.rotation[1],
          -dynamics.rotation[2],
          dynamics.rotation[3],
        ] as const;
        const frame = dynamics.principalInertiaLocalRotation;
        const principalUp = rotateWaterVector(
          [-frame[0], -frame[1], -frame[2], frame[3]],
          rotateWaterVector(bodyInverse, [0, 1, 0]),
        );
        const yawRate =
          shipNavigation.running && shipNavigation.path === 'circle' ? speed / radius : 0;
        const yawAcceleration = Math.max(
          -0.25,
          Math.min(
            0.25,
            (shipNavigation.running ? yawError * 0.7 : 0) +
              (yawRate - dynamics.angularVelocityRadps[1]) * 1.8,
          ),
        );
        const principalTorque: Vector = [
          principalUp[0] * dynamics.principalInertiaKgM2[0] * yawAcceleration,
          principalUp[1] * dynamics.principalInertiaKgM2[1] * yawAcceleration,
          principalUp[2] * dynamics.principalInertiaKgM2[2] * yawAcceleration,
        ];
        const torqueNm: Vector = [
          ...rotateWaterVector(dynamics.rotation, rotateWaterVector(frame, principalTorque)),
        ];
return { forceN, torqueNm, radialErrorM, dragSource, waterDrag, damping };
};
const { forceN, torqueNm, radialErrorM, dragSource, waterDrag, damping } = calculateR8ShipNavigationForces();
        owner
          .applyBodyForceAtPoint({
            entity: ship,
            generation: dynamics.generation,
            fixedStep: dynamics.nextFixedStep,
            pointM: dynamics.centerOfMassM,
            forceN,
          })
          .unwrap();
        owner
          .applyBodyTorque({
            entity: ship,
            generation: dynamics.generation,
            fixedStep: dynamics.nextFixedStep,
            torqueNm,
          })
          .unwrap();
        shipNavigation.lastCommand = {
          fixedStep: dynamics.nextFixedStep,
          forceN,
          torqueNm,
          radialErrorM,
          waterDragSource:
            dragSource === undefined
              ? null
              : {
                  entity: dragSource.rootEntity,
                  generation: dragSource.rootGeneration,
                  physicsStep: dragSource.physicsStep,
                  accelerationMps2: [...waterDrag],
                },
          nativeDampingPerSecond: damping,
          propulsionPowerW:
            forceN[0] * dynamics.linearVelocityMps[0] + forceN[2] * dynamics.linearVelocityMps[2],
          yawPowerW: torqueNm.reduce(
            (sum, value, axis) => sum + value * dynamics.angularVelocityRadps[axis]!,
            0,
          ),
        };
        if (
          !shipNavigation.running &&
          Math.hypot(dynamics.linearVelocityMps[0], dynamics.linearVelocityMps[2]) < 0.03
        )
          shipNavigation.braking = false;};
return applyR8ShipNavigationCommand();

      },
    }))
    .unwrap();
  world
    .addSystem(FixedUpdate, defineSystem({
      name: 'waterR8CompletedPhysicsTrace',
      after: [WaterBuoyancyCompletion],
      queries: [],
      fn: () => {
        const body = bodySnapshot(bodies[0]!);
        if (body) for (const ball of balls) {
          if (ball.launch.fixedStep === undefined) continue;
          const accepted = physics().getCommittedBodyDynamics?.(ball.entity);
          if (!accepted?.ok) continue;
          const dynamics = accepted.value;
          if (ball.trajectory.length < 240 && dynamics.completedStep % 6 === 0)
            ball.trajectory.push({ fixedStep: dynamics.completedStep, positionM: [...dynamics.positionM], velocityMps: [...dynamics.linearVelocityMps] });
          if (ball.entryRetireStep !== undefined && dynamics.completedStep >= ball.entryRetireStep) {
            world.despawn(ball.entryPlayer).unwrap();
            delete ball.entryRetireStep;
          }
          if (ball.entry) continue;
          const solverClock = physics().getSolverClock?.();
          if (!solverClock) continue;
          const sample = water().queryBody(body.guid, { positionM: dynamics.positionM,
            timeSeconds: solverClock.simulationTimeSeconds, expectedBodyGeneration: body.sceneGeneration,
            nativePhysics: { completedStep: solverClock.completedStep, timeSeconds: solverClock.simulationTimeSeconds },
            flags: WaterQueryFlags.ComputeLocation | WaterQueryFlags.ComputeNormal | WaterQueryFlags.IncludeWaves });
          if (sample.ok && !sample.value.excluded && sample.value.surfaceM && sample.value.normalYUp && dynamics.positionM[1] - IRON_BALL_RADIUS_M <= sample.value.surfaceM[1]) {
            ball.entry = {
              fixedStep: dynamics.completedStep,
              bodyGeneration: body.sceneGeneration,
              positionM: [...sample.value.surfaceM],
              normalYUp: [...sample.value.normalYUp],
              velocityMps: [...dynamics.linearVelocityMps],
            };
            record('iron-ball-water-entry', { entity: ball.entity, input: 'native-water-shallow-collider', ...ball.entry });
            const patched = vfxControl.patchPlayerParameters({
              player: ball.entryPlayer,
              values: {
                entryPosition: ball.entry.positionM,
                entryVelocity: ball.entry.velocityMps,
                surfaceNormal: ball.entry.normalYUp,
              },
            });
            if (!patched.ok) {
              record('iron-ball-entry-vfx-failed', {
                entity: ball.entity,
                entry: ball.entry,
                error: patched.error,
              });
              report(patched.error);
              const retired = world.despawn(ball.entryPlayer);
              if (!retired.ok) {
                record('iron-ball-entry-vfx-retirement-failed', {
                  entity: ball.entity,
                  error: retired.error,
                });
                report(retired.error);
              }
              continue;
            }
            const started = world.set(ball.entryPlayer, ParticleEffectPlayer, { playing: true });
            if (!started.ok) {
              record('iron-ball-entry-vfx-start-failed', {
                entity: ball.entity,
                entry: ball.entry,
                error: started.error,
              });
              report(started.error);
              const retired = world.despawn(ball.entryPlayer);
              if (!retired.ok) {
                record('iron-ball-entry-vfx-retirement-failed', {
                  entity: ball.entity,
                  error: retired.error,
                });
                report(retired.error);
              }
              continue;
            }
            ball.entryRetireStep = dynamics.completedStep + Math.ceil(1.2 / world.getResource(FixedTime).delta);
          }
        }
const recordR8CompletedPhysicsDiagnostics = () => {
        if (diagnostics.enabled || transaction) {
          if (fixedTrace.length >= 180) fixedTrace.shift();
          fixedTrace.push(structuredClone({
                step: world.getResource(FixedTime).tick,
                delta: world.getResource(FixedTime).delta,
                steps: buoyancy().steps.map((row) => ({
                  entity: row.entity,
                  result: row.result.ok
                    ? { ok: true, value: snapshotWaterBuoyancyStepForTrace(row.result.value) }
                    : { ok: false, error: json('', row.result.error) },
                })),
                async: buoyancy().async,
              }));
        }};
recordR8CompletedPhysicsDiagnostics();

      },
    }))
    .unwrap();
  const completionTimes: number[] = [];
  const completedFrameTimes: {
    frameId: number;
    wallTimeMs: number;
    simulationTimeSeconds: number;
  }[] = [];
  const submittedSamples = new Map<
    string,
    {
      readonly receipt: FrameReceipt;
      readonly sample: {
        frameId: number;
        deviceGeneration: number;
        graphGeneration?: number;
        presentation: FrameReceipt['presentation'];
        waterGraph: RenderInspection['waterGraph'];
        allocation: RenderInspection['renderGraphGenerationAllocation'];
        featureGraph: RenderInspection['featureGraph'];
        completion: 'pending' | 'fulfilled' | 'rejected';
      };
      readonly inspection: RenderInspection | undefined;
      readonly candidateEvidence: unknown;
      readonly issuedTransaction: number | undefined;
      readonly profileRun: R8ProfileRun | undefined;
      readonly profileReceipt: R8ProfileReceipt | undefined;
    }
  >();
  const receiptKey = (frameId: number, deviceGeneration: number) =>
    `${deviceGeneration}/${frameId}`;
  const exactProfileToken = (
    left: FrameReceipt['profileFrame'],
    right: FrameReceipt['profileFrame'],
  ) =>
    left !== undefined &&
    right !== undefined &&
    left.captureId === right.captureId &&
    left.frameId === right.frameId;

  const startProfileCapture = (request: R8ProfileCaptureRequest = 'normal') => {
    if (profileRun !== undefined)
      return { ok: false as const, error: { code: 'profile-capture-already-active' } };
    const requestOptions = typeof request === 'object' && request !== null ? request : undefined;
    const preset = typeof request === 'string' ? request : (requestOptions?.preset ?? 'normal');
    if (preset !== 'normal' && preset !== 'nested')
      return { ok: false as const, error: { code: 'profile-capture-preset-invalid' } };
const admitR8ProfileCaptureLimits = () => {
    const defaults = R8_PROFILE_LIMITS[preset];
    const limits = Object.freeze({
      frameLimit: requestOptions?.frameLimit ?? defaults.frameLimit,
      eventLimit: requestOptions?.eventLimit ?? defaults.eventLimit,
      detail: requestOptions?.detail ?? defaults.detail,
    });
    if (
      !Number.isSafeInteger(limits.frameLimit) ||
      limits.frameLimit < 1 ||
      limits.frameLimit > R8_PROFILE_MAX_FRAME_LIMIT ||
      !Number.isSafeInteger(limits.eventLimit) ||
      limits.eventLimit < 1 ||
      limits.eventLimit > R8_PROFILE_MAX_EVENT_LIMIT ||
      (limits.detail !== 'owner' && limits.detail !== 'passes' && limits.detail !== 'nested')
    ) {
      return {
        ok: false as const,
        error: {
          code: 'profile-capture-limits-invalid',
          expected: `frameLimit 1..${R8_PROFILE_MAX_FRAME_LIMIT} and eventLimit 1..${R8_PROFILE_MAX_EVENT_LIMIT}`,
          hint: 'Choose the normal or nested preset, or pass bounded RecorderLimits overrides.',
          detail: { limits },
        },
      };
    }
    // Profiler.startCapture applies the shared RecorderLimits validation before admission.
    const started = profiler.startCapture(limits);
    if (!started.ok) return started;
const createR8ProfileRun = () => {
    const run: R8ProfileRun = {
      session: started.value,
      captureId: started.value.captureId,
      detail: limits.detail,
      receipts: [],
      completionCpu: [],
      expectedCompletionKeys: new Set(),
      observedCompletionKeys: new Set(),
      callbackCompletionKeys: new Set(),
      native: [],
      gpu: [],
      pendingReceipts: new Map(),
      nativeAvailable: false,
      nativeFenceFailures: 0,
      nativeObserverRows: 0,
      nativeIndexGapCount: 0,
      nativeFixedStepGapCount: 0,
      nativeInvalidIdentityCount: 0,
      nativeUnassociated: 0,
      nativeDropped: 0,
      cpuFinished: false,
      finalized: false,
      completionExpected: 0,
      completionCallbacksActual: 0,
      completionCpuActual: 0,
      completionCpuUnassociated: 0,
      completionCpuDuplicates: 0,
      receiptExpected: 0,
      receiptDropped: 0,
      receiptLedgerEvicted: 0,
      receiptFailures: 0,
      receiptResultCounts: { pending: 0, fulfilled: 0, rejected: 0 },
      receiptStatusCounts: {
        submitted: 0,
        completed: 0,
        'presentation-pending': 0,
        'generation-mismatch': 0,
        'identity-mismatch': 0,
        missing: 0,
        'ledger-evicted': 0,
        failed: 0,
      },
      completionIdentityMismatch: 0,
      completionDropped: 0,
      gpuExpected: 0,
      gpuPending: 0,
      gpuFailed: 0,
      gpuDropped: 0,
      gpuTimingStatusCounts: {
        complete: 0,
        partial: 0,
        unavailable: 0,
        failed: 0,
        missing: 0,
      },
      gpuUnmeasuredPasses: 0,
      gpuDroppedPasses: 0,
      gpuMissingMeasurementReceipts: 0,
    };
return run;
};
const run = createR8ProfileRun();
const admitR8ProfileObservers = () => {
    const startStep = captureNativeStepFence(run, readNativeCompletedStep);
    if (startStep !== undefined) run.nativeFenceStartStep = startStep;
    profileRun = run;
    latestProfileExport = undefined;
    run.releaseCompletionCpu = profiler.observeCompletionCpu((observation) => {
      if (run.finalized || observation.captureId !== run.captureId) return;
      const key = profileCompletionKey(
        observation.captureId,
        observation.profileFrameId,
        observation.receiptFrameId,
        observation.deviceGeneration,
      );
      if (!run.expectedCompletionKeys.has(key)) {
        run.completionCpuUnassociated += 1;
        return;
      }
      if (run.observedCompletionKeys.has(key)) {
        run.completionCpuDuplicates += 1;
        return;
      }
      run.observedCompletionKeys.add(key);
      run.completionCpuActual += 1;
      if (!appendBounded(run.completionCpu, observation)) run.completionDropped += 1;
    });
    const physicsWorld = world.getResource<PhysicsWorld>(PhysicsWorldResource);
    if (typeof physicsWorld.observeNativeStepTiming === 'function') {
      run.nativeAvailable = true;
      run.releaseNative = physicsWorld.observeNativeStepTiming((timing) => {
        if (run.finalized || run.cpuFinished || profiler.activeCaptureId() !== run.captureId) {
          closeR8CpuCapture(run, readNativeCompletedStep);
          return;
        }
        // This is sampled while Rapier is still on the App frame that admitted this step.
        const frameToken = run.session.currentFrameToken();
        const associated = frameToken?.captureId === run.captureId ? frameToken : undefined;
        if (associated === undefined) run.nativeUnassociated += 1;
        run.nativeObserverRows += 1;
        if (run.nativeLastIndex !== undefined) {
          if (timing.nativeStepIndex <= run.nativeLastIndex) run.nativeInvalidIdentityCount += 1;
          else if (timing.nativeStepIndex > run.nativeLastIndex + 1)
            run.nativeIndexGapCount += timing.nativeStepIndex - run.nativeLastIndex - 1;
        }
        if (run.nativeLastFixedStep !== undefined) {
          if (timing.fixedStep <= run.nativeLastFixedStep) run.nativeInvalidIdentityCount += 1;
          else if (timing.fixedStep > run.nativeLastFixedStep + 1)
            run.nativeFixedStepGapCount += timing.fixedStep - run.nativeLastFixedStep - 1;
        }
        run.nativeLastIndex = timing.nativeStepIndex;
        run.nativeLastFixedStep = timing.fixedStep;
        const row = Object.freeze({
          captureId: run.captureId,
          profileFrameId: associated?.frameId ?? null,
          nativeStepIndex: timing.nativeStepIndex,
          fixedStep: timing.fixedStep,
          deltaSeconds: timing.deltaSeconds,
          timingMs: timing.timingMs,
        });
        if (!appendBounded(run.native, row)) run.nativeDropped += 1;
      });
    }
    record('profile-capture-started', { captureId: run.captureId, preset, limits });
    return {
      ok: true as const,
      value: { captureId: run.captureId, preset, limits },
    };};
return admitR8ProfileObservers();
};
return admitR8ProfileCaptureLimits();

  };

  const finishProfileCapture = async (
    options: { readonly waitMs?: number } = {},
  ): Promise<R8ProfileFinishResult> => {
    const run = profileRun;
    if (run === undefined) {
      return latestProfileExport === undefined
        ? { ok: false as const, error: { code: 'profile-capture-not-started' } }
        : { ok: true as const, value: latestProfileExport };
    }
    if (run.finishPromise !== undefined) return run.finishPromise;
    const waitMs = options?.waitMs ?? R8_PROFILE_DEFAULT_FINISH_WAIT_MS;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > R8_PROFILE_MAX_FINISH_WAIT_MS)
      return {
        ok: false as const,
        error: {
          code: 'profile-capture-finish-wait-invalid',
          expected: `waitMs 0..${R8_PROFILE_MAX_FINISH_WAIT_MS}`,
          hint: 'Use a bounded receipt and GPU drain interval.',
          detail: { waitMs },
        },
      };
    const finished = run.session.finish();
    if (!finished.ok) return { ok: false as const, error: finished.error };
    closeR8CpuCapture(run, readNativeCompletedStep);
    const finishPromise = (async (): Promise<R8ProfileFinishResult> => {
      const drained = await waitForR8ProfileDrain(run, waitMs);
const closeR8PendingReceiptLedger = () => {
      let missingCompletionNotifications = 0;
      for (const [key, receipt] of run.pendingReceipts) {
        if (receipt.resultStatus !== 'fulfilled') continue;
        missingCompletionNotifications += 1;
        if (receipt.status === 'submitted') setR8ReceiptStatus(run, receipt, 'missing');
        run.pendingReceipts.delete(key);
      }
return missingCompletionNotifications;
};
const missingCompletionNotifications = closeR8PendingReceiptLedger();
      const pendingReceiptResults = [...run.pendingReceipts.values()].filter(
        (receipt) => receipt.resultStatus === 'pending',
      ).length;
      const modeled = buildProfileModel(finished.value, { orderEvidence: 'recorder-closure' });
      run.releaseCompletionCpu?.();
      run.releaseCompletionCpu = undefined;
      run.releaseNative?.();
      run.releaseNative = undefined;
      if (!modeled.ok) {
        run.finalized = true;
        profileRun = undefined;
        return { ok: false as const, error: modeled.error };
      }
const summarizeR8ReceiptCompletion = () => {
const countR8IncompleteCompletionEvidence = () => {
      const missingCompletionCallbacks = Math.max(
        missingCompletionNotifications,
        run.completionExpected - run.completionCallbacksActual,
      );
      const missingCompletionCpu = Math.max(0, run.completionExpected - run.completionCpuActual);
      const receiptStatusIncomplete =
        run.receiptStatusCounts.submitted > 0 ||
        run.receiptStatusCounts['presentation-pending'] > 0 ||
        run.receiptStatusCounts['generation-mismatch'] > 0 ||
        run.receiptStatusCounts['identity-mismatch'] > 0 ||
        run.receiptStatusCounts.missing > 0 ||
        run.receiptStatusCounts['ledger-evicted'] > 0 ||
        run.receiptStatusCounts.failed > 0;
return { missingCompletionCallbacks, missingCompletionCpu, receiptStatusIncomplete };
};
const { missingCompletionCallbacks, missingCompletionCpu, receiptStatusIncomplete } = countR8IncompleteCompletionEvidence();
      const completionCpuStatus =
        drained &&
        !receiptStatusIncomplete &&
        run.completionCallbacksActual === run.completionExpected &&
        run.completionCpuActual === run.completionExpected &&
        missingCompletionCallbacks === 0 &&
        missingCompletionCpu === 0 &&
        run.pendingReceipts.size === 0 &&
        run.completionIdentityMismatch === 0 &&
        run.completionCpuUnassociated === 0 &&
        run.completionCpuDuplicates === 0 &&
        run.receiptDropped === 0 &&
        run.receiptLedgerEvicted === 0 &&
        run.receiptFailures === 0 &&
        run.completionDropped === 0
          ? 'complete'
          : 'partial';
return { missingCompletionCallbacks, missingCompletionCpu, completionCpuStatus };
};
const { missingCompletionCallbacks, missingCompletionCpu, completionCpuStatus } = summarizeR8ReceiptCompletion();
const summarizeR8NativeCompletion = () => {
      const expectedNativeSteps =
        run.nativeFenceStartStep === undefined || run.nativeFenceEndStep === undefined
          ? undefined
          : run.nativeFenceEndStep - run.nativeFenceStartStep;
      const nativePhysicsStatus = !run.nativeAvailable
        ? 'unavailable'
        : expectedNativeSteps !== undefined &&
            expectedNativeSteps >= 0 &&
            run.nativeFenceFailures === 0 &&
            run.nativeObserverRows === expectedNativeSteps &&
            run.native.length === run.nativeObserverRows &&
            run.nativeUnassociated === 0 &&
            run.nativeIndexGapCount === 0 &&
            run.nativeFixedStepGapCount === 0 &&
            run.nativeInvalidIdentityCount === 0 &&
            run.nativeDropped === 0
          ? 'complete'
          : 'partial';
return { expectedNativeSteps, nativePhysicsStatus };
};
const { expectedNativeSteps, nativePhysicsStatus } = summarizeR8NativeCompletion();
const summarizeR8GpuCompletion = () => {
      const gpuIdentityJoin = analyzeR8GpuIdentityJoin(run);
      const gpuStatus =
        drained &&
        run.gpuPending === 0 &&
        run.gpuFailed === 0 &&
        run.gpuDropped === 0 &&
        run.gpu.length === run.gpuExpected &&
        run.gpuTimingStatusCounts.complete === run.gpuExpected &&
        run.gpuTimingStatusCounts.partial === 0 &&
        run.gpuTimingStatusCounts.unavailable === 0 &&
        run.gpuTimingStatusCounts.failed === 0 &&
        run.gpuTimingStatusCounts.missing === 0 &&
        run.gpuUnmeasuredPasses === 0 &&
        run.gpuDroppedPasses === 0 &&
        run.gpuMissingMeasurementReceipts === 0 &&
        gpuIdentityJoin.gpuFrameIntegrityStatus === 'complete' &&
        (!gpuIdentityJoin.identityJoinApplicable || gpuIdentityJoin.status === 'complete')
          ? 'complete'
          : 'partial';
return { gpuIdentityJoin, gpuStatus };
};
const { gpuIdentityJoin, gpuStatus } = summarizeR8GpuCompletion();
      const allComplete =
        drained &&
        run.receiptExpected > 0 &&
        finished.value.completeness.status === 'complete' &&
        run.receiptExpected === run.receipts.length &&
        run.receiptDropped === 0 &&
        run.receiptLedgerEvicted === 0 &&
        completionCpuStatus === 'complete' &&
        nativePhysicsStatus === 'complete' &&
        gpuStatus === 'complete';
const publishR8FinishedProfileCapture = () => {
      const sourceFailure = run.session.firstSourceFailure();
      const exportValue: R8ProfileExport = Object.freeze({
        version: 1,
        capture: finished.value,
        model: modeled.value,
        sidecars: Object.freeze({
          receipts: Object.freeze(run.receipts.map((row) => Object.freeze({ ...row }))),
          completionCpu: Object.freeze([...run.completionCpu]),
          nativePhysics: Object.freeze(run.native.map((row) => Object.freeze({ ...row }))),
          gpu: Object.freeze([...run.gpu]),
          diagnostics: Object.freeze({
            profileSourceFailure: sourceFailure ?? null,
          }),
          completeness: Object.freeze({
            status: allComplete ? 'complete' : 'partial',
            profile: finished.value.completeness,
            receiptCompletionCpu: {
              status: completionCpuStatus,
              expected: run.completionExpected,
              callbacksActual: run.completionCallbacksActual,
              actual: run.completionCpuActual,
              retained: run.completionCpu.length,
              missingCompletionCallbacks,
              missingCompletionCpu,
              pendingReceipts: pendingReceiptResults,
              identityMismatches: run.completionIdentityMismatch,
              unassociatedObservations: run.completionCpuUnassociated,
              duplicateObservations: run.completionCpuDuplicates,
              dropped: run.completionDropped,
              receiptExpected: run.receiptExpected,
              receiptRetained: run.receipts.length,
              receiptStatusCounts: Object.freeze({ ...run.receiptStatusCounts }),
              receiptDropped: run.receiptDropped,
              ledgerEvicted: run.receiptLedgerEvicted,
              failedReceipts: run.receiptFailures,
              receiptResultCounts: Object.freeze({ ...run.receiptResultCounts }),
              drainTimedOut: !drained,
            },
            nativePhysics: {
              status: nativePhysicsStatus,
              expectedSteps: expectedNativeSteps ?? null,
              expectedSource: 'PhysicsWorld.getSolverClock().completedStep delta',
              execution:
                'successful synchronous native steps only; async/worker steps are excluded',
              retainedSteps: run.native.length,
              observedSteps: run.nativeObserverRows,
              missingStepRows:
                expectedNativeSteps === undefined
                  ? null
                  : Math.max(0, expectedNativeSteps - run.nativeObserverRows),
              unexpectedStepRows:
                expectedNativeSteps === undefined
                  ? null
                  : Math.max(0, run.nativeObserverRows - expectedNativeSteps),
              fenceStartCompletedStep: run.nativeFenceStartStep ?? null,
              fenceEndCompletedStep: run.nativeFenceEndStep ?? null,
              fenceReadFailures: run.nativeFenceFailures,
              unassociatedSteps: run.nativeUnassociated,
              nativeIndexGaps: run.nativeIndexGapCount,
              fixedStepGaps: run.nativeFixedStepGapCount,
              invalidStepIdentities: run.nativeInvalidIdentityCount,
              dropped: run.nativeDropped,
            },
            gpu: {
              status: gpuStatus,
              expected: run.gpuExpected,
              retained: run.gpu.length,
              pending: run.gpuPending,
              failed: run.gpuFailed,
              dropped: run.gpuDropped,
              timingStatuses: Object.freeze({ ...run.gpuTimingStatusCounts }),
              unmeasuredPasses: run.gpuUnmeasuredPasses,
              droppedPasses: run.gpuDroppedPasses,
              missingMeasurementReceipts: run.gpuMissingMeasurementReceipts,
              cpuGpuIdentityJoin: gpuIdentityJoin,
              drainTimedOut: !drained,
            },
          }),
        }),
      });
      latestProfileExport = exportValue;
      run.finalized = true;
      profileRun = undefined;
      record('profile-capture-finished', {
        captureId: run.captureId,
        completeness: exportValue.sidecars.completeness,
      });
      return { ok: true as const, value: exportValue };};
return publishR8FinishedProfileCapture();

    })();
    run.finishPromise = finishPromise;
    return finishPromise;
  };

  const exportProfileCapture = () => latestProfileExport;
  const downloadProfileCapture = () => {
    const exported = exportProfileCapture();
    if (exported === undefined) throw new Error('Finish a profile capture before exporting it');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(exported, json, 2)], { type: 'application/json' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `water-r8-profile-${exported.capture.captureId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    return exported;
  };

  const observeGpuTiming = (receipt: FrameReceipt, run: R8ProfileRun | undefined) => {
    const token = receipt.profileFrame;
    const profileMatch = run !== undefined && token?.captureId === run.captureId;
    if (!diagnostics.enabled && !profileMatch) return;
    if (profileMatch && run !== undefined) {
      run.gpuExpected += 1;
      run.gpuPending += 1;
    }
    let pending: Promise<void>;
    try {
      pending = app.renderer
        .observe(receipt, { include: ['timings'] })
        .then((result) => {
          if (diagnostics.enabled) {
            gpuTimings.push(result);
            if (gpuTimings.length > 120) gpuTimings.shift();
          }
          if (profileMatch && run !== undefined) {
            run.gpuPending = Math.max(0, run.gpuPending - 1);
            if (!result.ok) {
              run.gpuFailed += 1;
              run.gpuTimingStatusCounts.failed += 1;
            } else if (!run.finalized && token !== undefined) {
              const timings = result.value.timings;
              const timingStatus = timings?.status ?? 'missing';
              const timingFrame = timings && 'frame' in timings ? timings.frame : undefined;
              run.gpuTimingStatusCounts[timingStatus] += 1;
              if (timingFrame === undefined) run.gpuMissingMeasurementReceipts += 1;
              else {
                run.gpuUnmeasuredPasses += Math.max(
                  0,
                  timingFrame.executedPassCount -
                    timingFrame.measuredPassCount -
                    timingFrame.droppedPassCount,
                );
                run.gpuDroppedPasses += timingFrame.droppedPassCount;
              }
              const sidecar = Object.freeze({
                captureId: token.captureId,
                profileFrameId: token.frameId,
                receiptFrameId: receipt.frameId,
                deviceGeneration: receipt.deviceGeneration,
                timingStatus,
                executedPassCount: timingFrame?.executedPassCount ?? null,
                measuredPassCount: timingFrame?.measuredPassCount ?? null,
                droppedPassCount: timingFrame?.droppedPassCount ?? null,
                timings: timings ?? null,
              });
              if (!appendBounded(run.gpu, sidecar)) run.gpuDropped += 1;
            }
          }
        })
        .catch((cause) => {
          if (profileMatch && run !== undefined) {
            run.gpuPending = Math.max(0, run.gpuPending - 1);
            run.gpuFailed += 1;
            run.gpuTimingStatusCounts.failed += 1;
          }
          report(cause);
        });
    } catch (cause) {
      if (profileMatch && run !== undefined) {
        run.gpuPending = Math.max(0, run.gpuPending - 1);
        run.gpuFailed += 1;
        run.gpuTimingStatusCounts.failed += 1;
      }
      report(cause);
      return;
    }
    void pending;
  };

  onReceiptCompleted = (completion) => {
    const key = receiptKey(completion.frameId, completion.deviceGeneration);
    const submitted = submittedSamples.get(key);
    if (submitted === undefined) return;
    submittedSamples.delete(key);
    const {
      receipt,
      sample,
      inspection,
      candidateEvidence,
      issuedTransaction,
      profileRun: run,
      profileReceipt,
    } = submitted;
    sample.completion = 'fulfilled';
    const currentGeneration = app.renderer.currentDeviceGeneration?.();
    const sameGeneration =
      currentGeneration === undefined || currentGeneration === completion.deviceGeneration;
    const sameToken = exactProfileToken(receipt.profileFrame, completion.profileFrame);
const recordR8ProfileCompletionIdentity = () => {
    if (run !== undefined && profileReceipt !== undefined && !run.finalized) {
      run.pendingReceipts.delete(key);
      const completionKey = profileCompletionKey(
        profileReceipt.captureId,
        profileReceipt.profileFrameId,
        completion.frameId,
        completion.deviceGeneration,
      );
      if (run.expectedCompletionKeys.has(completionKey)) {
        if (run.callbackCompletionKeys.has(completionKey)) run.completionIdentityMismatch += 1;
        else {
          run.callbackCompletionKeys.add(completionKey);
          run.completionCallbacksActual += 1;
        }
      } else run.completionIdentityMismatch += 1;
      if (!sameToken) {
        run.completionIdentityMismatch += 1;
        setR8ReceiptStatus(run, profileReceipt, 'identity-mismatch');
      } else if (!sameGeneration) setR8ReceiptStatus(run, profileReceipt, 'generation-mismatch');
      else if (completion.presentation !== 'ready')
        setR8ReceiptStatus(run, profileReceipt, 'presentation-pending');
      else setR8ReceiptStatus(run, profileReceipt, 'completed');
    }
};
recordR8ProfileCompletionIdentity();
    if (!sameGeneration) return;
    const profileMatch = run !== undefined && !run.finalized && sameToken && sameGeneration;
    if (completion.presentation !== 'ready') return;
    if (profileMatch && run !== undefined) observeGpuTiming(receipt, run);
    else if (diagnostics.enabled) observeGpuTiming(receipt, undefined);

const publishR8CompletedConfiguration = () => {
    completedFrames++;
    completedReceipt = {
      frameId: completion.frameId,
      deviceGeneration: completion.deviceGeneration,
      ...(receipt.graphGeneration === undefined
        ? {}
        : { graphGeneration: receipt.graphGeneration }),
    };
    if (inspection) latest = inspection;
    if (
      diagnostics.enabled ||
      transaction ||
      (renderTrace.length > 0 &&
        (renderTrace[renderTrace.length - 1] as typeof sample).graphGeneration !==
          sample.graphGeneration)
    ) {
      renderTrace.push(sample);
      if (renderTrace.length > 45) renderTrace.shift();
    }
    if (transaction && transaction.revision === issuedTransaction && candidateEvidence) {
      const accepted = transaction;
      activeMode = transaction.mode;
      transaction = undefined;
      lockConfiguration(false);
      record('configuration-completed', {
        transaction: transactionEvidence(accepted),
        receipt: completedReceipt,
        evidence: candidateEvidence,
        allocation: inspection?.renderGraphGenerationAllocation,
        sources: bodies.map((body) => assets.source(body.handle)),
      });
      element('transition').textContent = `候选配置已完成 · 帧 ${completion.frameId}`;
    }
};
publishR8CompletedConfiguration();
const refreshR8CompletedFramePresentation = () => {
    const now = performance.now();
    if (diagnostics.enabled) {
      completedFrameTimes.push({
        frameId: completion.frameId,
        wallTimeMs: now,
        simulationTimeSeconds: world.getResource(Time).elapsed,
      });
      if (completedFrameTimes.length > 2048) completedFrameTimes.shift();
    }
    completionTimes.push(now);
    while ((completionTimes[0] ?? now) < now - 1200) completionTimes.shift();
    if (now - lastRefresh > 250) {
      const duration = now - (completionTimes[0] ?? now);
      element('fps').textContent =
        duration > 400
          ? `${(((completionTimes.length - 1) * 1000) / duration).toFixed(1)} FPS`
          : '-- FPS';
      element('state').textContent = '实时渲染';
      refresh();
      lastRefresh = now;
    }};
refreshR8CompletedFramePresentation();

  };

  app.renderer.subscribe((event) => {
    if (event.kind === 'error') {
      report(event.error);
      return;
    }
    if (event.kind === 'state-changed') {
      record('renderer-state', event);
      element('state').textContent = event.current;
      return;
    }
    if (event.kind !== 'frame-submitted') return;
    const submittedAtMs = performance.now();
    const needsInspection =
      diagnostics.enabled ||
      transaction !== undefined ||
      (!element('controls-panel').hidden &&
        submittedAtMs - lastInspectionMs >= diagnostics.inspectionIntervalMs);
    const inspection = needsInspection ? app.renderer.inspect() : undefined,
      issuedTransaction = transaction?.revision;
    if (inspection) lastInspectionMs = submittedAtMs;
    const candidateEvidence =
      transaction && inspection
        ? configurationEvidence(transaction, event.receipt, inspection)
        : undefined;
    const sample = {
      frameId: event.receipt.frameId,
      deviceGeneration: event.receipt.deviceGeneration,
      ...(event.receipt.graphGeneration === undefined
        ? {}
        : { graphGeneration: event.receipt.graphGeneration }),
      presentation: event.receipt.presentation,
      waterGraph: inspection?.waterGraph,
      allocation: inspection?.renderGraphGenerationAllocation,
      featureGraph: inspection?.featureGraph,
      completion: 'pending' as 'pending' | 'fulfilled' | 'rejected',
    };
    if (transaction && candidateEvidence) transaction.status = 'awaiting-completion';
    const key = receiptKey(event.receipt.frameId, event.receipt.deviceGeneration);
    const run = profileRun;
    let profileReceipt: R8ProfileReceipt | undefined;
const captureR8SubmittedProfileReceipt = () => {
    if (
      run !== undefined &&
      !run.finalized &&
      event.receipt.profileFrame?.captureId === run.captureId
    ) {
      const token = event.receipt.profileFrame;
      profileReceipt = {
        captureId: token.captureId,
        profileFrameId: token.frameId,
        receiptFrameId: event.receipt.frameId,
        deviceGeneration: event.receipt.deviceGeneration,
        ...(event.receipt.graphGeneration === undefined
          ? {}
          : { graphGeneration: event.receipt.graphGeneration }),
        ...(event.receipt.renderPassCpuIdentities === undefined
          ? {}
          : { renderPassCpuIdentities: event.receipt.renderPassCpuIdentities }),
        ...(event.receipt.renderPassCpuIdentitiesComplete === undefined
          ? {}
          : { renderPassCpuIdentitiesComplete: event.receipt.renderPassCpuIdentitiesComplete }),
        resultStatus: 'pending',
        status: 'submitted',
      };
      run.receiptExpected += 1;
      run.receiptResultCounts.pending += 1;
      run.receiptStatusCounts.submitted += 1;
      run.expectedCompletionKeys.add(
        profileCompletionKey(
          profileReceipt.captureId,
          profileReceipt.profileFrameId,
          profileReceipt.receiptFrameId,
          profileReceipt.deviceGeneration,
        ),
      );
      run.pendingReceipts.set(key, profileReceipt);
      if (!appendBounded(run.receipts, profileReceipt)) run.receiptDropped += 1;
    }
};
captureR8SubmittedProfileReceipt();
    submittedSamples.set(key, {
      receipt: event.receipt,
      sample,
      inspection,
      candidateEvidence,
      issuedTransaction,
      profileRun: run,
      profileReceipt,
    });
const evictR8SubmittedSamples = () => {
    while (submittedSamples.size > 16) {
      const oldest = submittedSamples.keys().next().value;
      if (oldest === undefined) break;
      const evicted = submittedSamples.get(oldest);
      if (evicted?.profileReceipt !== undefined && evicted.profileRun !== undefined) {
        setR8ReceiptStatus(evicted.profileRun, evicted.profileReceipt, 'ledger-evicted');
        evicted.profileRun.receiptLedgerEvicted += 1;
      }
      submittedSamples.delete(oldest);
    }
};
evictR8SubmittedSamples();
    void event.receipt.completed.then(
      (result) => {
        if (result.ok) {
          // App registers its onCompleted reaction immediately after emitting
          // frame-submitted. This handler therefore records the Result only;
          // the App callback owns closing the pending completion notification.
          if (
            profileReceipt !== undefined &&
            run !== undefined &&
            !run.finalized &&
            profileReceipt.resultStatus === 'pending'
          ) {
            profileReceipt.resultStatus = 'fulfilled';
            run.receiptResultCounts.pending -= 1;
            run.receiptResultCounts.fulfilled += 1;
            run.completionExpected += 1;
          }
          return;
        }
        sample.completion = 'rejected';
        if (profileReceipt !== undefined && run !== undefined && !run.finalized) {
          if (profileReceipt.resultStatus === 'pending') {
            profileReceipt.resultStatus = 'rejected';
            run.receiptResultCounts.pending -= 1;
            run.receiptResultCounts.rejected += 1;
          }
          setR8ReceiptStatus(run, profileReceipt, 'failed');
          run.receiptFailures += 1;
          run.pendingReceipts.delete(key);
        }
        record('frame-failed', { sample, error: result.error });
        report(result.error);
      },
      (cause) => {
        sample.completion = 'rejected';
        if (profileReceipt !== undefined && run !== undefined && !run.finalized) {
          if (profileReceipt.resultStatus === 'pending') {
            profileReceipt.resultStatus = 'rejected';
            run.receiptResultCounts.pending -= 1;
            run.receiptResultCounts.rejected += 1;
          }
          setR8ReceiptStatus(run, profileReceipt, 'failed');
          run.receiptFailures += 1;
          run.pendingReceipts.delete(key);
        }
        report(cause);
      },
    );
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
    button.addEventListener('click', () => setView(button.dataset.view as View));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fault]'))
    button.addEventListener('click', () => {
      void fault(button.dataset.fault!).catch(report);
    });
  element('region').addEventListener('change', () => {
    setView(view);
  });
  element('quality').addEventListener('change', () => {
    try {
      setMode(element<HTMLSelectElement>('quality').value as Mode);
    } catch (error) {
      report(error);
    }
  });
  element('waves').addEventListener('input', () => {
    if (transaction) return;
    pendingWindStrength = Number(element<HTMLInputElement>('waves').value);
    element('wind-value').textContent = `${pendingWindStrength.toFixed(2)} ×`;
  });
  element('weather').addEventListener('change', () => {
    const index = ['day', 'sunset', 'overcast'].indexOf(
      element<HTMLSelectElement>('weather').value,
    );
    applySkyVariant(index);
    world
      .set(sunlight, DirectionalLight, {
        color: index === 1 ? [1, 0.64, 0.35] : [1, 0.97, 0.89],
        intensity: index === 2 ? 1.5 : 2.4,
      })
      .unwrap();
  });
  element('clouds').addEventListener('change', () => {
    cloudsEnabled = element<HTMLInputElement>('clouds').checked;
    const index = ['day', 'sunset', 'overcast'].indexOf(
      element<HTMLSelectElement>('weather').value,
    );
    applySkyVariant(index);
  });
  element('water-color').addEventListener('input', () => {
    const color = element<HTMLInputElement>('water-color').value;
    const rgb = [1, 3, 5].map((start) => Number.parseInt(color.slice(start, start + 2), 16) / 255);
    for (const material of materials)
      assets
        .update(material, {
          values: {
            ...assets.read(material).unwrap().values,
            absorptionPerM: rgb.map((channel) => 0.035 + (1 - channel) ** 2 * 0.48),
            scatteringPerM: rgb.map((channel) => 0.004 + channel * 0.026),
          },
        })
        .unwrap();
  });
  element('exposure').addEventListener('input', () => {
    const multiplier = Number(element<HTMLInputElement>('exposure').value);
    world.set(camera, Camera, { exposure: multiplier }).unwrap();
    element('exposure-value').textContent = multiplier.toFixed(2);
  });
  element('pause').addEventListener('change', () => {
    if (element<HTMLInputElement>('pause').checked) app.pause().unwrap();
    else app.resume().unwrap();
  });
  element('reset-ship').addEventListener('click', resetShip);
  element('ship-go').addEventListener('click', () => {
    shipNavigation.path =
      element<HTMLSelectElement>('ship-route').value === 'straight' ? 'straight' : 'circle';
    const dynamics = physics().getCommittedBodyDynamics?.(ship);
    if (dynamics?.ok) {
      const forward = rotateWaterVector(dynamics.value.rotation, [1, 0, 0]);
      const horizontalLength = Math.hypot(forward[0], forward[2]);
      if (horizontalLength > 1e-6)
        shipNavigation.straightDirectionXZ = [
          forward[0] / horizontalLength,
          forward[2] / horizontalLength,
        ];
    }
    shipNavigation.running = true;
    shipNavigation.braking = false;
    shipNavigation.previousAngle = undefined;
    record('ship-navigation-started', {
      speedMps: shipNavigation.speedMps,
      loop: shipNavigation.loop,
      path: shipNavigation.path,
      route: shipRoute,
      straightDirectionXZ: shipNavigation.straightDirectionXZ,
    });
  });
  element('ship-stop').addEventListener('click', () => {
    shipNavigation.running = false;
    shipNavigation.braking = true;
    record('ship-navigation-stopped', { physicsStep: world.getResource(FixedTime).tick });
  });
  element('fire-ball').addEventListener('click', () => {
    fireRequested = true;
  });
  element<HTMLInputElement>('ship-loop').addEventListener('change', (event) => {
    shipNavigation.loop = (event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLInputElement>('ship-speed').addEventListener('input', (event) => {
    shipNavigation.speedMps = Number((event.currentTarget as HTMLInputElement).value);
    element('ship-speed-value').textContent = `${shipNavigation.speedMps} m/s`;
  });
  for (const [id, entity, component] of [['buoyancy-enabled', ship, WaterPontoonSet]] as const) {
    element<HTMLInputElement>(id).addEventListener('change', (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      world
        .set(entity, component, { enabled: enabled && shipRigAdmission.kind === 'ready' })
        .unwrap();
      record(id, { enabled });
    });
  }
  element<HTMLInputElement>('contacts-enabled').addEventListener('change', (event) => {
    if (transaction) return;
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    world.set(ship, WaterContactProbeSet, { enabled }).unwrap();
    for (const handle of materials) {
      const material = assets.read(handle).unwrap();
      assets
        .update(handle, { values: { ...material.values, contactFoamAmount: Number(enabled) } })
        .unwrap();
    }
    record('contacts-enabled', { enabled });
  });
  element<HTMLInputElement>('depth-foam-enabled').addEventListener('change', (event) => {
    if (transaction) return;
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    for (const handle of materials) {
      const material = assets.read(handle).unwrap();
      assets
        .update(handle, {
          values: {
            ...material.values,
            sceneDepthFoamAmount:
              enabled && material.staticSwitches?.waterOceanFoam === true ? 1.2 : 0,
          },
        })
        .unwrap();
    }
    record('depth-foam-enabled', { enabled });
  });
  element<HTMLInputElement>('crests-enabled').addEventListener('change', (event) => {
    if (transaction) return;
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    applyCrestComposition(activeMode);
    record('crests-enabled', { enabled });
  });
  element('capture').addEventListener('click', () => {
    void capture().catch(report);
  });
  element('panel-toggle').addEventListener('click', () => {
    const panel = element('controls-panel');
    panel.hidden = !panel.hidden;
    document.body.classList.toggle('panel-closed', panel.hidden);
    element('panel-toggle').setAttribute('aria-expanded', String(!panel.hidden));
    applyCamera();
  });
  element('export').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(readState(), json, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `water-r8-${activeMode}-frame-${completedReceipt?.frameId ?? 0}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  window.addEventListener('resize', applyCamera);
  Object.assign(window, {
    __waterR8: {
      app,
      profiler,
      world,
      assets,
      ship,
      camera,
      bodies,
      zoneAsset,
      readState,
      setMode,
      setView,
      fault,
      capture,
      startProfileCapture,
      finishProfileCapture,
      exportProfileCapture,
      downloadProfileCapture,
      errors,
      operations,
      setDiagnostics,
      setMeshProfile: (profile: keyof typeof COAST_MESH_PROFILES) => {
        if (transaction) throw new Error('A configuration is already preparing');
        if (!(profile in COAST_MESH_PROFILES)) throw new Error('Unknown coast mesh profile');
        setMode(activeMode, profile);
      },
      localSimulation: () => (requestedMode === 'R7-shallow' ? r7Simulation : localSimulation),
      setCameraPose: (pose: { eye: Vector; target: Vector }) => {
        eye = [...pose.eye];
        target = [...pose.target];
        applyCamera();
      },
    },
  });
  applyWindStrength(1);
  setView('middle');
  app.start().unwrap();
}

void main().catch((error) => {
  console.error(error);
  element('state').textContent = '启动失败';
  element('message').hidden = false;
  element('message').textContent =
    typeof error === 'object' && error !== null && 'code' in error
      ? `${String(error.code)} · ${JSON.stringify(error)}`
      : String(error);
});
