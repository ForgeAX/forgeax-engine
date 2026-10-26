import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type {
  RenderFeature,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeatureSceneSdfDescriptor,
  RenderFeatureSubmission,
} from '@forgeax/engine-render';
import { MeshFilter } from '@forgeax/engine-render';
import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '@forgeax/engine-render/internal';
import { GlobalTransform } from '@forgeax/engine-scene';
import {
  err,
  type MaterialAsset,
  type MaterialSceneDepth,
  type MeshAsset,
  ok,
  type Result,
  type TextureAsset,
} from '@forgeax/engine-types';
import type {
  ParticleRendererSourceV3,
  VfxDataInterfaceResource,
  VfxDataInterfaceToken,
  VfxForceFieldError,
} from '@forgeax/engine-vfx';
import {
  buildVfxRecoveryIntents,
  isParticleTopologyRenderer,
  isVfxFieldTransform,
  ParticleEffectPlayer,
  type VfxGpuTickIntent as SourceVfxGpuTickIntent,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_STRIDE,
  type VfxGpuEffectAsset,
  type VfxGpuEmitterSource,
  type VfxGpuRuntime,
  vfxForceFieldFailure,
} from '@forgeax/engine-vfx';
import { RenderFeatureStageFailedError } from '../../../render/src/errors/render';
import type { RenderFeatureGpuProgramDescriptor } from '../../../render/src/features/prepared-gpu-work';
import type { VfxDataInterfaceRegistry } from '../host/data-interface-providers.js';
import {
  compileVfxComputeBatchProgram,
  type VfxComputeBatchProgram,
} from './batched-compute-program.js';
import type { ParticleRenderCamera, ParticleRenderCameraSource } from './camera.js';
import { createVfxDirectComputeFrame } from './direct-compute-frame.js';
import {
  createVfxEmitterProgramOwner,
  emitterComputeProgram,
  reflectedDataInterfaceRequirements,
  simulationDispatches,
  WORKGROUP_SIZE,
} from './emitter-program.js';
import { createEmitterVisibility } from './emitter-visibility.js';
import {
  encodeEventBuffer,
  eventCapacity,
  eventInputCapacity,
  VFX_EVENT_BYTES,
  VFX_EVENT_INPUT_BYTES,
} from './event-resources.js';
import { createVfxForceFieldPreparation, type PreparedVfxForceFields } from './force-fields.js';
import { submittedObservation, type VfxRenderObservation } from './inspect.js';
import { createVfxInstanceArena, type VfxArenaInstance } from './instance-arena.js';
import {
  adoptSubmittedRetained,
  createQueuedIntentResolution,
  createRecentQueuedIntents,
  createVfxIntentPayloads,
  createVfxIntentPublication,
  isVfxIntentReference,
  publishQueuedIntents,
  resolveRetainedIntent,
  retainedStreamKey,
  type VfxIntentReference,
} from './intent-publication.js';
import { type ParticleMaterialSource, projectParticleMaterial } from './material-source.js';
import {
  createTopologyResourcePlan,
  PARTICLE_INPUT_SHADER_IDENTIFIERS,
  PARTICLE_SHADER_IDENTIFIERS,
  PARTICLE_UNLIT_MESH_SHADER_IDENTIFIERS,
  particleMaterialPass,
  particleMaterialSceneDepthBinding,
  particleMaterialUsesBindings,
  particleMeshIndices,
  particleMeshVerticesCached,
  particleRendererRenderState,
  prepareParticleMaterialInputs,
} from './particle-resources.js';
import {
  BILLBOARD_INSTANCE_BYTES,
  batchStorageSizes,
  COUNTERS_BYTES,
  type ComputeDispatch,
  coalesceComputeWork,
  compareSharedDeclarations,
  computeBindingEntries,
  createInterner,
  fieldBufferName,
  MESH_INSTANCE_BYTES,
  maxRendererInputBytes,
  meshDrawRange,
  NO_DATA_INTERFACES,
  type ParticleVertexLayout,
  type PlanPass,
  type PlanResource,
  particleInstanceBytes,
  particleVertexLayout,
  planName,
  preparedDataInterfaceResource,
  projectionDispatches,
  type RasterDraw,
  type RasterPass,
  type RendererOwnedDataInterface,
  rendererIndirectWords,
  requiredRange,
  sharedDataInterfaceResource,
  vertexLayoutId,
  viewBindingValues,
} from './plan-declarations.js';
import {
  type BindingValues,
  directProjectionRows,
  directSimulationRanges,
  type GraphicsProgramDescriptor,
  graphicsProgramDescriptor,
  materialBindingValues,
  NO_COPIES,
  particleBindingValues,
  planObservation,
  STORAGE_USAGE,
  sameEntries,
  simulationEntries,
} from './plan-memos.js';
import {
  compareKeys,
  type GroupDeclarationRanges,
  type KeyedDeclarationRanges,
  remapTickPassRanges,
  reorderStreamTickBlocks,
  restoreGroupDeclarationOrder,
  sortGroupDeclarations,
  type TickPassRange,
} from './plan-order.js';
import { coalesceVfxRasterPasses } from './raster-passes.js';
import {
  type RetainedEmitterResources,
  retainEmitterResources,
  retainProjectionResources,
  uploadEmitterResource,
} from './retained-emitter-resources.js';
import { createRuntimeStorage, RUNTIME_BYTES, runtimeData } from './runtime-uniform.js';
import { shareVfxGraphicsPrograms, vfxGraphicsProgramKey } from './shared-graphics-programs.js';
import type { VfxValidatedStagePlan } from './stage-plan.js';
import { validatedStagePlan } from './stage-plan.js';

const IDENTITY = 'forgeax.vfx-render.gpu-particles';
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ParticleRenderer = ParticleRendererSourceV3;

export {
  type BillboardAdvancedSample,
  createVfxRenderInspectSnapshot,
  resolveBillboardAdvancedState,
  topologyRecoveryHint,
  type VfxRenderInspectInput,
  type VfxRenderObservation,
} from './inspect.js';

interface GpuParticleFeatureOptions {
  readonly camera: ParticleRenderCameraSource;
  /** Same-build diagnostic A/B. Opt in to validated view-local graph isolation. */
  readonly isolateViewGraph?: boolean;
  /** Diagnostic opt-in until the complete instance-arena owner is qualified. */
  readonly instanceArenas?: boolean;
  /** Build a Host-private primary plan instead of publishing a raw declaration tree. */
  readonly nativePlanning?: boolean;
  /** Reuse admitted native resources; requires native planning and instance arenas. */
  readonly retainedResources?: boolean;
  readonly sceneSdf?: { read(world: World): RenderFeatureSceneSdfDescriptor | undefined };
  readonly dataInterfaces?: Pick<VfxDataInterfaceRegistry, 'resolve'>;
  readonly material?: ParticleMaterialSource;
  readonly mesh?: {
    read(
      world: World,
      guid: string | import('@forgeax/engine-types').AssetHandle<'mesh'>,
    ): MeshAsset | undefined;
  };
  readonly playerConsumption?: {
    readonly isEnabled: (world: World, player: EntityHandle) => boolean;
  };
}

interface ExtractedMaterial {
  readonly asset: MaterialAsset;
  readonly projection?: MaterialRenderProjection;
}

interface ExtractedEmitterState {
  readonly forceFields?: Result<PreparedVfxForceFields, VfxForceFieldError>;
  readonly enabled: boolean;
  readonly preparePipelines?: boolean;
  readonly prepareOnly?: boolean;
  readonly programFingerprint?: string;
  readonly instanceGeneration?: number;
  readonly localToWorld: Float32Array;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuTickIntent['emitter'];
}

