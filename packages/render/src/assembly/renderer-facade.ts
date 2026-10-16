import { ProjectedDecalInvalidError } from '../decals/component';
import { RenderPublicationError } from '../publication/contract';
import {
  freezeDiffuseGi,
  freezeGlobalSdfGrid,
  validateCardCapture,
  validateDiffuseGi,
  validateGlobalSdfRegion,
} from '../raytracing/irradiance-field-plan';
import { RAY_REFERENCE_LIMIT } from '../raytracing/scene';

// Public renderer facade and profile validation.
// This module narrows the lifetime-heavy host implementation to the stable
// lease/receipt contract and owns the profile/error projection helpers.

import type { World } from '@forgeax/engine-ecs';
import { err, ok, type RhiError } from '@forgeax/engine-rhi';
import type {
  DynamicGeometryCandidate,
  DynamicGeometryError,
  DynamicGeometryOrdering,
  DynamicGeometryPrepareInput,
} from '../dynamic-geometry';
import { type RecoverFailure, RecoveryFailedError } from '../errors/recover';
import {
  EquirectProjectionFailedError,
  ExternalTextureInvalidError,
  ExternalTextureStateInvalidError,
  MaterialSampledTextureBudgetExceededError,
  type RenderError,
  RendererContractFailureError,
  type RendererOperationCause,
  RendererOperationError,
} from '../errors/render';
import { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import {
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  STANDARD_POST_STAGE_NAMES,
} from '../pipeline/standard-profile';
import type {
  FrameObservationDomain,
  FrameReceipt,
  Renderer,
  RendererError,
  RendererEventListener,
  RendererState,
  RenderInspection,
  RenderProfile,
  RenderResult,
} from '../render-contract';
import { resolveSsaoParameters } from '../ssao-config';
import type { RendererHostImplementation } from './host-contract';
import { createRendererLifecycle, isRendererStateOperational } from './renderer-lifecycle';

/** Narrow the concrete host to the lease/receipt-only public contract. */
export function exposeRenderer(renderer: RendererHostImplementation): Renderer {
  const listeners = new Set<RendererEventListener>();
  const lifecycle = createRendererLifecycle(renderer.inspect().state);
  let disposed = lifecycle.state() === 'disposed';
  let recoverInFlight: Promise<RenderResult<void, RenderError>> | undefined;
  const dynamicGeometryFault = (world: World): DynamicGeometryError | undefined =>
    (
      renderer as RendererHostImplementation & {
        readonly dynamicGeometryFault?: (world: World) => DynamicGeometryError | undefined;
      }
    ).dynamicGeometryFault?.(world);

  const emit = (event: Parameters<RendererEventListener>[0]): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.error('[Renderer.subscribe] listener threw:', cause);
      }
    }
  };
  const transition = (next: RendererState): void => {
    const previous = lifecycle.state();
    if (previous === next || !lifecycle.transition(next)) return;
    emit(Object.freeze({ kind: 'state-changed', previous, current: next }));
  };
  // Projection and texture-budget failures are public, asset-caused RenderErrors
  // that name the source problem; wrapping them would hide it behind a device code.
  const eventError = (cause: RendererError): RenderError =>
    cause instanceof RendererOperationError ||
    cause instanceof EquirectProjectionFailedError ||
    cause instanceof ExternalTextureInvalidError ||
    cause instanceof ExternalTextureStateInvalidError ||
    cause instanceof MaterialSampledTextureBudgetExceededError
      ? cause
      : new RendererOperationError('device-operation-failed', {
          operation: 'renderer-event',
          cause: structuredRendererCause(cause, 'renderer-event'),
        });
  const drawError = (cause: RhiError | RenderError): RenderError => {
    if (
      cause instanceof MotionBlurValidationError ||
      cause instanceof RenderPublicationError ||
      cause instanceof ProjectedDecalInvalidError
    )
      return cause;
    if (cause instanceof RendererOperationError) return cause;
    if (cause instanceof RendererContractFailureError) {
      return new RendererOperationError('device-operation-failed', {
        operation: 'draw',
        cause: structuredRendererCause(cause, 'draw'),
      });
    }
    return new RendererOperationError('device-operation-failed', {
      operation: 'draw',
      cause: structuredRendererCause(cause, 'draw'),
    });
  };
  const offHostEvents = renderer.subscribeHostEvents((event) => {
    if (event.kind === 'error') {
      emit(Object.freeze({ kind: 'error', error: eventError(event.error) }));
      return;
    }
    transition(
      event.health.reason === 'device-lost'
        ? 'device-lost'
        : event.health.reason === 'internal-fault'
          ? 'faulted'
          : 'alive',
    );
  });

  return {
    setSurfaceDynamicInput: (frame) => renderer.setSurfaceDynamicInput(frame),
    bounds: (world, entity) => (disposed ? undefined : renderer.bounds(world, entity)),
    attach: (world) => {
      const result = renderer.attach(world);
      return result.ok
        ? result
        : err(
            new RendererOperationError('world-lease-invalid', {
              operation: 'attach',
              cause: result.error,
            }),
          );
    },
    prepareDynamicGeometry: (input: DynamicGeometryPrepareInput) => {
      const fault = dynamicGeometryFault(input.world as World);
      return fault === undefined ? renderer.prepareDynamicGeometry(input) : err(fault);
    },
    prepareDynamicGeometryCandidates: (inputs) => {
      const first = inputs[0];
      const fault = first === undefined ? undefined : dynamicGeometryFault(first.world as World);
      return fault === undefined ? renderer.prepareDynamicGeometryCandidates(inputs) : err(fault);
    },
    preparePublishedMeshResidency: (input) => renderer.preparePublishedMeshResidency(input),
    prepareMeshResidency: (world, meshHandle, observePhase) =>
      renderer.prepareMeshResidency(world, meshHandle, observePhase),
    acceptDynamicGeometry: (
      candidate: DynamicGeometryCandidate,
      ordering: DynamicGeometryOrdering,
    ) => {
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.acceptDynamicGeometry(candidate, ordering) : err(fault);
    },
    acceptDynamicGeometryCandidates: (candidates, ordering) => {
      const first = candidates[0];
      const fault = first === undefined ? undefined : dynamicGeometryFault(first.world as World);
      return fault === undefined
        ? renderer.acceptDynamicGeometryCandidates(candidates, ordering)
        : err(fault);
    },
    isDynamicGeometryCurrent: (candidate: DynamicGeometryCandidate) =>
      lifecycle.state() === 'alive' && renderer.isDynamicGeometryCurrent(candidate),
    dynamicGeometryReceipt: (candidate: DynamicGeometryCandidate) =>
      dynamicGeometryFault(candidate.world as World) === undefined
        ? renderer.dynamicGeometryReceipt(candidate)
        : undefined,
    cancelDynamicGeometry: (candidate: DynamicGeometryCandidate) => {
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.cancelDynamicGeometry(candidate) : err(fault);
    },
    retireDynamicGeometry: (candidate: DynamicGeometryCandidate) => {
      const fault = dynamicGeometryFault(candidate.world as World);
      return fault === undefined ? renderer.retireDynamicGeometry(candidate) : err(fault);
    },
    createRenderTarget: (descriptor) => renderer.createRenderTarget(descriptor),
    resizeRenderTarget: (target, descriptor) => renderer.resizeRenderTarget(target, descriptor),
    createRenderTargetTextureSource: (target, options) =>
      renderer.createRenderTargetTextureSource(target, options),
    requestTargetReadback: (target, request) => renderer.requestTargetReadback(target, request),
    requestFramebufferSnapshot: (target, request) =>
      renderer.requestFramebufferSnapshot(target, request),
    destroyRenderTarget: (target) => renderer.destroyRenderTarget(target),
    importTexture: (input) => renderer.importTexture(input),
    nativeDevice: () => renderer.nativeDevice(),
    setProfile: (profile) => {
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-profile',
            state,
          }),
        );
      }
      return renderer.setProfile(profile);
    },
    setOutputColorSpace: (colorSpace) => {
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'set-output-color-space',
            state,
          }),
        );
      }
      return renderer.setOutputColorSpace(colorSpace);
    },
    state: () => lifecycle.state(),
    draw: (request) => {
      const state = lifecycle.state();
      if (!isRendererStateOperational(state)) {
        return err(
          new RendererOperationError('renderer-state-invalid', {
            operation: 'draw',
            state,
          }),
        );
      }
      // A failed record can publish its precise owner error before returning the
      // generic no-submission guard. Preserve that same-call cause for the caller.
      let frameFailure: RenderError | undefined;
      const observeFailure: RendererEventListener = (event) => {
        if (event.kind === 'error') frameFailure ??= event.error;
      };
      listeners.add(observeFailure);
      let result: RenderResult<FrameReceipt, RhiError | RenderError>;
      try {
        result = renderer.drawFrame(request);
      } finally {
        listeners.delete(observeFailure);
      }
      if (!result.ok) {
        return err(
          result.error instanceof RendererContractFailureError && frameFailure !== undefined
            ? frameFailure
            : drawError(result.error),
        );
      }
      emit(
        Object.freeze({
          kind: 'frame-submitted',
          frameId: result.value.frameId,
          deviceGeneration: result.value.deviceGeneration,
          ...(result.value.graphGeneration === undefined
            ? {}
            : { graphGeneration: result.value.graphGeneration }),
          receipt: result.value,
        }),
      );
      return ok(result.value);
    },
    requestObservation: (domains: readonly FrameObservationDomain[]) =>
      renderer.requestObservation?.(domains) ??
      err(
        new RendererOperationError('renderer-state-invalid', {
          operation: 'request-observation',
          state: lifecycle.state(),
        }),
      ),
    currentDeviceGeneration: () =>
      renderer.currentDeviceGeneration?.() ?? renderer.inspect().frame.deviceGeneration,
    inspect: () => ({ ...renderer.inspect(), state: lifecycle.state() }),
    observe: (receipt, request) => renderer.observe(receipt, request),
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    releaseSurface: () => {
      const result = renderer.releaseSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'release-surface',
              cause: result.error,
            }),
          );
    },
    restoreSurface: () => {
      const result = renderer.restoreSurface();
      return result.ok
        ? result
        : err(
            new RendererOperationError('surface-unavailable', {
              operation: 'restore-surface',
              cause: result.error,
            }),
          );
    },
    recover: () => {
      if (recoverInFlight !== undefined) return recoverInFlight;
      const state = lifecycle.state();
      if (state !== 'device-lost') {
        return Promise.resolve(
          err(
            new RendererOperationError('renderer-state-invalid', {
              operation: 'recover',
              state,
            }),
          ),
        );
      }
      transition('recovering');
      recoverInFlight = renderer
        .recover()
        .then((result): RenderResult<void, RenderError> => {
          if (!result.ok) {
            const error = new RendererOperationError('recovery-failed', {
              operation: 'recover',
              ...projectRecoveryFailureDetail(result.error, renderer.inspect().recovery),
              cause: structuredRendererCause(result.error, 'recover'),
            });
            emit(Object.freeze({ kind: 'error', error }));
            return err(error);
          }
          return ok(undefined);
        })
        .finally(() => {
          transition(renderer.inspect().state);
          recoverInFlight = undefined;
        });
      return recoverInFlight;
    },
    dispose: async () => {
      if (disposed) return ok(undefined);
      const result = renderer.dispose();
      if (!result.ok) emit(Object.freeze({ kind: 'error', error: result.error }));
      disposed = true;
      transition('disposed');
      offHostEvents();
      listeners.clear();
      return result;
    },
  };
}

