import { type AssetVersion, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import {
  Disabled,
  type EntityHandle,
  FixedUpdate,
  Time,
  Update,
  type World,
} from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import type { Plugin } from '@forgeax/engine-plugin';
import type { AssetHandle, Result, TextureAsset } from '@forgeax/engine-types';
import { unpackSlot } from '@forgeax/engine-types';
import type { ParticleEventSource } from './code-source.js';
import type { VfxValueMap } from './effect-contract.js';
import { createVfxEffectContract, type VfxEffectReflection } from './effect-contract.js';
import {
  captureVfxFieldInputs,
  releaseVfxFieldInputs,
  type VfxFieldInputs,
  type VfxFieldTexture,
} from './force-field-inputs.js';
import type { VfxForceFieldError } from './force-fields.js';
import type { VfxGpuEffectAsset, VfxGpuEmitterProgram } from './gpu-program.js';
import {
  ParticleEffectInstance,
  type VfxChannelCounters,
  type VfxChannelInput,
  type VfxInstanceCommit,
  type VfxReplayInput,
} from './instance.js';
import { ParticleEffectPlayer } from './player.js';

export const VFX_GPU_RUNTIME_RESOURCE_KEY = 'VfxGpuRuntime';

export interface VfxInspectSnapshotInput {
  readonly layoutFingerprint: string;
  readonly parameterGeneration: number;
  readonly patchCount: number;
  readonly dataInterfaces?: unknown;
  readonly channels?: unknown;
  readonly stages?: unknown;
  readonly renderers?: unknown;
  readonly hmr?: unknown;
  readonly gpuTiming?: unknown;
  readonly error?: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  };
}

export function createVfxInspectSnapshot(input: VfxInspectSnapshotInput) {
  return {
    layout: { fingerprint: input.layoutFingerprint },
    values: { generation: input.parameterGeneration, patchCount: input.patchCount },
    ...(input.dataInterfaces === undefined ? {} : { dataInterfaces: input.dataInterfaces }),
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    ...(input.stages === undefined ? {} : { stages: input.stages }),
    ...(input.renderers === undefined ? {} : { renderers: input.renderers }),
    ...(input.hmr === undefined ? {} : { hmr: input.hmr }),
    ...(input.gpuTiming === undefined ? {} : { gpuTiming: input.gpuTiming }),
    ...(input.error === undefined ? {} : { error: input.error }),
  } as const;
}

export interface VfxGpuTickIntent {
  /** Prepared simulation input captured at this tick, including exact texture content. */
  readonly forceFields?: Result<readonly VfxFieldTexture[], VfxForceFieldError>;
  readonly sequence: number;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuEmitterProgram;
  /** Exact immutable definition; queued work survives asset replacement. */
  readonly effect: VfxGpuEffectAsset;
  readonly programFingerprint: string;
  readonly reset: boolean;
  /** Simulated seconds of this dispatch: the Update frame delta times the player's timeScale. */
  readonly delta: number;
  /** First dispatch delta in this play cycle, including zero-time admission. */
  readonly initialDelta: number;
  /** Simulated seconds of this play cycle through this dispatch. */
  readonly elapsed: number;
  /** Effect-relative dispatch, including initialization. Resets on replay and restart-on-visible. */
  readonly phaseTick: number;
  /** Runtime update count when the intent was queued, retained for renderer correlation. */
  readonly tick: number;
  readonly seed: number;
  readonly playCycle: number;
  readonly spawnCount: number;
  readonly firstParticleId: number;
  readonly instanceGeneration: number;
  readonly instancePatchCount: number;
  readonly parameterBlock: Uint8Array;
  readonly canonicalPayload: Uint8Array;
  readonly replayInput: VfxReplayInput<VfxValueMap>;
  readonly channelInputs: VfxReplayInput<VfxValueMap>['channelInputs'];
  readonly eventCounters: VfxChannelCounters;
}

export interface VfxGpuEmitterInspectSnapshot {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  /** Renderer-owned camera-frustum result. This is not an editor mute/isolate control. */
  readonly cameraVisible: boolean;
  /** Session-only preview mask. False suppresses both simulation and retained rendering. */
  readonly sessionEnabled: boolean;
  readonly phaseTick: number | null;
  readonly tick: number | null;
  readonly playCycle: number | null;
  readonly spawnCount: number;
  readonly firstParticleId: number;
  readonly reset: boolean;
  readonly schedule: VfxGpuEmitterProgram['schedule'];
  readonly bounds: VfxGpuEmitterProgram['bounds'];
  readonly simulationWhenCulled: VfxGpuEmitterProgram['simulationWhenCulled'];
  readonly renderers: readonly {
    readonly index: number;
    readonly kind: VfxGpuEmitterProgram['renderers'][number]['kind'];
    readonly enabled: boolean;
  }[];
  readonly stages: readonly string[];
  readonly dataInterfaces: readonly string[];
}

/** Renderer-facing source view used to refresh culling without a queued tick. */
export interface VfxGpuEmitterSource {
  readonly forceFields?: Result<readonly VfxFieldTexture[], VfxForceFieldError>;
  readonly instanceGeneration: number;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuEmitterProgram;
  /** Exact immutable definition; queued work survives asset replacement. */
  readonly effect: VfxGpuEffectAsset;
}

export interface VfxGpuCommittedInspectSnapshot {
  readonly sequence: number;
  readonly tick: number;
  readonly phaseTick: number;
  readonly playCycle: number;
  readonly spawnCount: number;
  readonly firstParticleId: number;
  readonly reset: boolean;
  readonly instanceGeneration: number;
  readonly instancePatchCount: number;
}

export interface VfxGpuPlayerInspectSnapshot {
  readonly player: EntityHandle;
  readonly assetGuid: string;
  readonly programFingerprint: string;
  readonly seed: number;
  readonly delta: number;
  readonly playing: boolean;
  readonly values: {
    readonly layoutFingerprint: string;
    readonly generation: number;
    readonly pendingPatchCount: number;
  };
  readonly queuedIntents: number;
  readonly queuedTicks: number;
  readonly lastCommitted: VfxGpuCommittedInspectSnapshot | null;
  readonly channels: VfxChannelCounters;
  readonly emitters: readonly VfxGpuEmitterInspectSnapshot[];
  readonly diagnostics: readonly VfxGpuRuntimeDiagnostic[];
}