export interface ExtractedWorld {
  readonly sourceWorldIndex: number;
  readonly sceneSdf?: RenderFeatureSceneSdfDescriptor;
  readonly worldId: number;
  readonly runtimeId: number;
  readonly renderGeneration: number;
  readonly emitterState: ReadonlyMap<string, ExtractedEmitterState>;
  readonly materials: ReadonlyMap<ParticleRenderer['material'], ExtractedMaterial>;
  readonly meshes: ReadonlyMap<string | number, MeshAsset>;
  readonly camera: ParticleRenderCamera;
  readonly views: readonly { readonly identity: string; readonly camera: ParticleRenderCamera }[];
  readonly intents: readonly VfxGpuTickIntent[];
  /** Current paused preparation owns the player, including obsolete queued emitter IDs. */
  readonly preparationPlayers?: readonly EntityHandle[];
  /**
   * Last submitted emitter state kept drawable between ticks.  The queue
   * above is simulation work only; a paused, culled or deferred emitter has
   * no tick this frame and must keep its projection/raster lease warm.
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
export type VfxGpuTickIntent = Omit<SourceVfxGpuTickIntent, 'effect' | 'forceFields'> & {
  readonly forceFields?: Result<PreparedVfxForceFields, VfxForceFieldError>;
};

interface ExtractedFrame {
  readonly worlds: readonly ExtractedWorld[];
  readonly frameNumber: number;
}

/** Source frames carry exact resource identities, never immutable program bodies. */
type PublishedEmitter = { readonly effect: number; readonly revision: number; readonly id: string };
type PublishedIntent = Omit<SourceVfxGpuTickIntent, 'effect' | 'emitter'> & {
  readonly emitter: PublishedEmitter;
};
type PublishedEmitterState = Omit<ExtractedEmitterState, 'emitter' | 'forceFields'> & {
  readonly forceFields?: SourceVfxGpuTickIntent['forceFields'];
  readonly emitter: PublishedEmitter;
};
type PublishedWorld = Omit<ExtractedWorld, 'emitterState' | 'intents' | 'retained' | 'meshes'> & {
  readonly meshes: ReadonlyMap<string | number, MeshAsset | number>;
  readonly emitterState: ReadonlyMap<string, PublishedEmitterState>;
  readonly intents: readonly (PublishedIntent | VfxIntentReference<PublishedIntent>)[];
  /**
   * A retained row carries its intent only until a submitted frame proved the
   * receiver adopted that sequence; afterwards it names the sequence and the
   * plan reuses its cached copy. A missing copy is reported and resent.
   */
  readonly retained: readonly (Omit<RetainedEmitter, 'emitter' | 'intent'> & {
    readonly emitter: PublishedEmitter;
    readonly intentSequence: number;
    readonly intent?: PublishedIntent;
  })[];
};
interface PublishedFrame {
  readonly worlds: readonly PublishedWorld[];
  readonly frameNumber: number;
}

const immutableEmitters = new WeakSet<object>();
const fixedEmitters = new WeakMap<object, VfxGpuTickIntent['emitter']>();

function ownEmitter(source: VfxGpuTickIntent['emitter']): VfxGpuTickIntent['emitter'] {
  let emitter = fixedEmitters.get(source);
  if (emitter === undefined) {
    emitter = ownRenderFeatureProgramData(source);
    fixedEmitters.set(source, emitter);
    if (isOwnedRenderFeatureProgramData(emitter)) immutableEmitters.add(emitter);
  }
  return emitter;
}

/** Facts derived only from an immutable emitter program, computed once per program. */
const eventEmitters = new WeakMap<object, boolean>();
function emitterHasEvents(emitter: VfxGpuTickIntent['emitter']): boolean {
  const immutable = immutableEmitters.has(emitter);
  const cached = immutable ? eventEmitters.get(emitter) : undefined;
  if (cached !== undefined) return cached;
  const value =
    (emitter.reflection.resources ?? []).includes('eventBuffer') ||
    (emitter.reflection.entryPoints ?? []).includes('forgeax_vfx_event_main') ||
    (emitter.reflection.bindings[0]?.entries ?? []).some((entry) => entry.binding === 8);
  if (immutable) eventEmitters.set(emitter, value);
  return value;
}
const stagePlans = new WeakMap<object, Map<number, ReturnType<typeof validatedStagePlan>>>();
function emitterStagePlan(
  emitter: VfxGpuTickIntent['emitter'],
  generation: number,
): ReturnType<typeof validatedStagePlan> {
  if (!immutableEmitters.has(emitter))
    return validatedStagePlan(emitter.reflection.stages, generation);
  let plans = stagePlans.get(emitter);
  if (plans === undefined) {
    plans = new Map();
    stagePlans.set(emitter, plans);
  }
  let plan = plans.get(generation);
  if (plan === undefined) {
    plan = validatedStagePlan(emitter.reflection.stages, generation);
    // Instance generations advance with recovery; keep the latest few only.
    if (plans.size >= 4) plans.clear();
    plans.set(generation, plan);
  }
  return plan;
}

function resolveEffect(
  reference: PublishedEmitter,
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
): VfxGpuEffectAsset {
  const resolved = context.resolveAsset?.(sourceWorldIndex, reference.effect, reference.revision);
  if (resolved === undefined) throw new Error('VFX requires the feature asset resolver');
  if (!resolved.ok) throw resolved.error;
  const effect = resolved.value as VfxGpuEffectAsset;
  if (effect.kind !== 'particle-effect' || effect.schemaVersion !== 3)
    throw new Error('VFX requires a schemaVersion 3 particle effect');
  return effect;
}

function resolveEmitter(
  reference: PublishedEmitter,
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
) {
  const effect = resolveEffect(reference, sourceWorldIndex, context);
  const emitter = effect.program.emitters.find((candidate) => candidate.id === reference.id);
  if (emitter === undefined) throw new Error(`Missing VFX emitter ${reference.id}`);
  if (isOwnedRenderFeatureProgramData(effect)) {
    immutableEmitters.add(emitter);
    return { effect, emitter };
  }
  return { effect, emitter: ownEmitter(emitter) };
}

function resolveFields(
  emitter: VfxGpuTickIntent['emitter'],
  input: SourceVfxGpuTickIntent['forceFields'],
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
  prepare: ReturnType<typeof createVfxForceFieldPreparation>,
): Result<PreparedVfxForceFields, VfxForceFieldError> | undefined {
  if (emitter.forceFields === undefined) return undefined;
  if (input === undefined)
    return vfxForceFieldFailure('vfx-field-asset-missing', 'forceFields', 'tick inputs');
  if (!input.ok) return input;
  const textures: {
    handle: number;
    revision: number;
    value: TextureAsset;
    delta?: import('@forgeax/engine-assets-runtime/internal').AssetVersionDelta;
  }[] = [];
  for (const reference of input.value) {
    const asset = context.resolveAsset?.(sourceWorldIndex, reference.handle, reference.revision);
    if (!asset?.ok || asset.value.kind !== 'texture')
      return vfxForceFieldFailure(
        'vfx-field-asset-missing',
        'forceFields.texture',
        'a retained exact Texture version',
      );
    textures.push({ ...reference, value: asset.value });
  }
  return prepare(emitter.forceFields, textures);
}

function resolveIntent(
  intent: PublishedIntent,
  sourceWorldIndex: number,
  context: RenderFeaturePlanContext,
  prepare: ReturnType<typeof createVfxForceFieldPreparation>,
): VfxGpuTickIntent {
  const definition = resolveEmitter(intent.emitter, sourceWorldIndex, context);
  if (definition.effect.program.fingerprint !== intent.programFingerprint)
    throw new Error('VFX intent and exact effect fingerprint differ');
  const forceFields = resolveFields(
    definition.emitter,
    intent.forceFields,
    sourceWorldIndex,
    context,
    prepare,
  );
  const { forceFields: _input, ...tick } = intent;
  return { ...tick, ...definition, ...(forceFields === undefined ? {} : { forceFields }) };
}

function resolveDataInterfaces(
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'instanceGeneration'>,
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

/** Zero source shared by every reset copy of one plan. */
const RESET_ZERO = 'vfx.reset-zero';

/** Emitters without data-interface or force-field providers own no per-frame provider resources. */
function emitterHasNoProviders(emitter: VfxGpuTickIntent['emitter']): boolean {
  return (
    (emitter.reflection.dataInterfaces?.length ?? 0) === 0 && emitter.forceFields === undefined
  );
}

/** Immutable provider-free emitters may retain bindings, storage and native plans across frames. */
function isRetainableEmitter(emitter: VfxGpuTickIntent['emitter']): boolean {
  return immutableEmitters.has(emitter) && emitterHasNoProviders(emitter);
}

/** A paused or culled tick is skipped, but a reset waits and blocks the rest of its stream. */
function holdIntent(
  intent: Pick<VfxGpuTickIntent, 'reset'>,
  baseKey: string,
  blockedEmitters: Set<string>,
): 'skipped' | 'deferred' {
  if (!intent.reset) return 'skipped';
  blockedEmitters.add(baseKey);
  return 'deferred';
}

/** Largest per-particle material input stride among an emitter's renderers. */
type VfxParticleRenderFeature = RenderFeature<PublishedFrame> & {
  readonly inspect: () => VfxRenderObservation;
};

export function gpuParticleRenderFeature(
  options: GpuParticleFeatureOptions,
): VfxParticleRenderFeature {
  const packArenas = options.instanceArenas === true ? createVfxInstanceArena() : undefined;
  type IntentOutcomeState = 'dispatched' | 'skipped' | 'deferred';
  interface PlannedIntent {
    readonly intent: VfxGpuTickIntent;
    readonly localToWorld: Float32Array;
    readonly stagePlan: VfxValidatedStagePlan;
    /** Camera projection is optional for `simulationWhenCulled: continue`. */
    readonly visible: boolean;
    /** Retained state has no tick simulation/history work this frame. */
    readonly retained: boolean;
  }
  interface EmitterStream {
    lastGroup: string;
    /** Only program changes in this plan need command-order reconciliation. */
    ranges: TickPassRange[] | undefined;
  }
  interface EmitterPreparation {
    readonly forceFields?: Result<PreparedVfxForceFields, VfxForceFieldError>;
    readonly player: EntityHandle;
    readonly emitter: VfxGpuTickIntent['emitter'];
    readonly programFingerprint: string;
    readonly instanceGeneration: number;
    readonly localToWorld: Float32Array;
  }
  interface EmitterGroup {
    readonly key: string;
    readonly record: StreamRecord;
    readonly program: ProgramRecord;
    readonly entry: ExtractedWorld;
    readonly intents: PlannedIntent[];
    readonly preparation?: EmitterPreparation;
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
    /** False when a retained stream was missing, so its device state was not rebuilt. */
    readonly rebuilt: boolean;
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
    readonly emitters: Map<string, EmitterResourceState>;
    /** Plan-side resolution owned by this runtime; see `planResolver`. */
    resolution: ResolutionCache | undefined;
    /** Interned stream names owned by this runtime; see `streamKeys`. */
    keys: StreamKeyCache | undefined;
  }
  interface EmitterResourceState {
    readonly id: number;
    tickCapacity: number;
    resources?: RetainedEmitterResources;
    /** Last plan serial that referenced this stream program. */
    seen: number;
  }
  /** Names derived from one group prefix. Built once per stream program. */
  interface GroupNames {
    readonly particles: string;
    readonly aliveIndices: string;
    readonly counters: string;
    readonly indirect: string;
    readonly indirectInitial: string;
    readonly scratch: string;
    readonly sharedInstances: string;
    readonly projectionEventInputs: string;
    readonly custom: string;
    readonly parameters: string;
    readonly privateProgram: string;
    readonly viewPrefix: string;
    readonly ticks: TickNames[];
    readonly renderers: RendererNames[];
  }
  interface TickNames {
    readonly prefix: string;
    readonly runtime: string;
    readonly eventInputs: string;
    readonly bindings: string;
    readonly parameters: string;
    readonly reset: string;
    readonly simulate: string;
    readonly history: {
      readonly runtime: string;
      readonly bindings: string;
      readonly write: string;
    }[];
  }
  interface RendererNames {
    /** Frame-scope trail history owned by the simulation. */
    readonly history: string;
    readonly view: {
      readonly prefix: string;
      readonly instances: string;
      readonly aliveIndices: string;
      readonly indirect: string;
      readonly counters: string;
      readonly history: string;
      readonly runtime: string;
      readonly computeBindings: string;
      readonly copy: string;
      readonly project: string;
      readonly graphicsProgram: string;
      readonly graphicsBindings: string;
      readonly vertexData: string;
      readonly shadowProgram: string;
      readonly shadowBindings: string;
      readonly shadow: string;
      readonly raster: string;
      readonly materialBindings: Map<number, string>;
      /** Last graphics program descriptor per view; reused while its inputs match. */
      readonly graphics: Map<string, ViewGraphicsProgram>;
      /** Last frozen binding values per view and role; reused while they match. */
      readonly bindingValues: Map<string, BindingValues>;
    };
  }
  /**
   * One renderer view's last graphics program descriptor, with the content
   * key that names the view-shared program declaration (undefined when the
   * render state is not plain data and the declaration stays private).
   */
  interface ViewGraphicsProgram {
    readonly descriptor: GraphicsProgramDescriptor;
    readonly shared: string | undefined;
  }
  /** One plan view's shared graphics declarations for one program content key. */
  interface SharedViewProgram {
    /** Graphics bindings name per scene-depth binding slot (view/light group 0). */
    readonly bindings: Map<0 | 1 | undefined, string>;
    /** Material bindings name per source world and material reference (group 1). */
    readonly materials: Map<number, Map<ParticleRenderer['material'], string>>;
  }
  /** One player/emitter program group: its plan key and persistent storage owner. */
  interface ProgramRecord {
    readonly key: string;
    readonly resourceKey: string;
    readonly resource: EmitterResourceState;
    names?: GroupNames;
    /** Arena instance per compute-program name; identity-stable for repacking. */
    readonly instances: Map<string, VfxArenaInstance>;
  }
  /** One player/emitter stream in one runtime render generation. */
  interface StreamRecord {
    readonly player: number;
    readonly emitterId: string;
    readonly stateKey: string;
    readonly baseKey: string;
    readonly streamKey: string;
    readonly programs: Map<string, ProgramRecord>;
    readonly owners: Map<string, string>;
    /** Last plan serial that referenced this stream. */
    seen: number;
  }
  interface StreamKeyCache {
    readonly worldId: number;
    readonly renderGeneration: number;
    readonly groupPrefix: string;
    readonly players: Map<number, Map<string, StreamRecord>>;
  }
  /**
   * Published frames cross a structured-clone boundary, so nothing in them is
   * identity-stable. Resolution is keyed by exact values instead: effect
   * handle/revision (validated against the resolver's current object), emitter
   * id and intent sequence. A queued intent is immutable for its sequence
   * within one renderGeneration; device or render generation changes discard
   * the whole cache, and entries absent from a frame retire immediately.
   */
  interface ResolvedEffect {
    readonly effect: VfxGpuEffectAsset;
    readonly emitters: Map<string, VfxGpuTickIntent['emitter']>;
    seen: number;
  }
  interface ResolvedIntent {
    readonly effect: VfxGpuEffectAsset;
    readonly intent: VfxGpuTickIntent;
    seen: number;
  }
  interface ResolutionCache {
    readonly renderGeneration: number;
    readonly device: number;
    serial: number;
    readonly effects: Map<number, Map<number, ResolvedEffect>>;
    readonly intents: Map<number, ResolvedIntent>;
  }
  const planResolver = (
    state: RuntimeState,
    renderGeneration: number,
    sourceWorldIndex: number,
    context: RenderFeaturePlanContext,
  ) => {
    let cache = state.resolution;
    if (cache?.renderGeneration !== renderGeneration || cache.device !== context.generation) {
      cache = {
        renderGeneration,
        device: context.generation,
        serial: 0,
        effects: new Map(),
        intents: new Map(),
      };
      state.resolution = cache;
    }
    const serial = ++cache.serial;
    const { effects, intents } = cache;
    const effectFor = (reference: PublishedEmitter): ResolvedEffect => {
      let revisions = effects.get(reference.effect);
      if (revisions === undefined) {
        revisions = new Map();
        effects.set(reference.effect, revisions);
      }
      let resolved = revisions.get(reference.revision);
      // Ask the resolver once per exact version per frame; reuse derived rows
      // only while it still returns the same immutable effect object.
      if (resolved?.seen === serial) return resolved;
      const effect = resolveEffect(reference, sourceWorldIndex, context);
      if (resolved?.effect !== effect) {
        resolved = { effect, emitters: new Map(), seen: serial };
        revisions.set(reference.revision, resolved);
      }
      resolved.seen = serial;
      return resolved;
    };
    const emitter = (reference: PublishedEmitter): VfxGpuTickIntent['emitter'] => {
      const resolved = effectFor(reference);
      let emitter = resolved.emitters.get(reference.id);
      if (emitter === undefined) {
        const candidate = resolved.effect.program.emitters.find((row) => row.id === reference.id);
        if (candidate === undefined) throw new Error(`Missing VFX emitter ${reference.id}`);
        if (isOwnedRenderFeatureProgramData(resolved.effect)) {
          immutableEmitters.add(candidate);
          emitter = candidate;
        } else emitter = ownEmitter(candidate);
        resolved.emitters.set(reference.id, emitter);
      }
      return emitter;
    };
    const intent = (
      published: PublishedIntent | VfxIntentReference<PublishedIntent>,
    ): VfxGpuTickIntent | undefined => {
      const resolved = effectFor(published.emitter);
      const definition = { effect: resolved.effect, emitter: emitter(published.emitter) };
      if (definition.effect.program.fingerprint !== published.programFingerprint)
        throw new Error('VFX intent and exact effect fingerprint differ');
      // Field inputs carry per-tick texture versions; they keep exact resolution.
      if (definition.emitter.forceFields !== undefined && !isVfxIntentReference(published))
        return resolveIntent(published, sourceWorldIndex, context, prepareFields);
      const prior = intents.get(published.sequence);
      if (
        prior !== undefined &&
        prior.effect === definition.effect &&
        prior.intent.emitter === definition.emitter &&
        prior.intent.player === published.player &&
        prior.intent.programFingerprint === published.programFingerprint
      ) {
        prior.seen = serial;
        return prior.intent;
      }
      // A payload-free reference needs this receiver's cached copy of its sequence.
      if (isVfxIntentReference(published)) return undefined;
      const { forceFields: _input, ...tick } = published;
      const resolvedIntent: VfxGpuTickIntent = { ...tick, ...definition };
      intents.set(published.sequence, {
        effect: definition.effect,
        intent: resolvedIntent,
        seen: serial,
      });
      return resolvedIntent;
    };
    /** Retire every row this frame did not reference. */
    const finish = () => {
      for (const [sequence, row] of intents) if (row.seen !== serial) intents.delete(sequence);
      for (const [handle, revisions] of effects) {
        for (const [revision, row] of revisions)
          if (row.seen !== serial) revisions.delete(revision);
        if (revisions.size === 0) effects.delete(handle);
      }
    };
    return { emitter, intent, finish };
  };
  const runtimeStates = new Map<number, RuntimeState>();
  const emitterPrograms = createVfxEmitterProgramOwner(
    immutableEmitters,
    emitterComputeProgram,
    compileVfxComputeBatchProgram,
  );
  const computeProgramIds = new WeakMap<object, number>();
  let nextComputeProgramId = 0;
  type ComputeBindings = Extract<PlanResource, { readonly kind: 'compute-bindings' }>;
  // Only plain logical bindings survive a plan. Uploads, providers, and GPU
  // references keep their ordinary per-frame ownership and validation.
  let bindingLayouts = new Map<
    string,
    { readonly emitter: VfxGpuTickIntent['emitter']; readonly resource: ComputeBindings }
  >();
  type StaticBuffer = Extract<PlanResource, { readonly kind: 'buffer' }>;
  let bufferLayouts = new Map<string, StaticBuffer>();
  // Two tables per kind alternate: the previous plan's table stays readable
  // while the other is cleared and refilled, so steady plans grow no tables.
  let spareBindingLayouts: typeof bindingLayouts = new Map();
  let spareBufferLayouts: typeof bufferLayouts = new Map();
  const freshBindingLayouts = (): typeof bindingLayouts => {
    spareBindingLayouts.clear();
    return spareBindingLayouts;
  };
  const runtimeState = (identity: number): RuntimeState => {
    let state = runtimeStates.get(identity);
    if (state === undefined) {
      state = {
        submittedDeviceGeneration: undefined,
        submitted: undefined,
        emitters: new Map(),
        resolution: undefined,
        keys: undefined,
      };
      runtimeStates.set(identity, state);
    }
    return state;
  };
  const sourceRuntimes = new Map<number, VfxGpuRuntime>();
  /** Source ledger: retained intent sequence the receiver adopted, per stream. */
  const adoptedRetained = new Map<string, number>();
  /** Source ledger: queued intent payloads already published, per runtime render session. */
  const intentPublication = createVfxIntentPublication();
  const intentPayloads = createVfxIntentPayloads();
  let receiverSession: string | undefined;
  const recentQueued = createRecentQueuedIntents<PublishedIntent>();
  /** Receiver cache: last published retained intent, per stream. */
  const receivedRetained = new Map<
    string,
    { readonly sequence: number; readonly intent: PublishedIntent }
  >();
  let lastObservation: VfxRenderObservation = Object.freeze({
    frameNumber: -1,
    dispatches: 0,
    indirectDraws: 0,
    subjectOutputs: 0,
  });
  const worldIds = new WeakMap<World, number>();
  const runtimeIds = new WeakMap<VfxGpuRuntime, number>();
  let nextEmitterResourceId = 0;
  /** Plan invocations; ages stream program owners. */
  let planSerial = 0;
  /** Absent streams keep their identity briefly so a short gap does not rename storage. */
  const STREAM_RETENTION_PLANS = 8;
  const emitterResource = (states: RuntimeState['emitters'], key: string) => {
    let state = states.get(key);
    if (state === undefined) {
      state = { id: nextEmitterResourceId++, tickCapacity: 0, seen: planSerial };
      states.set(key, state);
    }
    state.seen = planSerial;
    return state;
  };
  /**
   * Interned per-stream names. Every string here was previously rebuilt for
   * each live intent/retained row on every plan; keeping the same string
   * objects also keeps their hashes warm for every downstream Map lookup.
   */
  const streamKeys = (
    state: RuntimeState,
    world: number,
    renderGeneration: number,
    runtime: number,
  ) => {
    let cache = state.keys;
    if (cache?.worldId !== world || cache.renderGeneration !== renderGeneration) {
      cache = {
        worldId: world,
        renderGeneration,
        groupPrefix:
          `vfx.w-${planName(world.toString(36), 8)}.` +
          `a-${planName(runtime.toString(36), 8)}.` +
          `r-${renderGeneration}.p-`,
        players: new Map(),
      };
      state.keys = cache;
    }
    const keys = cache;
    const stream = (player: EntityHandle, emitterId: string): StreamRecord => {
      const playerId = Number(player);
      let emitters = keys.players.get(playerId);
      if (emitters === undefined) {
        emitters = new Map();
        keys.players.set(playerId, emitters);
      }
      let record = emitters.get(emitterId);
      if (record === undefined) {
        const baseKey = `${world}:${renderGeneration}:${playerId}:${emitterId}`;
        record = {
          player: playerId,
          emitterId,
          stateKey: `${playerId}:${emitterId}`,
          baseKey,
          streamKey: `${runtime}:${baseKey}`,
          programs: new Map(),
          owners: new Map(),
          seen: planSerial,
        };
        emitters.set(emitterId, record);
      }
      record.seen = planSerial;
      return record;
    };
    const program = (record: StreamRecord, fingerprint: string): ProgramRecord => {
      let program = record.programs.get(fingerprint);
      const resourceKey = program?.resourceKey ?? `${record.baseKey}:${fingerprint}`;
      const resource = emitterResource(state.emitters, resourceKey);
      if (program?.resource !== resource) {
        program = {
          key:
            keys.groupPrefix +
            `${planName(record.player.toString(36), 16)}.e-${resource.id.toString(36)}`,
          resourceKey,
          resource,
          instances: new Map(),
        };
        record.programs.set(fingerprint, program);
      }
      return program;
    };
    /** Arena owner of one stream for one compute program name. */
    const owner = (record: StreamRecord, program: string): string => {
      let owner = record.owners.get(program);
      if (owner === undefined) {
        owner = `${runtime}:${renderGeneration}:${record.player}:${record.emitterId}:${program}`;
        record.owners.set(program, owner);
      }
      return owner;
    };
    /** Arena instance of one group for one compute program name. */
    const instance = (
      record: StreamRecord,
      group: ProgramRecord,
      program: string,
    ): VfxArenaInstance => {
      let instance = group.instances.get(program);
      if (instance === undefined) {
        instance = {
          prefix: group.key,
          program: `${program}.a-${runtime}.r-${renderGeneration}`,
          owner: owner(record, program),
        };
        group.instances.set(program, instance);
      }
      return instance;
    };
    return { stream, program, owner, instance };
  };
  /** Forget stream records that aged out with their storage owners in `state.emitters`. */
  const pruneStreamKeys = (state: RuntimeState) => {
    const keys = state.keys;
    if (keys === undefined) return;
    for (const [player, emitters] of keys.players) {
      for (const [id, record] of emitters) {
        for (const [fingerprint, program] of record.programs)
          if (state.emitters.get(program.resourceKey) !== program.resource)
            record.programs.delete(fingerprint);
        if (record.programs.size === 0 && record.seen + STREAM_RETENTION_PLANS < planSerial)
          emitters.delete(id);
      }
      if (emitters.size === 0) keys.players.delete(player);
    }
  };
  const groupNames = (program: ProgramRecord): GroupNames => {
    if (program.names !== undefined) return program.names;
    const prefix = program.key;
    program.names = {
      particles: `${prefix}.particles`,
      aliveIndices: `${prefix}.alive-indices`,
      counters: `${prefix}.counters`,
      indirect: `${prefix}.indirect`,
      indirectInitial: `${prefix}.indirect-initial`,
      scratch: `${prefix}.scratch`,
      sharedInstances: `${prefix}.shared-instances`,
      projectionEventInputs: `${prefix}.projection-event-inputs`,
      custom: `${prefix}.custom`,
      parameters: `${prefix}.parameters`,
      privateProgram: `${prefix}.compute-program`,
      viewPrefix: `${prefix}.view`,
      ticks: [],
      renderers: [],
    };
    return program.names;
  };
  const tickNames = (program: ProgramRecord, tick: number, renderers: number): TickNames => {
    const names = groupNames(program);
    let row = names.ticks[tick];
    if (row === undefined) {
      const prefix = `${program.key}.tick-${tick}`;
      row = {
        prefix,
        runtime: `${prefix}.runtime`,
        eventInputs: `${prefix}.event-inputs`,
        bindings: `${prefix}.simulation-bindings`,
        parameters: `${prefix}.parameters`,
        reset: `${prefix}.reset`,
        simulate: `${prefix}.simulate`,
        history: [],
      };
      names.ticks[tick] = row;
    }
    for (let index = row.history.length; index < renderers; index++) {
      const bindings = `${row.prefix}.renderer-${index}.history-bindings`;
      row.history.push({
        runtime: `${row.prefix}.renderer-${index}.history-runtime`,
        bindings,
        write: `${bindings}.write`,
      });
    }
    return row;
  };
  const rendererNames = (program: ProgramRecord, renderer: number): RendererNames => {
    const names = groupNames(program);
    let row = names.renderers[renderer];
    if (row === undefined) {
      const prefix = `${names.viewPrefix}.renderer-${renderer}`;
      row = {
        history: `${program.key}.renderer-${renderer}.history`,
        view: {
          prefix,
          instances: `${prefix}.instances`,
          aliveIndices: `${prefix}.alive-indices`,
          indirect: `${prefix}.indirect`,
          counters: `${prefix}.counters`,
          history: `${prefix}.history`,
          runtime: `${prefix}.runtime`,
          computeBindings: `${prefix}.compute-bindings`,
          copy: `${prefix}.copy`,
          project: `${prefix}.project`,
          graphicsProgram: `${prefix}.graphics-program`,
          graphicsBindings: `${prefix}.graphics-bindings`,
          vertexData: `${prefix}.vertex-data`,
          shadowProgram: `${prefix}.shadow-program`,
          shadowBindings: `${prefix}.shadow-bindings`,
          shadow: `${prefix}.shadow`,
          raster: `${prefix}.raster`,
          materialBindings: new Map(),
          graphics: new Map(),
          bindingValues: new Map(),
        },
      };
      names.renderers[renderer] = row;
    }
    return row;
  };
  /** Stable small ids for content keys and string sources of shared declaration names. */
  const internedId = createInterner();
  const sharedProgramNames: string[] = [];
  const sharedProgramName = (id: number): string => {
    let name = sharedProgramNames[id];
    if (name === undefined) {
      name = `vfx.compute-program-${id}`;
      sharedProgramNames[id] = name;
    }
    return name;
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
  type StreamKeys = ReturnType<typeof streamKeys>;
  type ResourceCopy = Extract<PlanPass, { kind: 'copy' }>['copies'][number];
  type ComputeProgramResource = Extract<PlanResource, { readonly kind: 'compute-program' }>;
  type NativePlan = ReturnType<NonNullable<RenderFeaturePlanContext['createNativePlan']>>;
  type RetainedArenaFrame = ReturnType<NonNullable<typeof packArenas>['beginRetainedFrame']>;
  type PlanView = RenderFeaturePlanContext['views'][number];
  type PlanTarget = PlanView['targets'][number];
  type RetainedProjection = NonNullable<ReturnType<typeof retainProjectionResources>>;
  /** Ledgers shared by every world resolved from one published frame. */
  interface FrameResolution {
    readonly context: RenderFeaturePlanContext;
    readonly emitterVisible: ReturnType<typeof createEmitterVisibility>;
    /** Retained streams this plan saw, published or cached. */
    readonly liveRetained: Set<string>;
    /** Per runtime, retained streams with neither a published nor a cached intent. */
    readonly missingRetained: Map<number, string[]>;
    /** Per runtime, queued intent references without a cached payload. */
    readonly missingIntents: Map<number, number[]>;
    readonly keys: Map<ExtractedWorld, StreamKeys>;
  }
  interface ViewWork {
    readonly view: PlanView;
    readonly resources: PlanResource[];
    readonly passes: PlanPass[];
    readonly opaque: RasterPass[];
    readonly blended: RasterPass[];
    readonly colorTarget: PlanTarget | undefined;
    readonly depthTarget: PlanTarget | undefined;
    /** Frozen raster attachment state shared by every draw of this view. */
    readonly attachments: {
      readonly color: RasterPass['colorAttachments'];
      readonly depth: RasterPass['depthStencilAttachment'];
      readonly sampled: readonly string[] | undefined;
    };
    /** Mesh geometry declared once per view, keyed by world, mesh source and vertex layout. */
    readonly meshGeometry: Map<string, SharedMeshGeometry>;
    /** Graphics programs and bindings declared once per view, keyed by shared program name. */
    readonly graphics: Map<string, SharedViewProgram>;
    /**
     * View-shared declarations. They belong to no player group, so they are
     * appended in name order after group declarations are sorted: queued and
     * retained players exchanging positions keep one resource topology.
     */
    readonly shared: PlanResource[];
  }
  /** Declarations and ledgers one plan accumulates across its emitter groups. */
  interface FramePlan {
    readonly resolution: FrameResolution;
    readonly frame: ExtractedFrame;
    readonly runtimeScratch: ReturnType<typeof createRuntimeStorage>;
    readonly nativePlan: NativePlan | undefined;
    readonly resourceAdmission: NativePlan['resourceAdmission'];
    /** Opened after stream owners are pruned; undefined when resources are not retained. */
    retainedArena: RetainedArenaFrame | undefined;
    readonly directCompute: ReturnType<typeof createVfxDirectComputeFrame>;
    readonly resources: PlanResource[];
    readonly passes: PlanPass[];
    readonly viewWork: readonly ViewWork[];
    readonly arenaInstances: VfxArenaInstance[];
    readonly sharedDataInterfaces: Map<string, PlanResource>;
    readonly sharedComputePrograms: Map<number, ComputeProgramResource>;
    readonly privateComputePrograms: Set<string>;
    readonly fieldNames: Set<string>;
    readonly nextBindingLayouts: typeof bindingLayouts;
    readonly groups: Map<string, EmitterGroup>;
    readonly streams: Map<string, EmitterStream>;
    readonly outcomesByEntry: Map<ExtractedWorld, IntentOutcome[]>;
    readonly liveArenaOwners: Set<string>;
    /** Per published world, the facts of every emitter this plan described. */
    readonly emitterFacts: Map<ExtractedWorld, Map<VfxGpuTickIntent['emitter'], EmitterFrameFacts>>;
    /** Largest reset copy; one zero buffer of this size serves every group. */
    resetZeroBytes: number;
    readonly resourceRanges: KeyedDeclarationRanges[];
    readonly executionRanges: Map<string, GroupDeclarationRanges>;
    readonly resourceArrays: readonly PlanResource[][];
    readonly executionArrays: readonly PlanPass[][];
  }
  /** Program facts shared by every tick and view of one emitter group. */
  interface GroupFacts {
    readonly group: EmitterGroup;
    readonly first: PlannedIntent | undefined;
    readonly firstIntent: VfxGpuTickIntent | EmitterPreparation;
    readonly latest: PlannedIntent | undefined;
    readonly latestTransform: Float32Array;
    readonly source: ExtractedEmitterState | undefined;
    readonly renderEnabled: boolean;
    readonly names: GroupNames;
    readonly sharedProgramId: number | undefined;
    readonly computeProgramName: string;
    readonly arenaInstance: VfxArenaInstance;
    readonly capacity: number;
    readonly renderers: readonly ParticleRenderer[];
    readonly meshes: readonly (MeshAsset | undefined)[];
    /** Published mesh source key per renderer (asset handle or player-owned mesh). */
    readonly meshKeys: readonly (string | number | undefined)[];
    readonly preparedProgram: ReturnType<typeof emitterPrograms>;
    readonly batchProgram: VfxComputeBatchProgram | undefined;
    readonly computeProgram: RenderFeatureGpuProgramDescriptor;
    readonly parameterBytes: number;
    readonly customStride: number;
    readonly hasEvents: boolean;
    readonly entryPoints: ReadonlySet<string>;
    readonly maxParticleInputBytes: number;
    readonly sharedInstanceBytes: number;
    readonly scratchBytes: number;
    readonly eventBufferBytes: number;
    readonly emitterFacts: EmitterFrameFacts;
    /** Built on first use: most frames neither reset nor declare ordinary tick passes. */
    resetCopyList: ResourceCopy[] | undefined;
  }
  /**
   * Facts of one immutable emitter in one published world, derived once per
   * plan and shared by every player group of that emitter. They depend only
   * on the emitter, the plan's limits and arena admission, and that world's
   * published materials and meshes; per-player state stays in GroupFacts.
   */
  interface EmitterFrameFacts {
    readonly sharedProgramId: number | undefined;
    readonly sharedProgramName: string | undefined;
    readonly noProviders: boolean;
    readonly preparedProgram: ReturnType<typeof emitterPrograms>;
    readonly maxParticleInputBytes: number;
    readonly customStride: number;
    /** The batched program when plan limits and arena slabs admit it. */
    readonly batchCandidate: VfxComputeBatchProgram | undefined;
    readonly ordinaryComputeProgram: RenderFeatureGpuProgramDescriptor;
    readonly parameterBytes: number;
    readonly hasEvents: boolean;
    readonly entryPoints: ReadonlySet<string>;
    readonly sharedInstanceBytes: number;
    readonly scratchBytes: number;
    readonly eventBufferBytes: number;
    /** Largest zero-fill copy of one reset, including trail history. */
    readonly resetZeroBytes: number;
    readonly hasMeshRenderer: boolean;
    readonly noMeshKeys: readonly undefined[];
    readonly dataInterfaceFree: boolean;
    /** Initial indirect arguments per resolved mesh list (one entry without mesh renderers). */
    readonly indirect: {
      readonly meshes: readonly (MeshAsset | undefined)[];
      readonly words: Uint32Array | undefined;
    }[];
    /** Renderer facts per renderer index, for the last mesh and batch they were derived for. */
    readonly renderers: (RendererFrameFacts | RenderFeatureStageFailedError | undefined)[];
  }
  /** View-independent facts of one renderer, shared by the groups of one emitter in one plan. */
  interface RendererFrameFacts {
    readonly mesh: MeshAsset | undefined;
    readonly batch: VfxComputeBatchProgram | undefined;
    readonly statics: RendererStatics;
    /** Projection program for batched storage without a batched projection; else the group's. */
    readonly singleProjection: string | undefined;
    readonly dispatches: ComputeDispatch[];
  }
  /** Data-interface resources and binding slots of one group. */
  interface GroupDataInterfaces {
    readonly bindings: Record<number, string>;
    /** Slot of the force-field buffer, whose name follows each tick's field revision. */
    readonly fieldBinding: number | undefined;
    readonly resources: PlanResource[];
  }
  interface GroupPlan extends GroupFacts {
    readonly dataInterfaces: GroupDataInterfaces;
    readonly indirectWords: Uint32Array;
    readonly programDeclaration: ComputeProgramResource;
    /** Arena storage the group retained this frame; undefined when it declares its buffers. */
    readonly retained: RetainedEmitterResources | undefined;
  }
  /** One view of a group: its work lists, camera, targets and presentation visibility. */
  interface GroupView {
    readonly work: ViewWork;
    readonly camera: ParticleRenderCamera;
    readonly colorTarget: PlanTarget | undefined;
    readonly depthTarget: PlanTarget | undefined;
    readonly visible: boolean;
  }
  /** Renderer view facts that do not depend on the player or the view. */
  interface RendererStatics {
    readonly castsShadow: boolean;
    readonly material: MaterialAsset | undefined;
    readonly inputLanes: number;
    readonly hasParticleInputs: boolean;
    readonly materialPass: ReturnType<typeof particleMaterialPass>;
    readonly mesh: MeshAsset | undefined;
    readonly submesh: MeshAsset['submeshes'][number] | undefined;
    readonly indexFormat: 'uint16' | 'uint32';
    readonly materialBindingContract: Parameters<typeof particleMaterialUsesBindings>[0];
    readonly sceneDepthVersion: MaterialSceneDepth | undefined;
    readonly sceneDepthBinding: ReturnType<typeof particleMaterialSceneDepthBinding>;
    readonly renderState: ReturnType<typeof particleRendererRenderState>;
    readonly vertexLayout: ParticleVertexLayout;
    readonly instanceBytes: number;
    readonly historyBytes: number;
    readonly projectionBatch: VfxComputeBatchProgram | undefined;
  }
  /** One enabled renderer of a group in one view, with its material and geometry facts. */
  interface RendererView extends RendererStatics {
    readonly view: GroupView;
    readonly index: number;
    readonly renderer: ParticleRenderer;
    readonly names: RendererNames['view'];
    /** Frame-scope trail history the simulation writes. */
    readonly simulationHistory: string;
    readonly meshKey: string | number | undefined;
    readonly projectionProgram: string;
    readonly dispatches: readonly ComputeDispatch[];
  }
  interface SharedMeshGeometry {
    readonly mesh: MeshAsset;
    readonly geometry: string;
    readonly indexData?: { readonly resource: string; readonly format: 'uint16' | 'uint32' };
  }
  interface DrawGeometry {
    readonly vertexData: readonly { readonly slot: number; readonly resource: string }[];
    readonly indexData?: { readonly resource: string; readonly format: 'uint16' | 'uint32' };
  }

  const keysOf = (plan: FramePlan, entry: ExtractedWorld): StreamKeys => {
    const keys = plan.resolution.keys.get(entry);
    if (keys === undefined) throw new Error('Missing VFX stream keys');
    return keys;
  };
  /** Published mesh handles resolve through the feature asset resolver; inline meshes pass through. */
  const resolveWorldMeshes = (
    entry: PublishedWorld,
    context: RenderFeaturePlanContext,
  ): ReadonlyMap<string | number, MeshAsset> => {
    let meshes: Map<string | number, MeshAsset | number> | undefined;
    for (const [key, value] of entry.meshes) {
      if (typeof value !== 'number') continue;
      const resolved = context.resolveAsset?.(entry.sourceWorldIndex, value);
      if (resolved === undefined) throw new Error('VFX requires the feature asset resolver');
      if (!resolved.ok) throw resolved.error;
      if (resolved.value.kind !== 'mesh') throw new Error('VFX requires a mesh asset');
      meshes ??= new Map(entry.meshes);
      meshes.set(key, resolved.value);
    }
    return (meshes ?? entry.meshes) as ReadonlyMap<string | number, MeshAsset>;
  };
  /** Terminal ledger of the runtime's current render and device generation, pruned to live intents. */
  const submittedLedger = (
    state: RuntimeState,
    entry: PublishedWorld,
    device: number,
  ): NonNullable<RuntimeState['submitted']> => {
    let submitted = state.submitted;
    if (submitted?.generation !== entry.renderGeneration || submitted.device !== device) {
      submitted = { generation: entry.renderGeneration, device, terminal: new Map() };
      state.submitted = submitted;
    }
    if (submitted.terminal.size > 0) {
      const live = new Set<number>();
      for (const intent of entry.intents) live.add(intent.sequence);
      for (const sequence of submitted.terminal.keys())
        if (!live.has(sequence)) submitted.terminal.delete(sequence);
    }
    return submitted;
  };
  const resolveEmitterStates = (
    entry: PublishedWorld,
    resolver: ReturnType<typeof planResolver>,
    keys: StreamKeys,
    context: RenderFeaturePlanContext,
  ): Map<string, ExtractedEmitterState> => {
    const emitterState = new Map<string, ExtractedEmitterState>();
    for (const source of entry.emitterState.values()) {
      const emitter = resolver.emitter(source.emitter);
      const key = keys.stream(source.player, emitter.id).stateKey;
      if (emitter.forceFields === undefined && source.forceFields === undefined) {
        // Neither side owns fields: the published row has no field member.
        emitterState.set(key, {
          ...(source as Omit<typeof source, 'forceFields'>),
          emitter,
        });
        continue;
      }
      const forceFields = resolveFields(
        emitter,
        source.forceFields,
        entry.sourceWorldIndex,
        context,
        prepareFields,
      );
      const { forceFields: _input, ...rest } = source;
      emitterState.set(key, {
        ...rest,
        emitter,
        ...(forceFields === undefined ? {} : { forceFields }),
      });
    }
    return emitterState;
  };
  /** Resolve one published world against the receiver's effect, stream and retained caches. */
  const resolveWorld = (resolution: FrameResolution, entry: PublishedWorld): ExtractedWorld => {
    const { context, emitterVisible } = resolution;
    const meshes = resolveWorldMeshes(entry, context);
    const camera = entry.camera;
    const views = context.views.map((view) => ({
      identity: view.identity,
      camera:
        view.selectedView ??
        entry.views.find((candidate) => candidate.identity === view.identity)?.camera ??
        camera,
    }));
    const state = runtimeState(entry.runtimeId);
    const submitted = submittedLedger(state, entry, context.generation);
    intentPayloads.begin(entry.runtimeId, entry.renderGeneration, entry.intents);
    const resolver = planResolver(state, entry.renderGeneration, entry.sourceWorldIndex, context);
    const keys = streamKeys(state, entry.worldId, entry.renderGeneration, entry.runtimeId);
    const emitterState = resolveEmitterStates(entry, resolver, keys, context);
    const preparationPlayers = new Set(entry.preparationPlayers ?? []);
    const retained = new Map<string, RetainedEmitter>();
    for (const row of entry.retained) {
      if (preparationPlayers.has(row.player)) continue;
      const published = resolveRetainedIntent(
        receivedRetained,
        resolution,
        entry,
        row,
        recentQueued,
      );
      if (published === undefined) continue;
      const intent = resolver.intent(published);
      if (intent === undefined) continue;
      retained.set(keys.stream(row.player, intent.emitter.id).stateKey, {
        player: row.player,
        localToWorld: row.localToWorld,
        intent,
        emitter: intent.emitter,
        visible: views.some((view) =>
          emitterVisible(intent.emitter, view.camera, row.localToWorld),
        ),
      });
    }
    const intents: VfxGpuTickIntent[] = [];
    const queued = createQueuedIntentResolution(resolution.missingIntents, entry.runtimeId, (p) => {
      const full = intentPayloads.resolve(entry.runtimeId, p as (typeof entry.intents)[number]);
      if (full !== undefined) recentQueued.remember(entry, full);
      return full === undefined ? undefined : resolver.intent(full);
    });
    for (const published of entry.intents) {
      const terminal = submitted.terminal.get(published.sequence);
      if (terminal === 'skipped' || terminal === 'deferred') continue;
      const intent = queued(published);
      if (intent === undefined) continue;
      if (terminal === undefined) {
        intents.push(intent);
      } else if (terminal === 'dispatched' && !preparationPlayers.has(intent.player)) {
        const key = keys.stream(intent.player, intent.emitter.id).stateKey;
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
    resolver.finish();
    const resolved: ExtractedWorld = {
      ...entry,
      meshes,
      camera,
      views,
      emitterState,
      intents,
      retained: [...retained.values()],
    };
    resolution.keys.set(resolved, keys);
    return resolved;
  };
  /** Runtimes absent from this frame drop their state; stale pending frames retire. */
  const retireAbsentState = (frame: ExtractedFrame): void => {
    const liveRuntimes = new Set(frame.worlds.map((entry) => entry.runtimeId));
    for (const identity of runtimeStates.keys())
      if (!liveRuntimes.has(identity)) runtimeStates.delete(identity);
    intentPayloads.retire(liveRuntimes);
    for (const frameNumber of pendingFrames.keys())
      if (frameNumber + 4 < frame.frameNumber) pendingFrames.delete(frameNumber);
  };
  /** Native planning requires every emitter the frame references to be retainable. */
  const framePlansNatively = (frame: ExtractedFrame): boolean => {
    for (const entry of frame.worlds) {
      for (const { emitter } of entry.emitterState.values())
        if (!isRetainableEmitter(emitter)) return false;
      for (const { emitter } of entry.intents) if (!isRetainableEmitter(emitter)) return false;
      for (const { intent } of entry.retained)
        if (!isRetainableEmitter(intent.emitter)) return false;
    }
    return true;
  };
  const createFramePlan = (
    resolution: FrameResolution,
    frame: ExtractedFrame,
    runtimeScratch: ReturnType<typeof createRuntimeStorage>,
  ): FramePlan => {
    const { context } = resolution;
    const nativePlan =
      options.nativePlanning === true && framePlansNatively(frame)
        ? context.createNativePlan?.()
        : undefined;
    const frameWork = nativePlan?.scope('frame');
    const resources: PlanResource[] = frameWork?.resources ?? [];
    const passes: PlanPass[] = frameWork?.passes ?? [];
    const viewWork = context.views
      .filter((view) => view.render)
      .map((view): ViewWork => {
        const scope = nativePlan?.scope({ view: view.identity });
        const colorTarget =
          view.targets.find((target) => target.kind === 'color') ??
          view.targets.find((target) => target.kind === 'swapchain');
        const depthTarget = view.targets.find((target) => target.kind === 'depth');
        return {
          view,
          colorTarget,
          depthTarget,
          attachments: {
            color: Object.freeze([
              Object.freeze({
                target: colorTarget?.name ?? 'swapchain',
                loadOp: 'load' as const,
                storeOp: 'store' as const,
              }),
            ]),
            depth:
              depthTarget === undefined
                ? undefined
                : Object.freeze({
                    target: depthTarget.name,
                    depthLoadOp: 'load' as const,
                    depthStoreOp: 'store' as const,
                  }),
            sampled: depthTarget === undefined ? undefined : Object.freeze([depthTarget.name]),
          },
          resources: scope?.resources ?? [],
          passes: scope?.passes ?? [],
          opaque: [],
          blended: [],
          meshGeometry: new Map(),
          graphics: new Map(),
          shared: [],
        };
      });
    return {
      resolution,
      frame,
      runtimeScratch,
      nativePlan,
      resourceAdmission:
        options.retainedResources === true ? nativePlan?.resourceAdmission : undefined,
      retainedArena: undefined,
      directCompute: createVfxDirectComputeFrame(),
      resources,
      passes,
      viewWork,
      arenaInstances: [],
      sharedDataInterfaces: new Map(),
      sharedComputePrograms: new Map(),
      privateComputePrograms: new Set(),
      fieldNames: new Set(),
      nextBindingLayouts: freshBindingLayouts(),
      groups: new Map(),
      streams: new Map(),
      outcomesByEntry: new Map(),
      liveArenaOwners: new Set(),
      emitterFacts: new Map(),
      resetZeroBytes: 0,
      resourceRanges: [],
      executionRanges: new Map(),
      resourceArrays: [resources, ...viewWork.map((work) => work.resources)],
      executionArrays: [
        passes,
        ...viewWork.flatMap((work) => [work.passes, work.opaque, work.blended]),
      ],
    };
  };
  /** Plain logical bindings of immutable emitters keep their identity across plans. */
  const computeBindings = (
    nextBindingLayouts: typeof bindingLayouts,
    name: string,
    program: string,
    intent: Pick<VfxGpuTickIntent, 'emitter'>,
    resources: () => Readonly<Record<number, string>>,
  ): ComputeBindings => {
    const emitter = intent.emitter;
    const retain = isRetainableEmitter(emitter);
    const previous = retain
      ? (nextBindingLayouts.get(name) ?? bindingLayouts.get(name))
      : undefined;
    if (previous?.emitter === emitter && previous.resource.program === program) {
      nextBindingLayouts.set(name, previous);
      return previous.resource;
    }
    const resource: ComputeBindings = {
      kind: 'compute-bindings',
      name,
      program,
      entries: computeBindingEntries(intent, resources()),
    };
    if (!retain) return resource;
    const owned = ownRenderFeatureProgramData(resource);
    nextBindingLayouts.set(name, { emitter, resource: owned });
    return owned;
  };

  // First classify every queued intent.  A deferred intent is an ordered
  // barrier: later intents in the same runtime cannot be dispatched until
  // the provider/target is ready.  Session masks and paused consumption
  // skip ordinary ticks, but a reset remains deferred so a new authored
  // timeline cannot be mixed into the previous GPU state.
  // A program owns persistent storage for one player/emitter. Resets run
  // in encoder order alongside ticks; preparation never clears live state.
  const classifyQueuedIntents = (
    plan: FramePlan,
    entry: ExtractedWorld,
  ): RenderFeatureStageFailedError | undefined => {
    const outcomes: IntentOutcome[] = [];
    plan.outcomesByEntry.set(entry, outcomes);
    const keys = keysOf(plan, entry);
    // Ordering barriers belong to one player/emitter stream.  A paused
    // reset or unavailable provider must not head-of-line block unrelated
    // players that share the same VfxGpuRuntime/World.
    const blockedEmitters = new Set<string>();
    const preparationPlayers = new Set(entry.preparationPlayers ?? []);
    for (const intent of entry.intents) {
      // Explicit paused preparation retires expired playback, including a
      // queued reset. Acknowledge its exact sequence without GPU work.
      if (preparationPlayers.has(intent.player)) {
        outcomes.push({ intent, state: 'skipped' });
        continue;
      }
      const record = keys.stream(intent.player, intent.emitter.id);
      const state = classifyIntent(plan, entry, record, intent, blockedEmitters);
      if (state instanceof RenderFeatureStageFailedError) return state;
      outcomes.push({ intent, state });
    }
    return undefined;
  };
  /** Terminal state of one queued intent; an admitted intent joins its program group. */
  const classifyIntent = (
    plan: FramePlan,
    entry: ExtractedWorld,
    record: StreamRecord,
    intent: VfxGpuTickIntent,
    blockedEmitters: Set<string>,
  ): IntentOutcomeState | RenderFeatureStageFailedError => {
    const baseKey = record.baseKey;
    if (blockedEmitters.has(baseKey)) return 'deferred';
    const source = entry.emitterState.get(record.stateKey);
    if (source?.enabled === false) return holdIntent(intent, baseKey, blockedEmitters);
    const localToWorld = source?.localToWorld ?? IDENTITY_MATRIX;
    const visible = entry.views.some((view) =>
      plan.resolution.emitterVisible(intent.emitter, view.camera, localToWorld),
    );
    if (!visible && intent.emitter.simulationWhenCulled !== 'continue')
      return holdIntent(intent, baseKey, blockedEmitters);
    const requirements = intent.emitter.reflection.dataInterfaces ?? [];
    if (
      requirements.length > 0 &&
      resolveDataInterfaces(intent, options.dataInterfaces) === undefined
    ) {
      blockedEmitters.add(baseKey);
      return 'deferred';
    }
    const stagePlan = emitterStagePlan(intent.emitter, intent.instanceGeneration);
    if (!stagePlan.ok) return planFailure();
    const entryPoints =
      emitterPrograms(intent.emitter)?.entryPoints ??
      new Set(intent.emitter.reflection.entryPoints);
    const dispatchCount = simulationEntries(
      intent.emitter,
      immutableEmitters.has(intent.emitter),
      stagePlan.value,
      entryPoints,
      () => simulationDispatches(intent, stagePlan.value),
    ).length;
    if (dispatchCount === 0 && intent.emitter.renderers.length === 0) return 'skipped';
    const failure = admitIntent(plan, entry, record, {
      intent,
      localToWorld,
      stagePlan: stagePlan.value,
      visible,
      retained: false,
    });
    if (failure !== undefined) return failure;
    return dispatchCount > 0 ? 'dispatched' : 'skipped';
  };
  /** Join an admitted intent to its stream's program group; a group never mixes worlds or programs. */
  const admitIntent = (
    plan: FramePlan,
    entry: ExtractedWorld,
    record: StreamRecord,
    planned: PlannedIntent,
  ): RenderFeatureStageFailedError | undefined => {
    const intent = planned.intent;
    const program = keysOf(plan, entry).program(record, intent.programFingerprint);
    const key = program.key;
    let stream = plan.streams.get(record.streamKey);
    if (stream === undefined) {
      stream = { lastGroup: key, ranges: undefined };
      plan.streams.set(record.streamKey, stream);
    } else if (stream.lastGroup !== key) {
      stream.lastGroup = key;
      stream.ranges ??= [];
    }
    let group = plan.groups.get(key);
    if (group === undefined) {
      group = { key, record, program, entry, intents: [], stream };
      plan.groups.set(key, group);
    } else if (
      group.entry !== entry ||
      group.intents[0]?.intent.emitter.wgsl !== intent.emitter.wgsl ||
      group.intents[0]?.intent.emitter.capacity !== intent.emitter.capacity
    ) {
      return planFailure();
    }
    group.intents.push(planned);
    return undefined;
  };
  /** Device recovery replays a retained stream's committed session as fresh ticks. */
  const recoveryRows = (
    retained: RetainedEmitter,
    intents: readonly VfxGpuTickIntent[],
    stagePlan: VfxValidatedStagePlan,
    visible: boolean,
  ): PlannedIntent[] =>
    intents.map((intent) => ({
      intent,
      localToWorld: retained.localToWorld,
      stagePlan,
      visible,
      retained: false,
    }));
  /** Recovery ticks precede admitted work only when that work continues the retained session. */
  const continuesSession = (group: EmitterGroup, retained: VfxGpuTickIntent): boolean => {
    const first = group.intents[0]?.intent;
    return first !== undefined && !first.reset && first.playCycle === retained.playCycle;
  };
  // A paused, culled or deferred emitter has no queued tick this frame.
  // Keep the last submitted emitter state as a render-only group so its
  // persistent particle/history buffers, projection and raster passes stay
  // alive until the player is reset. A queued intent admitted above owns
  // the frame; deferred/skipped work falls back to this retained lease.
  const keepRetainedGroups = (
    plan: FramePlan,
    entry: ExtractedWorld,
  ): RenderFeatureStageFailedError | undefined => {
    const keys = keysOf(plan, entry);
    const { submittedDeviceGeneration } = runtimeState(entry.runtimeId);
    const rebuildingDeviceState = submittedDeviceGeneration !== plan.resolution.context.generation;
    for (const retained of entry.retained) {
      const record = keys.stream(retained.player, retained.emitter.id);
      const program = keys.program(record, retained.intent.programFingerprint);
      const key = program.key;
      const stagePlan = emitterStagePlan(
        retained.intent.emitter,
        retained.intent.instanceGeneration,
      );
      if (!stagePlan.ok) return planFailure();
      const visible =
        retained.visible && (entry.emitterState.get(record.stateKey)?.enabled ?? true);
      const recoveryIntents = rebuildingDeviceState ? buildVfxRecoveryIntents(retained.intent) : [];
      const admittedGroup = plan.groups.get(key);
      if (admittedGroup !== undefined) {
        if (recoveryIntents.length > 0 && continuesSession(admittedGroup, retained.intent))
          plan.groups.set(key, {
            ...admittedGroup,
            intents: [
              ...recoveryRows(retained, recoveryIntents, stagePlan.value, visible),
              ...admittedGroup.intents,
            ],
          });
        continue;
      }
      // A different program owns separate storage. Never recreate the
      // prior retained cycle alongside it on a replacement device.
      if (plan.streams.has(record.streamKey)) continue;
      plan.groups.set(key, {
        key,
        record,
        program,
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
            : recoveryRows(retained, recoveryIntents, stagePlan.value, visible),
      });
    }
    return undefined;
  };
  // Paused preparation is resource intent, never a fabricated tick.
  // It also parks a previously played emitter without retaining its last visible particles.
  const addPreparationGroups = (plan: FramePlan, entry: ExtractedWorld): void => {
    const keys = keysOf(plan, entry);
    for (const source of entry.emitterState.values()) {
      if (!source.prepareOnly || source.programFingerprint === undefined) continue;
      const record = keys.stream(source.player, source.emitter.id);
      if (plan.streams.has(record.streamKey)) continue;
      const program = keys.program(record, source.programFingerprint);
      const key = program.key;
      plan.groups.set(key, {
        key,
        record,
        program,
        entry,
        intents: [],
        stream: { lastGroup: key, ranges: undefined },
        preparation: {
          ...source,
          programFingerprint: source.programFingerprint,
          instanceGeneration: source.instanceGeneration ?? 0,
        },
      });
    }
  };
  /** Immutable emitters share one compute program identity across groups and plans. */
  const sharedComputeProgramId = (emitter: VfxGpuTickIntent['emitter']): number | undefined => {
    if (!immutableEmitters.has(emitter)) return undefined;
    let id = computeProgramIds.get(emitter);
    if (id === undefined) {
      id = nextComputeProgramId++;
      computeProgramIds.set(emitter, id);
    }
    return id;
  };
  const includeArenaOwner = (
    plan: FramePlan,
    keys: StreamKeys,
    player: EntityHandle,
    emitter: VfxGpuTickIntent['emitter'],
  ): void => {
    const id = computeProgramIds.get(emitter);
    if (id !== undefined)
      plan.liveArenaOwners.add(keys.owner(keys.stream(player, emitter.id), sharedProgramName(id)));
  };
  /** Shared program identities for every planned group, then the arena owners of every live stream. */
  const collectArenaOwners = (plan: FramePlan): void => {
    for (const group of plan.groups.values()) {
      const emitter = (group.intents[0]?.intent ?? group.preparation)?.emitter;
      if (emitter !== undefined) sharedComputeProgramId(emitter);
    }
    for (const entry of plan.frame.worlds) {
      const keys = keysOf(plan, entry);
      for (const state of entry.emitterState.values())
        includeArenaOwner(plan, keys, state.player, state.emitter);
      for (const intent of entry.intents)
        includeArenaOwner(plan, keys, intent.player, intent.emitter);
      for (const retained of entry.retained)
        includeArenaOwner(plan, keys, retained.player, retained.emitter);
    }
  };
  const pruneStreamOwners = (liveArenaOwners: ReadonlySet<string>): void => {
    for (const state of runtimeStates.values()) {
      let pruned = false;
      for (const [key, emitter] of state.emitters) {
        // Retired streams release their identity after a short grace period;
        // the owner map otherwise grows with every player ever planned.
        if (emitter.seen + STREAM_RETENTION_PLANS < planSerial) {
          state.emitters.delete(key);
          pruned = true;
          continue;
        }
        const owner = emitter.resources?.ranges[0]?.owner;
        if (owner !== undefined && !liveArenaOwners.has(owner)) delete emitter.resources;
      }
      // Streams without storage (never admitted) age out on a slower sweep.
      if (pruned || planSerial % 64 === 0) pruneStreamKeys(state);
    }
  };
  /** The batched program applies when plan limits and the arena hold each of its storage slabs. */
  const admitBatchProgram = (
    plan: FramePlan,
    emitter: VfxGpuTickIntent['emitter'],
    candidate: VfxComputeBatchProgram | undefined,
    inputBytes: number,
  ): VfxComputeBatchProgram | undefined => {
    const arena = plan.retainedArena;
    if (candidate === undefined || arena === undefined) return undefined;
    const limits = plan.resolution.context.limits;
    if ((limits?.maxStorageBuffersPerShaderStage ?? 0) < 8) return undefined;
    const bindingLimit = Math.min(
      limits?.maxBufferSize ?? 256 * 1024 * 1024,
      limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024,
    );
    if (bindingLimit < 16 * 336) return undefined;
    return batchStorageSizes(emitter, candidate.customStride, inputBytes).every(([size, stride]) =>
      arena.supports(size, STORAGE_USAGE, stride),
    )
      ? candidate
      : undefined;
  };
  const emitterFactsOf = (
    plan: FramePlan,
    entry: ExtractedWorld,
    emitter: VfxGpuTickIntent['emitter'],
  ): EmitterFrameFacts => {
    let table = plan.emitterFacts.get(entry);
    if (table === undefined) {
      table = new Map();
      plan.emitterFacts.set(entry, table);
    }
    const prior = table.get(emitter);
    if (prior !== undefined) return prior;
    const sharedProgramId = sharedComputeProgramId(emitter);
    const capacity = emitter.capacity;
    const renderers = emitter.renderers;
    const preparedProgram = emitterPrograms(emitter);
    const maxParticleInputBytes = maxRendererInputBytes(renderers);
    const layout = emitter.reflection.layout;
    const customStride = layout?.customLayout?.stride ?? 0;
    const scratchBytes = (capacity * 2 + Math.ceil(capacity / WORKGROUP_SIZE)) * 4;
    let resetZeroBytes = Math.max(
      capacity * VFX_PARTICLE_CORE_STRIDE,
      capacity * 4,
      COUNTERS_BYTES,
      scratchBytes,
      customStride === 0 ? 0 : capacity * customStride,
    );
    for (const renderer of renderers)
      if (renderer.enabled !== false && renderer.kind === 'trail')
        resetZeroBytes = Math.max(
          resetZeroBytes,
          capacity * (Math.max(2, renderer.historyLength) + 1) * 16,
        );
    const hasMeshRenderer = renderers.some((renderer) => renderer.kind === 'mesh');
    const requirements =
      preparedProgram?.requirements ?? reflectedDataInterfaceRequirements(emitter);
    const facts: EmitterFrameFacts = {
      sharedProgramId,
      sharedProgramName:
        sharedProgramId === undefined ? undefined : sharedProgramName(sharedProgramId),
      noProviders: emitterHasNoProviders(emitter),
      preparedProgram,
      maxParticleInputBytes,
      customStride,
      batchCandidate: admitBatchProgram(
        plan,
        emitter,
        preparedProgram?.batch,
        maxParticleInputBytes,
      ),
      ordinaryComputeProgram: preparedProgram?.program ?? emitterComputeProgram(emitter),
      parameterBytes: layout?.parameters.size ?? 0,
      hasEvents: emitterHasEvents(emitter),
      entryPoints: preparedProgram?.entryPoints ?? new Set(emitter.reflection.entryPoints),
      sharedInstanceBytes:
        capacity *
        (Math.max(BILLBOARD_INSTANCE_BYTES, MESH_INSTANCE_BYTES) + maxParticleInputBytes),
      scratchBytes,
      eventBufferBytes: Math.max(
        4,
        eventInputCapacity(emitter) * VFX_EVENT_INPUT_BYTES +
          eventCapacity(emitter) * VFX_EVENT_BYTES,
      ),
      resetZeroBytes,
      hasMeshRenderer,
      noMeshKeys: renderers.map(() => undefined),
      dataInterfaceFree: requirements.length === 0,
      indirect: [],
      renderers: [],
    };
    table.set(emitter, facts);
    return facts;
  };
  /** Initial indirect arguments of one emitter for one resolved mesh list, derived once per plan. */
  const groupIndirectWords = (
    facts: EmitterFrameFacts,
    renderers: readonly ParticleRenderer[],
    meshes: readonly (MeshAsset | undefined)[],
  ): Uint32Array | undefined => {
    for (const row of facts.indirect)
      if (row.meshes.length === meshes.length && row.meshes.every((mesh, i) => mesh === meshes[i]))
        return row.words;
    const words = rendererIndirectWords(renderers, meshes);
    facts.indirect.push({ meshes, words });
    return words;
  };
  const describeGroup = (
    plan: FramePlan,
    group: EmitterGroup,
    firstIntent: VfxGpuTickIntent | EmitterPreparation,
  ): GroupFacts | RenderFeatureStageFailedError => {
    const first = group.intents[0];
    const latest = group.intents.at(-1) ?? first;
    const latestTransform = latest?.localToWorld ?? group.preparation?.localToWorld;
    if (latestTransform === undefined) return planFailure();
    const source = group.entry.emitterState.get(group.record.stateKey);
    const names = groupNames(group.program);
    const emitter = firstIntent.emitter;
    const emitterFacts = emitterFactsOf(plan, group.entry, emitter);
    const sharedProgramId = emitterFacts.sharedProgramId;
    const computeProgramName = emitterFacts.sharedProgramName ?? names.privateProgram;
    // Every row of a group shares its player/emitter stream record, so the
    // arena owner and its instance object stay identity-stable across plans.
    const arenaInstance = keysOf(plan, group.entry).instance(
      group.record,
      group.program,
      computeProgramName,
    );
    if (sharedProgramId !== undefined && emitterFacts.noProviders)
      plan.arenaInstances.push(arenaInstance);
    const renderers = emitter.renderers;
    const preparedProgram = emitterFacts.preparedProgram;
    // Every tick of a batched group must run the one admitted emitter program.
    const batchProgram =
      emitterFacts.batchCandidate !== undefined &&
      group.intents.every((row) => row.intent.emitter === emitter)
        ? emitterFacts.batchCandidate
        : undefined;
    const meshKeys = emitterFacts.hasMeshRenderer
      ? renderers.map((renderer) =>
          renderer.kind === 'mesh'
            ? typeof renderer.mesh !== 'object'
              ? renderer.mesh
              : `player:${firstIntent.player}`
            : undefined,
        )
      : emitterFacts.noMeshKeys;
    return {
      group,
      first,
      firstIntent,
      latest,
      latestTransform,
      source,
      renderEnabled: group.preparation === undefined && (source?.enabled ?? true),
      names,
      sharedProgramId,
      computeProgramName,
      arenaInstance,
      capacity: emitter.capacity,
      renderers,
      meshes: emitterFacts.hasMeshRenderer
        ? meshKeys.map((key) => (key === undefined ? undefined : group.entry.meshes.get(key)))
        : emitterFacts.noMeshKeys,
      meshKeys,
      preparedProgram,
      batchProgram,
      computeProgram: batchProgram?.descriptor ?? emitterFacts.ordinaryComputeProgram,
      parameterBytes: emitterFacts.parameterBytes,
      customStride: emitterFacts.customStride,
      hasEvents: emitterFacts.hasEvents,
      entryPoints: emitterFacts.entryPoints,
      maxParticleInputBytes: emitterFacts.maxParticleInputBytes,
      sharedInstanceBytes: emitterFacts.sharedInstanceBytes,
      scratchBytes: emitterFacts.scratchBytes,
      eventBufferBytes: emitterFacts.eventBufferBytes,
      emitterFacts,
      resetCopyList: undefined,
    };
  };
  /** Force fields need the emitter's field declaration and a finite invertible transform per row. */
  const fieldOwnerFailure = (group: EmitterGroup, emitter: VfxGpuTickIntent['emitter']) => {
    if (emitter.forceFields === undefined) return planFailure();
    if (
      !group.intents.every((planned) => isVfxFieldTransform(planned.localToWorld)) ||
      (group.preparation !== undefined && !isVfxFieldTransform(group.preparation.localToWorld))
    )
      return planFailure({
        code: 'vfx-field-invalid',
        expected: 'finite invertible emitter transform',
        hint: 'repair the player Scene transform',
        detail: { path: 'player.transform' },
      });
    return undefined;
  };
  /** Declare one field revision's buffer and its upload; returns the buffer name. */
  const planForceFieldRevision = (
    plan: FramePlan,
    prefix: string,
    input: { readonly forceFields?: VfxGpuTickIntent['forceFields'] },
    resources: PlanResource[],
  ): string | RenderFeatureStageFailedError => {
    const fields = input.forceFields;
    if (fields === undefined) return planFailure();
    if (!fields.ok) return planFailure(fields.error);
    const name = fieldBufferName(prefix, fields.value.revision);
    if (plan.fieldNames.has(name)) return name;
    plan.fieldNames.add(name);
    const prepared = fields.value;
    const generation = plan.resolution.context.generation;
    const predecessor =
      prepared.delta === undefined ? undefined : fieldBufferName(prefix, prepared.delta.from);
    const incremental =
      predecessor !== undefined &&
      (plan.fieldNames.has(predecessor) || uploadedFields.get(predecessor) === generation);
    resources.push({
      kind: 'buffer',
      name,
      size: prepared.byteLength,
      usage: ['storage', 'copy-src'],
    });
    if (uploadedFields.get(name) === generation) return name;
    const copies: ResourceCopy[] = [];
    if (incremental && predecessor !== undefined) {
      if (!plan.fieldNames.has(predecessor)) {
        plan.fieldNames.add(predecessor);
        resources.push({
          kind: 'buffer',
          name: predecessor,
          size: prepared.byteLength,
          usage: ['storage', 'copy-src'],
        });
      }
      copies.push({ source: predecessor, destination: name, size: prepared.byteLength });
    }
    const uploads = incremental ? (prepared.delta?.uploads ?? []) : prepared.uploads;
    for (let index = 0; index < uploads.length; index++) {
      const upload = uploads[index] as (typeof uploads)[number];
      if (upload.data.byteLength === 0) continue;
      const staging = `${name}.upload.${index}`;
      resources.push({
        kind: 'buffer',
        name: staging,
        size: upload.data.byteLength,
        usage: ['copy-src'],
        data: upload.data,
      });
      copies.push({
        source: staging,
        destination: name,
        size: upload.data.byteLength,
        destinationOffset: upload.offset,
      });
    }
    if (copies.length > 0) plan.passes.push({ kind: 'copy', name: `${name}.prepare`, copies });
    return name;
  };
  const declareSharedDataInterface = (
    plan: FramePlan,
    entry: ExtractedWorld,
    kind: RendererOwnedDataInterface,
  ): string | RenderFeatureStageFailedError => {
    const name = kind === 'noise' ? 'vfx.di-noise' : `vfx.a-${entry.runtimeId}.di-${kind}`;
    if (plan.sharedDataInterfaces.has(name)) return name;
    const resource = sharedDataInterfaceResource(entry, name, kind);
    if (resource === undefined) return planFailure();
    plan.sharedDataInterfaces.set(name, resource);
    return name;
  };
  const planGroupDataInterfaces = (
    plan: FramePlan,
    facts: GroupFacts,
  ): GroupDataInterfaces | RenderFeatureStageFailedError => {
    const { group, firstIntent } = facts;
    if (facts.emitterFacts.dataInterfaceFree) return NO_DATA_INTERFACES;
    const bindings: Record<number, string> = {};
    const resources: PlanResource[] = [];
    let fieldBinding: number | undefined;
    const requirements =
      facts.preparedProgram?.requirements ??
      reflectedDataInterfaceRequirements(firstIntent.emitter);
    if (requirements.length === 0) return { bindings, fieldBinding, resources };
    const resolved = resolveDataInterfaces(firstIntent, options.dataInterfaces);
    if (resolved === undefined) return planFailure();
    for (const requirement of requirements) {
      if (requirement.kind === 'force-fields') {
        const failure = fieldOwnerFailure(group, firstIntent.emitter);
        if (failure !== undefined) return failure;
        fieldBinding = requirement.binding;
        const inputs =
          group.intents.length > 0 ? group.intents.map((planned) => planned.intent) : [firstIntent];
        for (const input of inputs) {
          const name = planForceFieldRevision(plan, group.key, input, resources);
          if (name instanceof RenderFeatureStageFailedError) return name;
          bindings[requirement.binding] = name;
        }
        continue;
      }
      const prepared = resolved.get(requirement.token)?.resource;
      if (prepared === undefined) {
        const name = declareSharedDataInterface(plan, group.entry, requirement.kind);
        if (name instanceof RenderFeatureStageFailedError) return name;
        bindings[requirement.binding] = name;
        continue;
      }
      const name = `${group.key}.di-${planName(requirement.kind)}`;
      const resource = preparedDataInterfaceResource(name, prepared);
      if (resource === undefined) return planFailure();
      resources.push(resource);
      bindings[requirement.binding] = name;
    }
    return { bindings, fieldBinding, resources };
  };
  /** Data-interface bindings of one tick, with the force-field buffer of its own revision. */
  const tickDataInterfaceBindings = (
    gp: GroupPlan,
    input: { readonly forceFields?: VfxGpuTickIntent['forceFields'] },
  ): Readonly<Record<number, string>> => {
    const { bindings, fieldBinding } = gp.dataInterfaces;
    const field = input.forceFields;
    const name = field?.ok ? fieldBufferName(gp.group.key, field.value.revision) : undefined;
    return fieldBinding === undefined || name === undefined
      ? bindings
      : { ...bindings, [fieldBinding]: name };
  };
  /** The group's reset copies, built on first use (resets and ordinary tick chains). */
  const resetCopiesOf = (gp: GroupPlan): ResourceCopy[] => {
    if (gp.resetCopyList !== undefined) return gp.resetCopyList;
    const copies = groupResetCopies(gp);
    for (let rendererIndex = 0; rendererIndex < gp.renderers.length; rendererIndex++) {
      const renderer = gp.renderers[rendererIndex] as (typeof gp.renderers)[number];
      if (renderer.enabled === false || renderer.kind !== 'trail') continue;
      copies.push({
        source: RESET_ZERO,
        destination: rendererNames(gp.group.program, rendererIndex).history,
        size: gp.capacity * (Math.max(2, renderer.historyLength) + 1) * 16,
      });
    }
    copies.push({
      source: gp.names.indirectInitial,
      destination: gp.names.indirect,
      size: gp.indirectWords.byteLength,
    });
    gp.resetCopyList = copies;
    return copies;
  };
  const groupResetCopies = (facts: GroupFacts): ResourceCopy[] => {
    const { names, capacity, customStride } = facts;
    return [
      {
        source: RESET_ZERO,
        destination: names.particles,
        size: capacity * VFX_PARTICLE_CORE_STRIDE,
      },
      { source: RESET_ZERO, destination: names.aliveIndices, size: capacity * 4 },
      { source: RESET_ZERO, destination: names.counters, size: COUNTERS_BYTES },
      { source: RESET_ZERO, destination: names.scratch, size: facts.scratchBytes },
      ...(customStride === 0
        ? []
        : [{ source: RESET_ZERO, destination: names.custom, size: capacity * customStride }]),
    ];
  };
  const declareComputeProgram = (plan: FramePlan, facts: GroupFacts): ComputeProgramResource => {
    const id = facts.sharedProgramId;
    if (id !== undefined) {
      const previous = plan.sharedComputePrograms.get(id);
      // The same program and preparation intent reuse the declaration already chosen.
      if (
        previous !== undefined &&
        (previous.preparePipelines === true) === (facts.source?.preparePipelines === true) &&
        previous.program === facts.computeProgram
      ) {
        if (facts.emitterFacts.noProviders)
          plan.privateComputePrograms.add(facts.computeProgramName);
        return previous;
      }
    }
    const declaration: ComputeProgramResource = {
      kind: 'compute-program',
      ...(facts.source?.preparePipelines ? { preparePipelines: true } : {}),
      name: facts.computeProgramName,
      program: facts.computeProgram,
    };
    if (id === undefined) return declaration;
    if (facts.emitterFacts.noProviders) plan.privateComputePrograms.add(facts.computeProgramName);
    const previous = plan.sharedComputePrograms.get(id);
    if (previous === undefined || declaration.preparePipelines)
      plan.sharedComputePrograms.set(id, declaration);
    return declaration;
  };
  /** A queued, non-retained reset rewrites the group's initial indirect arguments this frame. */
  const resetsThisFrame = (group: EmitterGroup): boolean =>
    group.intents.some((planned) => !planned.retained && planned.intent.reset);
  /**
   * Provider-free shared programs without events or parameters keep their
   * storage in the retained arena; other groups declare buffers each frame.
   */
  const retainGroupStorage = (
    plan: FramePlan,
    facts: GroupFacts,
    declaration: ComputeProgramResource,
    indirectWords: Uint32Array,
  ): RetainedEmitterResources | undefined => {
    const { resourceAdmission, retainedArena } = plan;
    const emitter = facts.group.program.resource;
    if (
      resourceAdmission === undefined ||
      retainedArena === undefined ||
      facts.sharedProgramId === undefined ||
      facts.hasEvents ||
      facts.parameterBytes !== 0 ||
      !emitterHasNoProviders(facts.firstIntent.emitter)
    )
      return undefined;
    resourceAdmission.program(
      'frame',
      facts.computeProgramName,
      facts.computeProgram,
      declaration.preparePipelines,
    );
    const retained = retainEmitterResources({
      previous: emitter.resources,
      batch: facts.batchProgram,
      emitter: facts.firstIntent.emitter,
      instance: facts.arenaInstance,
      program: facts.computeProgramName,
      tickCapacity: emitter.tickCapacity,
      customStride: facts.customStride,
      sharedInstanceBytes: facts.sharedInstanceBytes,
      indirectBytes: indirectWords.byteLength,
      arena: retainedArena,
      admission: resourceAdmission,
    });
    if (retained === undefined) {
      delete emitter.resources;
      return undefined;
    }
    emitter.resources = retained;
    const views = plan.resolution.context.views;
    for (const view of retained.views.keys())
      if (!views.some((row) => row.identity === view)) retained.views.delete(view);
    for (const binding of retained.bindings) {
      const prior = bindingLayouts.get(binding.name);
      plan.nextBindingLayouts.set(
        binding.name,
        prior?.emitter === facts.firstIntent.emitter && prior.resource === binding
          ? prior
          : { emitter: facts.firstIntent.emitter, resource: binding },
      );
    }
    if (resetsThisFrame(facts.group))
      uploadEmitterResource(
        resourceAdmission,
        retained,
        facts.names.indirectInitial,
        indirectWords,
      );
    return retained;
  };
  /** Frame-scope buffers of a group whose storage is not retained in the arena. */
  const declareGroupStorage = (plan: FramePlan, gp: GroupPlan): void => {
    const { names, capacity, parameterBytes, customStride, latest, first } = gp;
    plan.resources.push(
      ...gp.dataInterfaces.resources,
      ...(gp.sharedProgramId === undefined ? [gp.programDeclaration] : []),
      {
        kind: 'buffer',
        name: names.particles,
        size: capacity * VFX_PARTICLE_CORE_STRIDE,
        usage: ['storage'],
      },
      ...(parameterBytes === 0
        ? []
        : [
            {
              kind: 'buffer' as const,
              name: names.parameters,
              size: parameterBytes,
              usage: ['uniform'] as const,
              ...(latest === undefined ? {} : { data: latest.intent.parameterBlock }),
            },
          ]),
      ...(customStride === 0
        ? []
        : [
            {
              kind: 'buffer' as const,
              name: names.custom,
              size: capacity * customStride,
              usage: ['storage'] as const,
            },
          ]),
      {
        kind: 'buffer',
        name: names.aliveIndices,
        size: capacity * 4,
        usage: ['storage', 'copy-src'],
      },
      {
        kind: 'buffer',
        name: names.counters,
        size: COUNTERS_BYTES,
        usage: ['storage', 'copy-src'],
      },
      {
        kind: 'buffer',
        name: names.indirect,
        size: gp.indirectWords.byteLength,
        usage: ['storage', 'indirect', 'copy-src'],
      },
      {
        kind: 'buffer',
        name: names.indirectInitial,
        size: gp.indirectWords.byteLength,
        usage: ['copy-src'],
        ...(resetsThisFrame(gp.group) ? { data: gp.indirectWords } : {}),
      },
      {
        kind: 'buffer',
        name: names.scratch,
        size: gp.scratchBytes,
        usage: ['storage'],
      },
      {
        kind: 'buffer',
        name: names.sharedInstances,
        size: gp.sharedInstanceBytes,
        usage: ['storage', 'vertex'],
      },
      ...(gp.hasEvents
        ? [
            {
              kind: 'buffer' as const,
              name: names.projectionEventInputs,
              size: gp.eventBufferBytes,
              usage: ['storage'] as const,
              ...(first === undefined ? {} : { data: encodeEventBuffer(first.intent) }),
            },
          ]
        : []),
    );
  };
  /** Trail history is simulation state: reset with the group and declared unless retained. */
  const declareTrailHistory = (plan: FramePlan, gp: GroupPlan): void => {
    for (let rendererIndex = 0; rendererIndex < gp.renderers.length; rendererIndex++) {
      const renderer = gp.renderers[rendererIndex] as (typeof gp.renderers)[number];
      if (renderer.enabled === false || renderer.kind !== 'trail') continue;
      const historyBytes = gp.capacity * (Math.max(2, renderer.historyLength) + 1) * 16;
      const history = rendererNames(gp.group.program, rendererIndex).history;
      if (gp.retained === undefined)
        plan.resources.push({
          kind: 'buffer',
          name: history,
          size: historyBytes,
          usage: ['storage', 'copy-src'],
        });
    }
  };
  /** Batched simulation: each admitted tick becomes one direct compute job over retained ranges. */
  const planDirectTicks = (
    plan: FramePlan,
    gp: GroupPlan,
    retained: RetainedEmitterResources,
  ): RenderFeatureStageFailedError | undefined => {
    const { names, group } = gp;
    // One retained owner keeps one frozen range list for its lifetime.
    let ranges = directSimulationRanges.get(retained);
    if (ranges === undefined) {
      ranges = Object.freeze(
        [
          names.particles,
          names.aliveIndices,
          names.counters,
          names.indirect,
          names.scratch,
          names.sharedInstances,
          names.custom,
        ].map((name) => requiredRange(retained.byName, name, 'simulation')),
      );
      directSimulationRanges.set(retained, ranges);
    }
    for (let tickIndex = 0; tickIndex < group.intents.length; tickIndex++) {
      const planned = group.intents[tickIndex];
      if (planned === undefined) return planFailure();
      if (planned.retained) continue;
      const runtime = runtimeData(
        plan.runtimeScratch,
        planned.intent,
        group.entry.camera,
        undefined,
        planned.localToWorld,
      );
      const entries = simulationEntries(
        planned.intent.emitter,
        immutableEmitters.has(planned.intent.emitter),
        planned.stagePlan,
        gp.entryPoints,
        () => simulationDispatches(planned.intent, planned.stagePlan),
      );
      plan.directCompute.simulation({
        program: gp.computeProgramName,
        tick: tickIndex,
        reset: planned.intent.reset ? resetCopiesOf(gp) : NO_COPIES,
        ranges,
        customStride: gp.customStride,
        entries,
        runtime,
      });
    }
    return undefined;
  };
  /** Runtime, event and parameter inputs of one tick: uploaded into retained storage or declared. */
  const declareTickInputs = (
    plan: FramePlan,
    gp: GroupPlan,
    tick: TickNames,
    planned: PlannedIntent | undefined,
    live: PlannedIntent | undefined,
  ): void => {
    const admission = plan.resourceAdmission;
    const retained = gp.retained;
    const tickData =
      live === undefined
        ? undefined
        : runtimeData(
            retained !== undefined && admission !== undefined ? plan.runtimeScratch : undefined,
            live.intent,
            gp.group.entry.camera,
            undefined,
            live.localToWorld,
          );
    if (retained !== undefined && admission !== undefined) {
      if (tickData !== undefined)
        uploadEmitterResource(admission, retained, tick.runtime, tickData);
      return;
    }
    const { names, hasEvents, parameterBytes, customStride } = gp;
    const template = planned?.intent ?? gp.firstIntent;
    plan.resources.push(
      {
        kind: 'buffer',
        name: tick.runtime,
        size: RUNTIME_BYTES,
        usage: ['uniform'],
        ...(tickData === undefined ? {} : { data: tickData }),
      },
      ...(hasEvents
        ? [
            {
              kind: 'buffer' as const,
              name: tick.eventInputs,
              size: gp.eventBufferBytes,
              usage: ['storage'] as const,
              ...(live === undefined ? {} : { data: encodeEventBuffer(live.intent) }),
            },
          ]
        : []),
      ...(parameterBytes === 0
        ? []
        : [
            {
              kind: 'buffer' as const,
              name: tick.parameters,
              size: parameterBytes,
              usage: ['uniform'] as const,
              ...(live === undefined ? {} : { data: live.intent.parameterBlock }),
            },
          ]),
      computeBindings(
        plan.nextBindingLayouts,
        tick.bindings,
        gp.computeProgramName,
        template,
        () => ({
          0: names.particles,
          1: tick.runtime,
          2: names.aliveIndices,
          3: names.counters,
          4: names.indirect,
          5: names.scratch,
          6: names.sharedInstances,
          ...(hasEvents ? { 8: tick.eventInputs } : {}),
          ...(parameterBytes === 0 ? {} : { 10: tick.parameters }),
          ...(customStride === 0 ? {} : { 11: names.custom }),
          ...tickDataInterfaceBindings(gp, template),
        }),
      ),
    );
  };
  // Trail history is part of the per-tick simulation state.  It must
  // be written immediately after each tick, before the next tick can
  // mutate particles; projecting history once after the whole batch
  // would overwrite only the latest ring slot.
  const planTrailHistoryWrites = (
    plan: FramePlan,
    gp: GroupPlan,
    tick: TickNames,
    planned: PlannedIntent,
    enabled: boolean,
  ): RenderFeatureStageFailedError | undefined => {
    const { names, hasEvents, parameterBytes, customStride } = gp;
    const admission = plan.resourceAdmission;
    const retained = gp.retained;
    for (let rendererIndex = 0; rendererIndex < gp.renderers.length; rendererIndex++) {
      const renderer = gp.renderers[rendererIndex] as (typeof gp.renderers)[number];
      if (renderer.enabled === false) continue;
      if (renderer.kind !== 'trail') continue;
      if (!gp.entryPoints.has('forgeax_vfx_trail_history_main')) continue;
      const history = rendererNames(gp.group.program, rendererIndex).history;
      const historyNames = tick.history[rendererIndex];
      if (historyNames === undefined) return planFailure();
      const historyRuntime = historyNames.runtime;
      const historyBindings = historyNames.bindings;
      const historyData = enabled
        ? runtimeData(
            retained !== undefined && admission !== undefined ? plan.runtimeScratch : undefined,
            planned.intent,
            gp.group.entry.camera,
            undefined,
            planned.localToWorld,
            renderer,
            rendererIndex,
          )
        : undefined;
      if (retained !== undefined && admission !== undefined) {
        if (historyData !== undefined)
          uploadEmitterResource(admission, retained, historyRuntime, historyData);
      } else
        plan.resources.push(
          {
            kind: 'buffer',
            name: historyRuntime,
            size: RUNTIME_BYTES,
            usage: ['uniform'],
            ...(historyData === undefined ? {} : { data: historyData }),
          },
          computeBindings(
            plan.nextBindingLayouts,
            historyBindings,
            gp.computeProgramName,
            planned.intent,
            () => ({
              0: names.particles,
              1: historyRuntime,
              2: names.aliveIndices,
              3: names.counters,
              4: names.indirect,
              5: history,
              6: names.sharedInstances,
              ...(hasEvents ? { 8: tick.eventInputs } : {}),
              ...(parameterBytes === 0 ? {} : { 10: tick.parameters }),
              ...(customStride === 0 ? {} : { 11: names.custom }),
              ...tickDataInterfaceBindings(gp, planned.intent),
            }),
          ),
        );
      plan.passes.push({
        kind: 'compute',
        enabled,
        name: historyNames.write,
        program: gp.computeProgramName,
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
    return undefined;
  };
  // Each tick gets only its own immutable runtime/event input and
  // bindings.  The particle/counter/scratch/event/history resources are
  // shared, so dispatch order advances one emitter state rather than
  // simulating independent q-0/q-1 copies.
  // Tick occupancy is frame data. Retain the largest admitted batch's
  // slots so a catch-up or recovery batch does not rebuild the graph.
  const planTickPasses = (
    plan: FramePlan,
    gp: GroupPlan,
  ): RenderFeatureStageFailedError | undefined => {
    const { group } = gp;
    for (let tickIndex = 0; tickIndex < group.program.resource.tickCapacity; tickIndex++) {
      const planned = group.intents[tickIndex] ?? gp.first;
      const enabled =
        planned !== undefined && tickIndex < group.intents.length && !planned.retained;
      const tick = tickNames(group.program, tickIndex, gp.renderers.length);
      declareTickInputs(plan, gp, tick, planned, enabled ? planned : undefined);
      if (planned === undefined) continue;
      const dispatches = simulationDispatches(planned.intent, planned.stagePlan).filter(
        (dispatch) => gp.entryPoints.has(dispatch.entryPoint),
      );
      if (dispatches.length === 0) continue;
      const tickPassStart = plan.passes.length;
      // Keep the ordinary reset boundary before the complete compute chain.
      // A rare mid-batch reset needs a real boundary; reserving disabled
      // copies between every tick would split steady-state compute passes.
      if (tickIndex === 0 || (enabled && planned.intent.reset))
        plan.passes.push({
          kind: 'copy',
          name: tick.reset,
          enabled: enabled && planned.intent.reset,
          copies: resetCopiesOf(gp),
        });
      plan.passes.push({
        kind: 'compute',
        enabled,
        name: tick.simulate,
        program: gp.computeProgramName,
        bindings: tick.bindings,
        dispatches,
      });
      const failure = planTrailHistoryWrites(plan, gp, tick, planned, enabled);
      if (failure !== undefined) return failure;
      if (enabled)
        group.stream.ranges?.push({
          sequence: planned.intent.sequence,
          start: tickPassStart,
          end: plan.passes.length,
        });
    }
    return undefined;
  };
  /** Projection batching applies when the arena can hold each per-view projection slab. */
  const projectionBatchProgram = (
    plan: FramePlan,
    gp: GroupPlan,
    instanceBytes: number,
    historyBytes: number,
  ): VfxComputeBatchProgram | undefined => {
    const batch = gp.retained?.batch;
    const arena = plan.retainedArena;
    if (batch === undefined || arena?.supports(instanceBytes, STORAGE_USAGE) !== true)
      return undefined;
    return arena.supports(historyBytes, STORAGE_USAGE) &&
      arena.supports(gp.indirectWords.byteLength, STORAGE_USAGE, 20) &&
      arena.supports(COUNTERS_BYTES, STORAGE_USAGE, 24)
      ? batch
      : undefined;
  };
  const describeRendererView = (
    plan: FramePlan,
    gp: GroupPlan,
    view: GroupView,
    index: number,
    renderer: ParticleRenderer,
  ): RendererView | RenderFeatureStageFailedError => {
    const mesh = gp.meshes[index];
    const batch = gp.retained?.batch;
    let facts = gp.emitterFacts.renderers[index];
    if (
      facts === undefined ||
      (!(facts instanceof RenderFeatureStageFailedError) &&
        (facts.mesh !== mesh || facts.batch !== batch))
    ) {
      facts = describeRenderer(plan, gp, index, renderer, mesh, batch);
      gp.emitterFacts.renderers[index] = facts;
    }
    if (facts instanceof RenderFeatureStageFailedError) return facts;
    const rendererRow = rendererNames(gp.group.program, index);
    return {
      ...facts.statics,
      view,
      index,
      renderer,
      names: rendererRow.view,
      simulationHistory: rendererRow.history,
      meshKey: gp.meshKeys[index],
      projectionProgram: facts.singleProjection ?? gp.computeProgramName,
      dispatches: facts.dispatches,
    };
  };
  /** Player-independent renderer facts for one emitter, world, mesh and batched storage. */
  const describeRenderer = (
    plan: FramePlan,
    gp: GroupPlan,
    index: number,
    renderer: ParticleRenderer,
    mesh: MeshAsset | undefined,
    batch: VfxComputeBatchProgram | undefined,
  ): RendererFrameFacts | RenderFeatureStageFailedError => {
    const { context } = plan.resolution;
    const topologyPlan = isParticleTopologyRenderer(renderer)
      ? createTopologyResourcePlan(renderer)
      : undefined;
    if (topologyPlan !== undefined && !topologyPlan.ok) return planFailure();
    const publishedMaterial = gp.group.entry.materials.get(renderer.material);
    const material = publishedMaterial?.asset;
    const preparedInputs = prepareParticleMaterialInputs(
      renderer,
      material,
      gp.firstIntent.emitter.reflection.renderers?.[index]?.materialInputDefinitions,
    );
    if (!preparedInputs.ok) return planFailure();
    const hasParticleInputs = preparedInputs.value.lanes > 0;
    const materialPass = particleMaterialPass(
      renderer.kind,
      material,
      hasParticleInputs,
      publishedMaterial?.projection === undefined
        ? undefined
        : { projection: publishedMaterial.projection, context: context.materialContext },
      renderer.kind === 'mesh' && renderer.lighting === 'unlit',
    );
    const materialContract = context.materialShaderBindingContract?.(materialPass.shader);
    const instanceBytes = particleInstanceBytes(
      renderer,
      gp.capacity,
      preparedInputs.value.stride,
      topologyPlan?.value.vertexBytes,
    );
    const historyBytes =
      renderer.kind === 'trail' ? gp.capacity * (Math.max(2, renderer.historyLength) + 1) * 16 : 16;
    const projectionBatch = projectionBatchProgram(plan, gp, instanceBytes, historyBytes);
    const statics: RendererStatics = {
      castsShadow: renderer.kind === 'mesh' && renderer.castShadows === true,
      material,
      inputLanes: preparedInputs.value.lanes,
      hasParticleInputs,
      materialPass,
      mesh,
      submesh: renderer.kind === 'mesh' ? mesh?.submeshes[renderer.submesh ?? 0] : undefined,
      indexFormat: mesh?.indices instanceof Uint32Array ? 'uint32' : 'uint16',
      materialBindingContract: materialContract?.bindings,
      sceneDepthVersion: materialPass.sceneDepth ?? materialContract?.sceneDepth,
      sceneDepthBinding: particleMaterialSceneDepthBinding(materialContract?.bindings),
      renderState: particleRendererRenderState(
        renderer.kind,
        renderer.kind === 'billboard' ? renderer.blend : undefined,
        materialPass.renderState,
      ),
      vertexLayout: particleVertexLayout(renderer, hasParticleInputs),
      instanceBytes,
      historyBytes,
      projectionBatch,
    };
    return {
      mesh,
      batch,
      statics,
      // Batched storage implies the emitter's shared program name.
      singleProjection:
        batch !== undefined && projectionBatch === undefined
          ? `${gp.computeProgramName}.single-projection`
          : undefined,
      dispatches: projectionDispatches(renderer, gp.capacity, gp.entryPoints),
    };
  };
  const retainRendererProjection = (
    plan: FramePlan,
    gp: GroupPlan,
    rv: RendererView,
  ): RetainedProjection | undefined => {
    const { retainedArena, resourceAdmission } = plan;
    if (gp.retained === undefined || retainedArena === undefined || resourceAdmission === undefined)
      return undefined;
    const retained = retainProjectionResources({
      frame: gp.retained,
      batch: rv.projectionBatch,
      instance: gp.arenaInstance,
      program: rv.projectionProgram,
      view: rv.view.work.view.identity,
      renderer: rv.index,
      instanceBytes: rv.instanceBytes,
      historyBytes: rv.historyBytes,
      indirectBytes: gp.indirectWords.byteLength,
      arena: retainedArena,
      admission: resourceAdmission,
    });
    if (retained?.binding !== undefined) {
      const prior = bindingLayouts.get(rv.names.computeBindings);
      plan.nextBindingLayouts.set(
        rv.names.computeBindings,
        prior?.emitter === gp.firstIntent.emitter && prior.resource === retained.binding
          ? prior
          : { emitter: gp.firstIntent.emitter, resource: retained.binding },
      );
    }
    return retained;
  };
  /** Per-view copies of the simulated state the projection consumes. */
  const declareProjectionCopies = (
    gp: GroupPlan,
    rv: RendererView,
    retained: RetainedProjection | undefined,
  ): void => {
    const { names, view } = rv;
    const { resources, passes } = view.work;
    const indirectBytes = gp.indirectWords.byteLength;
    if (retained === undefined)
      resources.push(
        {
          kind: 'buffer',
          name: names.instances,
          size: rv.instanceBytes,
          usage: ['storage', 'vertex'],
        },
        { kind: 'buffer', name: names.history, size: rv.historyBytes, usage: ['storage'] },
        { kind: 'buffer', name: names.aliveIndices, size: gp.capacity * 4, usage: ['storage'] },
        { kind: 'buffer', name: names.counters, size: COUNTERS_BYTES, usage: ['storage'] },
        {
          kind: 'buffer',
          name: names.indirect,
          size: indirectBytes,
          usage: ['storage', 'indirect'],
        },
      );
    passes.push({
      kind: 'copy',
      name: names.copy,
      enabled: gp.renderEnabled && (view.visible || rv.castsShadow),
      copies: [
        { source: gp.names.aliveIndices, destination: names.aliveIndices, size: gp.capacity * 4 },
        { source: gp.names.counters, destination: names.counters, size: COUNTERS_BYTES },
        { source: gp.names.indirect, destination: names.indirect, size: indirectBytes },
        ...(rv.renderer.kind === 'trail'
          ? [{ source: rv.simulationHistory, destination: names.history, size: rv.historyBytes }]
          : []),
      ],
    });
  };
  /** Projection runtime uniform: uploaded into retained storage (and returned) or declared. */
  const declareProjectionRuntime = (
    plan: FramePlan,
    gp: GroupPlan,
    rv: RendererView,
    retained: RetainedProjection | undefined,
  ): ArrayBufferView | undefined => {
    const admission = plan.resourceAdmission;
    const { names, view, renderer } = rv;
    const latest = gp.latest;
    const projectionData =
      latest === undefined
        ? undefined
        : runtimeData(
            retained !== undefined && admission !== undefined ? plan.runtimeScratch : undefined,
            latest.intent,
            view.camera,
            rv.material,
            gp.latestTransform,
            renderer,
            rv.index,
            rv.inputLanes,
            meshDrawRange(renderer, rv.mesh, rv.submesh),
            true,
          );
    if (retained !== undefined && admission !== undefined) {
      if (projectionData !== undefined && retained.runtime !== undefined)
        admission.upload(
          { view: view.work.view.identity },
          retained.runtime.name,
          retained.runtime.offset,
          projectionData,
        );
      return projectionData;
    }
    const { names: groupNames, hasEvents, parameterBytes, customStride } = gp;
    view.work.resources.push(
      {
        kind: 'buffer',
        name: names.runtime,
        size: RUNTIME_BYTES,
        usage: ['uniform'],
        ...(projectionData === undefined ? {} : { data: projectionData }),
      },
      computeBindings(
        plan.nextBindingLayouts,
        names.computeBindings,
        rv.projectionProgram,
        gp.firstIntent,
        () => ({
          0: groupNames.particles,
          1: names.runtime,
          2: names.aliveIndices,
          3: names.counters,
          4: names.indirect,
          5: names.history,
          6: names.instances,
          ...(hasEvents ? { 8: groupNames.projectionEventInputs } : {}),
          ...(parameterBytes === 0 ? {} : { 10: groupNames.parameters }),
          ...(customStride === 0 ? {} : { 11: groupNames.custom }),
          ...gp.dataInterfaces.bindings,
        }),
      ),
    );
    return undefined;
  };
  /** Project simulated particles into this view's instances, as a direct job or a compute pass. */
  const planRendererProjection = (
    plan: FramePlan,
    gp: GroupPlan,
    rv: RendererView,
  ): RetainedProjection | undefined | RenderFeatureStageFailedError => {
    const admission = plan.resourceAdmission;
    if (rv.projectionProgram !== gp.computeProgramName && admission !== undefined) {
      if (gp.preparedProgram === undefined) return planFailure();
      admission.program(
        'frame',
        rv.projectionProgram,
        gp.preparedProgram.program,
        gp.programDeclaration.preparePipelines,
      );
    }
    const retained = retainRendererProjection(plan, gp, rv);
    declareProjectionCopies(gp, rv, retained);
    const runtime = declareProjectionRuntime(plan, gp, rv, retained);
    const dispatches = rv.dispatches;
    const { names, view } = rv;
    const enabled = gp.renderEnabled && (view.visible || rv.castsShadow);
    if (retained?.batch !== undefined && gp.retained !== undefined) {
      if (enabled && runtime !== undefined) {
        const frame = gp.retained;
        const entries = dispatches.map((dispatch) => dispatch.entryPoint);
        let row = directProjectionRows.get(retained);
        if (row?.frame !== frame || !sameEntries(row.entries, entries)) {
          row = {
            frame,
            ranges: Object.freeze([
              requiredRange(frame.byName, gp.names.particles, 'frame'),
              requiredRange(retained.byName, names.aliveIndices, 'view'),
              requiredRange(retained.byName, names.counters, 'view'),
              requiredRange(retained.byName, names.indirect, 'view'),
              requiredRange(retained.byName, names.history, 'view'),
              requiredRange(retained.byName, names.instances, 'view'),
              requiredRange(frame.byName, gp.names.custom, 'frame'),
            ]),
            entries: Object.freeze(entries),
          };
          directProjectionRows.set(retained, row);
        }
        plan.directCompute.projection(view.work.view.identity, {
          program: gp.computeProgramName,
          customStride: gp.customStride,
          ranges: row.ranges,
          entries: row.entries,
          runtime,
        });
      }
    } else if (dispatches.length > 0) {
      view.work.passes.push({
        kind: 'compute',
        name: names.project,
        enabled,
        program: rv.projectionProgram,
        bindings: names.computeBindings,
        dispatches,
      });
    }
    return retained;
  };
  /**
   * Graphics program, bindings and instance stream of one renderer view.
   *
   * Particle draw bindings resolve the renderer-owned View (and scene depth)
   * group or a material group; they carry no player data. Every player of one
   * view whose descriptor has the same content therefore draws with one
   * program and one bindings declaration, named by that content, and only
   * its instance stream and draw record remain per player.
   */
  const declareGraphics = (
    gp: GroupPlan,
    rv: RendererView,
    projectionRuntime: string | undefined,
  ): { readonly program: string; readonly bindings: string[] } => {
    const { names, view, mesh } = rv;
    const identity = view.work.view.identity;
    const cached = names.graphics.get(identity);
    const descriptor = graphicsProgramDescriptor(cached?.descriptor, {
      shader: rv.materialPass.shader,
      preparePipelines: gp.source?.preparePipelines ? true : undefined,
      vertexLayout: rv.vertexLayout,
      particleInputLanes: rv.hasParticleInputs ? rv.inputLanes : undefined,
      colorFormat: view.colorTarget?.format ?? 'rgba8unorm-srgb',
      depthFormat: view.depthTarget?.format,
      sampleCount: view.colorTarget?.sampleCount ?? 1,
      topology: rv.submesh?.topology ?? 'triangle-list',
      indexFormat: mesh?.indices === undefined ? undefined : rv.indexFormat,
      renderState: rv.renderState,
    });
    let program = cached;
    if (program?.descriptor !== descriptor) {
      const key = vfxGraphicsProgramKey(descriptor);
      program = {
        descriptor,
        shared: key === undefined ? undefined : `vfx.graphics.p-${internedId(key)}`,
      };
      names.graphics.set(identity, program);
    }
    view.work.resources.push({
      kind: 'vertex-data',
      name: names.vertexData,
      layout: rv.vertexLayout,
      buffer: names.instances,
    });
    const sceneDepthBinding = rv.sceneDepthBinding;
    const shared = program.shared;
    if (shared !== undefined) return declareSharedGraphics(gp, rv, descriptor, shared);
    view.work.resources.push(
      { kind: 'graphics-program', name: names.graphicsProgram, program: descriptor },
      {
        kind: 'graphics-bindings',
        name: names.graphicsBindings,
        program: names.graphicsProgram,
        values: particleBindingValues(
          names.bindingValues,
          identity,
          projectionRuntime,
          names.instances,
          sceneDepthBinding,
        ),
        ...(sceneDepthBinding !== undefined && view.depthTarget !== undefined
          ? { logicalTargets: { sceneDepth: view.depthTarget.name } }
          : {}),
      },
    );
    const drawBindings = [names.graphicsBindings];
    if (particleMaterialUsesBindings(rv.materialBindingContract))
      drawBindings.push(declareMaterialBindings(gp, rv));
    return { program: names.graphicsProgram, bindings: drawBindings };
  };
  /** One view-shared program, bindings and material bindings per content key. */
  const declareSharedGraphics = (
    gp: GroupPlan,
    rv: RendererView,
    descriptor: GraphicsProgramDescriptor,
    shared: string,
  ): { readonly program: string; readonly bindings: string[] } => {
    const { view } = rv;
    const sceneDepthBinding = rv.sceneDepthBinding;
    let declared = view.work.graphics.get(shared);
    if (declared === undefined) {
      declared = { bindings: new Map(), materials: new Map() };
      view.work.graphics.set(shared, declared);
      view.work.shared.push({ kind: 'graphics-program', name: shared, program: descriptor });
    }
    let bindings = declared.bindings.get(sceneDepthBinding);
    if (bindings === undefined) {
      bindings = `${shared}.bindings${sceneDepthBinding === undefined ? '' : `.d-${sceneDepthBinding}`}`;
      declared.bindings.set(sceneDepthBinding, bindings);
      view.work.shared.push({
        kind: 'graphics-bindings',
        name: bindings,
        program: shared,
        values: viewBindingValues(sceneDepthBinding),
        ...(sceneDepthBinding !== undefined && view.depthTarget !== undefined
          ? { logicalTargets: { sceneDepth: view.depthTarget.name } }
          : {}),
      });
    }
    if (!particleMaterialUsesBindings(rv.materialBindingContract))
      return { program: shared, bindings: [bindings] };
    const world = gp.group.entry.sourceWorldIndex;
    let worldMaterials = declared.materials.get(world);
    if (worldMaterials === undefined) {
      worldMaterials = new Map();
      declared.materials.set(world, worldMaterials);
    }
    const material = rv.renderer.material;
    let materialBindings = worldMaterials.get(material);
    if (materialBindings === undefined) {
      const source = typeof material === 'number' ? `h${material}` : `s${internedId(material)}`;
      materialBindings = `${shared}.material-bindings.w-${world}.${source}`;
      worldMaterials.set(material, materialBindings);
      view.work.shared.push({
        kind: 'graphics-bindings',
        name: materialBindings,
        program: shared,
        values: Object.freeze({ group: 1, material: Object.freeze({ world, handle: material }) }),
      });
    }
    return { program: shared, bindings: [bindings, materialBindings] };
  };
  const declareMaterialBindings = (gp: GroupPlan, rv: RendererView): string => {
    const { names } = rv;
    const world = gp.group.entry.sourceWorldIndex;
    let materialBindings = names.materialBindings.get(world);
    if (materialBindings === undefined) {
      materialBindings = `${names.prefix}.material-bindings.w-${world}`;
      names.materialBindings.set(world, materialBindings);
    }
    rv.view.work.resources.push({
      kind: 'graphics-bindings',
      name: materialBindings,
      program: names.graphicsProgram,
      values: materialBindingValues(names.bindingValues, world, rv.renderer.material),
    });
    return materialBindings;
  };
  /**
   * Mesh geometry belongs to the mesh source, not to the player. Every player
   * of one view that draws the same published mesh with the same vertex
   * layout reads one geometry/index declaration (uploaded once per frame)
   * instead of a private copy each.
   */
  const sharedMeshGeometry = (
    gp: GroupPlan,
    rv: RendererView,
  ): SharedMeshGeometry | RenderFeatureStageFailedError => {
    const { mesh, meshKey } = rv;
    if (mesh === undefined || meshKey === undefined) return planFailure();
    const work = rv.view.work;
    const world = gp.group.entry.worldId;
    const layout = vertexLayoutId(rv.vertexLayout);
    const key = `${world}:${typeof meshKey}:${meshKey}:${layout}`;
    const prior = work.meshGeometry.get(key);
    // One frame resolves one mesh object per world and source key.
    if (prior !== undefined) return prior.mesh === mesh ? prior : planFailure();
    const geometryData = particleMeshVerticesCached(mesh);
    if (geometryData.length === 0) return planFailure();
    const source = typeof meshKey === 'number' ? `h${meshKey}` : `s${internedId(meshKey)}`;
    const prefix = `vfx.w-${world}.mesh-${source}.l-${layout}`;
    const geometryBuffer = `${prefix}.geometry-buffer`;
    const geometry = `${prefix}.geometry`;
    work.shared.push(
      {
        kind: 'buffer',
        name: geometryBuffer,
        size: geometryData.byteLength,
        usage: ['vertex'],
        data: geometryData,
      },
      { kind: 'vertex-data', name: geometry, layout: rv.vertexLayout, buffer: geometryBuffer },
    );
    const indexUpload = particleMeshIndices(mesh);
    let indexData: DrawGeometry['indexData'];
    if (indexUpload !== undefined) {
      const indexBuffer = `${prefix}.index-buffer`;
      const indices = `${prefix}.indices`;
      work.shared.push(
        {
          kind: 'buffer',
          name: indexBuffer,
          size: indexUpload.byteLength,
          usage: ['index'],
          data: indexUpload,
        },
        { kind: 'index-data', name: indices, format: rv.indexFormat, buffer: indexBuffer },
      );
      indexData = { resource: indices, format: rv.indexFormat };
    }
    const shared: SharedMeshGeometry = {
      mesh,
      geometry,
      ...(indexData === undefined ? {} : { indexData }),
    };
    work.meshGeometry.set(key, shared);
    return shared;
  };
  /** Vertex and index streams of one renderer view; mesh renderers read their shared geometry. */
  const declareDrawGeometry = (
    gp: GroupPlan,
    rv: RendererView,
  ): DrawGeometry | RenderFeatureStageFailedError => {
    const { names } = rv;
    if (rv.renderer.kind !== 'mesh')
      return { vertexData: [{ slot: 0, resource: names.vertexData }] };
    const shared = sharedMeshGeometry(gp, rv);
    if (shared instanceof RenderFeatureStageFailedError) return shared;
    const vertexData = [
      { slot: 0, resource: shared.geometry },
      { slot: 1, resource: names.vertexData },
    ];
    return shared.indexData === undefined
      ? { vertexData }
      : { vertexData, indexData: shared.indexData };
  };
  const indirectDraw = (rv: RendererView, geometry: DrawGeometry): RasterDraw['draw'] => ({
    kind: geometry.indexData === undefined ? 'draw-indirect' : 'draw-indexed-indirect',
    resource: rv.names.indirect,
    offset: rv.index * 20,
  });
  const declareShadowCaster = (
    gp: GroupPlan,
    rv: RendererView,
    projectionRuntime: string | undefined,
    geometry: DrawGeometry,
  ): void => {
    const { names, view } = rv;
    view.work.resources.push(
      {
        kind: 'graphics-program',
        name: names.shadowProgram,
        program: {
          shader: 'forgeax::vfx-render.particles.mesh-shadow',
          ...(gp.source?.preparePipelines ? { preparePipelines: true } : {}),
          vertexLayout: rv.vertexLayout,
          ...(rv.hasParticleInputs ? { particleInputLanes: rv.inputLanes } : {}),
          colorFormats: [],
          depthFormat: 'depth32float',
          topology: rv.submesh?.topology ?? 'triangle-list',
          ...(rv.mesh?.indices === undefined ? {} : { indexFormat: rv.indexFormat }),
          renderState: { depthWriteEnabled: true, cullMode: 'none' },
        },
      },
      {
        kind: 'graphics-bindings',
        name: names.shadowBindings,
        program: names.shadowProgram,
        values: particleBindingValues(
          names.bindingValues,
          `shadow:${rv.view.work.view.identity}`,
          projectionRuntime,
          names.instances,
          undefined,
        ),
      },
    );
    view.work.passes.push({
      kind: 'shadow-caster',
      name: names.shadow,
      enabled: gp.renderEnabled,
      draws: [
        {
          program: names.shadowProgram,
          bindings: [names.shadowBindings],
          ...geometry,
          draw: indirectDraw(rv, geometry),
        },
      ],
    });
  };
  const rasterPass = (
    rv: RendererView,
    graphics: { readonly program: string; readonly bindings: string[] },
    geometry: DrawGeometry,
  ): RasterPass => {
    const { names, view } = rv;
    const { depthTarget } = view;
    const attachments = view.work.attachments;
    return {
      kind: 'raster',
      enabled: view.visible,
      name: names.raster,
      colorAttachments: attachments.color,
      ...(attachments.depth === undefined ? {} : { depthStencilAttachment: attachments.depth }),
      ...(rv.sceneDepthBinding !== undefined && depthTarget !== undefined
        ? {
            sampledTargets: attachments.sampled ?? [depthTarget.name],
            ...(rv.sceneDepthVersion === undefined ? {} : { sceneDepth: rv.sceneDepthVersion }),
          }
        : {}),
      draws: [
        {
          program: graphics.program,
          bindings: graphics.bindings,
          ...geometry,
          draw: indirectDraw(rv, geometry),
        },
      ],
    };
  };
  const planRendererView = (
    plan: FramePlan,
    gp: GroupPlan,
    rv: RendererView,
  ): RenderFeatureStageFailedError | undefined => {
    const projection = planRendererProjection(plan, gp, rv);
    if (projection instanceof RenderFeatureStageFailedError) return projection;
    const projectionRuntime = projection?.batch === undefined ? rv.names.runtime : undefined;
    const graphics = declareGraphics(gp, rv, projectionRuntime);
    const geometry = declareDrawGeometry(gp, rv);
    if (geometry instanceof RenderFeatureStageFailedError) return geometry;
    if (rv.castsShadow) declareShadowCaster(gp, rv, projectionRuntime, geometry);
    const work = rv.view.work;
    (rv.renderState?.blend === undefined ? work.opaque : work.blended).push(
      rasterPass(rv, graphics, geometry),
    );
    return undefined;
  };
  const planGroupView = (
    plan: FramePlan,
    gp: GroupPlan,
    work: ViewWork,
    camera: ParticleRenderCamera,
  ): RenderFeatureStageFailedError | undefined => {
    const latest = gp.latest;
    const view: GroupView = {
      work,
      camera,
      colorTarget: work.colorTarget,
      depthTarget: work.depthTarget,
      visible:
        gp.renderEnabled &&
        latest !== undefined &&
        plan.resolution.emitterVisible(latest.intent.emitter, camera, gp.latestTransform) &&
        latest.visible,
    };
    for (let rendererIndex = 0; rendererIndex < gp.renderers.length; rendererIndex++) {
      const renderer = gp.renderers[rendererIndex] as (typeof gp.renderers)[number];
      // Disabled entries remain in the cooked renderer index space but do
      // not acquire projection, graphics, or shadow resources.
      if (renderer.enabled === false) continue;
      const rv = describeRendererView(plan, gp, view, rendererIndex, renderer);
      if (rv instanceof RenderFeatureStageFailedError) return rv;
      const failure = planRendererView(plan, gp, rv);
      if (failure !== undefined) return failure;
    }
    return undefined;
  };
  const planGroupViews = (
    plan: FramePlan,
    gp: GroupPlan,
  ): RenderFeatureStageFailedError | undefined => {
    // Older programs still simulate and acknowledge their ordered ticks,
    // but only this stream's final admitted program can be presented.
    if (gp.group.stream.lastGroup !== gp.group.key) return undefined;
    for (const work of plan.viewWork) {
      const camera =
        work.view.selectedView ??
        gp.group.entry.views.find((entry) => entry.identity === work.view.identity)?.camera;
      if (camera === undefined) continue;
      const failure = planGroupView(plan, gp, work, camera);
      if (failure !== undefined) return failure;
    }
    return undefined;
  };
  /** Declare one group's storage, simulation ticks and per-view draws, recording its declaration ranges. */
  const planGroup = (
    plan: FramePlan,
    group: EmitterGroup,
  ): RenderFeatureStageFailedError | undefined => {
    const resourceStarts = plan.resourceArrays.map((array) => array.length);
    const executionStarts =
      plan.retainedArena === undefined
        ? undefined
        : plan.executionArrays.map((array) => array.length);
    const firstIntent = group.intents[0]?.intent ?? group.preparation;
    if (firstIntent === undefined) return undefined;
    const facts = describeGroup(plan, group, firstIntent);
    if (facts instanceof RenderFeatureStageFailedError) return facts;
    const dataInterfaces = planGroupDataInterfaces(plan, facts);
    if (dataInterfaces instanceof RenderFeatureStageFailedError) return dataInterfaces;
    const indirectWords = groupIndirectWords(facts.emitterFacts, facts.renderers, facts.meshes);
    if (indirectWords === undefined) return planFailure();
    const programDeclaration = declareComputeProgram(plan, facts);
    const emitter = group.program.resource;
    emitter.tickCapacity = Math.max(emitter.tickCapacity, group.intents.length, 1);
    // Provider-owned data-interface resources keep per-frame declarations.
    const retained =
      dataInterfaces.resources.length === 0
        ? retainGroupStorage(plan, facts, programDeclaration, indirectWords)
        : undefined;
    // The facts object becomes the group plan: one record per group and plan.
    const gp = Object.assign(facts, {
      dataInterfaces,
      indirectWords,
      programDeclaration,
      retained,
    }) as GroupPlan;
    if (retained === undefined) declareGroupStorage(plan, gp);
    declareTrailHistory(plan, gp);
    plan.resetZeroBytes = Math.max(plan.resetZeroBytes, facts.emitterFacts.resetZeroBytes);
    const tickFailure =
      retained?.batch !== undefined
        ? planDirectTicks(plan, gp, retained)
        : planTickPasses(plan, gp);
    if (tickFailure !== undefined) return tickFailure;
    const viewFailure = planGroupViews(plan, gp);
    if (viewFailure !== undefined) return viewFailure;
    plan.resourceRanges.push({
      key: group.key,
      starts: resourceStarts,
      ends: plan.resourceArrays.map((array) => array.length),
    });
    if (executionStarts !== undefined)
      plan.executionRanges.set(group.key, {
        starts: executionStarts,
        ends: plan.executionArrays.map((array) => array.length),
      });
    return undefined;
  };
  /**
   * Restore authored command order after sorted arena allocation, then
   * finish shared declarations and coalesce compute, copy and raster work.
   */
  const finishPlanOrder = (plan: FramePlan, originalGroups: readonly EmitterGroup[]): void => {
    // Allocate cold slots in the same sorted declaration order as the Arena
    // owner, then restore the original command and transparent draw order.
    if (plan.retainedArena !== undefined) {
      const frameIndices = restoreGroupDeclarationOrder(
        plan.executionArrays,
        plan.executionRanges,
        originalGroups,
      );
      for (const stream of plan.streams.values())
        if (stream.ranges !== undefined) remapTickPassRanges(stream.ranges, frameIndices);
    }
    reorderStreamTickBlocks(plan.passes, plan.streams.values());
    // View passes retain authored stream order for premultiplied-alpha composition.
    sortGroupDeclarations(plan.resourceArrays, plan.resourceRanges);
    for (const work of plan.viewWork) {
      if (work.shared.length === 0) continue;
      work.shared.sort(compareSharedDeclarations);
      for (const resource of work.shared) work.resources.push(resource);
    }
    if (plan.resetZeroBytes > 0)
      plan.resources.push({
        kind: 'buffer',
        name: RESET_ZERO,
        size: plan.resetZeroBytes,
        usage: ['copy-src'],
      });
    const bindingsOf = (name: string) => plan.nextBindingLayouts.get(name)?.resource;
    coalesceComputeWork(plan.passes, plan.privateComputePrograms, bindingsOf);
    for (const work of plan.viewWork)
      coalesceComputeWork(work.passes, plan.privateComputePrograms, bindingsOf);
    plan.directCompute.finishFrame(plan.resources, plan.passes);
    for (const work of plan.viewWork)
      plan.directCompute.finishView(work.view.identity, work.resources, work.passes);
    // All emitters share each view's color/depth targets. Finish projection
    // and opaque coverage before blending, regardless of Player spawn order.
    // Keep authored ordering within each group and GPU particle sorting intact.
    for (const work of plan.viewWork)
      work.passes.push(
        ...coalesceVfxRasterPasses(work.opaque, 'opaque'),
        ...coalesceVfxRasterPasses(work.blended, 'blended'),
      );
  };
  const pendingEntry = (
    plan: FramePlan,
    entry: ExtractedWorld,
    observation: VfxRenderObservation,
    requiredPasses: readonly string[],
  ): PendingEntry => ({
    source: entry,
    generation: plan.resolution.context.generation,
    outcomes:
      plan.outcomesByEntry.get(entry) ??
      entry.intents.map((intent) => ({ intent, state: 'deferred' as const })),
    observation,
    requiredPasses,
    // Device state is rebuilt only when this plan saw the full retained roster.
    rebuilt: !plan.resolution.missingRetained.has(entry.runtimeId),
  });
  const sourceFeedback = (plan: FramePlan, entry: ExtractedWorld) => {
    const outcomes = plan.outcomesByEntry.get(entry) ?? [];
    return {
      runtimeId: entry.runtimeId,
      renderGeneration: entry.renderGeneration,
      visibility: [...entry.emitterState.values()].map((state) => ({
        player: state.player,
        emitter: state.emitter.id,
        visible: entry.views.some((view) =>
          plan.resolution.emitterVisible(state.emitter, view.camera, state.localToWorld),
        ),
      })),
      acknowledged: outcomes
        .filter((row) => row.state !== 'deferred')
        .map((row) => row.intent.sequence),
      published: outcomes
        .filter((row) => row.state === 'dispatched')
        .map((row) => row.intent.sequence),
      missingRetained: plan.resolution.missingRetained.get(entry.runtimeId) ?? [],
      missingIntents: plan.resolution.missingIntents.get(entry.runtimeId) ?? [],
    };
  };
  /** Only our generated metadata is retained, after every source read. */
  const retainBufferLayouts = (
    nextBufferLayouts: Map<string, StaticBuffer>,
    declarations: PlanResource[],
  ): void => {
    for (let index = 0; index < declarations.length; index += 1) {
      const resource = declarations[index];
      // Upload declarations keep their current bytes and ordinary lifetime.
      if (
        resource?.kind !== 'buffer' ||
        Object.hasOwn(resource, 'data') ||
        Object.hasOwn(resource, 'uploads')
      )
        continue;
      const previous = nextBufferLayouts.get(resource.name) ?? bufferLayouts.get(resource.name);
      const retained =
        previous !== undefined &&
        previous.size === resource.size &&
        previous.usage.length === resource.usage.length &&
        previous.usage.every((usage, index) => usage === resource.usage[index])
          ? previous
          : ownRenderFeatureProgramData(resource);
      nextBufferLayouts.set(resource.name, retained);
      declarations[index] = retained;
    }
  };
  /** Record the pending submission, publish source feedback, and hand the work to the Host. */
  const publishPlan = (plan: FramePlan): RenderFeaturePlan => {
    const { frame, nativePlan } = plan;
    const { context } = plan.resolution;
    const observation = planObservation(frame.frameNumber, [
      plan.passes,
      ...plan.viewWork.map((work) => work.passes),
    ]);
    // Every entry of one frame requires the same enabled frame passes.
    const requiredPasses: string[] = [];
    for (const pass of plan.passes) if (pass.enabled !== false) requiredPasses.push(pass.name);
    pendingFrames.set(frame.frameNumber, {
      entries: frame.worlds.map((entry) => pendingEntry(plan, entry, observation, requiredPasses)),
      fields: [...plan.fieldNames],
      generation: context.generation,
    });
    const feedback = frame.worlds.map((entry) => sourceFeedback(plan, entry));
    for (const key of receivedRetained.keys())
      if (!plan.resolution.liveRetained.has(key)) receivedRetained.delete(key);
    recentQueued.endFrame();
    // Bound templates to the current successful producer roster. A removed
    // player or replaced program cannot keep its layouts alive indefinitely.
    spareBindingLayouts = bindingLayouts;
    bindingLayouts = plan.nextBindingLayouts;
    const nextBufferLayouts = spareBufferLayouts;
    nextBufferLayouts.clear();
    const work: import('@forgeax/engine-render').RenderFeatureWork[] = [
      {
        scope: 'frame',
        resources: [
          ...plan.sharedDataInterfaces.values(),
          ...[...plan.sharedComputePrograms]
            .sort((a, b) => a[0] - b[0])
            .map(([, resource]) => resource),
          ...plan.resources,
        ],
        passes: plan.passes,
      },
      ...plan.viewWork.map(({ view, resources, passes }) => ({
        scope: { view: view.identity },
        resources,
        passes,
      })),
    ];
    const packed =
      packArenas?.({
        work:
          nativePlan === undefined ? work : work.map((row) => shareVfxGraphicsPrograms(row, true)),
        transferPasses: nativePlan !== undefined,
        instances: plan.arenaInstances,
        liveOwners: plan.liveArenaOwners,
        generation: context.generation,
        ...(context.limits === undefined ? {} : { limits: context.limits }),
      }) ?? work;
    for (const row of packed)
      retainBufferLayouts(nextBufferLayouts, row.resources as PlanResource[]);
    spareBufferLayouts = bufferLayouts;
    bufferLayouts = nextBufferLayouts;
    return nativePlan === undefined
      ? { work: packed, sourceFeedback: feedback }
      : nativePlan.finish(packed, feedback, { batchReadOnlyDepthRaster: true });
  };
  const feature: VfxParticleRenderFeature = {
    identity: IDENTITY,
    ...(options.isolateViewGraph === true ? { viewGraph: 'transient' as const } : {}),
    requiredCapabilities: ['compute', 'indirectDrawing'],
    // Generated emitter programs are first-use assets. They must hand a
    // WebGPU module to the prepared feature pipeline without waiting for the
    // diagnostic-only getCompilationInfo() round trip; pipeline creation still
    // validates the module before the pass is submitted.
    shaderModuleMode: 'immediate',
    requiredMaterialShaders: Object.freeze([
      ...Object.values(PARTICLE_SHADER_IDENTIFIERS),
      ...Object.values(PARTICLE_UNLIT_MESH_SHADER_IDENTIFIERS),
      ...Object.values(PARTICLE_INPUT_SHADER_IDENTIFIERS),
    ]),
    extract: (context) => {
      const emitterVisible = createEmitterVisibility();
      // A rejected recovery candidate can outlive the frame that produced it.
      // Keep the producer-owned submission ledger bounded even when a host
      // disappears before it can call onFrameAborted.
      for (const frameNumber of pendingFrames.keys()) {
        if (frameNumber + 4 < context.frameNumber) pendingFrames.delete(frameNumber);
      }
      sourceRuntimes.clear();
      // A new receiver session starts with empty caches: adopt and send everything again.
      if (context.receiverSession !== receiverSession) {
        receiverSession = context.receiverSession;
        adoptedRetained.clear();
        intentPublication.reset();
      }
      const extracted: PublishedWorld[] = [];
      const queuedSessions = new Map<string, Set<string>>();
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
        const preparationPlayers = new Set<EntityHandle>();
        const emitterState = new Map<string, PublishedEmitterState>();
        const sourceWorldIndex = context.worlds.indexOf(world);
        // Every emitter of one effect references the same asset version; the
        // publisher's version ledger needs it once per extracted frame.
        const effectVersions = new Map<VfxGpuEffectAsset, { handle: number; revision: number }>();
        const emitterReference = (
          effect: VfxGpuEffectAsset,
          emitter: VfxGpuTickIntent['emitter'],
        ): Pick<PublishedIntent, 'emitter'> => {
          let version = effectVersions.get(effect);
          if (version === undefined) {
            version = runtime.effectVersion(effect);
            context.referenceAssetVersion?.(sourceWorldIndex, { ...version, value: effect });
            effectVersions.set(effect, version);
          }
          return {
            emitter: { effect: version.handle, revision: version.revision, id: emitter.id },
          };
        };
        // Player rows are read once per extracted frame and shared by every
        // emitter of the player: the ECS state cannot change during extract.
        interface PlayerFacts {
          readonly preparePipelines: boolean;
          readonly prepareOnly: boolean;
          readonly consumed: boolean;
          /** Published copy of the Scene world transform, shared read-only by the player's rows. */
          world: Float32Array | undefined;
          worldSource: Float32Array | undefined;
        }
        const playerFacts = new Map<EntityHandle, PlayerFacts>();
        const factsOf = (player: EntityHandle): PlayerFacts => {
          let facts = playerFacts.get(player);
          if (facts === undefined) {
            const intent = world.get(player, ParticleEffectPlayer);
            facts = {
              preparePipelines: intent.ok && intent.value.preparePipelines,
              prepareOnly: intent.ok && intent.value.preparePipelines && !intent.value.playing,
              consumed: options.playerConsumption?.isEnabled(world, player) ?? true,
              world: undefined,
              worldSource: undefined,
            };
            playerFacts.set(player, facts);
          }
          return facts;
        };
        const playerTransforms = new Map<EntityHandle, Float32Array>();
        /** Scene world transform of one player, read once per extracted frame. */
        const playerWorld = (player: EntityHandle): Float32Array => {
          let transform = playerTransforms.get(player);
          if (transform === undefined) {
            const read = world.get(player, GlobalTransform);
            transform = read.ok ? read.value.world : IDENTITY_MATRIX;
            playerTransforms.set(player, transform);
          }
          return transform;
        };
        let identityCopy: Float32Array | undefined;
        /** Snapshot of one emitter transform; identical sources share one published copy. */
        const publishedTransform = (player: EntityHandle, localToWorld: Float32Array) => {
          if (localToWorld === IDENTITY_MATRIX) {
            identityCopy ??= new Float32Array(IDENTITY_MATRIX);
            return identityCopy;
          }
          const facts = factsOf(player);
          if (facts.world === undefined || facts.worldSource !== localToWorld) {
            facts.world = new Float32Array(localToWorld);
            facts.worldSource = localToWorld;
          }
          return facts.world;
        };
        const publishFields = (input: SourceVfxGpuTickIntent['forceFields']) => {
          if (input?.ok)
            for (const texture of runtime.fieldTextureVersions(input.value))
              context.referenceAssetVersion?.(context.worlds.indexOf(world), {
                handle: texture.handle,
                revision: texture.revision,
                value: texture.value,
              });
        };
        const publishIntent = ({
          effect,
          emitter,
          ...intent
        }: SourceVfxGpuTickIntent): PublishedIntent => {
          publishFields(intent.forceFields);
          return { ...intent, ...emitterReference(effect, emitter) };
        };
        const materials = new Map<ParticleRenderer['material'], ExtractedMaterial>();
        const captureMaterials = options.material?.captureFrame?.(world) === true;
        const meshes = new Map<string | number, MeshAsset | number>();
        let meshFailure: RenderFeatureStageFailedError | undefined;
        const captureEmitter = (
          player: EntityHandle,
          emitter: VfxGpuTickIntent['emitter'],
          effect: VfxGpuEffectAsset,
          localToWorld: Float32Array,
          instanceGeneration = 0,
          forceFields?: SourceVfxGpuTickIntent['forceFields'],
        ) => {
          publishFields(forceFields);
          const facts = factsOf(player);
          const prepareOnly = facts.prepareOnly;
          if (prepareOnly) preparationPlayers.add(player);
          emitterState.set(`${Number(player)}:${emitter.id}`, {
            player,
            ...emitterReference(effect, emitter),
            ...(forceFields === undefined ? {} : { forceFields }),
            ...(facts.preparePipelines ? { preparePipelines: true } : {}),
            ...(prepareOnly
              ? {
                  prepareOnly: true,
                  programFingerprint: effect.program.fingerprint,
                  instanceGeneration,
                }
              : {}),
            enabled: facts.consumed && runtime.isEmitterSessionEnabled(player, emitter.id),
            localToWorld: publishedTransform(player, localToWorld),
          });
          captureResources(player, emitter);
        };
        const captureResources = (player: EntityHandle, emitter: VfxGpuTickIntent['emitter']) => {
          for (const renderer of emitter.renderers) {
            const material =
              captureMaterials && materials.has(renderer.material)
                ? undefined
                : options.material?.read(world, renderer.material);
            if (material !== undefined) {
              const projection = projectParticleMaterial(
                options.material,
                world,
                material,
                context.materialContext,
              );
              let asset = material;
              const cooked =
                context.referenceAsset === undefined
                  ? undefined
                  : Object.getOwnPropertyDescriptor(material, 'cooked');
              const reference =
                captureMaterials || (cooked?.enumerable === true && 'value' in cooked)
                  ? context.referenceAsset?.(sourceWorldIndex, renderer.material, material)
                  : undefined;
              // Cooked programs already cross through the exact asset/program closure.
              // Keep every authored field fresh; custom providers retain their full payload.
              if (cooked?.enumerable === true && 'value' in cooked && reference !== undefined) {
                asset = { ...material };
                delete (asset as MaterialAsset & { cooked?: unknown }).cooked;
              }
              materials.set(renderer.material, {
                asset,
                ...(projection === undefined ? {} : { projection }),
              });
            }
            if (renderer.kind === 'mesh') {
              if (typeof renderer.mesh !== 'object') {
                const mesh = options.mesh?.read(world, renderer.mesh);
                if (mesh !== undefined)
                  meshes.set(
                    renderer.mesh,
                    context.referenceAsset?.(sourceWorldIndex, renderer.mesh, mesh) ?? mesh,
                  );
              } else {
                const filter = world.get(player, MeshFilter);
                const mesh = filter.ok
                  ? runtimeAssets(world.assets).resolveAsset<MeshAsset>(filter.value.assetHandle)
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
                    `player:${player}`,
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
        runtime.forEachEmitterSource(
          world,
          ({ player, emitter, effect, instanceGeneration, forceFields }) => {
            const sourceIntent = runtime.lastCommittedEmitter(player, emitter.id);
            const localToWorld =
              (sourceIntent?.emitter ?? emitter).space === 'world'
                ? IDENTITY_MATRIX
                : playerWorld(player);
            const visible = visibleInAnyView(emitter, localToWorld);
            captureEmitter(player, emitter, effect, localToWorld, instanceGeneration, forceFields);
            const intent = runtime.lastCommittedEmitter(player, emitter.id);
            if (intent !== undefined && !preparationPlayers.has(player)) {
              // Retained queued work owns its previous geometry and material leases.
              if (intent.emitter !== emitter) captureResources(player, intent.emitter);
              // Field texture versions stay referenced even when the receiver
              // already holds this exact intent.
              const published = publishIntent(intent);
              const adopted =
                adoptedRetained.get(
                  retainedStreamKey(
                    runtimeId(runtime),
                    runtime.renderGeneration ?? 0,
                    player,
                    intent.emitter.id,
                  ),
                ) === intent.sequence;
              retained.push({
                player,
                ...emitterReference(intent.effect, intent.emitter),
                intentSequence: intent.sequence,
                ...(adopted ? {} : { intent: published }),
                localToWorld: publishedTransform(player, localToWorld),
                visible,
              });
            }
          },
        );
        // Keep every queued intent in the extracted frame.  Plan assigns each
        // intent an explicit terminal state (dispatched/skipped/deferred), so a
        // filtered head can never block an acknowledged tail or be silently
        // removed by a later global commit.
        const intents = runtime.snapshot();
        for (const intent of intents) {
          // A parked player keeps only its current resource intent. Queued
          // ticks remain below for exact acknowledgement, never stale metadata.
          if (preparationPlayers.has(intent.player)) continue;
          const localToWorld =
            intent.emitter.space === 'world' ? IDENTITY_MATRIX : playerWorld(intent.player);
          captureEmitter(
            intent.player,
            intent.emitter,
            intent.effect,
            localToWorld,
            0,
            intent.forceFields,
          );
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
          // Field intents carry exact per-tick texture versions and are always published.
          intents: publishQueuedIntents(
            intentPublication,
            queuedSessions,
            `${runtimeId(runtime)}:${runtime.renderGeneration ?? 0}`,
            intents,
            publishIntent,
            (intent) => !intent.forceFields,
            context.frameNumber,
          ),
          preparationPlayers: [...preparationPlayers],
          retained,
          emitterState,
          materials,
          meshes,
        });
      }
      intentPublication.retain(queuedSessions);
      return ok({ worlds: extracted, frameNumber: context.frameNumber });
    },
    assetDependencies: (frame) => [
      ...new Set(
        frame.worlds.flatMap((world) => [
          ...world.materials.keys(),
          ...[...world.meshes.values()].filter((mesh): mesh is number => typeof mesh === 'number'),
        ]),
      ),
    ],
    requiresPreparation: (frame) => {
      for (const world of frame.worlds)
        for (const source of world.emitterState.values())
          if (source.preparePipelines === true) return true;
      return false;
    },
    plan: (sourceFrame, context) => {
      // Retained writes consume bytes now; declaration payloads remain independent.
      const runtimeScratch = createRuntimeStorage();
      const emitterVisible = createEmitterVisibility();
      packArenas?.discardRetainedFrame();
      planSerial += 1;
      const resolution: FrameResolution = {
        context,
        emitterVisible,
        liveRetained: new Set(),
        missingRetained: new Map(),
        missingIntents: new Map(),
        keys: new Map(),
      };
      let frame: ExtractedFrame;
      try {
        frame = {
          ...sourceFrame,
          worlds: sourceFrame.worlds.map((entry) => resolveWorld(resolution, entry)),
        };
      } catch (cause) {
        return err(planFailure(cause));
      }
      retireAbsentState(frame);
      const plan = createFramePlan(resolution, frame, runtimeScratch);
      for (const entry of frame.worlds) {
        const failure = classifyQueuedIntents(plan, entry);
        if (failure !== undefined) return err(failure);
      }
      for (const entry of frame.worlds) {
        const failure = keepRetainedGroups(plan, entry);
        if (failure !== undefined) return err(failure);
      }
      for (const entry of frame.worlds) addPreparationGroups(plan, entry);
      collectArenaOwners(plan);
      pruneStreamOwners(plan.liveArenaOwners);
      plan.retainedArena =
        plan.resourceAdmission === undefined
          ? undefined
          : packArenas?.beginRetainedFrame({
              liveOwners: plan.liveArenaOwners,
              generation: context.generation,
              ...(context.limits === undefined ? {} : { limits: context.limits }),
            });
      // Declaration order can be stable without changing pass execution order.
      // These ranges belong to this producer's private arrays; no author names,
      // getters or metadata are inspected to establish the group identity.
      // New GPU buffers are zero initialized. One immutable source serves all
      // reset copies without per-emitter mirrors or CPU zero-array uploads.
      const originalGroups = [...plan.groups.values()];
      const orderedGroups =
        plan.retainedArena === undefined ? originalGroups : [...originalGroups].sort(compareKeys);
      for (const group of orderedGroups) {
        const failure = planGroup(plan, group);
        if (failure !== undefined) return err(failure);
      }
      finishPlanOrder(plan, originalGroups);
      return ok<RenderFeaturePlan>(publishPlan(plan));
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
        // Device rebuild replays every retained stream at once. Keep rebuilding
        // until a submitted frame planned the full roster, including resends.
        if (entry.rebuilt) state.submittedDeviceGeneration = entry.generation;
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
          submission === undefined ? planned : submittedObservation(frame.frameNumber, submission);
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
        missingRetained?: string[];
        missingIntents?: number[];
      }[]) {
        const source = frame.worlds.find((entry) => entry.runtimeId === row.runtimeId);
        intentPublication.forget(
          `${row.runtimeId}:${row.renderGeneration}`,
          row.missingIntents ?? [],
        );
        if (source !== undefined) {
          adoptSubmittedRetained(adoptedRetained, source, row.published, row.missingRetained ?? []);
        }
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
    onSourceFrameDiscarded: (frame) => intentPublication.discard(frame.frameNumber),
    onFrameAborted: (frame) => {
      pendingFrames.delete(frame.frameNumber);
    },
    inspect: () => lastObservation,
  };
  return feature;
}
