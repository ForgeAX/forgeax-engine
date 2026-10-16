import { Entity, type EntityHandle, FixedTime, FixedUpdate, type World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { type Handle, toShared } from '@forgeax/engine-types';
import type { ParticleEventSource } from './code-source.js';
import type { VfxValueMap } from './effect-contract.js';
import { createVfxEffectContract, type VfxEffectReflection } from './effect-contract.js';
import { isImmutableVfxGpuEffect } from './gpu-loader.js';
import type { VfxGpuEffectAssetAny, VfxGpuEmitterProgramAny } from './gpu-program.js';
import {
  ParticleEffectInstance,
  type VfxChannelCounters,
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
  readonly sequence: number;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuEmitterProgramAny;
  /** Exact immutable definition; queued work survives asset replacement. */
  readonly effect: VfxGpuEffectAssetAny;
  readonly programFingerprint: string;
  readonly reset: boolean;
  readonly fixedDelta: number;
  /** First dispatch delta in this play cycle, including zero-time admission. */
  readonly initialFixedDelta: number;
  /** Effect-relative dispatch, including initialization. Resets on replay and restart-on-visible. */
  readonly phaseTick: number;
  /** World-global FixedTime tick retained for renderer ring selection and correlation. */
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
  readonly schedule: VfxGpuEmitterProgramAny['schedule'];
  readonly bounds: VfxGpuEmitterProgramAny['bounds'];
  readonly simulationWhenCulled: VfxGpuEmitterProgramAny['simulationWhenCulled'];
  readonly renderers: readonly {
    readonly index: number;
    readonly kind: VfxGpuEmitterProgramAny['renderers'][number]['kind'];
    readonly enabled: boolean;
  }[];
  readonly stages: readonly string[];
  readonly dataInterfaces: readonly string[];
}

/** Renderer-facing source view used to refresh culling without a queued tick. */
export interface VfxGpuEmitterSource {
  readonly player: EntityHandle;
  readonly emitter: VfxGpuEmitterProgramAny;
  /** Exact immutable definition; queued work survives asset replacement. */
  readonly effect: VfxGpuEffectAssetAny;
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
  readonly fixedDelta: number;
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
  readonly effect: Handle<'ParticleEffectAsset', 'shared'>;
  readonly playing: boolean;
  readonly seed: number;
  readonly timeScale: number;
}

interface PlayerState {
  effect: Handle<'ParticleEffectAsset', 'shared'>;
  asset: VfxGpuEffectAssetAny;
  seed: number;
  playing: boolean;
  playCycle: number;
  elapsed: number[];
  rateRemainders: number[];
  nextParticleIds: number[];
  playCycles: number[];
  cameraVisible: boolean[];
  phaseTicks: number[];
  initialFixedDeltas: number[];
  hasCommitted: boolean;
  pendingResets: boolean[];
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
  /** Only SharedRef grants; definitions remain owned by the ordinary asset payload. */
  readonly #effectLeases = new Map<
    VfxGpuEffectAssetAny,
    {
      readonly store: World['sharedRefs'];
      readonly handle: Handle<'ParticleEffectAsset', 'shared'>;
    }
  >();
  readonly #instances = new Map<EntityHandle, ParticleEffectInstance>();
  readonly #seen = new Set<EntityHandle>();
  readonly #intents: VfxGpuTickIntent[] = [];
  readonly #diagnostics: VfxGpuRuntimeDiagnostic[] = [];
  readonly #lastCommitted = new Map<EntityHandle, VfxGpuTickIntent>();
  readonly #lastCommittedByEmitter = new Map<EntityHandle, Map<string, VfxGpuTickIntent>>();
  readonly #eventCounters = new Map<EntityHandle, VfxChannelCounters>();
  readonly #cameraVisibility = new Map<string, boolean>();
  readonly #sessionEnabled = new Map<string, boolean>();
  readonly #replayRequests = new Set<EntityHandle>();
  readonly #replayInputs = new Map<EntityHandle, VfxReplayInput<VfxValueMap>>();
  #sequence = 0;
  #renderGeneration = 0;

  constructor(options: VfxGpuRuntimeOptions = {}) {
    this.#maxQueuedTicks = options.maxQueuedTicks ?? 8;
  }

  /** Resource generation owned by the current VFX render attachment. */
  get renderGeneration(): number {
    return this.#renderGeneration;
  }

  /** Borrow the runtime-owned exact definition handle for local or published rendering. */
  effectHandle(
    world: World,
    effect: VfxGpuEffectAssetAny,
  ): Handle<'ParticleEffectAsset', 'shared'> {
    let lease = this.#effectLeases.get(effect);
    if (lease === undefined) {
      lease = {
        store: world.sharedRefs,
        handle: world.sharedRefs.acquire('ParticleEffectAsset', effect),
      };
      this.#effectLeases.set(effect, lease);
    }
    return lease.handle;
  }

  #releaseUnusedEffects(): void {
    if (this.#effectLeases.size === 0) return;
    // Replaced programs can remove emitter IDs. Those records no longer have
    // a live drawable source; pending ticks retain their own exact definition.
    for (const [player, emitters] of this.#lastCommittedByEmitter) {
      const state = this.#players.get(player);
      if (state !== undefined && !isImmutableVfxGpuEffect(state.asset)) continue;
      let latest: VfxGpuTickIntent | undefined;
      for (const [id, intent] of emitters) {
        if (!state?.asset.program.emitters.some((emitter) => emitter.id === id)) {
          emitters.delete(id);
        } else if (latest === undefined || latest.sequence < intent.sequence) {
          latest = intent;
        }
      }
      if (latest === undefined) this.#lastCommitted.delete(player);
      else this.#lastCommitted.set(player, latest);
    }
    const live = new Set<VfxGpuEffectAssetAny>();
    for (const state of this.#players.values()) live.add(state.asset);
    for (const intent of this.#intents) live.add(intent.effect);
    for (const intent of this.#lastCommitted.values()) live.add(intent.effect);
    for (const emitters of this.#lastCommittedByEmitter.values())
      for (const intent of emitters.values()) live.add(intent.effect);
    for (const [effect, lease] of this.#effectLeases) {
      if (live.has(effect)) continue;
      lease.store.release(lease.handle).unwrap();
      this.#effectLeases.delete(effect);
    }
  }

  snapshot(): readonly VfxGpuTickIntent[] {
    return this.#intents;
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
   * frame does not need a fabricated FixedUpdate. Existing players keep their
   * patch and replay commits on the fixed boundary.
   */
  forEachEmitterSource(world: World, visitor: (source: VfxGpuEmitterSource) => void): void {
    for (const row of world.query({ read: [ParticleEffectPlayer] }).unwrap()) {
      if (this.#players.has(row.entity)) continue;
      const player = row.get(ParticleEffectPlayer);
      this.#preparePlayer(
        world,
        world.getResource(FixedTime).tick,
        0,
        {
          player: row.entity,
          effect: toShared<'ParticleEffectAsset'>(player.effect),
          playing: player.playing,
          seed: player.seed,
          timeScale: player.timeScale,
        },
        true,
      );
    }
    for (const [player, state] of this.#players) {
      if (!world.hasComponent(player, ParticleEffectPlayer)) {
        this.reset(player);
        continue;
      }
      for (const emitter of state.asset.program.emitters)
        visitor({ player, emitter, effect: state.asset });
    }
  }

  lastCommitted(player: EntityHandle): VfxGpuTickIntent | undefined {
    return this.#lastCommitted.get(player);
  }

  /**
   * Return the last submitted fixed-tick state for one emitter.  Renderers
   * retain this projection between fixed ticks; simulation intents are a
   * queue, while a drawable emitter remains live until the player is reset.
   */
  lastCommittedEmitter(player: EntityHandle, emitterId: string): VfxGpuTickIntent | undefined {
    return this.#lastCommittedByEmitter.get(player)?.get(emitterId);
  }

  /**
   * Rebuild the deterministic fixed-tick inputs needed to rehydrate one
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
    for (const intent of this.#intents) {
      if (intent.player !== player) continue;
      queuedIntents += 1;
      queuedTicks.add(intent.tick);
    }
    return Object.freeze({
      player,
      assetGuid: state.asset.guid,
      programFingerprint: state.asset.program.fingerprint,
      seed: lastIntent?.seed ?? state.seed,
      fixedDelta: lastIntent?.fixedDelta ?? 0,
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
            cameraVisible: this.#cameraVisibility.get(`${player}:${emitter.id}`) ?? true,
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
    this.#cameraVisibility.set(`${player}:${emitterId}`, visible);
  }

  setEmitterSessionEnabled(player: EntityHandle, emitterId: string, enabled: boolean): void {
    this.#sessionEnabled.set(`${player}:${emitterId}`, enabled);
  }

  isEmitterSessionEnabled(player: EntityHandle, emitterId: string): boolean {
    return this.#sessionEnabled.get(`${player}:${emitterId}`) ?? true;
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
    const prefix = typeof sequence === 'number' ? sequence : undefined;
    const acknowledged = typeof sequence === 'number' ? undefined : new Set(sequence);
    const published = publishedSequences === undefined ? undefined : new Set(publishedSequences);
    const committedPlayers = new Set<EntityHandle>();
    const retained: VfxGpuTickIntent[] = [];
    for (const intent of this.#intents) {
      const shouldAcknowledge =
        prefix === undefined
          ? acknowledged?.has(intent.sequence) === true
          : intent.sequence <= prefix;
      if (!shouldAcknowledge) {
        retained.push(intent);
        continue;
      }
      const state = this.#players.get(intent.player);
      committedPlayers.add(intent.player);
      if (published === undefined || published.has(intent.sequence)) {
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
          emitters.set(intent.emitter.id, intent);
        }
      }
    }
    this.#intents.splice(0, this.#intents.length, ...retained);
    for (const player of committedPlayers) {
      this.#clearDiagnostics(player, 'vfx-intent-queue-overflow');
    }
    this.#releaseUnusedEffects();
  }

  reset(player: EntityHandle): void {
    this.#discardQueuedIntents(player);
    this.#clearDiagnostics(player);
    this.#players.delete(player);
    this.#instances.delete(player);
    this.#replayRequests.delete(player);
    this.#lastCommitted.delete(player);
    this.#lastCommittedByEmitter.delete(player);
    this.#eventCounters.delete(player);
    this.#replayInputs.delete(player);
    const prefix = `${player}:`;
    for (const key of this.#cameraVisibility.keys()) {
      if (key.startsWith(prefix)) this.#cameraVisibility.delete(key);
    }
    for (const key of this.#sessionEnabled.keys()) {
      if (key.startsWith(prefix)) this.#sessionEnabled.delete(key);
    }
    this.#releaseUnusedEffects();
  }

  /**
   * Drop every generation-owned VFX runtime value after device recovery.
   * Authored ParticleEffectPlayer state remains the restart source on the next
   * FixedUpdate; no queued intent or stale instance crosses the boundary.
   */
  recover(): void {
    this.#renderGeneration += 1;
    this.#players.clear();
    this.#instances.clear();
    this.#seen.clear();
    this.#intents.length = 0;
    this.#diagnostics.length = 0;
    this.#lastCommitted.clear();
    this.#lastCommittedByEmitter.clear();
    this.#eventCounters.clear();
    this.#cameraVisibility.clear();
    this.#sessionEnabled.clear();
    this.#replayRequests.clear();
    this.#replayInputs.clear();
    this.#releaseUnusedEffects();
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

  #discardQueuedIntents(player: EntityHandle): void {
    let retained = 0;
    for (const intent of this.#intents) {
      if (intent.player !== player) {
        this.#intents[retained] = intent;
        retained += 1;
      }
    }
    this.#intents.length = retained;
  }

  advance(
    world: World,
    tick: number,
    fixedDelta: number,
    players: readonly VfxGpuPlayerInput[],
  ): void {
    this.#seen.clear();
    for (const input of players) {
      this.#seen.add(input.player);
      this.#preparePlayer(world, tick, fixedDelta, input, false);
    }
    for (const player of this.#players.keys()) {
      if (!this.#seen.has(player)) this.reset(player);
    }
  }

  #preparePlayer(
    world: World,
    tick: number,
    fixedDelta: number,
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
    const resolved = world.sharedRefs.resolve<'ParticleEffectAsset', VfxGpuEffectAssetAny>(
      input.effect,
    );
    if (!resolved.ok || resolved.value.schemaVersion !== 3) {
      this.#report({
        code: 'vfx-effect-unavailable',
        expected: 'a loaded schemaVersion 3 GPU particle effect',
        hint: 'cold-cook the legacy effect as Program v3 before the first FixedUpdate',
        detail: { player: input.player },
      });
      return;
    }
    this.#clearDiagnostics(input.player, 'vfx-effect-unavailable');
    const previous = this.#players.get(input.player);
    const replayRequested = !initializing && this.#replayRequests.delete(input.player);
    const restartRequested =
      previous === undefined ||
      previous.effect !== input.effect ||
      previous.seed !== input.seed ||
      replayRequested ||
      (!previous.playing && input.playing);
    const restart = restartRequested;
    const state = restartRequested
      ? {
          effect: input.effect,
          asset: resolved.value,
          seed: input.seed,
          playing: input.playing,
          playCycle: (previous?.playCycle ?? -1) + 1,
          elapsed: resolved.value.program.emitters.map(() => 0),
          rateRemainders: resolved.value.program.emitters.map(() => 0),
          nextParticleIds: resolved.value.program.emitters.map(() => 0),
          playCycles: resolved.value.program.emitters.map(() => (previous?.playCycle ?? -1) + 1),
          cameraVisible: resolved.value.program.emitters.map(() => true),
          phaseTicks: resolved.value.program.emitters.map(() => 0),
          initialFixedDeltas: resolved.value.program.emitters.map(
            () => fixedDelta * input.timeScale,
          ),
          hasCommitted: false,
          pendingResets: resolved.value.program.emitters.map(() => false),
        }
      : previous;
    this.#players.set(input.player, state);
    if (previous !== undefined && previous.asset !== state.asset) this.#releaseUnusedEffects();
    // Replay is a one-FixedUpdate request, not a second persistent play-state
    // authority. Inspection always returns the authored player state after
    // the requested reset intent has been emitted.
    state.playing = input.playing;
    if (!input.playing && !replayRequested) {
      if (restart) state.pendingResets.fill(true);
      return;
    }
    const queuedForPlayer = this.#intents.reduce(
      (count, intent) => count + (intent.player === input.player ? 1 : 0),
      0,
    );
    if (
      queuedForPlayer >=
      this.#maxQueuedTicks * Math.max(1, resolved.value.program.emitters.length)
    ) {
      if (restart) state.pendingResets.fill(true);
      if (state.hasCommitted) {
        this.#report({
          code: 'vfx-intent-queue-overflow',
          expected: `at most ${this.#maxQueuedTicks} unconsumed fixed ticks`,
          hint: 'recover or restart the renderer; VFX does not silently discard simulation ticks',
          detail: { player: input.player, maxQueuedTicks: this.#maxQueuedTicks },
        });
      }
      return;
    }
    const instance =
      this.#instances.get(input.player) ?? this.#createInstance(input.player, resolved.value);
    if (instance === undefined) {
      if (restart) state.pendingResets.fill(true);
      return;
    }
    const hasActiveEmitter = resolved.value.program.emitters.some((emitter) => {
      if (!this.isEmitterSessionEnabled(input.player, emitter.id)) return false;
      const cameraVisible = this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
      return cameraVisible || emitter.simulationWhenCulled === 'continue';
    });
    if (!hasActiveEmitter) {
      if (restart) state.pendingResets.fill(true);
      for (const [index, emitter] of resolved.value.program.emitters.entries()) {
        state.cameraVisible[index] =
          this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
      }
      return;
    }
    const replayInput = this.#replayInputs.get(input.player);
    this.#replayInputs.delete(input.player);
    const committed =
      replayInput === undefined
        ? instance.commit({ seed: input.seed, tick })
        : instance.replay(replayInput);
    if (!committed.ok) {
      if (restart) state.pendingResets.fill(true);
      this.#report({
        code: 'vfx-instance-commit-failed',
        expected: 'the current typed instance values to pack into the reflected GPU block',
        hint: 'repair the instance patch and retry at the next FixedUpdate',
        detail: { player: input.player },
      });
      return;
    }
    const delta = fixedDelta * input.timeScale;
    const committedChannels = committed.value.channelInputs;
    for (const [index, emitter] of resolved.value.program.emitters.entries()) {
      const cameraVisible = this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
      const becameVisible = cameraVisible && state.cameraVisible[index] === false;
      state.cameraVisible[index] = cameraVisible;
      const emitterRestart = restart || state.pendingResets[index] === true;
      if (!this.isEmitterSessionEnabled(input.player, emitter.id)) {
        if (emitterRestart) state.pendingResets[index] = true;
        continue;
      }
      if (!cameraVisible && emitter.simulationWhenCulled !== 'continue') {
        if (emitterRestart) state.pendingResets[index] = true;
        continue;
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
      if (
        delta === 0 &&
        !emitterRestart &&
        !visibilityRestart &&
        committed.value.patchCount === 0 &&
        committedChannels.length === 0
      )
        continue;
      const previousElapsed = state.elapsed[index] ?? 0;
      const scheduled = spawnCount(
        emitter,
        previousElapsed,
        previousElapsed + delta,
        emitterRestart || visibilityRestart,
        state.rateRemainders[index] ?? 0,
      );
      state.rateRemainders[index] = scheduled.remainder;
      const firstParticleId = state.nextParticleIds[index] ?? 0;
      state.nextParticleIds[index] = firstParticleId + scheduled.count;
      const consumesEvent = resolved.value.program.emitters.some((source) =>
        (source.events ?? []).some((event) => event.subEmitter === emitter.id),
      );
      const eventSources = resolved.value.program.emitters.flatMap((source) =>
        (source.events ?? []).filter((event) => event.subEmitter === emitter.id),
      );
      const channelInputs =
        (emitter.events?.length ?? 0) > 0 || consumesEvent ? committedChannels : [];
      const phaseTick = state.phaseTicks[index] ?? 0;
      if (emitterRestart || visibilityRestart) state.initialFixedDeltas[index] = delta;
      this.#intents.push(
        Object.freeze({
          sequence: this.#sequence++,
          player: input.player,
          emitter,
          effect: resolved.value,
          programFingerprint: resolved.value.program.fingerprint,
          reset: emitterRestart || visibilityRestart,
          fixedDelta: delta,
          initialFixedDelta: state.initialFixedDeltas[index] ?? delta,
          phaseTick,
          tick,
          seed: input.seed,
          playCycle: state.playCycles[index] ?? state.playCycle,
          spawnCount: scheduled.count,
          firstParticleId,
          instanceGeneration: committed.value.generation,
          instancePatchCount: committed.value.patchCount,
          parameterBlock: committed.value.parameterBlock,
          canonicalPayload: committed.value.canonicalPayload,
          replayInput: committed.value.replayInput,
          channelInputs,
          eventCounters: eventCounters(
            { channelInputs, emitter },
            channelInputs.length === 0 ? 0 : committed.value.droppedCount,
            eventSources,
          ),
        }),
      );
      state.elapsed[index] = previousElapsed + delta;
      state.phaseTicks[index] = phaseTick + 1;
      state.pendingResets[index] = false;
    }
  }

  #createInstance(
    player: EntityHandle,
    effect: VfxGpuEffectAssetAny,
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
    for (let index = this.#intents.length - 1; index >= 0; index -= 1) {
      const intent = this.#intents[index];
      if (intent?.player !== player || intent.emitter.id !== emitterId) continue;
      if (latest === undefined || intent.sequence > latest.sequence) latest = intent;
      break;
    }
    return latest;
  }
}