export interface VfxGpuRuntimeDiagnostic {
  readonly code:
    | 'vfx-intent-queue-overflow'
    | 'vfx-effect-unavailable'
    | 'vfx-player-invalid'
    | 'vfx-instance-commit-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly player: EntityHandle; readonly maxQueuedTicks?: number };
}

interface VfxGpuPlayerInput {
  readonly player: EntityHandle;
  readonly effect: AssetHandle<'particle-effect'>;
  readonly playing: boolean;
  readonly seed: number;
  readonly timeScale: number;
  readonly preparePipelines: boolean;
}

function playerSource(world: World) {
  return {
    world,
    query: world.query({ read: [ParticleEffectPlayer] }).unwrap(),
    projection: createStateProjection(
      world,
      [ParticleEffectPlayer, Disabled],
      [ParticleEffectPlayer],
    ),
  };
}

interface PlayerState {
  readonly fields: Map<VfxGpuEmitterProgram, VfxFieldInputs>;
  effect: AssetHandle<'particle-effect'>;
  asset: VfxGpuEffectAsset;
  version: AssetVersion<VfxGpuEffectAsset>;
  contentRevision: number;
  emitterIds: ReadonlySet<string>;
  seed: number;
  playing: boolean;
  playCycle: number;
  elapsed: number[];
  rateRemainders: number[];
  nextParticleIds: number[];
  playCycles: number[];
  cameraVisible: boolean[];
  phaseTicks: number[];
  initialDeltas: number[];
  hasCommitted: boolean;
  pendingResets: boolean[];
}

/** A new play cycle starts on first play, definition or seed change, replay, or resume. */
function playerRestartRequested(
  previous: PlayerState | undefined,
  input: VfxGpuPlayerInput,
  contentRevision: number,
  replayRequested: boolean,
): boolean {
  return (
    previous === undefined ||
    previous.effect !== input.effect ||
    previous.contentRevision !== contentRevision ||
    previous.seed !== input.seed ||
    replayRequested ||
    (!previous.playing && input.playing)
  );
}

function createPlayerState(
  input: VfxGpuPlayerInput,
  version: AssetVersion<VfxGpuEffectAsset>,
  contentRevision: number,
  playCycle: number,
  delta: number,
): PlayerState {
  const asset = version.value;
  return {
    fields: new Map<VfxGpuEmitterProgram, VfxFieldInputs>(),
    effect: input.effect,
    asset,
    version,
    contentRevision,
    emitterIds: new Set(asset.program.emitters.map((emitter) => emitter.id)),
    seed: input.seed,
    playing: input.playing,
    playCycle,
    elapsed: asset.program.emitters.map(() => 0),
    rateRemainders: asset.program.emitters.map(() => 0),
    nextParticleIds: asset.program.emitters.map(() => 0),
    playCycles: asset.program.emitters.map(() => playCycle),
    cameraVisible: asset.program.emitters.map(() => true),
    phaseTicks: asset.program.emitters.map(() => 0),
    initialDeltas: asset.program.emitters.map(() => delta * input.timeScale),
    hasCommitted: false,
    pendingResets: asset.program.emitters.map(() => false),
  };
}

/** Event channels reach an emitter that produces events or consumes another emitter's events. */
function emitterChannelInputs(
  emitter: VfxGpuEmitterProgram,
  eventSources: readonly ParticleEventSource[],
  committedChannels: readonly VfxChannelInput[],
): readonly VfxChannelInput[] {
  return (emitter.events?.length ?? 0) > 0 || eventSources.length > 0 ? committedChannels : [];
}

function eventCounters(
  intent: Pick<VfxGpuTickIntent, 'channelInputs' | 'emitter'>,
  dropped: number,
  eventSources: readonly ParticleEventSource[],
): VfxChannelCounters {
  const inputs = intent.channelInputs;
  const events = [...(intent.emitter.events ?? []), ...eventSources];
  return Object.freeze({
    queued: inputs.length,
    produced: (intent.emitter.events?.length ?? 0) > 0 ? inputs.length : 0,
    consumed:
      eventSources.length > 0
        ? inputs.length * eventSources.reduce((total, event) => total + event.fanOut, 0)
        : 0,
    dropped,
    overflow: dropped > 0 ? 1 : 0,
    fanOut: events.reduce((total, event) => total + event.fanOut, 0),
    recursionDepth: events.reduce((depth, event) => Math.max(depth, event.recursionDepth), 0),
    lastSequence: inputs.at(-1)?.sequence ?? -1,
  });
}

export interface VfxGpuRuntimeOptions {
  readonly maxQueuedTicks?: number;
}

export class VfxGpuRuntime {
  readonly #maxQueuedTicks: number;
  readonly #players = new Map<EntityHandle, PlayerState>();
  readonly #intentVersions = new WeakMap<
    VfxGpuTickIntent,
    {
      readonly effect: AssetVersion<VfxGpuEffectAsset>;
      readonly fields: readonly AssetVersion<TextureAsset>[];
    }
  >();
  readonly #fieldVersions = new WeakMap<
    readonly VfxFieldTexture[],
    readonly AssetVersion<TextureAsset>[]
  >();
  readonly #definitionVersions = new WeakMap<
    VfxGpuEffectAsset,
    { readonly handle: number; readonly revision: number }
  >();
  readonly #instances = new Map<EntityHandle, ParticleEffectInstance>();
  #source: ReturnType<typeof playerSource> | undefined;
  readonly #controls = new Map<number, VfxGpuPlayerInput>();
  readonly #playing = new Set<VfxGpuPlayerInput>();
  readonly #changedControls = new Set<number>();
  readonly #intents = new Map<number, VfxGpuTickIntent>();
  readonly #playerIntents = new Map<EntityHandle, Set<number>>();
  #intentSnapshot: readonly VfxGpuTickIntent[] | undefined = [];
  readonly #diagnostics: VfxGpuRuntimeDiagnostic[] = [];
  readonly #lastCommitted = new Map<EntityHandle, VfxGpuTickIntent>();
  readonly #lastCommittedByEmitter = new Map<EntityHandle, Map<string, VfxGpuTickIntent>>();
  readonly #eventCounters = new Map<EntityHandle, VfxChannelCounters>();
  readonly #cameraVisibility = new Map<EntityHandle, Map<string, boolean>>();
  readonly #sessionEnabled = new Map<EntityHandle, Map<string, boolean>>();
  readonly #replayRequests = new Set<EntityHandle>();
  readonly #replayInputs = new Map<EntityHandle, VfxReplayInput<VfxValueMap>>();
  #sequence = 0;
  #updates = 0;
  #renderGeneration = 0;

