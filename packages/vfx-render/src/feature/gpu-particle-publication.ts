import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';

import type { EntityHandle, World } from '@forgeax/engine-ecs';

import type {
  RenderFeature,
  RenderFeaturePlanContext,
  RenderFeatureSceneSdfDescriptor,
} from '@forgeax/engine-render';

import {
  isOwnedRenderFeatureProgramData,
  ownRenderFeatureProgramData,
} from '@forgeax/engine-render/internal';

import type { MaterialAsset, MeshAsset, Result } from '@forgeax/engine-types';
import type {
  ParticleRendererSourceV3,
  VfxGpuTickIntent as SourceVfxGpuTickIntent,
  VfxForceFieldError,
  VfxGpuEffectAsset,
  VfxGpuEmitterSource,
} from '@forgeax/engine-vfx';

import { RenderFeatureStageFailedError } from '../../../render/src/errors/render';

import type { VfxDataInterfaceRegistry } from '../host/data-interface-providers.js';

import type { ParticleRenderCamera, ParticleRenderCameraSource } from './camera.js';

import { emitterHasNoProviders } from './emitter-program.js';

import type { createVfxForceFieldPreparation, PreparedVfxForceFields } from './force-fields.js';

import type { VfxRenderObservation } from './inspect.js';

import type { VfxIntentReference } from './intent-publication.js';

import type { ParticleMaterialSource } from './material-source.js';

import { resolveFields } from './provider-resolution.js';

export const IDENTITY = 'forgeax.vfx-render.gpu-particles';

export type ParticleRenderer = ParticleRendererSourceV3;

export interface GpuParticleFeatureOptions {
  readonly camera: ParticleRenderCameraSource;
  /** Same-build diagnostic A/B. Opt in to validated view-local graph isolation. */
  readonly isolateViewGraph?: boolean;
  /**
   * Capture policy; defaults to `all` (planar, probe and cube captures show
   * particles). Each captured face adds a particle pass; pass `display-only`
   * to opt out.
   */
  readonly capture?:
    | 'all'
    | 'display-only'
    | { readonly faces: readonly ('planar' | 'probe' | 'cube')[] };
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

export interface ExtractedMaterial {
  readonly asset: MaterialAsset;
  readonly projection?: MaterialRenderProjection;
}

export interface ExtractedEmitterState {
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

export interface RetainedEmitter {
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

export interface ExtractedFrame {
  readonly source: ExtractedWorld | undefined;
  readonly frameNumber: number;
}

/** Source frames carry exact resource identities, never immutable program bodies. */
export type PublishedEmitter = {
  readonly effect: number;
  readonly revision: number;
  readonly id: string;
};

export type PublishedIntent = Omit<SourceVfxGpuTickIntent, 'effect' | 'emitter'> & {
  readonly emitter: PublishedEmitter;
};

export type PublishedEmitterState = Omit<ExtractedEmitterState, 'emitter' | 'forceFields'> & {
  readonly forceFields?: SourceVfxGpuTickIntent['forceFields'];
  readonly emitter: PublishedEmitter;
};

export type PublishedWorld = Omit<
  ExtractedWorld,
  'emitterState' | 'intents' | 'retained' | 'meshes'
> & {
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
  readonly source: PublishedWorld | undefined;
  readonly frameNumber: number;
}

export const immutableEmitters = new WeakSet<object>();

const fixedEmitters = new WeakMap<object, VfxGpuTickIntent['emitter']>();

export function ownEmitter(source: VfxGpuTickIntent['emitter']): VfxGpuTickIntent['emitter'] {
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

export function emitterHasEvents(emitter: VfxGpuTickIntent['emitter']): boolean {
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

export function resolveEffect(
  reference: PublishedEmitter,
  context: RenderFeaturePlanContext,
): VfxGpuEffectAsset {
  const resolved = context.resolveAsset?.(reference.effect, reference.revision);
  if (resolved === undefined) throw new Error('VFX requires the feature asset resolver');
  if (!resolved.ok) throw resolved.error;
  const effect = resolved.value as VfxGpuEffectAsset;
  if (effect.kind !== 'particle-effect' || effect.schemaVersion !== 3)
    throw new Error('VFX requires a schemaVersion 3 particle effect');
  return effect;
}

function resolveEmitter(reference: PublishedEmitter, context: RenderFeaturePlanContext) {
  const effect = resolveEffect(reference, context);
  const emitter = effect.program.emitters.find((candidate) => candidate.id === reference.id);
  if (emitter === undefined) throw new Error(`Missing VFX emitter ${reference.id}`);
  if (isOwnedRenderFeatureProgramData(effect)) {
    immutableEmitters.add(emitter);
    return { effect, emitter };
  }
  return { effect, emitter: ownEmitter(emitter) };
}

export function resolveIntent(
  intent: PublishedIntent,
  context: RenderFeaturePlanContext,
  prepare: ReturnType<typeof createVfxForceFieldPreparation>,
): VfxGpuTickIntent {
  const definition = resolveEmitter(intent.emitter, context);
  if (definition.effect.program.fingerprint !== intent.programFingerprint)
    throw new Error('VFX intent and exact effect fingerprint differ');
  const forceFields = resolveFields(definition.emitter, intent.forceFields, context, prepare);
  const { forceFields: _input, ...tick } = intent;
  return { ...tick, ...definition, ...(forceFields === undefined ? {} : { forceFields }) };
}

export function planFailure(cause?: unknown): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError(IDENTITY, -1, 'plan', 'next-frame', cause);
}

/** Zero source shared by every reset copy of one plan. */
export const RESET_ZERO = 'vfx.reset-zero';

/** Immutable provider-free emitters may retain bindings, storage and native plans across frames. */
export function isRetainableEmitter(emitter: VfxGpuTickIntent['emitter']): boolean {
  return immutableEmitters.has(emitter) && emitterHasNoProviders(emitter);
}

/** A paused or culled tick is skipped, but a reset waits and blocks the rest of its stream. */
export function holdIntent(
  intent: Pick<VfxGpuTickIntent, 'reset'>,
  baseKey: string,
  blockedEmitters: Set<string>,
): 'skipped' | 'deferred' {
  if (!intent.reset) return 'skipped';
  blockedEmitters.add(baseKey);
  return 'deferred';
}

/** Largest per-particle material input stride among an emitter's renderers. */
export type VfxParticleRenderFeature = RenderFeature<PublishedFrame> & {
  readonly inspect: () => VfxRenderObservation;
};