function spawnCount(
  emitter: VfxGpuEmitterProgramAny,
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
  const rows: VfxGpuPlayerInput[] = [];
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
          .addSystem(FixedUpdate, {
            name: 'vfx-gpu-runtime',
            queries: [{ with: [Entity, ParticleEffectPlayer] }],
            fn: (world, queryResults) => {
              rows.length = 0;
              for (const row of queryResults[0]) {
                const player = row.get(ParticleEffectPlayer);
                rows.push({
                  player: row.entity,
                  effect: toShared<'ParticleEffectAsset'>(player.effect),
                  playing: player.playing,
                  seed: player.seed,
                  timeScale: player.timeScale,
                });
              }
              const fixed = world.getResource(FixedTime);
              runtime.advance(world, fixed.tick, fixed.delta, rows);
            },
          })
          .unwrap();
        return () => world.removeSystem(FixedUpdate, 'vfx-gpu-runtime');
      }, 'vfx/tick-system');
    },
  };
}

/** Reconstruct GPU inputs from submitted POD without owning World time or event queues. */
export function buildVfxRecoveryIntents(
  latest: VfxGpuTickIntent | undefined,
): readonly VfxGpuTickIntent[];
export function buildVfxRecoveryIntents(
  latest: Omit<VfxGpuTickIntent, 'effect'> | undefined,
): readonly Omit<VfxGpuTickIntent, 'effect'>[];
export function buildVfxRecoveryIntents(
  latest: Omit<VfxGpuTickIntent, 'effect'> | undefined,
): readonly Omit<VfxGpuTickIntent, 'effect'>[] {
  if (latest === undefined) return [];
  const intents: Omit<VfxGpuTickIntent, 'effect'>[] = [];
  let elapsed = 0;
  let remainder = 0;
  let firstParticleId = 0;
  for (let phaseTick = 0; phaseTick <= latest.phaseTick; phaseTick += 1) {
    const fixedDelta = phaseTick === 0 ? latest.initialFixedDelta : latest.fixedDelta;
    const next = elapsed + fixedDelta;
    const scheduled = spawnCount(latest.emitter, elapsed, next, phaseTick === 0, remainder);
    intents.push(
      Object.freeze({
        ...latest,
        reset: phaseTick === 0,
        fixedDelta,
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