  constructor(options: VfxGpuRuntimeOptions = {}) {
    this.#maxQueuedTicks = options.maxQueuedTicks ?? 8;
  }

  /** Resource generation owned by the current VFX render attachment. */
  get renderGeneration(): number {
    return this.#renderGeneration;
  }

  /** Exact owner version used by local and Worker rendering; never a second asset identity. */
  effectVersion(effect: VfxGpuEffectAsset): {
    readonly handle: number;
    readonly revision: number;
  } {
    const version = this.#definitionVersions.get(effect);
    if (version === undefined) throw new TypeError('VFX definition has no retained asset version');
    return version;
  }

  fieldTextureVersions(input: readonly VfxFieldTexture[]): readonly AssetVersion<TextureAsset>[] {
    const textures = this.#fieldVersions.get(input);
    if (textures === undefined) throw new TypeError('VFX field has no retained texture versions');
    return textures;
  }

  #captureFields(
    world: World,
    state: PlayerState,
    emitter: VfxGpuEmitterProgram,
  ): VfxFieldInputs | undefined {
    if (emitter.forceFields === undefined) return undefined;
    const captured = captureVfxFieldInputs(
      world.assets,
      emitter.forceFields,
      state.fields.get(emitter),
    );
    state.fields.set(emitter, captured);
    if (captured.input.ok) this.#fieldVersions.set(captured.input.value, captured.textures);
    return captured;
  }

  #releaseFields(state: PlayerState | undefined): void {
    if (state === undefined) return;
    for (const fields of state.fields.values()) releaseVfxFieldInputs(fields);
    state.fields.clear();
  }

  #releaseIntent(intent: VfxGpuTickIntent): void {
    const versions = this.#intentVersions.get(intent);
    versions?.effect.dispose();
    for (const texture of versions?.fields ?? []) texture.dispose();
    this.#intentVersions.delete(intent);
  }

  #clearCommitted(player: EntityHandle): void {
    const emitters = this.#lastCommittedByEmitter.get(player);
    if (emitters !== undefined) for (const intent of emitters.values()) this.#releaseIntent(intent);
    this.#lastCommittedByEmitter.delete(player);
    this.#lastCommitted.delete(player);
  }

  snapshot(): readonly VfxGpuTickIntent[] {
    this.#intentSnapshot ??= [...this.#intents.values()];
    return this.#intentSnapshot;
  }

  diagnostics(): readonly VfxGpuRuntimeDiagnostic[] {
    return this.#diagnostics;
  }

  /**
   * Visit every live emitter source.  The renderer uses this on render frames
   * where pause/restart culling has no pending simulation intent, so a camera
   * move back into the bounds can refresh visibility before the next tick.
   * World membership also retires removed players before rendering their last
   * committed state or pending work; removal is not a simulation-clock event.
   * New players prepare their authored time-zero state here so a render-only
   * frame does not need a fabricated update. Existing players keep their
   * patch and replay commits on the update boundary.
   */
  forEachEmitterSource(world: World, visitor: (source: VfxGpuEmitterSource) => void): void {
    this.#refreshPlayers(world, true);
    for (const [player, state] of this.#players) {
      for (const emitter of state.asset.program.emitters) {
        const fields = this.#captureFields(world, state, emitter);
        visitor({
          player,
          emitter,
          ...(fields === undefined ? {} : { forceFields: fields.input }),
          effect: state.asset,
          instanceGeneration: this.#instances.get(player)?.generation ?? 0,
        });
      }
    }
  }

  lastCommitted(player: EntityHandle): VfxGpuTickIntent | undefined {
    return this.#lastCommitted.get(player);
  }

  /**
   * Return the last submitted tick state for one emitter.  Renderers
   * retain this projection between ticks; simulation intents are a
   * queue, while a drawable emitter remains live until the player is reset.
   */
  lastCommittedEmitter(player: EntityHandle, emitterId: string): VfxGpuTickIntent | undefined {
    return this.#lastCommittedByEmitter.get(player)?.get(emitterId);
  }

  /**
   * Rebuild the deterministic tick inputs needed to rehydrate one
   * retained emitter on a replacement GPU device. This is a renderer-only
   * projection: it does not enqueue work, advance World time, allocate a new
   * play cycle, or publish channel/event counters.
   */

  inspectPlayers(): readonly VfxGpuPlayerInspectSnapshot[] {
    return Object.freeze(
      [...this.#players.keys()]
        .sort((left, right) => Number(left) - Number(right))
        .flatMap((player) => {
          const snapshot = this.inspectPlayer(player);
          return snapshot === undefined ? [] : [snapshot];
        }),
    );
  }

  inspectPlayer(player: EntityHandle): VfxGpuPlayerInspectSnapshot | undefined {
    const state = this.#players.get(player);
    if (state === undefined) return undefined;
    const instance = this.#instances.get(player);
    const latest = state.asset.program.emitters.map((emitter) =>
      this.#latestIntent(player, emitter.id),
    );
    const lastIntent = latest.reduce<VfxGpuTickIntent | undefined>(
      (current, intent) =>
        intent !== undefined && (current === undefined || intent.sequence > current.sequence)
          ? intent
          : current,
      undefined,
    );
    const layoutFingerprint =
      state.asset.program.emitters.find((emitter) => emitter.reflection.layout !== undefined)
        ?.reflection.layout?.fingerprint ?? state.asset.program.fingerprint;
    const lastCommitted = this.#lastCommitted.get(player);
    const queuedTicks = new Set<number>();
    let queuedIntents = 0;
    for (const sequence of this.#playerIntents.get(player) ?? []) {
      const intent = this.#intents.get(sequence);
      if (intent === undefined) continue;
      queuedIntents += 1;
      queuedTicks.add(intent.tick);
    }
    return Object.freeze({
      player,
      assetGuid: state.asset.guid,
      programFingerprint: state.asset.program.fingerprint,
      seed: lastIntent?.seed ?? state.seed,
      delta: lastIntent?.delta ?? 0,
      playing: state.playing,
      values: Object.freeze({
        layoutFingerprint,
        generation: instance?.generation ?? lastIntent?.instanceGeneration ?? 0,
        pendingPatchCount: instance?.pendingPatchCount ?? 0,
      }),
      queuedIntents,
      queuedTicks: queuedTicks.size,
      lastCommitted:
        lastCommitted === undefined
          ? null
          : Object.freeze({
              sequence: lastCommitted.sequence,
              tick: lastCommitted.tick,
              phaseTick: lastCommitted.phaseTick,
              playCycle: lastCommitted.playCycle,
              spawnCount: lastCommitted.spawnCount,
              firstParticleId: lastCommitted.firstParticleId,
              reset: lastCommitted.reset,
              instanceGeneration: lastCommitted.instanceGeneration,
              instancePatchCount: lastCommitted.instancePatchCount,
            }),
      channels: this.eventCounters(player),
      emitters: Object.freeze(
        state.asset.program.emitters.map((emitter, index) => {
          const intent = latest[index];
          return Object.freeze({
            id: emitter.id,
            module: emitter.module,
            capacity: emitter.capacity,
            cameraVisible: this.#cameraVisibility.get(player)?.get(emitter.id) ?? true,
            sessionEnabled: this.isEmitterSessionEnabled(player, emitter.id),
            phaseTick: intent?.phaseTick ?? null,
            tick: intent?.tick ?? null,
            playCycle: intent?.playCycle ?? null,
            spawnCount: intent?.spawnCount ?? 0,
            firstParticleId: intent?.firstParticleId ?? 0,
            reset: intent?.reset ?? false,
            schedule: emitter.schedule,
            bounds: emitter.bounds,
            simulationWhenCulled: emitter.simulationWhenCulled,
            renderers: Object.freeze(
              emitter.renderers.map((renderer, rendererIndex) =>
                Object.freeze({
                  index: rendererIndex,
                  kind: renderer.kind,
                  enabled: renderer.enabled ?? true,
                }),
              ),
            ),
            stages: Object.freeze((emitter.reflection.stages ?? []).map((stage) => stage.id)),
            dataInterfaces: Object.freeze(
              (emitter.reflection.dataInterfaces ?? []).map((requirement) => requirement.token),
            ),
          });
        }),
      ),
      diagnostics: Object.freeze(
        this.#diagnostics.filter((diagnostic) => diagnostic.detail.player === player),
      ),
    });
  }

  eventCounters(player: EntityHandle): VfxChannelCounters {
    return (
      this.#eventCounters.get(player) ??
      this.#lastCommitted.get(player)?.eventCounters ?? {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      }
    );
  }

  markEventDispatched(player: EntityHandle, counters: VfxChannelCounters): void {
    const prior = this.#eventCounters.get(player);
    if (counters.produced === 0 && prior !== undefined) {
      this.#eventCounters.set(
        player,
        Object.freeze({
          ...prior,
          queued: 0,
          consumed: Math.max(prior.consumed, counters.consumed),
        }),
      );
      return;
    }
    this.#eventCounters.set(
      player,
      Object.freeze({ ...counters, queued: 0, consumed: counters.produced }),
    );
  }

  hasPlayer(player: EntityHandle): boolean {
    return this.#players.has(player);
  }

  attachInstance(player: EntityHandle, instance: ParticleEffectInstance): void {
    this.#instances.set(player, instance);
  }

  detachInstance(player: EntityHandle): void {
    this.#instances.delete(player);
  }

  getInstance(player: EntityHandle): ParticleEffectInstance | undefined {
    return this.#instances.get(player);
  }

  setEmitterCameraVisibility(player: EntityHandle, emitterId: string, visible: boolean): void {
    let values = this.#cameraVisibility.get(player);
    if (values === undefined) {
      values = new Map();
      this.#cameraVisibility.set(player, values);
    }
    values.set(emitterId, visible);
  }

  setEmitterSessionEnabled(player: EntityHandle, emitterId: string, enabled: boolean): void {
    let values = this.#sessionEnabled.get(player);
    if (values === undefined) {
      values = new Map();
      this.#sessionEnabled.set(player, values);
    }
    values.set(emitterId, enabled);
  }

  isEmitterSessionEnabled(player: EntityHandle, emitterId: string): boolean {
    return this.#sessionEnabled.get(player)?.get(emitterId) ?? true;
  }

  /** Restart from tick zero without changing authored `ParticleEffectPlayer.playing`. */
  replay(player: EntityHandle, input?: VfxReplayInput<VfxValueMap>): void {
    this.#discardQueuedIntents(player);
    this.#clearDiagnostics(player, 'vfx-intent-queue-overflow');
    this.#replayInputs.delete(player);
    if (input === undefined) {
      this.#instances.delete(player);
    } else {
      this.#replayInputs.set(player, input);
    }
    this.#replayRequests.add(player);
  }

  /**
   * Acknowledge queued intents. A scalar acknowledges the contiguous prefix;
   * an array acknowledges only those terminal sequences, which lets unrelated
   * player/emitter streams progress while another stream is deferred. When the
   * renderer supplies `publishedSequences`, only intents that reached GPU
   * submission update the retained last-committed projection; skipped intents
   * are queue acknowledgements, not new GPU state.
   */
  commit(sequence: number | readonly number[], publishedSequences?: readonly number[]): void {
    const acknowledged: Iterable<number> =
      typeof sequence === 'number' ? this.#intents.keys() : sequence;
    const published = publishedSequences === undefined ? undefined : new Set(publishedSequences);
    const committedPlayers = new Set<EntityHandle>();
    for (const number of acknowledged) {
      if (typeof sequence === 'number' && !(number <= sequence)) break;
      const intent = this.#takeIntent(number);
      if (intent === undefined) continue;
      const state = this.#players.get(intent.player);
      committedPlayers.add(intent.player);
      if (
        state?.emitterIds.has(intent.emitter.id) &&
        (published === undefined || published.has(intent.sequence))
      ) {
        if (state !== undefined) state.hasCommitted = true;
        const priorCommitted = this.#lastCommitted.get(intent.player);
        if (priorCommitted === undefined || priorCommitted.sequence < intent.sequence) {
          this.#lastCommitted.set(intent.player, intent);
        }
        let emitters = this.#lastCommittedByEmitter.get(intent.player);
        if (emitters === undefined) {
          emitters = new Map();
          this.#lastCommittedByEmitter.set(intent.player, emitters);
        }
        const priorEmitter = emitters.get(intent.emitter.id);
        if (priorEmitter === undefined || priorEmitter.sequence < intent.sequence) {
          if (priorEmitter !== undefined) this.#releaseIntent(priorEmitter);
          emitters.set(intent.emitter.id, intent);
        } else this.#releaseIntent(intent);
      } else this.#releaseIntent(intent);
    }
    for (const player of committedPlayers) {
      this.#clearDiagnostics(player, 'vfx-intent-queue-overflow');
    }
  }

  reset(player: EntityHandle): void {
    this.#discardQueuedIntents(player);
    this.#clearDiagnostics(player);
    this.#releaseFields(this.#players.get(player));
    this.#players.get(player)?.version.dispose();
    this.#players.delete(player);
    this.#instances.delete(player);
    this.#replayRequests.delete(player);
    this.#clearCommitted(player);
    this.#eventCounters.delete(player);
    this.#replayInputs.delete(player);
    this.#cameraVisibility.delete(player);
    this.#sessionEnabled.delete(player);
  }

  /**
   * Drop every generation-owned VFX runtime value after device recovery.
   * Authored ParticleEffectPlayer state remains the restart source on the next
   * update; no queued intent or stale instance crosses the boundary.
   */
  recover(): void {
    this.#renderGeneration += 1;
    for (const player of this.#players.keys()) this.reset(player);
    this.#players.clear();
    this.#instances.clear();
    this.#controls.clear();
    this.#playing.clear();
    this.#changedControls.clear();
    this.#source?.projection.invalidate();
    this.#intents.clear();
    this.#playerIntents.clear();
    this.#intentSnapshot = [];
    this.#diagnostics.length = 0;
    this.#lastCommitted.clear();
    this.#lastCommittedByEmitter.clear();
    this.#eventCounters.clear();
    this.#cameraVisibility.clear();
    this.#sessionEnabled.clear();
    this.#replayRequests.clear();
    this.#replayInputs.clear();
  }

  #report(diagnostic: VfxGpuRuntimeDiagnostic): void {
    const alreadyActive = this.#diagnostics.some(
      (prior) => prior.code === diagnostic.code && prior.detail.player === diagnostic.detail.player,
    );
    if (alreadyActive) return;
    if (this.#diagnostics.length === 64) this.#diagnostics.shift();
    this.#diagnostics.push(diagnostic);
  }

  #clearDiagnostics(player: EntityHandle, code?: VfxGpuRuntimeDiagnostic['code']): void {
    for (let index = this.#diagnostics.length - 1; index >= 0; index -= 1) {
      const diagnostic = this.#diagnostics[index];
      if (
        diagnostic?.detail.player === player &&
        (code === undefined || diagnostic.code === code)
      ) {
        this.#diagnostics.splice(index, 1);
      }
    }
  }

  #takeIntent(sequence: number): VfxGpuTickIntent | undefined {
    const intent = this.#intents.get(sequence);
    if (intent === undefined) return undefined;
    this.#intents.delete(sequence);
    const owned = this.#playerIntents.get(intent.player);
    owned?.delete(sequence);
    if (owned?.size === 0) this.#playerIntents.delete(intent.player);
    this.#intentSnapshot = undefined;
    return intent;
  }

  #discardQueuedIntents(player: EntityHandle): void {
    const owned = this.#playerIntents.get(player);
    if (owned === undefined) return;
    for (const sequence of owned) {
      const intent = this.#takeIntent(sequence);
      if (intent !== undefined) this.#releaseIntent(intent);
    }
  }

  #refreshPlayers(world: World, renderOnly: boolean): void {
    this.#source ??= playerSource(world);
    const source = this.#source;
    if (source.world !== world) throw new TypeError('one VFX runtime belongs to one World');
    const changes = source.projection.read();
    for (const index of changes.indices) {
      const entity = source.projection.entity(index);
      const row = entity === undefined ? undefined : source.query.at(entity);
      const previous = this.#controls.get(index);
      if (previous !== undefined) this.#playing.delete(previous);
      if (previous !== undefined && (previous.player !== entity || row === undefined))
        this.reset(previous.player);
      const player = row?.get(ParticleEffectPlayer);
      if (player === undefined || entity === undefined) {
        this.#controls.delete(index);
        this.#changedControls.delete(index);
        continue;
      }
      const input: VfxGpuPlayerInput = {
        player: entity,
        effect: player.effect,
        playing: player.playing,
        seed: player.seed,
        timeScale: player.timeScale,
        preparePipelines: player.preparePipelines,
      };
      this.#controls.set(index, input);
      this.#changedControls.add(index);
      if (input.playing) this.#playing.add(input);
      if (renderOnly && !this.#players.has(entity))
        this.#preparePlayer(world, this.#updates, 0, input, true);
      const state = this.#players.get(entity);
      // Parking is resource intent; ordinary changes keep their update boundary.
      if (state !== undefined && input.preparePipelines && !input.playing) state.playing = false;
    }
    changes.accept();
  }

  /**
   * Advance every player by one Update frame. `delta` is the World frame
   * delta (`Time.delta`, already bounded by `TimePolicy.maxDeltaSeconds`);
   * each simulating emitter queues one intent carrying exactly that interval.
   */
  advance(world: World, delta: number): void {
    this.#updates += 1;
    const tick = this.#updates;
    this.#refreshPlayers(world, false);
    // Only changed paused controls and explicit replay requests need work.
    for (const player of this.#replayRequests) this.#changedControls.add(unpackSlot(player));
    for (const index of this.#changedControls) {
      const input = this.#controls.get(index);
      if (input !== undefined && !input.playing)
        this.#preparePlayer(world, tick, delta, input, false);
    }
    this.#changedControls.clear();
    for (const input of this.#playing) this.#preparePlayer(world, tick, delta, input, false);
  }

  #preparePlayer(
    world: World,
    tick: number,
    delta: number,
    input: VfxGpuPlayerInput,
    initializing: boolean,
  ): void {
    if (!Number.isFinite(input.timeScale) || input.timeScale < 0) {
      this.#report({
        code: 'vfx-player-invalid',
        expected: 'a finite non-negative particle timeScale',
        hint: 'repair ParticleEffectPlayer.timeScale and restart the player',
        detail: { player: input.player },
      });
      return;
    }
    this.#clearDiagnostics(input.player, 'vfx-player-invalid');
    const records = runtimeAssets(world.assets);
    const contentRevision = records.version(input.effect);
    const current = records.borrow<VfxGpuEffectAsset>(input.effect);
    if (
      !current.ok ||
      !contentRevision.ok ||
      current.value.kind !== 'particle-effect' ||
      current.value.schemaVersion !== 3
    ) {
      this.#report({
        code: 'vfx-effect-unavailable',
        expected: 'a loaded schemaVersion 3 GPU particle effect',
        hint: 'bind a valid particle effect from this World asset owner',
        detail: { player: input.player },
      });
      return;
    }
    this.#clearDiagnostics(input.player, 'vfx-effect-unavailable');
    const previous = this.#players.get(input.player);
    const replayRequested = !initializing && this.#replayRequests.delete(input.player);
    const restart = playerRestartRequested(previous, input, contentRevision.value, replayRequested);
    const version = this.#definitionVersion(world, input, previous, contentRevision.value);
    if (version === undefined) return;
    if (restart) this.#releaseFields(previous);
    const state =
      restart || previous === undefined
        ? createPlayerState(
            input,
            version,
            contentRevision.value,
            (previous?.playCycle ?? -1) + 1,
            delta,
          )
        : previous;
    this.#players.set(input.player, state);
    // Replay is a one-update request, not a second persistent play-state
    // authority. Inspection always returns the authored player state after
    // the requested reset intent has been emitted.
    state.playing = input.playing;
    if (!input.playing && !replayRequested) {
      if (restart) state.pendingResets.fill(true);
      return;
    }
    const instance = this.#simulationInstance(input.player, state, restart);
    if (instance === undefined) return;
    const committed = this.#commitInstance(input, tick, instance, state, restart);
    if (committed === undefined) return;
    this.#queueEmitterTicks(world, input, tick, delta, state, restart, committed);
  }

  /**
   * The fixed definition version the player simulates. A definition change
   * pins the new version and retires the previous one; `undefined` reports
   * exhausted snapshot capacity.
   */
  #definitionVersion(
    world: World,
    input: VfxGpuPlayerInput,
    previous: PlayerState | undefined,
    contentRevision: number,
  ): AssetVersion<VfxGpuEffectAsset> | undefined {
    if (
      previous !== undefined &&
      previous.effect === input.effect &&
      previous.contentRevision === contentRevision
    )
      return previous.version;
    const pinned = runtimeAssets(world.assets).pin<VfxGpuEffectAsset>(input.effect);
    if (!pinned.ok) {
      this.#report({
        code: 'vfx-effect-unavailable',
        expected: 'available fixed asset version capacity',
        hint: 'release completed work or increase the asset snapshot budget',
        detail: { player: input.player },
      });
      return undefined;
    }
    const version = pinned.value;
    this.#definitionVersions.set(version.value, {
      handle: version.handle,
      revision: version.revision,
    });
    if (previous !== undefined) this.#retireDefinition(input.player, previous, version);
    return version;
  }

  /**
   * A definition change starts a new play cycle and rebuilds its reflected instance.
   * Already queued work retains its exact definition and parameter bytes until ACK.
   */
  #retireDefinition(
    player: EntityHandle,
    previous: PlayerState,
    version: AssetVersion<VfxGpuEffectAsset>,
  ): void {
    previous.version.dispose();
    this.#instances.delete(player);
    const liveIds = new Set(version.value.program.emitters.map((emitter) => emitter.id));
    const committed = this.#lastCommittedByEmitter.get(player);
    let latest: VfxGpuTickIntent | undefined;
    if (committed !== undefined)
      for (const [id, intent] of committed) {
        if (!liveIds.has(id)) {
          this.#releaseIntent(intent);
          committed.delete(id);
        } else if (latest === undefined || latest.sequence < intent.sequence) latest = intent;
      }
    if (latest === undefined) this.#lastCommitted.delete(player);
    else this.#lastCommitted.set(player, latest);
  }

  /**
   * The instance that may simulate this tick, or `undefined` when the intent
   * queue is full, the instance cannot be built, or no emitter is active.
   * Every refusal keeps a requested restart pending.
   */
  #simulationInstance(
    player: EntityHandle,
    state: PlayerState,
    restart: boolean,
  ): ParticleEffectInstance | undefined {
    const asset = state.asset;
    const queuedForPlayer = this.#playerIntents.get(player)?.size ?? 0;
    if (queuedForPlayer >= this.#maxQueuedTicks * Math.max(1, asset.program.emitters.length)) {
      if (restart) state.pendingResets.fill(true);
      if (state.hasCommitted) {
        this.#report({
          code: 'vfx-intent-queue-overflow',
          expected: `at most ${this.#maxQueuedTicks} unconsumed simulation ticks`,
          hint: 'recover or restart the renderer; VFX does not silently discard simulation ticks',
          detail: { player, maxQueuedTicks: this.#maxQueuedTicks },
        });
      }
      return undefined;
    }
    const instance = this.#instances.get(player) ?? this.#createInstance(player, asset);
    if (instance === undefined) {
      if (restart) state.pendingResets.fill(true);
      return undefined;
    }
    const hasActiveEmitter = asset.program.emitters.some((emitter) => {
      if (!this.isEmitterSessionEnabled(player, emitter.id)) return false;
      const cameraVisible = this.#cameraVisibility.get(player)?.get(emitter.id) ?? true;
      return cameraVisible || emitter.simulationWhenCulled === 'continue';
    });
    if (!hasActiveEmitter) {
      if (restart) state.pendingResets.fill(true);
      for (const [index, emitter] of asset.program.emitters.entries()) {
        state.cameraVisible[index] = this.#cameraVisibility.get(player)?.get(emitter.id) ?? true;
      }
      return undefined;
    }
    return instance;
  }

  /** Commit (or replay) the instance values for this tick; failure keeps a restart pending. */
  #commitInstance(
    input: VfxGpuPlayerInput,
    tick: number,
    instance: ParticleEffectInstance,
    state: PlayerState,
    restart: boolean,
  ): VfxInstanceCommit<VfxValueMap> | undefined {
    const replayInput = this.#replayInputs.get(input.player);
    this.#replayInputs.delete(input.player);
    const committed =
      replayInput === undefined
        ? instance.commit({ seed: input.seed, tick })
        : instance.replay(replayInput);
    if (committed.ok) return committed.value;
    if (restart) state.pendingResets.fill(true);
    this.#report({
      code: 'vfx-instance-commit-failed',
      expected: 'the current typed instance values to pack into the reflected GPU block',
      hint: 'repair the instance patch and retry at the next update',
      detail: { player: input.player },
    });
    return undefined;
  }

  #queueEmitterTicks(
    world: World,
    input: VfxGpuPlayerInput,
    tick: number,
    frameDelta: number,
    state: PlayerState,
    restart: boolean,
    committed: VfxInstanceCommit<VfxValueMap>,
  ): void {
    const asset = state.asset;
    const delta = frameDelta * input.timeScale;
    for (const [index, emitter] of asset.program.emitters.entries()) {
      const reset = this.#emitterTickReset(input.player, state, index, emitter, restart);
      if (reset === undefined) continue;
      if (
        delta === 0 &&
        !reset &&
        committed.patchCount === 0 &&
        committed.channelInputs.length === 0
      )
        continue;
      const previousElapsed = state.elapsed[index] ?? 0;
      const scheduled = spawnCount(
        emitter,
        previousElapsed,
        previousElapsed + delta,
        reset,
        state.rateRemainders[index] ?? 0,
      );
      state.rateRemainders[index] = scheduled.remainder;
      const firstParticleId = state.nextParticleIds[index] ?? 0;
      state.nextParticleIds[index] = firstParticleId + scheduled.count;
      const eventSources = asset.program.emitters.flatMap((source) =>
        (source.events ?? []).filter((event) => event.subEmitter === emitter.id),
      );
      const channelInputs = emitterChannelInputs(emitter, eventSources, committed.channelInputs);
      const phaseTick = state.phaseTicks[index] ?? 0;
      if (reset) state.initialDeltas[index] = delta;
      const fields = this.#captureFields(world, state, emitter);
      const intent: VfxGpuTickIntent = Object.freeze({
        ...(fields === undefined ? {} : { forceFields: fields.input }),
        sequence: this.#sequence++,
        player: input.player,
        emitter,
        effect: asset,
        programFingerprint: asset.program.fingerprint,
        reset,
        delta,
        initialDelta: state.initialDeltas[index] ?? delta,
        elapsed: previousElapsed + delta,
        phaseTick,
        tick,
        seed: input.seed,
        playCycle: state.playCycles[index] ?? state.playCycle,
        spawnCount: scheduled.count,
        firstParticleId,
        instanceGeneration: committed.generation,
        instancePatchCount: committed.patchCount,
        parameterBlock: committed.parameterBlock,
        canonicalPayload: committed.canonicalPayload,
        replayInput: committed.replayInput,
        channelInputs,
        eventCounters: eventCounters(
          { channelInputs, emitter },
          channelInputs.length === 0 ? 0 : committed.droppedCount,
          eventSources,
        ),
      });
      this.#queueIntent(intent, state.version, fields);
      state.elapsed[index] = previousElapsed + delta;
      state.phaseTicks[index] = phaseTick + 1;
      state.pendingResets[index] = false;
    }
  }

  /**
   * Whether this emitter's tick resets its simulation, or `undefined` when the
   * emitter does not simulate (session-disabled or culled without `continue`).
   * Becoming visible under `restart-on-visible` restarts the emitter's cycle.
   */
  #emitterTickReset(
    player: EntityHandle,
    state: PlayerState,
    index: number,
    emitter: VfxGpuEmitterProgram,
    restart: boolean,
  ): boolean | undefined {
    const cameraVisible = this.#cameraVisibility.get(player)?.get(emitter.id) ?? true;
    const becameVisible = cameraVisible && state.cameraVisible[index] === false;
    state.cameraVisible[index] = cameraVisible;
    const emitterRestart = restart || state.pendingResets[index] === true;
    if (!this.isEmitterSessionEnabled(player, emitter.id)) {
      if (emitterRestart) state.pendingResets[index] = true;
      return undefined;
    }
    if (!cameraVisible && emitter.simulationWhenCulled !== 'continue') {
      if (emitterRestart) state.pendingResets[index] = true;
      return undefined;
    }
    const visibilityRestart =
      becameVisible && emitter.simulationWhenCulled === 'restart-on-visible';
    if (visibilityRestart) {
      state.elapsed[index] = 0;
      state.rateRemainders[index] = 0;
      state.nextParticleIds[index] = 0;
      state.playCycles[index] = (state.playCycles[index] ?? state.playCycle) + 1;
      state.phaseTicks[index] = 0;
    }
    return emitterRestart || visibilityRestart;
  }

  #queueIntent(
    intent: VfxGpuTickIntent,
    effect: AssetVersion<VfxGpuEffectAsset>,
    fields: VfxFieldInputs | undefined,
  ): void {
    this.#intentVersions.set(intent, {
      effect: effect.retain(),
      fields: fields?.textures.map((texture) => texture.retain()) ?? [],
    });
    this.#intents.set(intent.sequence, intent);
    let owned = this.#playerIntents.get(intent.player);
    if (owned === undefined) {
      owned = new Set();
      this.#playerIntents.set(intent.player, owned);
    }
    owned.add(intent.sequence);
    this.#intentSnapshot = undefined;
  }

  #createInstance(
    player: EntityHandle,
    effect: VfxGpuEffectAsset,
  ): ParticleEffectInstance | undefined {
    const layout = effect.program.emitters.find(
      (emitter) => emitter.reflection.layout !== undefined,
    )?.reflection.layout;
    if (layout === undefined) {
      this.#report({
        code: 'vfx-effect-unavailable',
        expected: 'a Program v3 emitter reflection layout',
        hint: 'recook the effect with Program v3 reflection before starting the player',
        detail: { player },
      });
      return undefined;
    }
    const reflection: VfxEffectReflection = layout;
    try {
      const instance = new ParticleEffectInstance(createVfxEffectContract(reflection), {
        channels: effect.program.emitters.flatMap((emitter) => emitter.channels ?? []),
      });
      this.#instances.set(player, instance);
      return instance;
    } catch {
      this.#report({
        code: 'vfx-instance-commit-failed',
        expected: 'a valid reflected VFX instance contract',
        hint: 'recook the effect with a valid reflection layout before starting the player',
        detail: { player },
      });
      return undefined;
    }
  }

  #latestIntent(player: EntityHandle, emitterId: string): VfxGpuTickIntent | undefined {
    let latest = this.#lastCommittedByEmitter.get(player)?.get(emitterId);
    for (const sequence of this.#playerIntents.get(player) ?? []) {
      const intent = this.#intents.get(sequence);
      if (intent === undefined || intent.emitter.id !== emitterId) continue;
      if (latest === undefined || intent.sequence > latest.sequence) latest = intent;
    }
    return latest;
  }
}