// ─── feat-20260520-directional-light-shadow-mapping M1c / w8 helpers ────────

// ─── Helpers ────────────────────────────────────────────────────────────────

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

export function structuredRendererCause(cause: unknown, operation: string): RendererOperationCause {
  if (typeof cause === 'object' && cause !== null) {
    const candidate = cause as Partial<RendererOperationCause>;
    if (
      typeof candidate.code === 'string' &&
      typeof candidate.expected === 'string' &&
      typeof candidate.hint === 'string'
    ) {
      return {
        code: candidate.code,
        expected: candidate.expected,
        hint: candidate.hint,
        ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
      };
    }
  }
  const contractFailure = new RendererContractFailureError(
    'draw',
    `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  return {
    code: contractFailure.code,
    expected: contractFailure.expected,
    hint: contractFailure.hint,
    detail: contractFailure.detail,
  };
}

function projectRecoveryFailureDetail(
  failure: RecoverFailure,
  inspection: RenderInspection['recovery'],
): Omit<
  import('../errors/render').RendererOperationDetailByCode['recovery-failed'],
  'operation' | 'cause'
> {
  if (failure instanceof RecoveryFailedError) {
    return {
      phase: failure.detail.phase,
      oldGeneration: failure.detail.oldGeneration,
      candidateGeneration: failure.detail.candidateGeneration,
      attempt: failure.detail.attempt,
      elapsedMs: failure.detail.elapsedMs,
      retryable: failure.detail.retryable,
      guidance: failure.detail.guidance,
      owner: failure.detail.owner,
      resourceKind: failure.detail.resourceKind,
      lastOutcome: failure.detail.lastOutcome,
      rehydratedRoots: failure.detail.rehydratedRoots,
      staleLossEvents: failure.detail.staleLossEvents,
      cleanupFailures: Object.freeze(
        failure.detail.cleanupFailures.map((cause: unknown) =>
          structuredRendererCause(cause, 'recovery-cleanup'),
        ),
      ),
    };
  }
  const lastOutcome = inspection.lastOutcome === 'disposed' ? 'disposed' : 'failed';
  return {
    phase: inspection.phase ?? 'cleanup',
    oldGeneration: inspection.fromGeneration,
    candidateGeneration: inspection.candidateGeneration,
    attempt: inspection.attempt,
    elapsedMs: inspection.elapsedMs,
    retryable: false,
    guidance: 'rebuild-renderer',
    owner: inspection.failedOwner ?? 'renderer',
    resourceKind: inspection.failedResourceKind ?? 'pipeline',
    lastOutcome,
    rehydratedRoots: inspection.rehydratedRoots,
    staleLossEvents: inspection.staleLossEvents,
    cleanupFailures: Object.freeze([]),
  };
}

const RENDER_PROFILE_KEYS = new Set([
  'pipelineId',
  'lightCount',
  'renderPath',
  'subsurfaceQuality',
  'visibleSurface',
  'diffuseGi',
  'probePlacement',
  'pbr',
  'ibl',
  'ssao',
  'volumetricFog',
  'gpuOcclusion',
  'postStages',
]);

export function validateRenderProfile(profile: RenderProfile): string | undefined {
  if (typeof profile !== 'object' || profile === null) return 'RenderProfile must be a POD object';
  const unknownKey = Object.keys(profile).find((key) => !RENDER_PROFILE_KEYS.has(key));
  if (unknownKey !== undefined) return `RenderProfile contains unsupported field '${unknownKey}'`;
  if (profile.pipelineId !== STANDARD_PIPELINE_ID) {
    return `RenderProfile.pipelineId must be '${STANDARD_PIPELINE_ID}'`;
  }
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return 'RenderProfile.lightCount must be 1, 32, or 256';
  }
  if (profile.renderPath !== 'forward' && profile.renderPath !== 'deferred') {
    return "RenderProfile.renderPath must be 'forward' or 'deferred'";
  }
  if (
    profile.subsurfaceQuality !== undefined &&
    profile.subsurfaceQuality !== 'low' &&
    profile.subsurfaceQuality !== 'high'
  )
    return 'RenderProfile.subsurfaceQuality must be low or high';
  if (profile.volumetricFog !== undefined) {
    const volume = profile.volumetricFog;
    if (
      typeof volume !== 'object' ||
      volume === null ||
      Array.isArray(volume) ||
      Object.keys(volume).some((key) => !['quality', 'depth', 'tileSize'].includes(key)) ||
      (volume.quality !== 'low' && volume.quality !== 'high') ||
      (volume.depth !== 48 && volume.depth !== 64) ||
      (volume.tileSize !== 4 && volume.tileSize !== 16)
    )
      return 'RenderProfile.volumetricFog requires quality low/high, depth 48/64 and tileSize 4/16';
  }
  if (profile.visibleSurface !== undefined && typeof profile.visibleSurface !== 'boolean')
    return 'RenderProfile.visibleSurface must be boolean';
  if (profile.gpuOcclusion !== undefined && typeof profile.gpuOcclusion !== 'boolean')
    return 'RenderProfile.gpuOcclusion must be boolean';
  if (profile.visibleSurface === true && profile.renderPath !== 'deferred')
    return 'Visible surfaces require the Standard deferred path';
  if (profile.probePlacement !== undefined) {
    const placement = profile.probePlacement;
    if (
      typeof placement !== 'object' ||
      placement === null ||
      Array.isArray(placement) ||
      Object.keys(placement).some((key) => !['seeds', 'global'].includes(key))
    )
      return 'Probe placement requires one seeds/global configuration object';
    const seeds = placement.seeds;
    if (profile.renderPath !== 'deferred') return 'Probe placement requires Standard deferred';
    if (
      !Array.isArray(seeds) ||
      seeds.length < 1 ||
      seeds.length > 4096 ||
      new Set(seeds.map((seed) => seed?.id)).size !== seeds.length ||
      seeds.some(
        (seed) =>
          typeof seed !== 'object' ||
          seed === null ||
          Object.keys(seed).some(
            (key) => !['id', 'generation', 'position', 'cellSize', 'traced'].includes(key),
          ) ||
          ![seed.id, seed.generation].every(
            (v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff,
          ) ||
          typeof seed.traced !== 'boolean' ||
          !Array.isArray(seed.position) ||
          seed.position.length !== 3 ||
          !seed.position.every(
            (v: unknown) =>
              typeof v === 'number' && Number.isFinite(Math.fround(v)) && Math.abs(v) < 1e30,
          ) ||
          typeof seed.cellSize !== 'number' ||
          !(Math.fround(seed.cellSize) > 1e-20 && Math.fround(seed.cellSize) < 1e20),
      )
    )
      return 'Probe placement requires 1..4096 unique nonzero u32 seed identities/generations, finite positions, bounded positive cells and explicit traced eligibility';
    const global = placement.global;
    if (global !== undefined) {
      const region = validateGlobalSdfRegion(global, ['rayResolution', 'tMax', 'cards']);
      if (!region.ok) return region.error.detail.cause;
      if (
        !Number.isInteger(global.rayResolution) ||
        global.rayResolution < 1 ||
        global.rayResolution > 256 ||
        seeds.length * global.rayResolution ** 2 > RAY_REFERENCE_LIMIT ||
        !(Math.fround(global.tMax) >= 2 ** -126 && Math.fround(global.tMax) < 1e30) ||
        seeds.some((seed) => seed.position.some((v: number) => Math.abs(v) + global.tMax >= 1e30))
      )
        return 'Global probes require 1..256 ray texels/axis within the query ray limit and finite normal f32 endpoints';
      if (global.cards !== undefined) {
        const cards = validateCardCapture(global.cards);
        if (!cards.ok) return cards.error.detail.cause;
      }
    }
  }
  if (profile.diffuseGi !== undefined) {
    const gi = validateDiffuseGi(profile.diffuseGi);
    if (!gi.ok) return gi.error.detail.cause;
    if (profile.renderPath !== 'deferred' || profile.ibl || !profile.pbr)
      return 'Diffuse GI requires deferred PBR with IBL disabled';
  }
  for (const field of ['pbr', 'ibl'] as const) {
    if (typeof profile[field] !== 'boolean') return `RenderProfile.${field} must be boolean`;
  }
  if (
    typeof profile.ssao !== 'boolean' &&
    (typeof profile.ssao !== 'object' || profile.ssao === null || Array.isArray(profile.ssao))
  )
    return 'RenderProfile.ssao must be boolean or AO parameters';
  if (typeof profile.ssao === 'object') {
    if (
      Object.keys(profile.ssao).some(
        (key) => !['algorithm', 'radius', 'bias', 'intensity', 'quality'].includes(key),
      )
    )
      return 'RenderProfile.ssao contains an unsupported parameter';
    const resolved = resolveSsaoParameters(profile.ssao);
    if (!resolved.ok) return resolved.error.hint;
  }
  if (profile.ssao !== false && profile.renderPath !== 'deferred')
    return 'SSAO needs current depth and normals: set renderPath to deferred';
  const stages = STANDARD_POST_STAGE_NAMES;
  if (
    !Array.isArray(profile.postStages) ||
    profile.postStages.length !== stages.length ||
    stages.some((stage, index) => profile.postStages[index] !== stage)
  ) {
    return 'RenderProfile.postStages must preserve the Standard post stage order';
  }
  return undefined;
}

export function freezeRenderProfile(profile: RenderProfile): RenderProfile {
  return Object.freeze({
    ...profile,
    ...(profile.probePlacement === undefined
      ? {}
      : {
          visibleSurface: true,
          probePlacement: Object.freeze({
            seeds: Object.freeze(
              profile.probePlacement.seeds.map((seed) =>
                Object.freeze({
                  ...seed,
                  position: Object.freeze([...seed.position]) as readonly [number, number, number],
                }),
              ),
            ),
            ...(profile.probePlacement.global === undefined
              ? {}
              : {
                  global: Object.freeze({
                    ...profile.probePlacement.global,
                    ...(profile.probePlacement.global.cards === undefined
                      ? {}
                      : { cards: Object.freeze({ ...profile.probePlacement.global.cards }) }),
                    grid: freezeGlobalSdfGrid(profile.probePlacement.global.grid),
                  }),
                }),
          }),
        }),
    ...(profile.diffuseGi === undefined
      ? {}
      : { visibleSurface: true, diffuseGi: freezeDiffuseGi(profile.diffuseGi) }),
    ssao: typeof profile.ssao === 'object' ? Object.freeze({ ...profile.ssao }) : profile.ssao,
    ...(profile.volumetricFog === undefined
      ? {}
      : { volumetricFog: Object.freeze({ ...profile.volumetricFog }) }),
    postStages: Object.freeze([...profile.postStages]) as RenderProfile['postStages'],
  });
}
