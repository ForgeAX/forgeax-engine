import { type MaterialRenderProjection, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { frustum } from '@forgeax/engine-math';
import type {
  RenderFeature,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureSceneSdfDescriptor,
  RenderFeatureSubmission,
  RenderFeatureWorkPlan,
} from '@forgeax/engine-render';
import { MeshFilter } from '@forgeax/engine-render';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '@forgeax/engine-render/internal';
import { GlobalTransform } from '@forgeax/engine-scene';
import {
  err,
  type Handle,
  type MaterialAsset,
  type MeshAsset,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import type {
  ParticleRendererSourceV3,
  ParticleTopologyRendererSourceV3,
  VfxDataInterfaceResource,
  VfxDataInterfaceToken,
  VfxForceFieldError,
} from '@forgeax/engine-vfx';
import {
  buildVfxRecoveryIntents,
  isImmutableVfxGpuEffect,
  isParticleTopologyRenderer,
  isVfxFieldTransform,
  type VfxGpuTickIntent as SourceVfxGpuTickIntent,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_STRIDE,
  type VfxGpuEffectAssetAny,
  type VfxGpuEmitterSource,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import { RenderFeatureStageFailedError } from '../../../render/src/errors/render';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../../../render/src/features/prepared-graphics';
import type { VfxDataInterfaceRegistry } from '../host/data-interface-providers.js';
import type { ParticleRenderCamera, ParticleRenderCameraSource } from './camera.js';
import {
  encodeEventBuffer,
  eventCapacity,
  eventInputCapacity,
  VFX_EVENT_BYTES,
  VFX_EVENT_INPUT_BYTES,
} from './event-resources.js';
import { createVfxForceFieldPreparation, type PreparedVfxForceFields } from './force-fields.js';
import {
  createTopologyResourcePlan,
  PARTICLE_INPUT_SHADER_IDENTIFIERS,
  PARTICLE_SHADER_IDENTIFIERS,
  particleMaterialPass,
  particleMaterialSceneDepthBinding,
  particleMaterialUsesBindings,
  particleMeshIndices,
  particleMeshVerticesCached,
  particleRendererRenderState,
  prepareParticleMaterialInputs,
} from './particle-resources.js';
import { coalesceVfxRasterPasses } from './raster-passes.js';
import type { VfxStagePlanObservation, VfxValidatedStagePlan } from './stage-plan.js';
import { validatedStagePlan } from './stage-plan.js';

const IDENTITY = 'forgeax.vfx-render.gpu-particles';
const WORKGROUP_SIZE = 256;
const BILLBOARD_INSTANCE_BYTES = 31 * 4;
const MESH_INSTANCE_BYTES = 18 * 4;
const COUNTERS_BYTES = 24;
const RUNTIME_BYTES = 76 * 4;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ParticleRendererKind = ParticleRendererSourceV3['kind'];

const rendererOnlyEntryPoints = new Map<string, ParticleRendererKind>([
  ['forgeax_vfx_billboard_main', 'billboard'],
  ['forgeax_vfx_mesh_main', 'mesh'],
  ['forgeax_vfx_ribbon_main', 'ribbon'],
  ['forgeax_vfx_trail_main', 'trail'],
  ['forgeax_vfx_beam_main', 'beam'],
  ['forgeax_vfx_trail_history_main', 'trail'],
  ['forgeax_vfx_trail_offsets_main', 'trail'],
]);
type ParticleRenderer = ParticleRendererSourceV3;
type ParticleTopologyKind = ParticleTopologyRendererSourceV3['kind'];
type VfxStageOutput = VfxStagePlanObservation['stageOutput'];

interface VfxRenderStageState {
  readonly stageOutput: VfxStageOutput;
}

interface VfxRenderInspectSnapshot extends VfxRenderStageState {
  readonly topology: ParticleRendererKind;
  readonly counters: {
    readonly capacity: number;
    readonly produced: number;
    readonly dropped: number;
  };
  readonly stageReadiness: readonly unknown[];
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

export interface VfxRenderInspectInput {
  readonly topology: ParticleRendererKind;
  readonly capacity: number;
  readonly produced: number;
  readonly dropped: number;
  readonly stageReadiness: readonly unknown[];
  readonly stageOutput?: VfxStageOutput;
  readonly providerReadiness: unknown;
  readonly gpuTiming: unknown;
}

/** Bounded receipt of VFX work that reached render-graph submission. */
export interface VfxRenderObservation {
  readonly frameNumber: number;
  readonly dispatches: number;
  readonly indirectDraws: number;
  readonly subjectOutputs: number;
}

export function createVfxRenderInspectSnapshot(
  input: VfxRenderInspectInput,
): VfxRenderInspectSnapshot {
  return {
    topology: input.topology,
    counters: { capacity: input.capacity, produced: input.produced, dropped: input.dropped },
    stageReadiness: input.stageReadiness,
    stageOutput: input.stageOutput ?? 'empty',
    providerReadiness: input.providerReadiness,
    gpuTiming: input.gpuTiming,
  } as const;
}

export interface BillboardAdvancedSample {
  readonly age: number;
  readonly lifetime: number;
  readonly particleDepth: number;
  readonly sceneDepth: number;
  readonly depthAvailable: boolean;
}

export function resolveBillboardAdvancedState(
  renderer: Extract<ParticleRendererSourceV3, { readonly kind: 'billboard' }>,
  sample: BillboardAdvancedSample,
) {
  if (renderer.softParticle !== undefined && !sample.depthAvailable) {
    return err({
      code: 'vfx-renderer-depth-missing' as const,
      expected: 'a scene-depth provider for soft particles',
      hint: 'attach the scene-depth data interface or disable soft particles',
      detail: { path: 'renderer.softParticle' },
    });
  }
  const sheet = renderer.textureSheet;
  const frameCount = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
  const frameIndex =
    sheet === undefined || sheet.frameRate === 0
      ? 0
      : Math.min(
          frameCount - 1,
          Math.max(0, Math.floor(Math.max(0, sample.age) * sheet.frameRate)),
        );
  const softParticleFade =
    renderer.softParticle === undefined || sample.sceneDepth <= 0
      ? 1
      : Math.max(
          0,
          Math.min(
            1,
            (sample.particleDepth - sample.sceneDepth) / renderer.softParticle.fadeDistance,
          ),
        );
  return ok({
    frameIndex,
    pivot: renderer.pivot ?? ([0, 0] as const),
    softParticleFade,
    sortingKey:
      renderer.sorting === 'view-depth' || renderer.sorting === 'view-distance'
        ? sample.particleDepth
        : 0,
  });
}

export function topologyRecoveryHint(
  topology: ParticleTopologyKind,
  reason: 'capacity' | 'broken' | 'degenerate' | 'device',
): string {
  if (reason === 'capacity')
    return `${topology} capacity overflow was bounded; increase its explicit capacity`;
  if (reason === 'broken')
    return `${topology} continuity broke; inspect its explicit source key and keep the last valid segment`;
  if (reason === 'degenerate')
    return `${topology} produced no drawable segment; preserve zero output and inspect source endpoints`;
  return `${topology} device resources recovered from the last known good generation`;
}

interface GpuParticleFeatureOptions {
  readonly camera: ParticleRenderCameraSource;
  readonly sceneSdf?: { read(world: World): RenderFeatureSceneSdfDescriptor | undefined };
  readonly dataInterfaces?: Pick<VfxDataInterfaceRegistry, 'resolve'>;
  readonly texture?: { read(world: World, guid: string): TextureAsset | undefined };
  readonly material?: {
    read(world: World, guid: string): MaterialAsset | undefined;
    projection?(world: World, material: MaterialAsset): MaterialRenderProjection | undefined;
  };
  readonly mesh?: { read(world: World, guid: string): MeshAsset | undefined };
  readonly playerConsumption?: {
    readonly isEnabled: (world: World, player: EntityHandle) => boolean;
  };
}

interface ExtractedMaterial {
  readonly asset: MaterialAsset;
  readonly projection?: MaterialRenderProjection;
}

interface ExtractedEmitterState {
  readonly enabled: boolean;
  readonly localToWorld: Float32Array;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuTickIntent['emitter'];
}

interface ExtractedWorld {
  readonly sourceWorldIndex: number;
  readonly sceneSdf?: RenderFeatureSceneSdfDescriptor;
  readonly worldId: number;
  readonly runtimeId: number;
  readonly renderGeneration: number;
  readonly emitterState: ReadonlyMap<string, ExtractedEmitterState>;
  readonly materials: ReadonlyMap<string, ExtractedMaterial>;
  readonly meshes: ReadonlyMap<string | EntityHandle, MeshAsset>;
  readonly forceFields: ReadonlyMap<string, Result<PreparedVfxForceFields, VfxForceFieldError>>;
  readonly camera: ParticleRenderCamera;
  readonly views: readonly { readonly identity: string; readonly camera: ParticleRenderCamera }[];
  readonly intents: readonly VfxGpuTickIntent[];
  /**
   * Last submitted emitter state kept drawable between fixed ticks.  The
   * queue above is simulation work only; renderHz is allowed to exceed
   * fixedHz, and a live emitter must keep its projection/raster lease warm.
   */
  readonly retained: readonly RetainedEmitter[];
}

interface RetainedEmitter {
  readonly player: VfxGpuEmitterSource['player'];
  readonly emitter: VfxGpuEmitterSource['emitter'];
  readonly intent: VfxGpuTickIntent;
  readonly localToWorld: Float32Array;
  readonly visible: boolean;
}

/** Render-side intents do not need the source definition owner. */
type VfxGpuTickIntent = Omit<SourceVfxGpuTickIntent, 'effect'>;

interface ExtractedFrame {
  readonly worlds: readonly ExtractedWorld[];
  readonly frameNumber: number;
}

/** Source frames carry exact resource identities, never immutable program bodies. */
type PublishedEmitter =
  | { readonly effect: Handle<'ParticleEffectAsset', 'shared'>; readonly id: string }
  | (VfxGpuTickIntent['emitter'] & { readonly effect?: never });
type PublishedIntent = Omit<VfxGpuTickIntent, 'emitter'> & {
  readonly emitter: PublishedEmitter;
  readonly inline?: true;
};
type PublishedEmitterState = Omit<ExtractedEmitterState, 'emitter'> & {
  readonly emitter: PublishedEmitter;
  readonly inline?: true;
};
type PublishedWorld = Omit<ExtractedWorld, 'emitterState' | 'intents' | 'retained' | 'meshes'> & {
  readonly meshes: ReadonlyMap<string | EntityHandle, MeshAsset | Handle<string, 'shared'>>;
  readonly emitterState: ReadonlyMap<string, PublishedEmitterState>;
  readonly intents: readonly PublishedIntent[];
  readonly retained: readonly (Omit<RetainedEmitter, 'emitter' | 'intent'> & {
    readonly emitter: PublishedEmitter;
    readonly inline?: true;
    readonly intent: PublishedIntent;
  })[];
  readonly textureGuids: readonly string[];
};
interface PublishedFrame {
  readonly worlds: readonly PublishedWorld[];
  readonly frameNumber: number;
}

const immutableEmitters = new WeakSet<object>();

function resolveEmitter(
  reference: PublishedEmitter,
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
  inline?: true,
) {
  if (inline) return { effect: undefined, emitter: reference as VfxGpuTickIntent['emitter'] };
  const resolved = context.resolveAsset?.(
    sourceWorldIndex,
    (reference as { effect: Handle<'ParticleEffectAsset', 'shared'> }).effect,
  );
  if (resolved === undefined) throw new Error('VFX requires the feature asset resolver');
  if (!resolved.ok) throw resolved.error;
  const effect = resolved.value as VfxGpuEffectAssetAny;
  if (effect.kind !== 'particle-effect' || effect.schemaVersion !== 3)
    throw new Error('VFX requires a schemaVersion 3 particle effect');
  const emitter = effect.program.emitters.find((candidate) => candidate.id === reference.id);
  if (emitter === undefined) throw new Error(`Missing VFX emitter ${reference.id}`);
  if (isImmutableVfxGpuEffect(effect) || isOwnedRenderFeatureProgramData(effect))
    immutableEmitters.add(emitter);
  return { effect, emitter };
}

function resolveIntent(
  intent: PublishedIntent,
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
): VfxGpuTickIntent {
  if (intent.inline) return { ...intent, emitter: intent.emitter as VfxGpuTickIntent['emitter'] };
  const definition = resolveEmitter(intent.emitter, sourceWorldIndex, context);
  if (definition.effect?.program.fingerprint !== intent.programFingerprint)
    throw new Error('VFX intent and exact effect fingerprint differ');
  return { ...intent, ...definition };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rendererSortingMode(renderer: ParticleRenderer | undefined): 0 | 1 | 2 | 3 | 4 | 5 {
  if (renderer === undefined || isParticleTopologyRenderer(renderer)) return 0;
  switch (renderer.sorting ?? 'none') {
    case 'view-depth':
      return 2;
    case 'view-distance':
      return 5;
    case 'custom-ascending':
      return 3;
    case 'custom-descending':
      return 4;
    case 'none':
      return 0;
  }
}

function vector(value: unknown, fallback: readonly number[], size: number): readonly number[] {
  return Array.isArray(value)
    ? Array.from({ length: size }, (_, index) => finite(value[index], fallback[index] ?? 0))
    : fallback;
}

function runtimeData(
  intent: VfxGpuTickIntent,
  camera: ParticleRenderCamera,
  material: MaterialAsset | undefined,
  localToWorld: Float32Array,
  renderer?: ParticleRenderer,
  rendererIndex = 0,
  particleInputLanes = renderer?.materialInputs?.length ?? 0,
  meshDraw?: { readonly count: number; readonly firstIndex: number },
): Uint8Array {
  const storage = new ArrayBuffer(RUNTIME_BYTES);
  const floats = new Float32Array(storage);
  const words = new Uint32Array(storage);
  floats[0] = intent.fixedDelta;
  words[1] = intent.phaseTick;
  words[2] = intent.seed;
  words[3] = intent.playCycle;
  words[4] = intent.emitter.capacity;
  words[5] = intent.spawnCount;
  words[6] = intent.firstParticleId;
  words[7] = intent.emitter.renderers.length;
  floats.set(camera.viewProjection, 8);
  floats.set(camera.right, 24);
  floats.set(camera.up, 28);
  floats.set(camera.position, 72);
  const values = material?.values ?? {};
  floats.set(vector(values.baseColor, [1, 1, 1, 1], 4), 32);
  const emissive = vector(values.emissive, [0, 0, 0], 3);
  floats.set(emissive, 36);
  floats[39] = finite(values.emissiveIntensity, 0);
  floats[40] = finite(values.metallic, 0);
  floats[41] = finite(values.roughness, 0.5);
  floats[42] = finite(values.clearcoat, 0);
  floats[43] = finite(values.clearcoatRoughness, 0.5);
  floats.set(localToWorld, 44);
  words[60] = rendererIndex;
  words[61] =
    renderer === undefined &&
    ((intent.emitter.reflection.resources ?? []).includes('eventBuffer') ||
      (intent.emitter.reflection.entryPoints ?? []).includes('forgeax_vfx_event_main'))
      ? eventInputCapacity(intent.emitter)
      : renderer?.kind === 'trail'
        ? renderer.historyLength
        : (meshDraw?.count ?? 0);
  words[62] =
    renderer !== undefined && isParticleTopologyRenderer(renderer)
      ? renderer.capacity
      : intent.emitter.capacity;
  words[63] = meshDraw?.firstIndex ?? 0;
  words[75] = rendererSortingMode(renderer);
  floats[64] =
    renderer?.kind === 'billboard'
      ? (renderer.pivot?.[0] ?? 0)
      : renderer !== undefined && isParticleTopologyRenderer(renderer)
        ? (renderer.width ?? 0.1)
        : 0.1;
  floats[65] = renderer?.kind === 'billboard' ? (renderer.pivot?.[1] ?? 0) : 0;
  floats[66] = renderer?.kind === 'billboard' ? (renderer.softParticle?.fadeDistance ?? 0) : 0;
  // The projection shader derives its instance stride from this reflected
  // material-input lane count; undeclared inputs therefore allocate nothing.
  floats[67] = particleInputLanes;
  const sheet = renderer?.kind === 'billboard' ? renderer.textureSheet : undefined;
  floats[68] = sheet?.columns ?? 1;
  floats[69] = sheet?.rows ?? 1;
  floats[70] = sheet?.frameRate ?? 0;
  floats[71] = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
  return new Uint8Array(storage);
}

function emitterTransform(world: World, intent: VfxGpuTickIntent): Float32Array {
  if (intent.emitter.space === 'world') return IDENTITY_MATRIX;
  const transform = world.get(intent.player, GlobalTransform);
  return transform.ok ? transform.value.world : IDENTITY_MATRIX;
}

function emitterVisible(
  emitter: VfxGpuTickIntent['emitter'],
  camera: ParticleRenderCamera,
  localToWorld: Float32Array,
): boolean {
  const bounds = emitter.bounds;
  const center =
    bounds.kind === 'sphere'
      ? bounds.center
      : ([
          (bounds.min[0] + bounds.max[0]) * 0.5,
          (bounds.min[1] + bounds.max[1]) * 0.5,
          (bounds.min[2] + bounds.max[2]) * 0.5,
        ] as const);
  const radius =
    bounds.kind === 'sphere'
      ? bounds.radius
      : Math.hypot(
          (bounds.max[0] - bounds.min[0]) * 0.5,
          (bounds.max[1] - bounds.min[1]) * 0.5,
          (bounds.max[2] - bounds.min[2]) * 0.5,
        );
  const matrix = (index: number): number => localToWorld[index] ?? 0;
  const worldCenter = new Float32Array([
    matrix(0) * center[0] + matrix(4) * center[1] + matrix(8) * center[2] + matrix(12),
    matrix(1) * center[0] + matrix(5) * center[1] + matrix(9) * center[2] + matrix(13),
    matrix(2) * center[0] + matrix(6) * center[1] + matrix(10) * center[2] + matrix(14),
  ]);
  const scale = Math.max(
    Math.hypot(matrix(0), matrix(1), matrix(2)),
    Math.hypot(matrix(4), matrix(5), matrix(6)),
    Math.hypot(matrix(8), matrix(9), matrix(10)),
  );
  const planes = frustum.fromViewProjection(frustum.create(), camera.viewProjection);
  return frustum.intersectsSphere(planes, worldCenter, radius * scale);
}

function resolveDataInterfaces(
  intent: VfxGpuTickIntent,
  registry: Pick<VfxDataInterfaceRegistry, 'resolve'> | undefined,
): ReadonlyMap<VfxDataInterfaceToken, VfxDataInterfaceResource> | undefined {
  const requirements = intent.emitter.reflection.dataInterfaces ?? [];
  const resources = new Map<VfxDataInterfaceToken, VfxDataInterfaceResource>();
  for (const requirement of requirements) {
    const resolved = registry?.resolve([requirement], intent.instanceGeneration);
    if (resolved === undefined) continue;
    if (!resolved.ok) {
      const error = resolved.error;
      // Missing providers or resident payloads use Renderer-owned producers.
      // Explicit unavailability and invalid provider contracts remain barriers.
      if (
        error?.code === 'vfx-data-interface-missing' &&
        (error.detail.providerId === undefined || error.detail.expectedResourceKind !== undefined)
      )
        continue;
      return undefined;
    }
    const resource = resolved.value.resources.find((entry) => entry.token === requirement.token);
    if (resource?.resource !== undefined) resources.set(requirement.token, resource);
  }
  return resources;
}

function planFailure(cause?: unknown): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(IDENTITY, -1, 'plan', 'next-frame', cause);
}

type PlanResource = RenderFeatureWorkPlan['resources'][number];
type PlanPass = RenderFeatureWorkPlan['passes'][number];
type RasterPass = Extract<PlanPass, { kind: 'raster' }>;

function planName(value: string, maxLength = 24): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9.-]/g, '-');
  return (normalized.length === 0 ? 'unnamed' : normalized).slice(0, maxLength);
}

function computeBindingEntries(
  intent: VfxGpuTickIntent,
  resources: Readonly<Record<number, string>>,
): readonly { readonly binding: number; readonly resource: string }[] {
  const declared = new Set(
    (intent.emitter.reflection.bindings[0]?.entries ?? [])
      .filter(
        (entry) =>
          entry.buffer !== undefined ||
          entry.texture !== undefined ||
          entry.sampler !== undefined ||
          entry.storageTexture !== undefined,
      )
      .map((entry) => entry.binding),
  );
  return Object.entries(resources).flatMap(([binding, resource]) =>
    declared.has(Number(binding)) ? [{ binding: Number(binding), resource }] : [],
  );
}

function needsCompactionOffsets(capacity: number): boolean {
  return capacity > WORKGROUP_SIZE;
}

function simulationDispatches(
  intent: VfxGpuTickIntent,
  stages: VfxValidatedStagePlan,
): Extract<PlanPass, { readonly kind: 'compute' }>['dispatches'] {
  const groups = Math.max(1, Math.ceil(intent.emitter.capacity / WORKGROUP_SIZE));
  const compact: Extract<PlanPass, { readonly kind: 'compute' }>['dispatches'] = [
    { kind: 'direct', entryPoint: 'forgeax_vfx_scan_blocks_main', workgroups: [groups] },
    // One block already has global prefixes. Its inter-block offset is zero;
    // neither compaction nor the next spawn reads the block-total scratch.
    ...(needsCompactionOffsets(intent.emitter.capacity)
      ? [
          {
            kind: 'direct' as const,
            entryPoint: 'forgeax_vfx_scan_block_offsets_main',
            workgroups: [1] as const,
          },
          {
            kind: 'direct' as const,
            entryPoint: 'forgeax_vfx_add_offsets_main',
            workgroups: [groups] as const,
          },
        ]
      : []),
    { kind: 'direct', entryPoint: 'forgeax_vfx_compact_main', workgroups: [groups] },
  ];
  return [
    {
      kind: 'direct',
      entryPoint: 'forgeax_vfx_spawn_main',
      workgroups: [intent.spawnCount === 0 ? 0 : groups],
    },
    { kind: 'direct', entryPoint: 'forgeax_vfx_update_main', workgroups: [groups] },
    ...stages.stages.map((stage) => ({
      kind: 'direct' as const,
      entryPoint: stage.entryPoint,
      workgroups: [groups] as const,
    })),
    ...compact,
    ...(intent.emitter.reflection.entryPoints.includes('forgeax_vfx_event_main')
      ? [
          {
            kind: 'direct' as const,
            entryPoint: 'forgeax_vfx_event_main',
            workgroups: [1] as const,
          },
          ...compact,
        ]
      : []),
  ];
}

type VfxParticleRenderFeature = RenderFeature<PublishedFrame> & {
  readonly inspect: () => VfxRenderObservation;
};

export function gpuParticleRenderFeature(
  options: GpuParticleFeatureOptions,
): VfxParticleRenderFeature {
  type IntentOutcomeState = 'dispatched' | 'skipped' | 'deferred';
  interface PlannedIntent {
    readonly intent: VfxGpuTickIntent;
    readonly localToWorld: Float32Array;
    readonly stagePlan: VfxValidatedStagePlan;
    /** Camera projection is optional for `simulationWhenCulled: continue`. */
    readonly visible: boolean;
    /** Retained state has no fixed-tick simulation/history work this frame. */
    readonly retained: boolean;
  }
  interface TickPassRange {
    readonly sequence: number;
    readonly start: number;
    readonly end: number;
  }
  interface EmitterStream {
    lastGroup: string;
    /** Only program changes in this plan need command-order reconciliation. */
    ranges: TickPassRange[] | undefined;
  }
  interface EmitterGroup {
    readonly key: string;
    readonly entry: ExtractedWorld;
    readonly intents: PlannedIntent[];
    readonly stream: EmitterStream;
  }
  interface IntentOutcome {
    readonly intent: VfxGpuTickIntent;
    readonly state: IntentOutcomeState;
  }
  interface PendingEntry {
    readonly source: ExtractedWorld;
    readonly generation: number;
    readonly outcomes: readonly IntentOutcome[];
    readonly observation: VfxRenderObservation;
    readonly requiredPasses: readonly string[];
  }
  const pendingFrames = new Map<
    number,
    {
      readonly entries: readonly PendingEntry[];
      readonly fields: readonly string[];
      readonly generation: number;
    }
  >();
  const prepareFields = createVfxForceFieldPreparation();
  const uploadedFields = new Map<string, number>();
  interface RuntimeState {
    submittedDeviceGeneration: number | undefined;
    // A sealed successor may precede source ACK. Keep only its live terminal sequences.
    submitted:
      | {
          generation: number;
          device: number;
          terminal: Map<number, IntentOutcomeState>;
        }
      | undefined;
    readonly emitters: Map<string, { readonly id: number; tickCapacity: number }>;
  }
  const runtimeStates = new Map<number, RuntimeState>();
  const computePrograms = new WeakMap<object, RenderFeatureGpuProgramDescriptor>();
  const runtimeState = (identity: number): RuntimeState => {
    let state = runtimeStates.get(identity);
    if (state === undefined) {
      state = {
        submittedDeviceGeneration: undefined,
        submitted: undefined,
        emitters: new Map(),
      };
      runtimeStates.set(identity, state);
    }
    return state;
  };
  const sourceRuntimes = new Map<number, VfxGpuRuntime>();
  let lastObservation: VfxRenderObservation = Object.freeze({
    frameNumber: -1,
    dispatches: 0,
    indirectDraws: 0,
    subjectOutputs: 0,
  });
  const worldIds = new WeakMap<World, number>();
  const runtimeIds = new WeakMap<VfxGpuRuntime, number>();
  let nextEmitterResourceId = 0;
  const emitterResource = (states: RuntimeState['emitters'], key: string) => {
    let state = states.get(key);
    if (state === undefined) {
      state = { id: nextEmitterResourceId++, tickCapacity: 0 };
      states.set(key, state);
    }
    return state;
  };
  let nextWorldId = 0;
  let nextRuntimeId = 0;
  const worldId = (world: World): number => {
    const prior = worldIds.get(world);
    if (prior !== undefined) return prior;
    const assigned = nextWorldId++;
    worldIds.set(world, assigned);
    return assigned;
  };
  const runtimeId = (runtime: VfxGpuRuntime): number => {
    const prior = runtimeIds.get(runtime);
    if (prior !== undefined) return prior;
    const assigned = nextRuntimeId++;
    runtimeIds.set(runtime, assigned);
    return assigned;
  };
  const feature: VfxParticleRenderFeature = {
    identity: IDENTITY,
    requiredCapabilities: ['compute', 'indirectDrawing'],
    // Generated emitter programs are first-use assets. They must hand a
    // WebGPU module to the prepared feature pipeline without waiting for the
    // diagnostic-only getCompilationInfo() round trip; pipeline creation still
    // validates the module before the pass is submitted.
    shaderModuleMode: 'immediate',
    requiredMaterialShaders: Object.freeze([
      ...Object.values(PARTICLE_SHADER_IDENTIFIERS),
      ...Object.values(PARTICLE_INPUT_SHADER_IDENTIFIERS),
    ]),
    extract: (context) => {
      // A rejected recovery candidate can outlive the frame that produced it.
      // Keep the producer-owned submission ledger bounded even when a host
      // disappears before it can call onFrameAborted.
      for (const frameNumber of pendingFrames.keys()) {
        if (frameNumber + 4 < context.frameNumber) pendingFrames.delete(frameNumber);
      }
      sourceRuntimes.clear();
      const extracted: PublishedWorld[] = [];
      for (const world of context.worlds) {
        if (!world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) continue;
        const camera = options.camera.read(world, context.views);
        if (camera === undefined) continue;
        const views = context.views.map((view) => ({
          identity: view.identity,
          camera: view.selectedView ?? camera,
        }));
        const visibleInAnyView = (emitter: VfxGpuTickIntent['emitter'], transform: Float32Array) =>
          views.some((view) => emitterVisible(emitter, view.camera, transform));
        const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
        sourceRuntimes.set(runtimeId(runtime), runtime);
        const retained: PublishedWorld['retained'][number][] = [];
        const emitterState = new Map<string, PublishedEmitterState>();
        const emitterReference = (
          effect: VfxGpuEffectAssetAny,
          emitter: VfxGpuTickIntent['emitter'],
        ): Pick<PublishedIntent, 'emitter' | 'inline'> =>
          isImmutableVfxGpuEffect(effect)
            ? { emitter: { effect: runtime.effectHandle(world, effect), id: emitter.id } }
            : { emitter, inline: true };
        const publishIntent = ({
          effect,
          emitter,
          ...intent
        }: SourceVfxGpuTickIntent): PublishedIntent => ({
          ...intent,
          ...emitterReference(effect, emitter),
        });
        const textureGuids = new Set<string>();
        const materials = new Map<string, ExtractedMaterial>();
        const meshes = new Map<string | EntityHandle, MeshAsset | Handle<string, 'shared'>>();
        const sourceWorldIndex = context.worlds.indexOf(world);
        let meshFailure: RenderFeatureStageFailedError | undefined;
        const textures = new Map<string, TextureAsset>();
        const forceFields = new Map<string, Result<PreparedVfxForceFields, VfxForceFieldError>>();
        const captureEmitter = (
          player: EntityHandle,
          emitter: VfxGpuTickIntent['emitter'],
          effect: VfxGpuEffectAssetAny,
          localToWorld: Float32Array,
        ) => {
          emitterState.set(`${Number(player)}:${emitter.id}`, {
            player,
            ...emitterReference(effect, emitter),
            enabled:
              (options.playerConsumption?.isEnabled(world, player) ?? true) &&
              runtime.isEmitterSessionEnabled(player, emitter.id),
            localToWorld: new Float32Array(localToWorld),
          });
          for (const field of emitter.forceFields ?? []) {
            if (field.kind !== 'vector') continue;
            textureGuids.add(field.texture);
            const texture = options.texture?.read(world, field.texture);
            if (texture !== undefined) textures.set(field.texture, texture);
          }
          if (emitter.forceFields !== undefined)
            forceFields.set(
              `${Number(player)}:${emitter.id}`,
              prepareFields(emitter.forceFields, textures),
            );
          for (const renderer of emitter.renderers) {
            const material = options.material?.read(world, renderer.material);
            if (material !== undefined) {
              const projection = options.material?.projection?.(world, material);
              materials.set(renderer.material, {
                asset: material,
                ...(projection === undefined ? {} : { projection }),
              });
            }
            if (renderer.kind === 'mesh') {
              if (typeof renderer.mesh === 'string') {
                const mesh = options.mesh?.read(world, renderer.mesh);
                if (mesh !== undefined)
                  meshes.set(
                    renderer.mesh,
                    context.referenceAsset?.(sourceWorldIndex, renderer.mesh, mesh) ?? mesh,
                  );
              } else {
                const filter = world.get(player, MeshFilter);
                const mesh = filter.ok
                  ? resolveAssetHandle<MeshAsset>(world, filter.value.assetHandle)
                  : filter;
                if (!mesh.ok) {
                  meshFailure ??= new RenderFeatureStageFailedError(
                    IDENTITY,
                    -1,
                    'extract',
                    'next-frame',
                    mesh.error,
                  );
                } else {
                  meshes.set(
                    player,
                    context.referenceAsset?.(
                      sourceWorldIndex,
                      filter.unwrap().assetHandle,
                      mesh.value,
                    ) ?? mesh.value,
                  );
                }
              }
            }
          }
        };
        // Refresh frustum state from live emitter sources even when a paused
        // or restart-on-visible emitter has no queued tick.  Otherwise a
        // camera move back into its bounds can never produce the next intent.
        runtime.forEachEmitterSource(world, ({ player, emitter, effect }) => {
          const sourceIntent = runtime.lastCommittedEmitter(player, emitter.id);
          const localToWorld =
            sourceIntent === undefined
              ? emitter.space === 'world'
                ? IDENTITY_MATRIX
                : (() => {
                    const transform = world.get(player, GlobalTransform);
                    return transform.ok ? transform.value.world : IDENTITY_MATRIX;
                  })()
              : emitterTransform(world, sourceIntent);
          const visible = visibleInAnyView(emitter, localToWorld);
          captureEmitter(player, emitter, effect, localToWorld);
          const intent = runtime.lastCommittedEmitter(player, emitter.id);
          if (intent !== undefined) {
            retained.push({
              player,
              ...emitterReference(intent.effect, intent.emitter),
              intent: publishIntent(intent),
              localToWorld: new Float32Array(localToWorld),
              visible,
            });
          }
        });
        // Keep every queued intent in the extracted frame.  Plan assigns each
        // intent an explicit terminal state (dispatched/skipped/deferred), so a
        // filtered head can never block an acknowledged tail or be silently
        // removed by a later global commit.
        const intents = runtime.snapshot();
        for (const intent of intents) {
          const localToWorld = emitterTransform(world, intent);
          captureEmitter(intent.player, intent.emitter, intent.effect, localToWorld);
        }
        if (meshFailure !== undefined) return err(meshFailure);
        const sceneSdf = options.sceneSdf?.read(world);
        extracted.push({
          sourceWorldIndex,
          ...(sceneSdf === undefined ? {} : { sceneSdf }),
          worldId: worldId(world),
          runtimeId: runtimeId(runtime),
          renderGeneration: runtime.renderGeneration ?? 0,
          camera,
          views,
          intents: intents.map(publishIntent),
          retained,
          emitterState,
          textureGuids: [...textureGuids],
          materials,
          meshes,
          forceFields,
        });
      }
      return ok({ worlds: extracted, frameNumber: context.frameNumber });
    },
    assetDependencies: (frame) => [
      ...new Set(
        frame.worlds.flatMap((world) => [
          ...world.materials.keys(),
          ...[...world.meshes.values()].filter(
            (mesh): mesh is Handle<string, 'shared'> => typeof mesh === 'number',
          ),
          ...world.textureGuids,
          ...[...world.emitterState.values()].flatMap(({ emitter, inline }) =>
            inline ? [] : [(emitter as { effect: Handle<'ParticleEffectAsset', 'shared'> }).effect],
          ),
          ...world.intents.flatMap(({ emitter, inline }) =>
            inline ? [] : [(emitter as { effect: Handle<'ParticleEffectAsset', 'shared'> }).effect],
          ),
          ...world.retained.flatMap(({ intent }) =>
            intent.inline
              ? []
              : [(intent.emitter as { effect: Handle<'ParticleEffectAsset', 'shared'> }).effect],
          ),
        ]),
      ),
    ],
    plan: (sourceFrame, context) => {
      let frame: ExtractedFrame;
      try {
        frame = {
          ...sourceFrame,
          worlds: sourceFrame.worlds.map((entry) => {
            let meshes:
              | Map<string | EntityHandle, MeshAsset | Handle<string, 'shared'>>
              | undefined;
            for (const [key, value] of entry.meshes) {
              if (typeof value !== 'number') continue;
              const resolved = context.resolveAsset?.(entry.sourceWorldIndex, value);
              if (resolved === undefined)
                throw new Error('VFX requires the feature asset resolver');
              if (!resolved.ok) throw resolved.error;
              if (resolved.value.kind !== 'mesh') throw new Error('VFX requires a mesh asset');
              meshes ??= new Map(entry.meshes);
              meshes.set(key, resolved.value);
            }
            const camera = entry.camera;
            const views = context.views.map((view) => ({
              identity: view.identity,
              camera:
                view.selectedView ??
                entry.views.find((candidate) => candidate.identity === view.identity)?.camera ??
                camera,
            }));
            const state = runtimeState(entry.runtimeId);
            let submitted = state.submitted;
            if (
              submitted?.generation !== entry.renderGeneration ||
              submitted.device !== context.generation
            ) {
              submitted = {
                generation: entry.renderGeneration,
                device: context.generation,
                terminal: new Map(),
              };
              state.submitted = submitted;
            }
            const live = new Set(entry.intents.map((intent) => intent.sequence));
            for (const sequence of submitted.terminal.keys())
              if (!live.has(sequence)) submitted.terminal.delete(sequence);
            const emitterState = new Map<string, ExtractedEmitterState>();
            for (const [key, state] of entry.emitterState)
              emitterState.set(key, {
                ...state,
                emitter: resolveEmitter(
                  state.emitter,
                  entry.sourceWorldIndex,
                  context,
                  state.inline,
                ).emitter,
              });
            const retained = new Map<string, RetainedEmitter>();
            for (const row of entry.retained) {
              const intent = resolveIntent(row.intent, entry.sourceWorldIndex, context);
              retained.set(`${Number(row.player)}:${intent.emitter.id}`, {
                ...row,
                intent,
                emitter: intent.emitter,
                visible: views.some((view) =>
                  emitterVisible(intent.emitter, view.camera, row.localToWorld),
                ),
              });
            }
            const intents: VfxGpuTickIntent[] = [];
            for (const published of entry.intents) {
              const state = submitted.terminal.get(published.sequence);
              if (state === 'skipped' || state === 'deferred') continue;
              const intent = resolveIntent(published, entry.sourceWorldIndex, context);
              if (state === undefined) {
                intents.push(intent);
              } else if (state === 'dispatched') {
                const key = `${Number(intent.player)}:${intent.emitter.id}`;
                const prior = retained.get(key);
                const localToWorld = emitterState.get(key)?.localToWorld ?? IDENTITY_MATRIX;
                if (prior === undefined || prior.intent.sequence < intent.sequence)
                  retained.set(key, {
                    player: intent.player,
                    emitter: intent.emitter,
                    intent,
                    localToWorld,
                    visible: views.some((view) =>
                      emitterVisible(intent.emitter, view.camera, localToWorld),
                    ),
                  });
              }
            }
            return {
              ...entry,
              meshes: (meshes ?? entry.meshes) as ReadonlyMap<string | EntityHandle, MeshAsset>,
              camera,
              views,
              emitterState,
              intents,
              retained: [...retained.values()],
            };
          }),
        };
      } catch (cause) {
        return err(planFailure(cause));
      }
      const liveRuntimes = new Set(frame.worlds.map((entry) => entry.runtimeId));
      for (const identity of runtimeStates.keys())
        if (!liveRuntimes.has(identity)) runtimeStates.delete(identity);
      for (const frameNumber of pendingFrames.keys())
        if (frameNumber + 4 < frame.frameNumber) pendingFrames.delete(frameNumber);
      const resources: PlanResource[] = [];
      const passes: PlanPass[] = [];
      const sharedDataInterfaces = new Map<string, PlanResource>();
      const fieldNames = new Set<string>();
      const viewWork = context.views
        .filter((view) => view.render)
        .map((view) => ({
          view,
          resources: [] as PlanResource[],
          passes: [] as PlanPass[],
          opaque: [] as RasterPass[],
          blended: [] as RasterPass[],
        }));
      const groups = new Map<string, EmitterGroup>();
      const streams = new Map<string, EmitterStream>();
      const outcomesByEntry = new Map<ExtractedWorld, IntentOutcome[]>();

      // First classify every queued intent.  A deferred intent is an ordered
      // barrier: later intents in the same runtime cannot be dispatched until
      // the provider/target is ready.  Session masks and paused consumption
      // skip ordinary ticks, but a reset remains deferred so a new authored
      // timeline cannot be mixed into the previous GPU state.
      // A program owns persistent storage for one player/emitter. Resets run
      // in encoder order alongside ticks; preparation never clears live state.
      for (const entry of frame.worlds) {
        const outcomes: IntentOutcome[] = [];
        outcomesByEntry.set(entry, outcomes);
        const renderGeneration = entry.renderGeneration;
        const attachmentId = entry.runtimeId;
        const { emitters } = runtimeState(entry.runtimeId);
        // Ordering barriers belong to one player/emitter stream.  A paused
        // reset or unavailable provider must not head-of-line block unrelated
        // players that share the same VfxGpuRuntime/World.
        const blockedEmitters = new Set<string>();
        for (const intent of entry.intents) {
          const baseKey =
            `${entry.worldId}:${renderGeneration}:` +
            `${Number(intent.player)}:${intent.emitter.id}`;
          if (blockedEmitters.has(baseKey)) {
            outcomes.push({
              intent,
              state: 'deferred',
            });
            continue;
          }
          if (
            entry.emitterState.get(`${Number(intent.player)}:${intent.emitter.id}`)?.enabled ===
            false
          ) {
            const state = intent.reset ? ('deferred' as const) : ('skipped' as const);
            outcomes.push({
              intent,
              state,
            });
            if (intent.reset) blockedEmitters.add(baseKey);
            continue;
          }
          const localToWorld =
            entry.emitterState.get(`${Number(intent.player)}:${intent.emitter.id}`)?.localToWorld ??
            IDENTITY_MATRIX;
          const visible = entry.views.some((view) =>
            emitterVisible(intent.emitter, view.camera, localToWorld),
          );
          if (!visible && intent.emitter.simulationWhenCulled !== 'continue') {
            const state = intent.reset ? ('deferred' as const) : ('skipped' as const);
            outcomes.push({
              intent,
              state,
            });
            if (intent.reset) blockedEmitters.add(baseKey);
            continue;
          }
          const requirements = intent.emitter.reflection.dataInterfaces ?? [];
          if (
            requirements.length > 0 &&
            resolveDataInterfaces(intent, options.dataInterfaces) === undefined
          ) {
            outcomes.push({
              intent,
              state: 'deferred',
            });
            blockedEmitters.add(baseKey);
            continue;
          }
          const stagePlan = validatedStagePlan(
            intent.emitter.reflection.stages,
            intent.instanceGeneration,
          );
          if (!stagePlan.ok) return err(planFailure());
          const entryPoints = new Set(intent.emitter.reflection.entryPoints);
          const dispatches = simulationDispatches(intent, stagePlan.value).filter((dispatch) =>
            entryPoints.has(dispatch.entryPoint),
          );
          if (dispatches.length === 0 && intent.emitter.renderers.length === 0) {
            outcomes.push({
              intent,
              state: 'skipped',
            });
            continue;
          }
          const key =
            `vfx.w-${planName(entry.worldId.toString(36), 8)}.` +
            `a-${planName(attachmentId.toString(36), 8)}.` +
            `r-${entry.renderGeneration}.p-${planName(Number(intent.player).toString(36), 16)}.` +
            `e-${emitterResource(emitters, `${baseKey}:${intent.programFingerprint}`).id.toString(36)}`;
          const streamKey = `${attachmentId}:${baseKey}`;
          let stream = streams.get(streamKey);
          if (stream === undefined) {
            stream = { lastGroup: key, ranges: undefined };
            streams.set(streamKey, stream);
          } else if (stream.lastGroup !== key) {
            stream.lastGroup = key;
            stream.ranges ??= [];
          }
          let group = groups.get(key);
          if (group === undefined) {
            group = {
              key,
              entry,
              intents: [],
              stream,
            };
            groups.set(key, group);
          } else if (
            group.entry !== entry ||
            group.intents[0]?.intent.emitter.wgsl !== intent.emitter.wgsl ||
            group.intents[0]?.intent.emitter.capacity !== intent.emitter.capacity
          ) {
            return err(planFailure());
          }
          group.intents.push({
            intent,
            localToWorld,
            stagePlan: stagePlan.value,
            visible,
            retained: false,
          });
          outcomes.push({
            intent,
            state: dispatches.length > 0 ? 'dispatched' : 'skipped',
          });
        }
      }

      // The fixed-tick queue is intentionally empty on most render frames.
      // Keep the last submitted emitter state as a render-only group so its
      // persistent particle/history buffers, projection and raster passes stay
      // alive until the player is reset. A queued intent admitted above owns
      // the frame; deferred/skipped work falls back to this retained lease.
      for (const entry of frame.worlds) {
        const renderGeneration = entry.renderGeneration;
        const attachmentId = entry.runtimeId;
        const { submittedDeviceGeneration, emitters } = runtimeState(entry.runtimeId);
        const rebuildingDeviceState = submittedDeviceGeneration !== context.generation;
        for (const retained of entry.retained ?? []) {
          const baseKey =
            `${entry.worldId}:${renderGeneration}:` +
            `${Number(retained.player)}:${retained.emitter.id}`;
          const key =
            `vfx.w-${planName(entry.worldId.toString(36), 8)}.` +
            `a-${planName(attachmentId.toString(36), 8)}.` +
            `r-${renderGeneration}.p-${planName(Number(retained.player).toString(36), 16)}.` +
            `e-${emitterResource(emitters, `${baseKey}:${retained.intent.programFingerprint}`).id.toString(36)}`;
          const admittedGroup = groups.get(key);
          const stream = streams.get(`${attachmentId}:${baseKey}`);
          const stagePlan = validatedStagePlan(
            retained.intent.emitter.reflection.stages,
            retained.intent.instanceGeneration,
          );
          if (!stagePlan.ok) return err(planFailure());
          const visible =
            retained.visible &&
            (entry.emitterState.get(`${Number(retained.player)}:${retained.emitter.id}`)?.enabled ??
              true);
          const recoveryIntents = rebuildingDeviceState
            ? buildVfxRecoveryIntents(retained.intent)
            : [];
          if (admittedGroup !== undefined) {
            const firstAdmitted = admittedGroup.intents[0]?.intent;
            const sameCommittedSession =
              firstAdmitted !== undefined &&
              !firstAdmitted.reset &&
              firstAdmitted.playCycle === retained.intent.playCycle;
            if (recoveryIntents.length > 0 && sameCommittedSession) {
              groups.set(key, {
                ...admittedGroup,
                intents: [
                  ...recoveryIntents.map((intent) => ({
                    intent,
                    localToWorld: retained.localToWorld,
                    stagePlan: stagePlan.value,
                    visible,
                    retained: false,
                  })),
                  ...admittedGroup.intents,
                ],
              });
            }
            continue;
          }
          // A different program owns separate storage. Never recreate the
          // prior retained cycle alongside it on a replacement device.
          if (stream !== undefined) continue;
          groups.set(key, {
            key,
            entry,
            stream: { lastGroup: key, ranges: undefined },
            intents:
              recoveryIntents.length === 0
                ? [
                    {
                      intent: retained.intent,
                      localToWorld: retained.localToWorld,
                      stagePlan: stagePlan.value,
                      visible,
                      retained: true,
                    },
                  ]
                : recoveryIntents.map((intent) => ({
                    intent,
                    localToWorld: retained.localToWorld,
                    stagePlan: stagePlan.value,
                    visible,
                    retained: false,
                  })),
          });
        }
      }

      // Declaration order can be stable without changing pass execution order.
      // These ranges belong to this producer's private arrays; no author names,
      // getters or metadata are inspected to establish the group identity.
      // New GPU buffers are zero initialized. One immutable source serves all
      // reset copies without per-emitter mirrors or CPU zero-array uploads.
      const resetZero = 'vfx.reset-zero';
      let resetZeroBytes = 0;
      const resourceRanges: { key: string; starts: number[]; ends: number[] }[] = [];
      const resourceArrays = [resources, ...viewWork.map((work) => work.resources)];
      for (const group of groups.values()) {
        const resourceStarts = resourceArrays.map((array) => array.length);
        const first = group.intents[0];
        if (first === undefined) continue;
        const firstIntent = first.intent;
        const latest = group.intents.at(-1) ?? first;
        const prefix = group.key;
        const program = `${prefix}.compute-program`;
        const particles = `${prefix}.particles`;
        const aliveIndices = `${prefix}.alive-indices`;
        const counters = `${prefix}.counters`;
        const indirect = `${prefix}.indirect`;
        const scratch = `${prefix}.scratch`;
        const sharedInstances = `${prefix}.shared-instances`;
        // Binding 8 is the cooked event ABI: input and output records share one
        // storage buffer. Keep the stable projection name for bind-group reuse.
        const projectionEventInputs = `${prefix}.projection-event-inputs`;
        const capacity = firstIntent.emitter.capacity;
        const renderers = firstIntent.emitter.renderers;
        let computeProgram = immutableEmitters.has(firstIntent.emitter)
          ? computePrograms.get(firstIntent.emitter)
          : undefined;
        if (computeProgram === undefined) {
          const authoredRendererKinds = new Set(renderers.map((renderer) => renderer.kind));
          const preparedEntryPoints = firstIntent.emitter.reflection.entryPoints.filter(
            (entryPoint) => {
              if (
                entryPoint === 'forgeax_vfx_scan_block_offsets_main' ||
                entryPoint === 'forgeax_vfx_add_offsets_main'
              )
                return needsCompactionOffsets(capacity);
              if (entryPoint === 'forgeax_vfx_sort_main')
                return renderers.some((renderer) => rendererSortingMode(renderer) !== 0);
              const kind = rendererOnlyEntryPoints.get(entryPoint);
              return kind === undefined || authoredRendererKinds.has(kind);
            },
          );
          computeProgram = {
            wgsl: firstIntent.emitter.wgsl,
            entryPoints: preparedEntryPoints,
            bindings: firstIntent.emitter.reflection.bindings,
          };
          if (immutableEmitters.has(firstIntent.emitter)) {
            computeProgram = ownRenderFeatureProgramData(computeProgram);
            computePrograms.set(firstIntent.emitter, computeProgram);
          }
        }
        const layout = firstIntent.emitter.reflection.layout;
        const parameterBytes = layout?.parameters.size ?? 0;
        const customStride = layout?.customLayout?.stride ?? 0;
        const hasEvents =
          (firstIntent.emitter.reflection.resources ?? []).includes('eventBuffer') ||
          (firstIntent.emitter.reflection.entryPoints ?? []).includes('forgeax_vfx_event_main') ||
          (firstIntent.emitter.reflection.bindings[0]?.entries ?? []).some(
            (entry) => entry.binding === 8,
          );
        const diBindings: Record<number, string> = {};
        const diResources: PlanResource[] = [];
        const reflectedBindings = new Set(
          firstIntent.emitter.reflection.bindings.flatMap((group) =>
            group.entries.map((entry) => entry.binding),
          ),
        );
        const requirements = (firstIntent.emitter.reflection.dataInterfaces ?? []).filter(
          (requirement) => reflectedBindings.has(requirement.binding),
        );
        if (requirements.length > 0) {
          const resolved = resolveDataInterfaces(firstIntent, options.dataInterfaces);
          if (resolved === undefined) return err(planFailure());
          for (const requirement of requirements) {
            if (requirement.kind === 'force-fields') {
              if (firstIntent.emitter.forceFields === undefined) return err(planFailure());
              if (!group.intents.every((planned) => isVfxFieldTransform(planned.localToWorld)))
                return err(
                  planFailure({
                    code: 'vfx-field-invalid',
                    expected: 'finite invertible emitter transform',
                    hint: 'repair the player Scene transform',
                    detail: { path: 'player.transform' },
                  }),
                );
              const fields = group.entry.forceFields.get(
                `${Number(firstIntent.player)}:${firstIntent.emitter.id}`,
              );
              if (fields === undefined) return err(planFailure());
              if (!fields.ok) return err(planFailure(fields.error));
              const name = `${prefix}.force-fields.${fields.value.revision}`;
              fieldNames.add(name);
              diResources.push({
                kind: 'buffer',
                name,
                size: fields.value.data.byteLength,
                usage: ['storage'],
                ...(uploadedFields.get(name) === context.generation
                  ? {}
                  : { data: fields.value.data }),
              });
              diBindings[requirement.binding] = name;
              continue;
            }
            const prepared = resolved.get(requirement.token)?.resource;
            if (prepared === undefined) {
              const name =
                requirement.kind === 'noise'
                  ? 'vfx.di-noise'
                  : `vfx.a-${group.entry.runtimeId}.di-${requirement.kind}`;
              if (!sharedDataInterfaces.has(name)) {
                switch (requirement.kind) {
                  case 'camera':
                    sharedDataInterfaces.set(name, {
                      kind: 'buffer',
                      name,
                      size: 64,
                      usage: ['uniform'],
                      data: new Float32Array(group.entry.camera.viewProjection),
                    });
                    break;
                  case 'scene-depth':
                    sharedDataInterfaces.set(name, {
                      kind: 'scene-depth',
                      name,
                      camera: {
                        position: new Float32Array(group.entry.camera.position),
                        right: new Float32Array(group.entry.camera.right),
                        up: new Float32Array(group.entry.camera.up),
                        viewProjection: new Float32Array(group.entry.camera.viewProjection),
                      },
                    });
                    break;
                  case 'noise':
                    sharedDataInterfaces.set(name, { kind: 'scene-noise', name });
                    break;
                  case 'scene-sdf': {
                    const descriptor = group.entry.sceneSdf;
                    if (descriptor === undefined) return err(planFailure());
                    sharedDataInterfaces.set(name, {
                      kind: 'scene-sdf',
                      name,
                      world: group.entry.sourceWorldIndex,
                      descriptor,
                    });
                    break;
                  }
                }
              }
              diBindings[requirement.binding] = name;
              continue;
            }
            const name = `${prefix}.di-${planName(requirement.kind)}`;
            if (prepared.kind === 'buffer') {
              if (prepared.size === undefined || prepared.size <= 0) return err(planFailure());
              diResources.push({
                kind: 'prepared-gpu-resource',
                name,
                resource: {
                  kind: 'buffer',
                  value: prepared.value,
                  size: prepared.size,
                  usage: prepared.usage === 'storage' ? ['storage'] : ['uniform'],
                },
              });
            } else {
              const external =
                prepared.kind === 'texture-view'
                  ? { kind: 'texture-view' as const, value: prepared.value }
                  : { kind: 'sampler' as const, value: prepared.value };
              diResources.push({
                kind: 'prepared-gpu-resource',
                name,
                resource: external,
              });
            }
            diBindings[requirement.binding] = name;
          }
        }
        const meshes = renderers.map((renderer) =>
          renderer.kind === 'mesh'
            ? group.entry.meshes.get(
                typeof renderer.mesh === 'string' ? renderer.mesh : firstIntent.player,
              )
            : undefined,
        );
        const indirectWords = new Uint32Array(Math.max(1, renderers.length) * 5);
        for (const [rendererIndex, renderer] of renderers.entries()) {
          const mesh = meshes[rendererIndex];
          const submesh =
            renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
          if (renderer.kind === 'mesh' && submesh === undefined) return err(planFailure());
          if (isParticleTopologyRenderer(renderer) && !createTopologyResourcePlan(renderer).ok) {
            return err(planFailure());
          }
          indirectWords[rendererIndex * 5] =
            renderer.kind === 'mesh'
              ? mesh?.indices === undefined
                ? (submesh?.vertexCount ?? 0)
                : (submesh?.indexCount ?? 0)
              : 6;
          indirectWords[rendererIndex * 5 + 2] =
            renderer.kind === 'mesh' && mesh?.indices !== undefined
              ? (submesh?.indexOffset ?? 0)
              : 0;
        }
        const scratchBytes = (capacity * 2 + Math.ceil(capacity / WORKGROUP_SIZE)) * 4;
        const eventBufferBytes = Math.max(
          4,
          eventInputCapacity(firstIntent.emitter) * VFX_EVENT_INPUT_BYTES +
            eventCapacity(firstIntent.emitter) * VFX_EVENT_BYTES,
        );
        const particleBytes = VFX_PARTICLE_CORE_STRIDE;
        const maxParticleInputBytes = Math.max(
          0,
          ...renderers.map((renderer) => (renderer.materialInputs?.length ?? 0) * 16),
        );
        const resetCopies = [
          { source: resetZero, destination: particles, size: capacity * particleBytes },
          { source: resetZero, destination: aliveIndices, size: capacity * 4 },
          { source: resetZero, destination: counters, size: COUNTERS_BYTES },
          { source: resetZero, destination: scratch, size: scratchBytes },
          ...(customStride === 0
            ? []
            : [
                {
                  source: resetZero,
                  destination: `${prefix}.custom`,
                  size: capacity * customStride,
                },
              ]),
        ];
        resources.push(
          ...diResources,
          {
            kind: 'compute-program',
            name: program,
            program: computeProgram,
          },
          {
            kind: 'buffer',
            name: particles,
            size: capacity * particleBytes,
            usage: ['storage'],
          },
          ...(parameterBytes === 0
            ? []
            : [
                {
                  kind: 'buffer' as const,
                  name: `${prefix}.parameters`,
                  size: parameterBytes,
                  usage: ['uniform'] as const,
                  data: latest.intent.parameterBlock,
                },
              ]),
          ...(customStride === 0
            ? []
            : [
                {
                  kind: 'buffer' as const,
                  name: `${prefix}.custom`,
                  size: capacity * customStride,
                  usage: ['storage'] as const,
                },
              ]),
          {
            kind: 'buffer',
            name: aliveIndices,
            size: capacity * 4,
            usage: ['storage', 'copy-src'],
          },
          {
            kind: 'buffer',
            name: counters,
            size: COUNTERS_BYTES,
            usage: ['storage', 'copy-src'],
          },
          {
            kind: 'buffer',
            name: indirect,
            size: indirectWords.byteLength,
            usage: ['storage', 'indirect', 'copy-src'],
          },
          {
            kind: 'buffer',
            name: `${prefix}.indirect-initial`,
            size: indirectWords.byteLength,
            usage: ['copy-src'],
            ...(group.intents.some((planned) => !planned.retained && planned.intent.reset)
              ? { data: indirectWords }
              : {}),
          },
          {
            kind: 'buffer',
            name: scratch,
            size: scratchBytes,
            usage: ['storage'],
          },
          {
            kind: 'buffer',
            name: sharedInstances,
            size:
              capacity *
              (Math.max(BILLBOARD_INSTANCE_BYTES, MESH_INSTANCE_BYTES) + maxParticleInputBytes),
            usage: ['storage', 'vertex'],
          },
          ...(hasEvents
            ? [
                {
                  kind: 'buffer' as const,
                  name: projectionEventInputs,
                  size: eventBufferBytes,
                  usage: ['storage'] as const,
                  data: encodeEventBuffer(firstIntent),
                },
              ]
            : []),
        );
        const entryPoints = new Set(firstIntent.emitter.reflection.entryPoints);

        for (const [rendererIndex, renderer] of renderers.entries()) {
          if (renderer.enabled === false || renderer.kind !== 'trail') continue;
          const historyBytes = capacity * (Math.max(2, renderer.historyLength) + 1) * 16;
          resetCopies.push({
            source: resetZero,
            destination: `${prefix}.renderer-${rendererIndex}.history`,
            size: historyBytes,
          });
          resources.push({
            kind: 'buffer',
            name: `${prefix}.renderer-${rendererIndex}.history`,
            size: historyBytes,
            usage: ['storage', 'copy-src'],
          });
        }

        for (const copy of resetCopies) resetZeroBytes = Math.max(resetZeroBytes, copy.size);
        resetCopies.push({
          source: `${prefix}.indirect-initial`,
          destination: indirect,
          size: indirectWords.byteLength,
        });

        // Each fixed tick gets only its own immutable runtime/event input and
        // bindings.  The particle/counter/scratch/event/history resources are
        // shared, so dispatch order advances one emitter state rather than
        // simulating independent q-0/q-1 copies.
        // Tick occupancy is frame data. Retain the largest admitted batch's
        // slots so alternating fixed/render cadence does not rebuild the graph.
        const emitter = emitterResource(
          runtimeState(group.entry.runtimeId).emitters,
          `${group.entry.worldId}:${group.entry.renderGeneration}:${Number(firstIntent.player)}:${firstIntent.emitter.id}:${firstIntent.programFingerprint}`,
        );
        emitter.tickCapacity = Math.max(emitter.tickCapacity, group.intents.length);
        for (let tickIndex = 0; tickIndex < emitter.tickCapacity; tickIndex++) {
          const planned = group.intents[tickIndex] ?? first;
          const enabled = tickIndex < group.intents.length && !planned.retained;
          const tickPrefix = `${prefix}.tick-${tickIndex}`;
          const tickRuntime = `${tickPrefix}.runtime`;
          const tickEventInputs = `${tickPrefix}.event-inputs`;
          const tickBindings = `${tickPrefix}.simulation-bindings`;
          resources.push(
            {
              kind: 'buffer',
              name: tickRuntime,
              size: RUNTIME_BYTES,
              usage: ['uniform'],
              ...(enabled
                ? {
                    data: runtimeData(
                      planned.intent,
                      group.entry.camera,
                      undefined,
                      planned.localToWorld,
                    ),
                  }
                : {}),
            },
            ...(hasEvents
              ? [
                  {
                    kind: 'buffer' as const,
                    name: tickEventInputs,
                    size: eventBufferBytes,
                    usage: ['storage'] as const,
                    ...(enabled ? { data: encodeEventBuffer(planned.intent) } : {}),
                  },
                ]
              : []),
            ...(parameterBytes === 0
              ? []
              : [
                  {
                    kind: 'buffer' as const,
                    name: `${tickPrefix}.parameters`,
                    size: parameterBytes,
                    usage: ['uniform'] as const,
                    ...(enabled ? { data: planned.intent.parameterBlock } : {}),
                  },
                ]),
            {
              kind: 'compute-bindings',
              name: tickBindings,
              program,
              entries: computeBindingEntries(planned.intent, {
                0: particles,
                1: tickRuntime,
                2: aliveIndices,
                3: counters,
                4: indirect,
                5: scratch,
                6: sharedInstances,
                ...(hasEvents ? { 8: tickEventInputs } : {}),
                ...(parameterBytes === 0 ? {} : { 10: `${tickPrefix}.parameters` }),
                ...(customStride === 0 ? {} : { 11: `${prefix}.custom` }),
                ...diBindings,
              }),
            },
          );
          const dispatches = simulationDispatches(planned.intent, planned.stagePlan).filter(
            (dispatch) => entryPoints.has(dispatch.entryPoint),
          );
          if (dispatches.length === 0) continue;
          const tickPassStart = passes.length;
          // Keep the ordinary reset boundary before the complete compute chain.
          // A rare mid-batch reset needs a real boundary; reserving disabled
          // copies between every tick would split steady-state compute passes.
          if (tickIndex === 0 || (enabled && planned.intent.reset))
            passes.push({
              kind: 'copy',
              name: `${tickPrefix}.reset`,
              enabled: enabled && planned.intent.reset,
              copies: resetCopies,
            });
          passes.push({
            kind: 'compute',
            enabled,
            name: `${tickPrefix}.simulate`,
            program,
            bindings: tickBindings,
            dispatches,
          });

          // Trail history is part of the fixed-step simulation state.  It must
          // be written immediately after each tick, before the next tick can
          // mutate particles; projecting history once after the whole batch
          // would overwrite only the latest ring slot.
          for (const [rendererIndex, renderer] of renderers.entries()) {
            if (renderer.enabled === false) continue;
            if (renderer.kind !== 'trail') continue;
            if (!entryPoints.has('forgeax_vfx_trail_history_main')) continue;
            const rendererPrefix = `${prefix}.renderer-${rendererIndex}`;
            const history = `${rendererPrefix}.history`;
            const historyRuntime = `${tickPrefix}.renderer-${rendererIndex}.history-runtime`;
            const historyBindings = `${tickPrefix}.renderer-${rendererIndex}.history-bindings`;
            resources.push(
              {
                kind: 'buffer',
                name: historyRuntime,
                size: RUNTIME_BYTES,
                usage: ['uniform'],
                ...(enabled
                  ? {
                      data: runtimeData(
                        planned.intent,
                        group.entry.camera,
                        undefined,
                        planned.localToWorld,
                        renderer,
                        rendererIndex,
                      ),
                    }
                  : {}),
              },
              {
                kind: 'compute-bindings',
                name: historyBindings,
                program,
                entries: computeBindingEntries(planned.intent, {
                  0: particles,
                  1: historyRuntime,
                  2: aliveIndices,
                  3: counters,
                  4: indirect,
                  5: history,
                  6: sharedInstances,
                  ...(hasEvents ? { 8: tickEventInputs } : {}),
                  ...(parameterBytes === 0 ? {} : { 10: `${tickPrefix}.parameters` }),
                  ...(customStride === 0 ? {} : { 11: `${prefix}.custom` }),
                  ...diBindings,
                }),
              },
            );
            passes.push({
              kind: 'compute',
              enabled,
              name: `${historyBindings}.write`,
              program,
              bindings: historyBindings,
              dispatches: [
                {
                  kind: 'direct',
                  entryPoint: 'forgeax_vfx_trail_history_main',
                  workgroups: [Math.max(1, Math.ceil(renderer.capacity / WORKGROUP_SIZE))],
                },
              ],
            });
          }
          if (enabled)
            group.stream.ranges?.push({
              sequence: planned.intent.sequence,
              start: tickPassStart,
              end: passes.length,
            });
        }

        for (const work of viewWork) {
          // Older programs still simulate and acknowledge their ordered ticks,
          // but only this stream's final admitted program can be presented.
          if (group.stream.lastGroup !== group.key) continue;
          const { view, resources, passes } = work;
          const camera =
            view.selectedView ??
            group.entry.views.find((entry) => entry.identity === view.identity)?.camera;
          if (camera === undefined) continue;
          const colorTarget =
            view.targets.find((target) => target.kind === 'color') ??
            view.targets.find((target) => target.kind === 'swapchain');
          const depthTarget = view.targets.find((target) => target.kind === 'depth');
          const visible =
            emitterVisible(latest.intent.emitter, camera, latest.localToWorld) && latest.visible;
          const viewPrefix = `${prefix}.view`;
          for (const [rendererIndex, renderer] of renderers.entries()) {
            // Disabled entries remain in the cooked renderer index space but do
            // not acquire projection, graphics, or shadow resources.
            if (renderer.enabled === false) continue;
            const castsShadow = renderer.kind === 'mesh' && renderer.castShadows === true;

            const rendererPrefix = `${viewPrefix}.renderer-${rendererIndex}`;
            const isBillboard = renderer.kind === 'billboard';
            const isTopology = isParticleTopologyRenderer(renderer);
            const topologyPlan = isTopology ? createTopologyResourcePlan(renderer) : undefined;
            if (topologyPlan !== undefined && !topologyPlan.ok) return err(planFailure());
            const publishedMaterial = group.entry.materials.get(renderer.material);
            const material = publishedMaterial?.asset;
            const reflectedRenderer = firstIntent.emitter.reflection.renderers?.[rendererIndex];
            const preparedInputs = prepareParticleMaterialInputs(
              renderer,
              material,
              reflectedRenderer?.materialInputDefinitions,
            );
            if (!preparedInputs.ok) return err(planFailure());
            const hasParticleInputs = preparedInputs.value.lanes > 0;
            const materialPass = particleMaterialPass(
              renderer.kind,
              material,
              hasParticleInputs,
              publishedMaterial?.projection === undefined
                ? undefined
                : {
                    projection: publishedMaterial.projection,
                    context: context.materialContext,
                  },
            );
            const mesh = meshes[rendererIndex];
            const submesh =
              renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined;
            const indexFormat = mesh?.indices instanceof Uint32Array ? 'uint32' : 'uint16';
            const materialContract = context.materialShaderBindingContract?.(materialPass.shader);
            const materialBindingContract = materialContract?.bindings;
            const sceneDepthVersion = materialPass.sceneDepth ?? materialContract?.sceneDepth;
            const sceneDepthBinding = particleMaterialSceneDepthBinding(materialBindingContract);
            const instances = `${rendererPrefix}.instances`;
            const viewAliveIndices = `${rendererPrefix}.alive-indices`;
            const viewIndirect = `${rendererPrefix}.indirect`;
            const viewCounters = `${rendererPrefix}.counters`;
            const history = `${rendererPrefix}.history`;
            const projectionRuntime = `${rendererPrefix}.runtime`;
            const projectionBindings = `${rendererPrefix}.compute-bindings`;
            const vertexLayout = isBillboard
              ? hasParticleInputs
                ? RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance
                : RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance
              : isTopology
                ? hasParticleInputs
                  ? RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance
                  : RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance
                : hasParticleInputs
                  ? RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance
                  : RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance;
            const inputBytes = preparedInputs.value.stride;
            const instanceBytes = isTopology
              ? (() => {
                  const vertexCount = Math.max(
                    1,
                    Math.floor((topologyPlan?.value.vertexBytes ?? 16) / 48),
                  );
                  return vertexCount * (48 + inputBytes);
                })()
              : capacity *
                ((isBillboard ? BILLBOARD_INSTANCE_BYTES : MESH_INSTANCE_BYTES) + inputBytes);
            const historyBytes =
              renderer.kind === 'trail'
                ? capacity * (Math.max(2, renderer.historyLength) + 1) * 16
                : 16;
            resources.push(
              {
                kind: 'buffer',
                name: instances,
                size: instanceBytes,
                usage: ['storage', 'vertex'],
              },
              {
                kind: 'buffer',
                name: history,
                size: historyBytes,
                usage: ['storage'],
              },
            );
            resources.push(
              { kind: 'buffer', name: viewAliveIndices, size: capacity * 4, usage: ['storage'] },
              { kind: 'buffer', name: viewCounters, size: COUNTERS_BYTES, usage: ['storage'] },
              {
                kind: 'buffer',
                name: viewIndirect,
                size: indirectWords.byteLength,
                usage: ['storage', 'indirect'],
              },
            );
            const copies = [
              { source: aliveIndices, destination: viewAliveIndices, size: capacity * 4 },
              { source: counters, destination: viewCounters, size: COUNTERS_BYTES },
              { source: indirect, destination: viewIndirect, size: indirectWords.byteLength },
              ...(renderer.kind === 'trail'
                ? [
                    {
                      source: `${prefix}.renderer-${rendererIndex}.history`,
                      destination: history,
                      size: historyBytes,
                    },
                  ]
                : []),
            ];
            passes.push({
              kind: 'copy',
              name: `${rendererPrefix}.copy`,
              enabled: visible || castsShadow,
              copies,
            });
            resources.push(
              {
                kind: 'buffer',
                name: projectionRuntime,
                size: RUNTIME_BYTES,
                usage: ['uniform'],
                data: runtimeData(
                  { ...latest.intent, fixedDelta: 0, spawnCount: 0 },
                  camera,
                  material,
                  latest.localToWorld,
                  renderer,
                  rendererIndex,
                  preparedInputs.value.lanes,
                  renderer.kind === 'mesh' && submesh !== undefined
                    ? {
                        count:
                          mesh?.indices === undefined ? submesh.vertexCount : submesh.indexCount,
                        firstIndex: mesh?.indices === undefined ? 0 : submesh.indexOffset,
                      }
                    : undefined,
                ),
              },
              {
                kind: 'compute-bindings',
                name: projectionBindings,
                program,
                entries: computeBindingEntries(latest.intent, {
                  0: particles,
                  1: projectionRuntime,
                  2: viewAliveIndices,
                  3: viewCounters,
                  4: viewIndirect,
                  5: history,
                  6: instances,
                  ...(hasEvents ? { 8: projectionEventInputs } : {}),
                  ...(parameterBytes === 0 ? {} : { 10: `${prefix}.parameters` }),
                  ...(customStride === 0 ? {} : { 11: `${prefix}.custom` }),
                  ...diBindings,
                }),
              },
            );
            const projectionDispatches: Extract<
              PlanPass,
              { readonly kind: 'compute' }
            >['dispatches'][number][] = [];
            const pushProjection = (entryPoint: string, workgroups: number): void => {
              if (!entryPoints.has(entryPoint)) return;
              projectionDispatches.push({
                kind: 'direct',
                entryPoint,
                workgroups: [Math.max(1, workgroups)],
              });
            };
            if (rendererSortingMode(renderer) !== 0) pushProjection('forgeax_vfx_sort_main', 1);
            if (renderer.kind === 'trail') pushProjection('forgeax_vfx_trail_offsets_main', 1);
            const projectionCount =
              renderer.kind === 'trail'
                ? renderer.capacity * Math.max(1, renderer.historyLength - 1)
                : isTopology
                  ? renderer.capacity
                  : capacity;
            pushProjection(
              `forgeax_vfx_${renderer.kind}_main`,
              Math.ceil(projectionCount / WORKGROUP_SIZE),
            );
            if (projectionDispatches.length > 0) {
              passes.push({
                kind: 'compute',
                name: `${rendererPrefix}.project`,
                enabled: visible || castsShadow,
                program,
                bindings: projectionBindings,
                dispatches: projectionDispatches,
              });
            }

            const graphicsProgram = `${rendererPrefix}.graphics-program`;
            const graphicsBindings = `${rendererPrefix}.graphics-bindings`;
            const vertexData = `${rendererPrefix}.vertex-data`;
            const renderState = particleRendererRenderState(
              renderer.kind,
              renderer.kind === 'billboard' ? renderer.blend : undefined,
              materialPass.renderState,
            );
            resources.push(
              {
                kind: 'graphics-program',
                name: graphicsProgram,
                program: {
                  shader: materialPass.shader,
                  vertexLayout,
                  ...(hasParticleInputs ? { particleInputLanes: preparedInputs.value.lanes } : {}),
                  colorFormats: [colorTarget?.format ?? 'rgba8unorm-srgb'],
                  ...(depthTarget === undefined ? {} : { depthFormat: depthTarget.format }),
                  sampleCount: colorTarget?.sampleCount ?? 1,
                  topology: submesh?.topology ?? 'triangle-list',
                  ...(mesh?.indices === undefined ? {} : { indexFormat }),
                  ...(renderState === undefined ? {} : { renderState }),
                },
              },
              {
                kind: 'graphics-bindings',
                name: graphicsBindings,
                program: graphicsProgram,
                values: {
                  group: 0,
                  runtime: projectionRuntime,
                  instances,
                  ...(sceneDepthBinding === undefined ? {} : { sceneDepthBinding }),
                },
                ...(sceneDepthBinding !== undefined && depthTarget !== undefined
                  ? { logicalTargets: { sceneDepth: depthTarget.name } }
                  : {}),
              },
              { kind: 'vertex-data', name: vertexData, layout: vertexLayout, buffer: instances },
            );
            const drawBindings = [graphicsBindings];
            if (particleMaterialUsesBindings(materialBindingContract)) {
              const materialBindings = `${rendererPrefix}.material-bindings.w-${group.entry.sourceWorldIndex}`;
              resources.push({
                kind: 'graphics-bindings',
                name: materialBindings,
                program: graphicsProgram,
                values: {
                  group: 1,
                  material: { world: group.entry.sourceWorldIndex, guid: renderer.material },
                },
              });
              drawBindings.push(materialBindings);
            }
            const vertexBindings: { readonly slot: number; readonly resource: string }[] = [];
            let indexData:
              | { readonly resource: string; readonly format: 'uint16' | 'uint32' }
              | undefined;
            if (renderer.kind === 'mesh') {
              if (mesh === undefined) return err(planFailure());
              const geometryBuffer = `${rendererPrefix}.geometry-buffer`;
              const geometry = `${rendererPrefix}.geometry`;
              const geometryData = particleMeshVerticesCached(mesh);
              if (geometryData.length === 0) return err(planFailure());
              resources.push(
                {
                  kind: 'buffer',
                  name: geometryBuffer,
                  size: geometryData.byteLength,
                  usage: ['vertex'],
                  data: geometryData,
                },
                {
                  kind: 'vertex-data',
                  name: geometry,
                  layout: vertexLayout,
                  buffer: geometryBuffer,
                },
              );
              vertexBindings.push(
                { slot: 0, resource: geometry },
                { slot: 1, resource: vertexData },
              );
              const indexUpload = particleMeshIndices(mesh);
              if (indexUpload !== undefined) {
                const indexBuffer = `${rendererPrefix}.index-buffer`;
                const indices = `${rendererPrefix}.indices`;
                resources.push(
                  {
                    kind: 'buffer',
                    name: indexBuffer,
                    size: indexUpload.byteLength,
                    usage: ['index'],
                    data: indexUpload,
                  },
                  {
                    kind: 'index-data',
                    name: indices,
                    format: indexFormat,
                    buffer: indexBuffer,
                  },
                );
                indexData = { resource: indices, format: indexFormat };
              }
            } else {
              vertexBindings.push({ slot: 0, resource: vertexData });
            }
            if (castsShadow) {
              const shadowProgram = `${rendererPrefix}.shadow-program`;
              const shadowBindings = `${rendererPrefix}.shadow-bindings`;
              resources.push(
                {
                  kind: 'graphics-program',
                  name: shadowProgram,
                  program: {
                    shader: 'forgeax::vfx-render.particles.mesh-shadow',
                    vertexLayout,
                    ...(hasParticleInputs
                      ? { particleInputLanes: preparedInputs.value.lanes }
                      : {}),
                    colorFormats: [],
                    depthFormat: 'depth32float',
                    topology: submesh?.topology ?? 'triangle-list',
                    ...(mesh?.indices === undefined ? {} : { indexFormat }),
                    renderState: { depthWriteEnabled: true, cullMode: 'none' },
                  },
                },
                {
                  kind: 'graphics-bindings',
                  name: shadowBindings,
                  program: shadowProgram,
                  values: { group: 0, runtime: projectionRuntime, instances },
                },
              );
              passes.push({
                kind: 'shadow-caster',
                name: `${rendererPrefix}.shadow`,
                draws: [
                  {
                    program: shadowProgram,
                    bindings: [shadowBindings],
                    vertexData: vertexBindings,
                    ...(indexData === undefined ? {} : { indexData }),
                    draw: {
                      kind: indexData === undefined ? 'draw-indirect' : 'draw-indexed-indirect',
                      resource: viewIndirect,
                      offset: rendererIndex * 20,
                    },
                  },
                ],
              });
            }
            (renderState?.blend === undefined ? work.opaque : work.blended).push({
              kind: 'raster',
              enabled: visible,
              name: `${rendererPrefix}.raster`,
              colorAttachments: [
                {
                  target: colorTarget?.name ?? 'swapchain',
                  loadOp: 'load',
                  storeOp: 'store',
                },
              ],
              ...(depthTarget === undefined
                ? {}
                : {
                    depthStencilAttachment: {
                      target: depthTarget.name,
                      depthLoadOp: 'load',
                      depthStoreOp: 'store',
                    },
                  }),
              ...(sceneDepthBinding !== undefined && depthTarget !== undefined
                ? {
                    sampledTargets: [depthTarget.name],
                    ...(sceneDepthVersion === undefined ? {} : { sceneDepth: sceneDepthVersion }),
                  }
                : {}),
              draws: [
                {
                  program: graphicsProgram,
                  bindings: drawBindings,
                  vertexData: vertexBindings,
                  ...(indexData === undefined ? {} : { indexData }),
                  draw: {
                    kind: indexData === undefined ? 'draw-indirect' : 'draw-indexed-indirect',
                    resource: viewIndirect,
                    offset: rendererIndex * 20,
                  },
                },
              ],
            });
          }
        }
        resourceRanges.push({
          key: group.key,
          starts: resourceStarts,
          ends: resourceArrays.map((array) => array.length),
        });
      }

      // Programs own storage, not execution order. Reorder complete tick blocks
      // only when a stream switches programs in this plan. Other stream slots
      // and the ordinary same-program compute chain retain their original order.
      let replacements: Map<number, { end: number; passes: readonly PlanPass[] }> | undefined;
      for (const stream of streams.values()) {
        if (stream.ranges === undefined) continue;
        const ordered = [...stream.ranges].sort((left, right) => left.sequence - right.sequence);
        if (ordered.every((range, index) => range === stream.ranges?.[index])) continue;
        for (const [index, range] of stream.ranges.entries()) {
          const replacement = ordered[index];
          if (replacement === undefined) continue;
          replacements ??= new Map();
          replacements.set(range.start, {
            end: range.end,
            passes: passes.slice(replacement.start, replacement.end),
          });
        }
      }
      if (replacements !== undefined) {
        const ordered: PlanPass[] = [];
        for (let index = 0; index < passes.length; ) {
          const replacement = replacements.get(index);
          if (replacement === undefined) {
            ordered.push(passes[index] as PlanPass);
            index++;
          } else {
            ordered.push(...replacement.passes);
            index = replacement.end;
          }
        }
        passes.splice(0, passes.length, ...ordered);
      }

      // Preserve each group's original resource dependency order while keeping
      // group declarations stable through queued/retained churn. View passes
      // retain authored stream order for premultiplied-alpha composition.
      const orderedRanges = [...resourceRanges].sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
      if (!orderedRanges.every((range, index) => range === resourceRanges[index])) {
        for (const [arrayIndex, array] of resourceArrays.entries()) {
          const original = [...array];
          let destination = 0;
          for (const range of orderedRanges)
            for (
              let index = range.starts[arrayIndex] as number;
              index < (range.ends[arrayIndex] as number);
              index++
            )
              array[destination++] = original[index] as PlanResource;
        }
      }

      if (resetZeroBytes > 0)
        resources.push({
          kind: 'buffer',
          name: resetZero,
          size: resetZeroBytes,
          usage: ['copy-src'],
        });

      // All emitters share each view's color/depth targets. Finish projection
      // and opaque coverage before blending, regardless of Player spawn order.
      // Keep authored ordering within each group and GPU particle sorting intact.
      for (const work of viewWork)
        work.passes.push(
          ...coalesceVfxRasterPasses(work.opaque, 'opaque'),
          ...coalesceVfxRasterPasses(work.blended, 'blended'),
        );

      const allPasses = [...passes, ...viewWork.flatMap((work) => work.passes)];
      const observation = Object.freeze({
        frameNumber: frame.frameNumber,
        dispatches: allPasses.reduce(
          (count, pass) =>
            count +
            (pass.kind === 'compute' && pass.enabled !== false
              ? pass.dispatches.reduce(
                  (total, dispatch) =>
                    total +
                    Number(dispatch.kind === 'indirect' || !dispatch.workgroups.includes(0)),
                  0,
                )
              : 0),
          0,
        ),
        indirectDraws: allPasses.reduce(
          (count, pass) =>
            count +
            (pass.kind === 'raster' && pass.enabled !== false
              ? pass.draws.filter(
                  (draw) =>
                    draw.enabled !== false &&
                    (draw.draw.kind === 'draw-indirect' ||
                      draw.draw.kind === 'draw-indexed-indirect'),
                ).length
              : 0),
          0,
        ),
        subjectOutputs: allPasses.reduce(
          (count, pass) =>
            pass.kind === 'raster' && pass.enabled !== false
              ? count + pass.draws.filter((draw) => draw.enabled !== false).length
              : count,
          0,
        ),
      });
      pendingFrames.set(frame.frameNumber, {
        entries: frame.worlds.map((entry) => ({
          source: entry,
          generation: context.generation,
          outcomes:
            outcomesByEntry.get(entry) ??
            entry.intents.map((intent) => ({ intent, state: 'deferred' as const })),
          observation,
          requiredPasses: passes.filter((pass) => pass.enabled !== false).map((pass) => pass.name),
        })),
        fields: [...fieldNames],
        generation: context.generation,
      });
      const sourceFeedback = frame.worlds.map((entry) => ({
        runtimeId: entry.runtimeId,
        renderGeneration: entry.renderGeneration,
        visibility: [...entry.emitterState.values()].map((state) => ({
          player: state.player,
          emitter: state.emitter.id,
          visible: entry.views.some((view) =>
            emitterVisible(state.emitter, view.camera, state.localToWorld),
          ),
        })),
        acknowledged: (outcomesByEntry.get(entry) ?? [])
          .filter((row) => row.state !== 'deferred')
          .map((row) => row.intent.sequence),
        published: (outcomesByEntry.get(entry) ?? [])
          .filter((row) => row.state === 'dispatched')
          .map((row) => row.intent.sequence),
      }));
      return ok<RenderFeaturePlan>({
        work: [
          { scope: 'frame', resources: [...sharedDataInterfaces.values(), ...resources], passes },
          ...viewWork.map(({ view, resources, passes }) => ({
            scope: { view: view.identity },
            resources,
            passes,
          })),
        ],
        sourceFeedback,
      });
    },
    onFrameSubmitted: (frame, submission?: RenderFeatureSubmission) => {
      const pending = pendingFrames.get(frame.frameNumber);
      if (pending === undefined) return;
      pendingFrames.delete(frame.frameNumber);
      if (submission !== undefined) {
        const executed = submission.works.find((work) => work.scope === 'frame');
        const names = new Set(executed?.passes.map((pass) => pass.name));
        if (
          executed === undefined ||
          pending.entries.some((entry) => entry.requiredPasses.some((name) => !names.has(name)))
        )
          return;
      }
      const live = new Set(pending.fields);
      for (const name of uploadedFields.keys()) if (!live.has(name)) uploadedFields.delete(name);
      for (const name of pending.fields) uploadedFields.set(name, pending.generation);
      for (const entry of pending.entries) {
        const state = runtimeState(entry.source.runtimeId);
        state.submittedDeviceGeneration = entry.generation;
        // A deferred provider or target is an ordered barrier for its own
        // player/emitter stream. Other streams may still have terminal work in
        // this frame, so acknowledge those exact sequences without dropping
        // the deferred intents that must retry later.
        for (const outcome of entry.outcomes) {
          if (outcome.state === 'deferred') continue;
          state.submitted?.terminal.set(outcome.intent.sequence, outcome.state);
        }
      }
      const planned = pending.entries[0]?.observation;
      if (planned === undefined) {
        // A valid frame may have no attached worlds.  Publish that empty
        // submission so inspection cannot retain a detached world's receipt.
        lastObservation = Object.freeze({
          frameNumber: frame.frameNumber,
          dispatches: 0,
          indirectDraws: 0,
          subjectOutputs: 0,
        });
      } else {
        lastObservation =
          submission === undefined
            ? planned
            : Object.freeze({
                frameNumber: frame.frameNumber,
                dispatches: submission.works
                  .flatMap((work) => work.passes)
                  .reduce(
                    (count, pass) => count + (pass.resolvedGpuCompute?.dispatches.length ?? 0),
                    0,
                  ),
                indirectDraws: submission.works
                  .flatMap((work) => work.passes)
                  .reduce(
                    (count, pass) =>
                      count +
                      (pass.shadowCaster === true || pass.graphics === undefined
                        ? 0
                        : pass.graphics.draws.filter(
                            (draw) =>
                              draw.kind === 'draw-indirect' ||
                              draw.kind === 'draw-indexed-indirect',
                          ).length),
                    0,
                  ),
                subjectOutputs: submission.works
                  .flatMap((work) => work.passes)
                  .reduce(
                    (count, pass) =>
                      count +
                      (pass.shadowCaster === true || pass.graphics === undefined
                        ? 0
                        : pass.graphics.draws.length),
                    0,
                  ),
              });
      }
    },
    onSourceFrameSubmitted: (frame, feedback) => {
      if (!Array.isArray(feedback)) return;
      for (const row of feedback as {
        runtimeId: number;
        renderGeneration: number;
        acknowledged: number[];
        published: number[];
        visibility: { player: EntityHandle; emitter: string; visible: boolean }[];
      }[]) {
        const source = frame.worlds.find((entry) => entry.runtimeId === row.runtimeId);
        const runtime = sourceRuntimes.get(row.runtimeId);
        if (
          source === undefined ||
          runtime === undefined ||
          runtime.renderGeneration !== row.renderGeneration
        )
          continue;
        for (const visibility of row.visibility)
          runtime.setEmitterCameraVisibility(
            visibility.player,
            visibility.emitter,
            visibility.visible,
          );
        const published = new Set(row.published);
        for (const intent of source.intents)
          if (published.has(intent.sequence))
            runtime.markEventDispatched(intent.player, intent.eventCounters);
        if (row.acknowledged.length > 0) runtime.commit(row.acknowledged, row.published);
      }
    },
    onFrameAborted: (frame) => {
      pendingFrames.delete(frame.frameNumber);
    },
    inspect: () => lastObservation,
  };
  return feature;
}