function spawnCount(
  emitter: VfxGpuEmitterProgram,
  previous: number,
  next: number,
  firstTick: boolean,
  priorRemainder: number,
): { readonly count: number; readonly remainder: number } {
  const exactRate = emitter.schedule.rate * Math.max(0, next - previous) + priorRemainder;
  let count = Math.floor(exactRate);
  const loop = emitter.schedule.loopDuration;
  for (const burst of emitter.schedule.bursts ?? []) {
    if (loop === undefined) {
      if ((firstTick && burst.time === 0) || (burst.time > previous && burst.time <= next)) {
        count += burst.count;
      }
      continue;
    }
    const firstOccurrence = Math.max(0, Math.floor((previous - burst.time) / loop) + 1);
    const lastOccurrence = Math.floor((next - burst.time) / loop);
    const occurrences = Math.max(0, lastOccurrence - firstOccurrence + 1);
    count += occurrences * burst.count;
    if (firstTick && burst.time === 0) count += burst.count;
  }
  return { count, remainder: exactRate - Math.floor(exactRate) };
}

export function vfxGpuRuntimePlugin(options: VfxGpuRuntimeOptions = {}): Plugin {
  return {
    name: 'vfx-gpu-runtime',
    inject: ['world'],
    apply(ctx) {
      const world = ctx.world;
      if (world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) {
        throw new TypeError(`${VFX_GPU_RUNTIME_RESOURCE_KEY} already exists`);
      }
      const runtime = new VfxGpuRuntime(options);
      ctx.effect(() => {
        world.insertResource(VFX_GPU_RUNTIME_RESOURCE_KEY, runtime);
        return () => {
          runtime.recover();
          world.removeResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
        };
      }, 'vfx/runtime-resource');
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: 'vfx-gpu-runtime',
            queries: [],
            // Players that this frame's simulation spawns or moves advance in the same frame.
            after: [FixedUpdate],
            fn: (world) => runtime.advance(world, world.getResource(Time).delta),
          })
          .unwrap();
        return () => world.removeSystem(Update, 'vfx-gpu-runtime');
      }, 'vfx/tick-system');
    },
  };
}

