import type { EntityHandle } from '@forgeax/engine-ecs';
import type { RenderFeaturePlanContext } from '@forgeax/engine-render';
import { isOwnedRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import type { Result } from '@forgeax/engine-types';
import type { VfxForceFieldError, VfxGpuEffectAsset } from '@forgeax/engine-vfx';
import type { createVfxForceFieldPreparation, PreparedVfxForceFields } from './force-fields.js';
import {
  type ExtractedWorld,
  immutableEmitters,
  ownEmitter,
  type ParticleRenderer,
  type PublishedEmitter,
  type PublishedIntent,
  resolveEffect,
  resolveIntent,
  type VfxGpuTickIntent,
} from './gpu-particle-publication.js';
import type { VfxRenderObservation } from './inspect.js';
import type { VfxArenaInstance } from './instance-arena.js';
import { isVfxIntentReference, type VfxIntentReference } from './intent-publication.js';
import type { BindingValues, GraphicsProgramDescriptor } from './plan-memos.js';
import type { TickPassRange } from './plan-order.js';
import type { RetainedEmitterResources } from './retained-emitter-resources.js';
import type { VfxValidatedStagePlan } from './stage-plan.js';
import type { TickCapacityState } from './tick-capacity.js';

/** Receiver-owned stream identities, exact-version resolution, and stable resource names. */
export type IntentOutcomeState = 'dispatched' | 'skipped' | 'deferred';

export interface PlannedIntent {
  readonly intent: VfxGpuTickIntent;
  readonly localToWorld: Float32Array;
  readonly stagePlan: VfxValidatedStagePlan;
  /** Camera projection is optional for `simulationWhenCulled: continue`. */
  readonly visible: boolean;
  /** Retained state has no tick simulation/history work this frame. */
  readonly retained: boolean;
}

export interface EmitterStream {
  lastGroup: string;
  /** Only program changes in this plan need command-order reconciliation. */
  ranges: TickPassRange[] | undefined;
}

export interface EmitterPreparation {
  readonly forceFields?: Result<PreparedVfxForceFields, VfxForceFieldError>;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuTickIntent['emitter'];
  readonly programFingerprint: string;
  readonly instanceGeneration: number;
  readonly localToWorld: Float32Array;
}

export interface EmitterGroup {
  readonly key: string;
  readonly record: StreamRecord;
  readonly program: ProgramRecord;
  readonly entry: ExtractedWorld;
  readonly intents: PlannedIntent[];
  readonly preparation?: EmitterPreparation;
  readonly stream: EmitterStream;
}

export interface IntentOutcome {
  readonly intent: VfxGpuTickIntent;
  readonly state: IntentOutcomeState;
}

export interface PendingEntry {
  readonly source: ExtractedWorld;
  readonly generation: number;
  readonly outcomes: readonly IntentOutcome[];
  readonly observation: VfxRenderObservation;
  readonly requiredPasses: readonly string[];
  /** False when a retained stream was missing, so its device state was not rebuilt. */
  readonly rebuilt: boolean;
}

export interface RuntimeState {
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

export interface EmitterResourceState extends TickCapacityState {
  readonly id: number;
  resources?: RetainedEmitterResources;
  /** Last plan serial that referenced this stream program. */
  seen: number;
}

export interface GroupNames {
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

export interface TickNames {
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

export interface RendererNames {
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
    materialBindings: string | undefined;
    /** Last graphics program descriptor per view; reused while its inputs match. */
    readonly graphics: Map<string, ViewGraphicsProgram>;
    /** Last frozen binding values per view and role; reused while they match. */
    readonly bindingValues: Map<string, BindingValues>;
  };
}

export interface ViewGraphicsProgram {
  readonly descriptor: GraphicsProgramDescriptor;
  readonly shared: string | undefined;
}

export interface SharedViewProgram {
  /** Graphics bindings name per scene-depth binding slot (view/light group 0). */
  readonly bindings: Map<0 | 1 | undefined, string>;
  /** Material bindings name per source world and material reference (group 1). */
  readonly materials: Map<ParticleRenderer['material'], string>;
}

export interface ProgramRecord {
  readonly key: string;
  readonly resourceKey: string;
  readonly resource: EmitterResourceState;
  names?: GroupNames;
  /** Arena instance per compute-program name; identity-stable for repacking. */
  readonly instances: Map<string, VfxArenaInstance>;
}

export interface StreamRecord {
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

export interface StreamKeyCache {
  readonly worldId: number;
  readonly renderGeneration: number;
  readonly groupPrefix: string;
  readonly players: Map<number, Map<string, StreamRecord>>;
}

export interface ResolvedEffect {
  readonly effect: VfxGpuEffectAsset;
  readonly emitters: Map<string, VfxGpuTickIntent['emitter']>;
  seen: number;
}

export interface ResolvedIntent {
  readonly effect: VfxGpuEffectAsset;
  readonly intent: VfxGpuTickIntent;
  seen: number;
}

export interface ResolutionCache {
  readonly renderGeneration: number;
  readonly device: number;
  serial: number;
  readonly effects: Map<number, Map<number, ResolvedEffect>>;
  readonly intents: Map<number, ResolvedIntent>;
}

export const planResolver = (
  state: RuntimeState,
  renderGeneration: number,
  context: RenderFeaturePlanContext,
  prepareFields: ReturnType<typeof createVfxForceFieldPreparation>,
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
    const effect = resolveEffect(reference, context);
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
      return resolveIntent(published, context, prepareFields);
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
      for (const [revision, row] of revisions) if (row.seen !== serial) revisions.delete(revision);
      if (revisions.size === 0) effects.delete(handle);
    }
  };
  return { emitter, intent, finish };
};

export const groupNames = (program: ProgramRecord): GroupNames => {
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
export const tickNames = (program: ProgramRecord, tick: number, renderers: number): TickNames => {
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
export const rendererNames = (program: ProgramRecord, renderer: number): RendererNames => {
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
        materialBindings: undefined,
        graphics: new Map(),
        bindingValues: new Map(),
      },
    };
    names.renderers[renderer] = row;
  }
  return row;
};