/**
 * Reconstruct GPU inputs from submitted POD without owning World time or event
 * queues. Frame deltas vary, so recovery quantizes: it replays the same number
 * of dispatches over the same cycle time, keeping the exact initial delta and
 * splitting the rest of `elapsed` evenly. Dispatch count, cycle time, spawn
 * total and particle ids match the live cycle; motion integrates over the even
 * steps rather than the recorded frame partition.
 */
export function buildVfxRecoveryIntents<T extends Omit<VfxGpuTickIntent, 'effect' | 'forceFields'>>(
  latest: T | undefined,
): readonly T[] {
  if (latest === undefined) return [];
  const intents: T[] = [];
  const step =
    latest.phaseTick === 0 ? 0 : (latest.elapsed - latest.initialDelta) / latest.phaseTick;
  let elapsed = 0;
  let remainder = 0;
  let firstParticleId = 0;
  for (let phaseTick = 0; phaseTick <= latest.phaseTick; phaseTick += 1) {
    const delta = phaseTick === 0 ? latest.initialDelta : step;
    // The last dispatch ends exactly at the recorded cycle time.
    const next = phaseTick === latest.phaseTick ? latest.elapsed : elapsed + delta;
    const scheduled = spawnCount(latest.emitter, elapsed, next, phaseTick === 0, remainder);
    intents.push(
      Object.freeze({
        ...latest,
        reset: phaseTick === 0,
        delta,
        elapsed: next,
        phaseTick,
        tick: latest.tick - latest.phaseTick + phaseTick,
        spawnCount: scheduled.count,
        firstParticleId,
        // Recovery restores GPU state from retained authored inputs. It
        // never republishes the World-facing event/channel stream.
        channelInputs: Object.freeze([]),
        eventCounters: Object.freeze({
          queued: 0,
          produced: 0,
          consumed: 0,
          dropped: 0,
          overflow: 0,
          fanOut: 0,
          recursionDepth: 0,
          lastSequence: -1,
        }),
      }),
    );
    elapsed = next;
    remainder = scheduled.remainder;
    firstParticleId += scheduled.count;
  }
  return Object.freeze(intents);
}
