import type { RhiError } from '@forgeax/engine-rhi';
import type { AssetError } from '@forgeax/engine-types';
import type { Antialias } from '../components/camera';
import type { RenderPublicationError } from '../publication/contract';
import type { SceneSdfUnavailableError } from './scene-sdf';
// @forgeax/engine-render -- render cluster error classes.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): the monolithic
// errors.ts RuntimeErrorCode / RuntimeError top-level aggregate unions are
// decomposed into five per-cluster files (render / asset / skin / recover /
// environment). Each cluster owns a closed *ErrorCode code union + a closed
// *Error class union; error class names, .code literals, and .detail shapes
// are preserved byte-for-byte (OOS-4: zero semantic change).
//
// The render cluster holds the shadow / HDRP cluster-forward + deferred /
// g-buffer / point-shadow-atlas / video-upload / vertex-storage-buffer render
// path errors. ShadowInvalidConfigError is consumed by the DirectionalLight /
// SpotLight / PointLightShadow component validators (forward cross-directory
// import, no cycle -- research Finding C2).

import type {
  RenderSurfaceFailureDetail,
  SurfaceFailureCode,
  SurfaceFailureKind,
} from '@forgeax/engine-render-graph';
import type { DeviceResourceKind, DeviceScopeReceipt } from '../device/resource-types';
import type { SunCardinalityError } from '../environment/frame';
import type { MotionBlurValidationError } from '../features/motion-blur/motion-blur-params';
import type {
  PreparedKind,
  RenderFeatureCapabilityKey,
  RenderFeatureRecovery,
  RenderFeatureStage,
} from '../features/vocabulary';
import type { AutoExposureError } from '../pipeline/standard-output/auto-exposure/inspection';
import type { SceneDataLane, SceneDataSchemaId } from '../temporal/scene-data';
import type { TransmissionCapabilityFact } from '../transmission/backdrop';
import type { CloudLayerError } from './cloud';
import type { RecoveryOutcome, RecoveryPhase } from './recover';

// Public render errors keep one machine-readable order: closed `code`,
// expected state, actionable `hint`, then typed `detail`. Consumers branch on
// that shape and never use Error.message as a protocol.

export type {
  AutoExposureCapabilityUnavailableDetail,
  AutoExposureError,
  AutoExposureErrorCode,
  AutoExposureErrorDetail,
  AutoExposureErrorDetailByCode,
  AutoExposureErrorRecord,
  AutoExposureInspection,
  AutoExposureInspectionInput,
  AutoExposureInvalidParameterDetail,
  AutoExposureReceipt,
  AutoExposureResetReason,
  AutoExposureStageFailedDetail,
  AutoExposureStaleGenerationDetail,
} from '../pipeline/standard-output/auto-exposure/inspection';
export {
  AutoExposureCapabilityUnavailableError,
  AutoExposureInvalidParameterError,
  AutoExposureStageFailedError,
  AutoExposureStaleGenerationError,
} from '../pipeline/standard-output/auto-exposure/inspection';

export interface LifecycleConstructionFailureDetail {
  readonly owner: string;
  readonly generation: number;
  readonly operation: 'create' | 'dispose';
  readonly resourceKind: DeviceResourceKind;
  readonly cause: unknown;
  readonly cleanupFailures: readonly {
    readonly resourceKind: DeviceResourceKind;
    readonly cause: unknown;
  }[];
  readonly receipt: DeviceScopeReceipt;
}

export class LifecycleConstructionError extends Error {
  readonly code = 'lifecycle-construction-failed' as const;
  readonly expected = 'all DeviceScope resources establish and terminate in order';
  readonly hint = 'inspect detail and cleanupFailures, then recover or rebuild the DeviceScope';
  readonly detail: LifecycleConstructionFailureDetail;

  constructor(detail: LifecycleConstructionFailureDetail) {
    super(`lifecycle-construction-failed: ${detail.resourceKind} lifecycle transaction failed`);
    this.name = 'LifecycleConstructionError';
    this.detail = detail;
  }
}

const SURFACE_FAILURE_POLICY: Readonly<
  Record<SurfaceFailureCode, { readonly expected: string; readonly hint: string }>
> = {
  'surface-allocation-failed': {
    expected: 'the required surface resource can be allocated with its declared format and usage',
    hint: 'inspect the capability detail, release transient resources, and retry the candidate graph',
  },
  'surface-attachment-failed': {
    expected: 'the float target is renderable as the declared attachment',
    hint: 'verify float color attachment support and retry without hiding the failure',
  },
  'surface-sampled-read-failed': {
    expected: 'the float target can be sampled by the next post-processing stage',
    hint: 'verify sampled-read support for the declared format before rebuilding the graph',
  },
  'surface-view-domain-failed': {
    expected: 'surface storage and display views preserve their declared color domains',
    hint: 'repair the explicit format/domain pair and retry the candidate graph',
  },
  'surface-raw-endpoint-failed': {
    expected: 'the surface presentation endpoint has descriptor, acquisition, and validation proof',
    hint: 'run the concrete presentation probe; keep the last-known-good surface when proof is absent',
  },
};

/** Render-surface failure with an exhaustive code and actionable detail. */
export class RenderSurfaceError<
  Code extends SurfaceFailureCode = SurfaceFailureCode,
> extends Error {
  readonly code: Code;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderSurfaceFailureDetail;

  constructor(code: Code, detail: RenderSurfaceFailureDetail) {
    const policy = SURFACE_FAILURE_POLICY[code];
    if (policy === undefined) {
      throw new Error(`unknown render surface failure code: ${code}`);
    }
    super(`[RenderSurfaceError ${code}] expected: ${policy.expected}; hint: ${policy.hint}`);
    this.name = 'RenderSurfaceError';
    this.code = code;
    this.expected = policy.expected;
    this.hint = policy.hint;
    this.detail = detail;
  }
}

export type { RenderSurfaceFailureDetail, SurfaceFailureCode, SurfaceFailureKind };

export type RenderSurfaceExpectedError = {
  readonly [Code in SurfaceFailureCode]: RenderSurfaceError<Code>;
}[SurfaceFailureCode];

/** Construct the closed surface error from its failure-stage discriminant. */
export function createRenderSurfaceError(
  kind: SurfaceFailureKind,
  detail: RenderSurfaceFailureDetail,
): RenderSurfaceExpectedError {
  return new RenderSurfaceError(`surface-${kind}-failed` as SurfaceFailureCode, detail);
}

export type LightResourceFailureReason = 'asset' | 'format' | 'capability' | 'capacity';

export interface LightResourceUnavailableDetail {
  readonly entity: number;
  readonly feature: 'ies' | 'cookie' | 'probe';
  readonly generation: number;
  readonly sourceKey: string;
  readonly reason: LightResourceFailureReason;
}

export class LightResourceUnavailableError extends Error {
  readonly code = 'light-resource-unavailable' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: LightResourceUnavailableDetail;

  constructor(
    detail: LightResourceUnavailableDetail,
    expected: string,
    actual: string,
    hint: string,
  ) {
    super(`light-resource-unavailable: ${detail.feature} ${actual}`);
    this.name = 'LightResourceUnavailableError';
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export function createLightResourceUnavailable(input: {
  readonly entity: number;
  readonly feature: LightResourceUnavailableDetail['feature'];
  readonly generation: number;
  readonly sourceKey: string;
  readonly reason: LightResourceFailureReason;
  readonly expected: string;
  readonly actual: string;
  readonly hint: string;
}): LightResourceUnavailableError {
  return new LightResourceUnavailableError(
    {
      entity: input.entity,
      feature: input.feature,
      generation: input.generation,
      sourceKey: input.sourceKey,
      reason: input.reason,
    },
    input.expected,
    input.actual,
    input.hint,
  );
}

export interface TemporalFrameSubmitDetail {
  readonly reason: 'queue-submit-failed';
}

export class TemporalFrameSubmitError extends Error {
  readonly code = 'temporal-frame-submit-rejected' as const;
  readonly expected = 'the staged frame is accepted by queue.submit before temporal facts advance';
  readonly hint = 'inspect the queue submission and retry the frame after the device is available';
  readonly detail: TemporalFrameSubmitDetail;

  constructor(reason: 'queue-submit-failed') {
    super(`temporal-frame-submit-rejected: ${reason}`);
    this.name = 'TemporalFrameSubmitError';
    this.detail = { reason };
  }
}
// ── ShadowInvalidConfigError ──────────────────────────────────────────────

/**
 * Detail for `RenderErrorCode 'shadow-invalid-config'`.
 *
 * The four fields are the only recovery surface: AI users read the invalid
 * field, actual value, structured bound, and reason without parsing prose.
 */
export type ShadowInvalidConfigBound =
  | { readonly kind: 'range'; readonly min: number; readonly max: number }
  | { readonly kind: 'lower-bound'; readonly operator: '>' | '>='; readonly value: number }
  | { readonly kind: 'allowed-values'; readonly values: readonly number[] };

export interface ShadowInvalidConfigDetail {
  readonly field: string;
  readonly actual: number;
  readonly bound: ShadowInvalidConfigBound;
  readonly reason: string;
}

/**
 * Structured error for shadow component config validation failures.
 *
 * Emitted by Directional, Point, and Spot shadow validation. All three
 * component owners share this error class so `switch (err.code)` on
 * `RenderErrorCode` needs one branch (charter P4 — closed-union SSOT).
 * Four-field surface:
 *   - `.code = 'shadow-invalid-config'` (closed RenderErrorCode)
 *   - `.expected` — expected-state description (programmatic predicate form)
 *   - `.hint` — actionable recovery guidance (imperative; AI users paste into
 *     spawn calls).
 *   - `.detail = { field, actual, bound, reason }` — structured values.
 */
export class ShadowInvalidConfigError extends Error {
  readonly code = 'shadow-invalid-config' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ShadowInvalidConfigDetail;

  constructor(field: string, actual: number, bound: ShadowInvalidConfigBound, reason?: string) {
    const resolvedReason = reason ?? shadowBoundReason(bound);
    const expected = shadowBoundExpected(field, bound);
    const hint = `set ${field} to ${resolvedReason}; got ${actual}`;
    super(`shadow component .${field} is invalid: ${resolvedReason}; got ${actual}`);
    this.name = 'ShadowInvalidConfigError';
    this.hint = hint;
    this.expected = expected;
    this.detail = { field, actual, bound, reason: resolvedReason };
  }
}

function shadowBoundExpected(field: string, bound: ShadowInvalidConfigBound): string {
  switch (bound.kind) {
    case 'range':
      return `${field} in [${bound.min}, ${bound.max}]`;
    case 'lower-bound':
      return `${field} ${bound.operator} ${bound.value}`;
    case 'allowed-values':
      return `${field} in {${bound.values.join(', ')}}`;
  }
}

function shadowBoundReason(bound: ShadowInvalidConfigBound): string {
  switch (bound.kind) {
    case 'range':
      return `a value in [${bound.min}, ${bound.max}]`;
    case 'lower-bound':
      return `a value ${bound.operator} ${bound.value}`;
    case 'allowed-values':
      return `one of [${bound.values.join(', ')}]`;
  }
}

// ── EquirectProjectionFailedError ────────────────────────────────────────────

/**
 * Detail for `RenderErrorCode 'equirect-projection-failed'`.
 *
 * Emitted when the equirect-to-cubemap IBL projection fails for the equirect
 * handle referenced by a `Skylight` / `SkyboxBackground` component. The handle
 * id is carried so AI users can trace which equirect source failed projection.
 * Degradation: the record arm records `status:'failed'`, binds the white-cube
 * fallback, fires this error ONCE, and does NOT retry the projection.
 *
 * feat-20260630 D-5: structured error with detail carrying the handle id.
 */
export interface EquirectProjectionFailedDetail {
  readonly handle: number;
  /** The projection step's own structured failure, e.g. `invalid-source-format`. */
  readonly cause: EquirectProjectionFailureCause;
}

/** The asset or RHI failure the store recorded when it marked the projection failed. */
export interface EquirectProjectionFailureCause {
  readonly code: AssetError['code'] | RhiError['code'];
  readonly expected: string;
  readonly hint: string;
}

/**
 * Structured error for a failed equirect-to-cubemap IBL projection.
 *
 * Emitted by the record stage when the internal cubemap projection for an
 * equirect handle returns a failure (or records `status:'failed'`). Four-field
 * surface per AGENTS.md error model:
 *   - `.code = 'equirect-projection-failed'` (closed RenderErrorCode)
 *   - `.expected` — equirect-to-cubemap projection + IBL precompute succeeds
 *   - `.hint` — declare `Skylight{equirect}` with a valid HDR equirect source;
 *     check `device.caps.rgba16floatRenderable`. The projection is internal —
 *     there is no user upload call to retry
 *   - `.detail = { handle, cause }` — the equirect handle id and the recorded
 *     asset/RHI failure (`cause.code`, e.g. `invalid-source-format`)
 */
export class EquirectProjectionFailedError extends Error {
  readonly code = 'equirect-projection-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: EquirectProjectionFailedDetail;

  constructor(handle: number, cause: EquirectProjectionFailureCause) {
    const expected = `equirect handle ${handle} projects to a GPU cubemap + IBL precompute`;
    const hint =
      `equirect handle ${handle} referenced by Skylight/SkyboxBackground failed projection with ` +
      `${cause.code} (${cause.hint}); fix detail.cause, then declare Skylight/SkyboxBackground with a new ` +
      `equirect handle. The projection is internal (no user upload call); the record arm does not retry`;
    super(`equirect handle ${handle} cubemap projection failed: ${cause.code}`);
    this.name = 'EquirectProjectionFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      handle,
      cause: { code: cause.code, expected: cause.expected, hint: cause.hint },
    };
  }
}

// ── StandardLightBudgetExceededError ──────────────────────────────────────

/** The finite local-light budget that a Standard frame agreed to admit. */
export interface StandardLightBudgetExceededDetail {
  readonly actual: number;
  readonly budget: number;
}

/**
 * Structured refusal for a Standard frame whose finite local-light set is
 * outside the selected profile budget. The frame is rejected as a whole; the
 * record owner must not slice the input or submit a partial membership set.
 */
export class StandardLightBudgetExceededError extends Error {
  readonly code = 'standard-light-budget-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: StandardLightBudgetExceededDetail;

  constructor(actual: number, budget: number) {
    const expected = `light count <= ${budget}`;
    const hint =
      `${actual} finite local lights exceed Standard budget ${budget}; ` +
      'reduce the local-light set or select a profile with a supported budget';
    super(`Standard light budget exceeded: ${actual} > ${budget}`);
    this.name = 'StandardLightBudgetExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { actual, budget };
  }
}

// ── StandardClusterIndexOverflowError ──────────────────────────────────────

/** Cluster membership entries that could not fit the single shared index list. */
export interface StandardClusterIndexOverflowDetail {
  readonly actual: number;
  readonly capacity: number;
}

/**
 * Structured refusal for a membership producer that exceeded the shared
 * Cluster index-list capacity. No truncated list is uploaded and no graph is
 * submitted for the rejected frame.
 */
export class StandardClusterIndexOverflowError extends Error {
  readonly code = 'standard-cluster-index-overflow' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: StandardClusterIndexOverflowDetail;

  constructor(actual: number, capacity: number) {
    const expected = `light index list entries <= ${capacity}`;
    const hint =
      `cluster binner overflow: writeCount ${actual} exceeds capacity ${capacity}; ` +
      'reduce finite local lights or choose a supported cluster layout';
    super(`Standard cluster index list overflow: ${actual} > ${capacity}`);
    this.name = 'StandardClusterIndexOverflowError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { actual, capacity };
  }
}

// ── StandardClusterTransportUnavailableError ───────────────────────────────

export interface StandardClusterTransportUnavailableDetail {
  readonly requested: number;
  readonly admitted: 0;
}

/**
 * Structured capability refusal. Standard never turns an unproven transport
 * into a smaller direct-light lane; the caller receives the exact requested
 * local-light count and an admitted count of zero.
 */
export class StandardClusterTransportUnavailableError extends Error {
  readonly code = 'standard-cluster-transport-unavailable' as const;
  readonly expected = 'all requested local lights have a proven Cluster transport';
  readonly hint: string;
  readonly detail: StandardClusterTransportUnavailableDetail;

  constructor(
    requested: number,
    hint = 'enable a proven Cluster storage transport before drawing',
  ) {
    super(`Standard Cluster transport unavailable for ${requested} local lights`);
    this.name = 'StandardClusterTransportUnavailableError';
    this.hint = hint;
    this.detail = { requested, admitted: 0 };
  }
}

// ── StandardProfileInvalidError ───────────────────────────────────────────

export interface StandardProfileInvalidDetail {
  readonly field: string;
  readonly actual: unknown;
}

/** Structured validation failure for the single Standard profile surface. */
export class StandardProfileInvalidError extends Error {
  readonly code = 'standard-profile-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: StandardProfileInvalidDetail;

  constructor(message: string, detail?: StandardProfileInvalidDetail) {
    super(message);
    this.name = 'StandardProfileInvalidError';
    this.detail = detail ?? { field: 'profile', actual: message };
    if (this.detail.field === 'clusterGrid') {
      this.expected = 'clusterGrid.{x,y,z} each positive integer in [1, 64]';
      this.hint =
        'set clusterGrid.x, clusterGrid.y, and clusterGrid.z to positive integers in [1, 64]';
    } else {
      this.expected = 'StandardProfile contains only supported fields and values';
      this.hint = 'repair the Standard profile fields and retry setProfile';
    }
  }
}

// ── PointShadowAtlasUninitializedError ─────────────────────────────────────

/**
 * Structured error for `ShadowAtlas.faceView` called before `ensure()`
 * allocated the cube_array texture. Replaces the prior bare
 * `throw new Error()` (Round-2 F-4: P3 closed-union compliance).
 *
 *   - `.code = 'point-shadow-atlas-uninitialized'`
 *   - `.expected` — call `ensure()` before iterating face views
 *   - `.hint` — gate `faceView` on `isAllocated()` or call `ensure()` once
 *     in the per-frame extract step before recording the 6 x N caster passes
 *   - `.detail = undefined` (no per-call data needed)
 */
export class PointShadowAtlasUninitializedError extends Error {
  readonly code = 'point-shadow-atlas-uninitialized' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected = 'ShadowAtlas.ensure() invoked before faceView()';
    const hint =
      'Gate faceView on isAllocated() or call ensure() once in the per-frame extract step before iterating face views';
    super('ShadowAtlas.faceView called before ensure(); the cube_array texture is not allocated');
    this.name = 'PointShadowAtlasUninitializedError';
    this.expected = expected;
    this.hint = hint;
  }
}

// ── PointShadowAtlasBoundsViolationError ───────────────────────────────────

/**
 * Detail for `RenderErrorCode 'point-shadow-atlas-bounds-violation'`.
 *
 * Emitted by `ShadowAtlas.faceView` when `layer` falls outside `[0, layers)`
 * or `face` falls outside `[0, 6)`. Both axes are reported as
 * `{ axis, value, max }` so AI users discriminate without parsing the message.
 */
export interface PointShadowAtlasBoundsViolationDetail {
  readonly axis: 'layer' | 'face';
  readonly value: number;
  readonly max: number;
}

/**
 * Structured error for `ShadowAtlas.faceView(layer, face)` arguments outside
 * the allocated atlas range. Replaces the prior bare `throw new Error()`
 * (Round-2 F-4: P3 closed-union compliance).
 *
 *   - `.code = 'point-shadow-atlas-bounds-violation'`
 *   - `.expected` — `0 <= layer < layers && 0 <= face < 6`
 *   - `.hint` — clamp `shadowAtlasLayer` or face index before calling
 *     `faceView`; the layer cap is the renderer-owned ShadowAtlas capacity
 *   - `.detail = { axis, value, max }` — discriminates layer vs face
 */
export class PointShadowAtlasBoundsViolationError extends Error {
  readonly code = 'point-shadow-atlas-bounds-violation' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointShadowAtlasBoundsViolationDetail;

  constructor(axis: 'layer' | 'face', value: number, max: number) {
    const expected = `0 <= ${axis} < ${max}`;
    const hint =
      axis === 'layer'
        ? `clamp PointLight.shadowAtlasLayer to [0, ${max}); the cap on layers equals PointLightShadow cardinality (4)`
        : `clamp face index to [0, ${max}); cube faces are indexed 0..5 in +X/-X/+Y/-Y/+Z/-Z order`;
    super(`ShadowAtlas.faceView ${axis} out of range: ${value} (must be in [0, ${max}))`);
    this.name = 'PointShadowAtlasBoundsViolationError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { axis, value, max };
  }
}

// ── VideoUploadUnsupportedError ─────────────────────────────────────────

/**
 * Structured error for `RenderErrorCode 'video-upload-unsupported'`
 * (feat-20260623-world-space-video-asset M3 / w11 — AC-10).
 *
 * Fired once per loss episode by the per-frame record stage
 * (`videoTextureView`) when a VideoPlayer entity has no host video source:
 * neither the copy path nor zero-copy `importExternalTexture` can run. The
 * last good (or default) view stays bound so the draw survives.
 *   - `.code = 'video-upload-unsupported'`
 *   - `.expected` — a host video source (both upload paths read it)
 *   - `.hint` — actionable recovery: register a VideoSourceProvider or use a static texture
 *   - `.detail` — undefined (no narrowed detail variant)
 */
export class VideoUploadUnsupportedError extends Error {
  readonly code = 'video-upload-unsupported' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected =
      'a host video source for the VideoPlayer entity; both the copy path and zero-copy importExternalTexture read it';
    const hint =
      'register a VideoSourceProvider that returns the HTMLVideoElement or VideoFrame for this entity, or render a static texture instead';
    super('video upload unsupported — no host video source for this VideoPlayer');
    this.name = 'VideoUploadUnsupportedError';
    this.expected = expected;
    this.hint = hint;
  }
}

// ── VertexStorageBufferUnavailableError ─────────────────────────────────

/**
 * Structured error for missing vertex-stage storage buffer capability.
 *
 * Emitted at createRenderer time (cap-gate).
 *   - `.code = 'vertex-storage-buffer-unavailable'`
 *   - `.expected` — device.caps supports vertex-stage storage buffer
 *   - `.hint` — switch to a WebGPU adapter with vertex storage buffer support or use uniform-buffer fallback (OOS-uniform-palette)
 *   - `.detail` — undefined (no narrowed detail variant)
 */
export class VertexStorageBufferUnavailableError extends Error {
  readonly code = 'vertex-storage-buffer-unavailable' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected =
      'device.caps supports vertex-stage storage buffer (maxStorageBuffersPerShaderStage >= 1)';
    const hint =
      'this device does not support vertex-stage storage buffers; skinning requires vertex-stage storage buffer access (OOS-uniform-palette fallback not implemented)';
    super('vertex-stage storage buffer unavailable — skinning cannot operate');
    this.name = 'VertexStorageBufferUnavailableError';
    this.expected = expected;
    this.hint = hint;
  }
}

// ── VertexColorVariantConflictError ───────────────────────────────────────

export interface VertexColorVariantConflictDetail {
  readonly authored: true;
  readonly authoredValue: string;
  readonly projected: boolean;
}

/** The authored color axis disagrees with the canonical geometry projection. */
export class VertexColorVariantConflictError extends Error {
  readonly code = 'vertex-color-variant-conflict' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: VertexColorVariantConflictDetail;

  constructor(authoredValue: string, projected: boolean) {
    const expected = `VERTEX_COLOR_AVAILABLE=${projected ? 'true' : 'false'}`;
    const hint =
      'derive the shader variant from the mesh VertexLayoutProjection; COLOR_0 presence is a geometry fact';
    super(`authored vertex-color variant ${authoredValue} disagrees with projected ${expected}`);
    this.name = 'VertexColorVariantConflictError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { authored: true, authoredValue, projected };
  }
}

// ── Skin palette/material validation errors ────────────────────────────────

/** Detail for a palette buffer that exceeds the device storage limit. */
export interface SkinPaletteOverflowDetail {
  readonly requestedBytes: number;
  readonly limit: number;
}

/**
 * Structured render error for a skin palette allocation that exceeds the
 * device storage-buffer binding limit. The allocator that emits this error
 * lives in render, so the error belongs to the render union rather than the
 * renderer-independent skinning binding package.
 */
export class SkinPaletteOverflowError extends Error {
  readonly code = 'skin-palette-overflow' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinPaletteOverflowDetail;

  constructor(requestedBytes: number, limit: number) {
    const expected = `skinned joint palette (${requestedBytes} B) fits within device.limits.maxStorageBufferBindingSize (${limit} B)`;
    const hint =
      'palette buffer exceeds device maxStorageBufferBindingSize; reduce skinned entity count or split into multiple palette buffers (OOS-skin-palette-batch)';
    super(`skin palette buffer needs ${requestedBytes} B, exceeds device limit ${limit} B`);
    this.name = 'SkinPaletteOverflowError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requestedBytes, limit };
  }
}

/** Detail for a skinned entity using a non-skin material shader. */
export interface SkinMaterialMismatchDetail {
  readonly entity: number;
  readonly actualShader: string | undefined;
}

/** Structured render error for a Skin/non-skin-material mismatch. */
export class SkinMaterialMismatchError extends Error {
  readonly code = 'skin-material-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinMaterialMismatchDetail;

  constructor(entity: number, actualShader: string | undefined) {
    const expected = "Skin entity's first material program module === 'forgeax::pbr-skin'";
    const hint = `entity ${entity} has Skin but the first material program module is ${actualShader ?? '<empty>'}; load the mesh via the gltf importer (cooker auto-routes 'forgeax::pbr-skin' for skinned primitives), or remove the Skin component to render the entity unskinned with Materials.standard / Materials.unlit`;
    super(
      `Skin / material mismatch on entity ${entity}: expected forgeax::pbr-skin, got ${actualShader ?? '<empty>'}`,
    );
    this.name = 'SkinMaterialMismatchError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, actualShader };
  }
}

/** Detail for a pbr-skin material whose mesh lacks skin attributes. */
export interface MaterialSkinAttrMissingDetail {
  readonly entity: number;
  readonly missing: 'skinIndex' | 'skinWeight' | 'both';
}

/** Structured render error for a pbr-skin material/mesh attribute mismatch. */
export class MaterialSkinAttrMissingError extends Error {
  readonly code = 'material-skin-attr-missing' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialSkinAttrMissingDetail;

  constructor(entity: number, missing: 'skinIndex' | 'skinWeight' | 'both') {
    const expected = 'pbr-skin material requires mesh.attributes.skinIndex + skinWeight';
    const hint = `entity ${entity} uses forgeax::pbr-skin but its MeshAsset is missing ${missing}; switch the entity to a skinned glTF mesh authored with JOINTS_0 + WEIGHTS_0, or change the material to a non-skin shader via Materials.standard / Materials.unlit`;
    super(
      `material/skin attribute mismatch on entity ${entity}: pbr-skin material with mesh missing ${missing}`,
    );
    this.name = 'MaterialSkinAttrMissingError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, missing };
  }
}

export interface TransmissionCapabilityMissingDetail {
  readonly material: string;
  readonly capability: 'transmission';
  readonly stage: 'prepare' | 'record';
  readonly lane: 'standard-forward';
  readonly format: string;
  readonly missing: readonly TransmissionCapabilityFact[];
}

export class TransmissionCapabilityMissingError extends Error {
  readonly code = 'transmission-capability-missing' as const;
  readonly expected = 'the renderer exposes the transmission capability for this material';
  readonly hint = 'disable transmission or provide the renderer capability before drawing';
  readonly detail: TransmissionCapabilityMissingDetail;

  constructor(
    material: string,
    stage: 'prepare' | 'record',
    evidence: {
      readonly lane: 'standard-forward';
      readonly format: string;
      readonly missing: readonly TransmissionCapabilityFact[];
    },
  ) {
    super(`transmission capability is missing for material '${material}'`);
    this.name = 'TransmissionCapabilityMissingError';
    this.detail = { material, capability: 'transmission', stage, ...evidence };
  }
}

export interface MaterialSampledTextureBudgetExceededDetail {
  /** Stable material source handle, or -1 when the snapshot carries none. */
  readonly materialHandle: number;
  readonly limit: number;
  readonly required: number;
  /** Authored split scalar maps that occupy the shared transmission pairs. */
  readonly conflicts: readonly string[];
}

/**
 * A Standard material cannot fit the device sampled-texture budget. Transmission
 * reports its occupied shared slots; explicitly requested DFG LUT resources fail
 * admission instead of silently substituting the fitted lighting model.
 */
export class MaterialSampledTextureBudgetExceededError extends Error {
  readonly code = 'material-sampled-texture-budget-exceeded' as const;
  readonly expected = 'the material sampled-texture bindings fit the device per-stage limit';
  readonly hint =
    'remove optional material textures, select fitted direct multiscattering, pack shared transmission maps, or use a device with maxSampledTexturesPerShaderStage >= required';
  readonly detail: MaterialSampledTextureBudgetExceededDetail;

  constructor(detail: MaterialSampledTextureBudgetExceededDetail) {
    super(
      `material ${detail.materialHandle} needs ${detail.required} sampled textures with ${detail.conflicts.join(', ')}; device limit is ${detail.limit}`,
    );
    this.name = 'MaterialSampledTextureBudgetExceededError';
    this.detail = detail;
  }
}

// -- RenderFeature errors ---------------------------------------------------

export type RenderFeatureErrorCode =
  | 'render-feature-registration-conflict'
  | 'render-feature-stage-failed'
  | 'render-feature-capability-missing'
  | 'render-feature-pass-order-conflict'
  | 'render-feature-preparation-failed'
  | 'render-feature-prepared-state-mismatch'
  | 'render-feature-draw-recording-failed';

export interface RenderFeatureRegistrationConflictDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly conflictingOrder: number;
}

export interface RenderFeatureCleanupFailure {
  readonly featureIdentity: string;
  readonly order: number;
  readonly code: string;
}

export interface RenderFeatureStageFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: RenderFeatureStage;
  readonly recovery: RenderFeatureRecovery;
  readonly cleanupFailures?: readonly RenderFeatureCleanupFailure[];
  /** Original stage exception when the feature did not return a RenderError. */
  readonly cause?: unknown;
}

export interface RenderFeatureCapabilityMissingDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly capability: RenderFeatureCapabilityKey;
}

export interface RenderFeaturePassOrderConflictDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly passIdentity: string;
  readonly dependencyIdentity: string;
}

export interface RenderFeaturePreparationFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'prepare';
  readonly operation: string;
  readonly resourceKind: PreparedKind;
  readonly resourceName: string;
  readonly reason: string;
  readonly recovery: RenderFeatureRecovery;
}

export type RenderFeaturePreparedStateMismatchDetail =
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'missing-prepared-state';
      readonly missingResource: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'foreign-feature';
      readonly expectedFeatureIdentity: string;
      readonly actualFeatureIdentity: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'foreign-kind';
      readonly expectedKind: PreparedKind;
      readonly actualKind: PreparedKind;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'generation-mismatch';
      readonly expectedGeneration: number;
      readonly actualGeneration: number;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'layout-mismatch';
      readonly expectedLayout: string;
      readonly actualLayout: string;
      readonly recovery: RenderFeatureRecovery;
    }
  | {
      readonly featureIdentity: string;
      readonly order: number;
      readonly stage: 'contribute';
      readonly operation: string;
      readonly resourceKind: PreparedKind;
      readonly reason: 'format-mismatch';
      readonly expectedFormat: string;
      readonly actualFormat: string;
      readonly recovery: RenderFeatureRecovery;
    };

export interface RenderFeatureDrawRecordingFailedDetail {
  readonly featureIdentity: string;
  readonly order: number;
  readonly stage: 'record';
  readonly operation: string;
  readonly resourceKind: PreparedKind;
  readonly reason: string;
  readonly backendReason: string;
  readonly recovery: RenderFeatureRecovery;
}

export type RenderFeatureErrorDetailByCode = {
  'render-feature-registration-conflict': RenderFeatureRegistrationConflictDetail;
  'render-feature-stage-failed': RenderFeatureStageFailedDetail;
  'render-feature-capability-missing': RenderFeatureCapabilityMissingDetail;
  'render-feature-pass-order-conflict': RenderFeaturePassOrderConflictDetail;
  'render-feature-preparation-failed': RenderFeaturePreparationFailedDetail;
  'render-feature-prepared-state-mismatch': RenderFeaturePreparedStateMismatchDetail;
  'render-feature-draw-recording-failed': RenderFeatureDrawRecordingFailedDetail;
};

/** Machine-readable four-field diagnostic exposed by every feature error. */
export type RenderFeatureErrorDescriptor = {
  [Code in RenderFeatureErrorCode]: {
    readonly code: Code;
    readonly expected: string;
    readonly hint: string;
    readonly detail: RenderFeatureErrorDetailByCode[Code];
  };
}[RenderFeatureErrorCode];

const renderFeatureRecoveryHintByRecovery = {
  'next-frame': (featureIdentity: string, stage: RenderFeatureStage) =>
    `correct '${featureIdentity}' ${stage} data and retry on the next frame`,
  'renderer-recover': (featureIdentity: string, _stage: RenderFeatureStage) =>
    `wait for renderer recovery before retrying '${featureIdentity}'`,
  registration: (featureIdentity: string, _stage: RenderFeatureStage) =>
    `correct '${featureIdentity}' registration before retrying`,
} satisfies Record<
  RenderFeatureRecovery,
  (featureIdentity: string, stage: RenderFeatureStage) => string
>;

export class RenderFeatureRegistrationConflictError extends Error {
  readonly code = 'render-feature-registration-conflict' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeatureRegistrationConflictDetail;

  constructor(featureIdentity: string, order: number, conflictingOrder: number) {
    const expected = `feature identity '${featureIdentity}' is unique`;
    const hint = `rename '${featureIdentity}' or remove the duplicate feature before registration`;
    super(`render feature registration conflict for '${featureIdentity}'`);
    this.name = 'RenderFeatureRegistrationConflictError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { featureIdentity, order, conflictingOrder };
  }
}

export class RenderFeatureStageFailedError extends Error {
  readonly code = 'render-feature-stage-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeatureStageFailedDetail;

  constructor(
    featureIdentity: string,
    order: number,
    stage: RenderFeatureStage,
    recovery: RenderFeatureRecovery,
    cause?: unknown,
  ) {
    const expected = `feature '${featureIdentity}' completes its ${stage} stage without an error`;
    const hint = renderFeatureRecoveryHintByRecovery[recovery](featureIdentity, stage);
    super(`render feature '${featureIdentity}' failed during ${stage}`);
    this.name = 'RenderFeatureStageFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      featureIdentity,
      order,
      stage,
      recovery,
      ...(cause === undefined ? {} : { cause }),
    };
  }
}

export class RenderFeatureCapabilityMissingError extends Error {
  readonly code = 'render-feature-capability-missing' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeatureCapabilityMissingDetail;

  constructor(
    featureIdentity: string,
    order: number,
    capability: RenderFeatureCapabilityMissingDetail['capability'],
  ) {
    const expected = `device capability '${capability}' is available for feature '${featureIdentity}'`;
    const hint = `disable '${featureIdentity}' or use a device with '${capability}' capability`;
    super(`render feature '${featureIdentity}' requires missing capability '${capability}'`);
    this.name = 'RenderFeatureCapabilityMissingError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { featureIdentity, order, capability };
  }
}

export class RenderFeaturePassOrderConflictError extends Error {
  readonly code = 'render-feature-pass-order-conflict' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeaturePassOrderConflictDetail;

  constructor(
    featureIdentity: string,
    order: number,
    passIdentity: string,
    dependencyIdentity: string,
  ) {
    const expected = `feature pass '${passIdentity}' follows dependency '${dependencyIdentity}'`;
    const hint = `reorder '${featureIdentity}' passes so '${passIdentity}' follows '${dependencyIdentity}'`;
    super(`render feature '${featureIdentity}' pass order conflict`);
    this.name = 'RenderFeaturePassOrderConflictError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { featureIdentity, order, passIdentity, dependencyIdentity };
  }
}

export class RenderFeaturePreparationFailedError extends Error {
  readonly code = 'render-feature-preparation-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeaturePreparationFailedDetail;

  constructor(
    featureIdentity: string,
    order: number,
    operation: string,
    resourceKind: RenderFeaturePreparationFailedDetail['resourceKind'],
    resourceName: string,
    reason: string,
    recovery: RenderFeatureRecovery,
  ) {
    const expected = `${resourceKind} '${resourceName}' is prepared during ${operation}`;
    const hint = `repair '${resourceName}' and retry feature '${featureIdentity}' on ${recovery}`;
    super(`render feature '${featureIdentity}' preparation failed for '${resourceName}'`);
    this.name = 'RenderFeaturePreparationFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      featureIdentity,
      order,
      stage: 'prepare',
      operation,
      resourceKind,
      resourceName,
      reason,
      recovery,
    };
  }
}

export class RenderFeaturePreparedStateMismatchError extends Error {
  readonly code = 'render-feature-prepared-state-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeaturePreparedStateMismatchDetail;

  constructor(detail: RenderFeaturePreparedStateMismatchDetail) {
    const expected = `${detail.resourceKind} state is compatible for '${detail.operation}'`;
    const hint = `repair '${detail.reason}' for feature '${detail.featureIdentity}' and retry`;
    super(`render feature '${detail.featureIdentity}' prepared state mismatch`);
    this.name = 'RenderFeaturePreparedStateMismatchError';
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export class RenderFeatureDrawRecordingFailedError extends Error {
  readonly code = 'render-feature-draw-recording-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderFeatureDrawRecordingFailedDetail;

  constructor(
    featureIdentity: string,
    order: number,
    operation: string,
    resourceKind: RenderFeatureDrawRecordingFailedDetail['resourceKind'],
    reason: string,
    backendReason: string,
    recovery: RenderFeatureRecovery,
  ) {
    const expected = `${resourceKind} recording succeeds for '${operation}'`;
    const hint = `repair '${reason}' and retry feature '${featureIdentity}' after ${recovery}`;
    super(`render feature '${featureIdentity}' draw recording failed`);
    this.name = 'RenderFeatureDrawRecordingFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      featureIdentity,
      order,
      stage: 'record',
      operation,
      resourceKind,
      reason,
      backendReason,
      recovery,
    };
  }
}

// ── ObservationUnavailableError ───────────────────────────────────────────

export type ObservationUnavailableReason =
  | 'no-frame'
  | 'resource'
  | 'copy-src'
  | 'stale'
  | 'identity'
  | 'format'
  | 'readback-failed';

export interface ObservationUnavailableDetail {
  readonly reason: ObservationUnavailableReason;
  readonly recovery: 'draw-current-frame' | 'enable-copy-src' | 'retry-readback';
}

/** A producer-owned current-frame observation could not be made available. */
export class ObservationUnavailableError extends Error {
  readonly code = 'observation-unavailable' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ObservationUnavailableDetail;

  constructor(reason: ObservationUnavailableReason, hint: string) {
    let recovery: ObservationUnavailableDetail['recovery'];
    if (reason === 'copy-src') recovery = 'enable-copy-src';
    else if (reason === 'resource' || reason === 'readback-failed') recovery = 'retry-readback';
    else recovery = 'draw-current-frame';
    super(`current-frame observation unavailable: ${reason}`);
    this.name = 'ObservationUnavailableError';
    this.expected = 'a fresh producer-owned rgba16float current-frame observation';
    this.hint = hint;
    this.detail = { reason, recovery };
  }
}

export type SceneDataUnavailableReason =
  | 'capability-missing'
  | 'producer-missing'
  | 'coverage-incomplete'
  | 'renderer-recovering';
export interface SceneDataUnavailableDetail {
  readonly featureIdentity: string;
  readonly schema: SceneDataSchemaId;
  readonly lane: SceneDataLane;
  readonly reason: SceneDataUnavailableReason;
  readonly missingContributorIds: readonly string[];
  readonly omittedMissingContributorCount: number;
  readonly recovery: 'enable-capability' | 'next-frame' | 'renderer-recover';
}
export class SceneDataUnavailableError extends Error {
  readonly code = 'scene-data-unavailable' as const;
  readonly expected = 'the requested semantic scene data is available for the active plan';
  readonly hint: string;
  readonly detail: SceneDataUnavailableDetail;
  constructor(detail: SceneDataUnavailableDetail) {
    const hint =
      detail.recovery === 'enable-capability'
        ? 'enable rgba16floatRenderable and retry the current frame'
        : detail.recovery === 'renderer-recover'
          ? 'wait for renderer recovery, then retry the frame'
          : 'restore the producer coverage and retry on the next frame';
    super(`scene data '${detail.schema}' unavailable for '${detail.featureIdentity}'`);
    this.name = 'SceneDataUnavailableError';
    this.hint = hint;
    this.detail = Object.freeze({
      ...detail,
      missingContributorIds: Object.freeze([...detail.missingContributorIds].slice(0, 32)),
      omittedMissingContributorCount: Math.max(
        detail.omittedMissingContributorCount,
        Math.max(0, detail.missingContributorIds.length - 32),
      ),
    });
  }
}

export class TaaUnavailableError extends Error {
  readonly code = 'taa-unavailable' as const;
  readonly expected =
    'Standard TAA has a renderable rgba16float target and a complete resolve path';
  readonly hint =
    'enable rgba16float rendering or select none/fxaa explicitly; do not treat TAA as no-AA';
  readonly detail: {
    readonly reason: 'capability' | 'topology' | 'history';
    readonly observed?: string;
  };
  constructor(reason: 'capability' | 'topology' | 'history', observed?: string) {
    super(`taa-unavailable: ${reason}`);
    this.name = 'TaaUnavailableError';
    this.detail = observed === undefined ? { reason } : { reason, observed };
  }
}

export interface FrameReceiptStaleDetail {
  readonly frameId: number;
  readonly receiptGeneration: number;
  readonly currentGeneration: number;
}

/** Receipt-bound observation failed closed at a generation fence. */
export class FrameReceiptStaleError extends Error {
  readonly code = 'frame-receipt-stale' as const;
  readonly expected = 'the observation receipt belongs to the active device generation';
  readonly hint = 'draw a new frame and call observe with its returned FrameReceipt';
  readonly detail: FrameReceiptStaleDetail;

  constructor(detail: FrameReceiptStaleDetail) {
    super('frame receipt belongs to a retired device generation');
    this.name = 'FrameReceiptStaleError';
    this.detail = detail;
  }
}

export interface RendererContractFailureDetail {
  readonly operation: 'construct' | 'attach' | 'draw' | 'request-observation' | 'observe';
  readonly cause: string;
}

/** Structured boundary failure while adapting an owner contract. */
export class RendererContractFailureError extends Error {
  readonly code = 'renderer-contract-failed' as const;
  readonly expected = 'renderer owner contracts remain valid at the public boundary';
  readonly hint = 'repair the owner contract and retry the operation';
  readonly detail: RendererContractFailureDetail;

  constructor(operation: RendererContractFailureDetail['operation'], cause: string) {
    super(`renderer ${operation} contract failed: ${cause}`);
    this.name = 'RendererContractFailureError';
    this.detail = { operation, cause };
  }
}

export interface EnvironmentSourceConflictDetail {
  readonly owners: readonly {
    readonly kind: 'image' | 'atmosphere';
    readonly entityKey: number;
    readonly sourceKey: string;
  }[];
}

export class EnvironmentSourceConflictError extends Error {
  readonly code = 'environment-source-conflict' as const;
  readonly expected = 'exactly one environment source owns the frame';
  readonly hint = 'remove all but one image or atmosphere environment owner';
  readonly detail: EnvironmentSourceConflictDetail;

  constructor(owners: readonly EnvironmentSourceConflictDetail['owners'][number][]) {
    super('environment source owners conflict');
    this.name = 'EnvironmentSourceConflictError';
    this.detail = { owners: owners.map((owner) => Object.freeze({ ...owner })) };
  }
}

export interface FogCardinalityDetail {
  readonly count: number;
}

export class FogCardinalityError extends Error {
  readonly code = 'fog-cardinality' as const;
  readonly expected = 'zero or one Fog owner contributes to a frame';
  readonly hint = 'remove extra Fog owners so the resource owner has at most one';
  readonly detail: FogCardinalityDetail;

  constructor(count: number) {
    super(`Fog owner cardinality is ${count}`);
    this.name = 'FogCardinalityError';
    this.detail = { count };
  }
}

export interface TaaCapsInsufficientDetail {
  readonly required: readonly string[];
  readonly available: readonly string[];
}

export class TaaCapsInsufficientError extends Error {
  readonly code = 'taa-caps-insufficient' as const;
  readonly expected = 'the backend exposes the capabilities required by TAA';
  readonly hint = 'select a backend with the required TAA capabilities or disable TAA on Camera';
  readonly detail: TaaCapsInsufficientDetail;

  constructor(required: readonly string[], available: readonly string[]) {
    super('TAA capabilities are insufficient');
    this.name = 'TaaCapsInsufficientError';
    this.detail = { required: [...required], available: [...available] };
  }
}

export interface EnvironmentGenerationFailedDetail {
  readonly sourceKey: string;
  readonly stage: 'prepare' | 'build' | 'execute' | 'finish' | 'submit';
}

export class EnvironmentGenerationFailedError extends Error {
  readonly code = 'environment-generation-failed' as const;
  readonly expected = 'the selected environment generation completes its owner stage';
  readonly hint = 'inspect the stage and sourceKey, then retry after correcting the environment';
  readonly detail: EnvironmentGenerationFailedDetail;

  constructor(sourceKey: string, stage: EnvironmentGenerationFailedDetail['stage']) {
    super(`environment generation failed during ${stage}`);
    this.name = 'EnvironmentGenerationFailedError';
    this.detail = { sourceKey, stage };
  }
}

export interface AtmosphereInvalidParameterDetail {
  readonly field: string;
  readonly value: number;
}

export interface AtmosphereParameterRange {
  readonly min: number;
  readonly max: number;
}

export class AtmosphereInvalidParameterError extends Error {
  readonly code = 'atmosphere-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AtmosphereInvalidParameterDetail;

  constructor(field: string, value: number, range: AtmosphereParameterRange) {
    super(`Atmosphere.${field} is invalid`);
    this.name = 'AtmosphereInvalidParameterError';
    this.detail = { field, value };
    const rangeText = Number.isFinite(range.max)
      ? `[${range.min}, ${range.max}]`
      : `>= ${range.min}`;
    this.expected = `Atmosphere.${field} must be finite and ${rangeText}`;
    this.hint = `set Atmosphere.${field} to a finite value ${rangeText}`;
  }
}

export interface DynamicResolutionInvalidParameterDetail {
  readonly field: 'targetGpuMs' | 'minScale' | 'maxScale';
  readonly value: number;
  readonly expected: string;
}

export class DynamicResolutionInvalidParameterError extends Error {
  readonly code = 'dynamic-resolution-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DynamicResolutionInvalidParameterDetail;

  constructor(detail: DynamicResolutionInvalidParameterDetail) {
    super(`DynamicResolution.${detail.field} is invalid`);
    this.name = 'DynamicResolutionInvalidParameterError';
    this.expected = `DynamicResolution.${detail.field} must be ${detail.expected}`;
    this.hint = `set DynamicResolution.${detail.field} to a value that is ${detail.expected}`;
    this.detail = detail;
  }
}

export interface DynamicResolutionRequiresTaaDetail {
  readonly antialias: Exclude<Antialias, 'taa'>;
}

export class DynamicResolutionRequiresTaaError extends Error {
  readonly code = 'dynamic-resolution-requires-taa' as const;
  readonly expected = "DynamicResolution requires Camera.antialias to be 'taa'";
  readonly hint = "set Camera.antialias to 'taa' or remove DynamicResolution before retrying";
  readonly detail: DynamicResolutionRequiresTaaDetail;

  constructor(detail: DynamicResolutionRequiresTaaDetail) {
    super('DynamicResolution requires TAA');
    this.name = 'DynamicResolutionRequiresTaaError';
    this.detail = detail;
  }
}

export interface DynamicResolutionTimingUnavailableDetail {
  readonly generation: number;
  readonly operation: 'timestamp-query';
}

export class DynamicResolutionTimingUnavailableError extends Error {
  readonly code = 'dynamic-resolution-timing-unavailable' as const;
  readonly expected = 'adaptive resolution receives a completed GPU timing sample';
  readonly hint = 'use fixed minScale=maxScale or retry after timestamp support is available';
  readonly detail: DynamicResolutionTimingUnavailableDetail;

  constructor(detail: DynamicResolutionTimingUnavailableDetail) {
    super(`DynamicResolution timing is unavailable for generation ${detail.generation}`);
    this.name = 'DynamicResolutionTimingUnavailableError';
    this.detail = detail;
  }
}

export type DynamicResolutionError =
  | DynamicResolutionInvalidParameterError
  | DynamicResolutionRequiresTaaError
  | DynamicResolutionTimingUnavailableError;

export class OutlineInvalidParameterError extends Error {
  readonly code = 'outline-invalid-parameter' as const;
  readonly hint: string;
  readonly detail: { readonly field: string; readonly value: number };
  constructor(
    field: string,
    value: number,
    readonly expected: string,
  ) {
    super(`Outline.${field} must be ${expected}`);
    this.name = 'OutlineInvalidParameterError';
    this.hint = `repair Outline.${field} on the active camera`;
    this.detail = { field, value };
  }
}

export class LensFlareInvalidParameterError extends Error {
  readonly code = 'lens-flare-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: keyof import('../components/lens-flare').LensFlareData;
    readonly value: number;
    readonly minimum: number;
    readonly maximum: number;
  };
  constructor(
    field: LensFlareInvalidParameterError['detail']['field'],
    value: number,
    minimum: number,
    maximum: number,
  ) {
    super(`LensFlare.${field} is invalid`);
    this.name = 'LensFlareInvalidParameterError';
    this.expected = `finite LensFlare.${field} in [${minimum}, ${maximum}]`;
    this.hint = `repair LensFlare.${field} on the camera and retry`;
    this.detail = { field, value, minimum, maximum };
  }
}

export class LensEffectsInvalidParameterError extends Error {
  readonly code = 'lens-effects-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: keyof import('../components/lens-effects').LensEffectsData;
    readonly value: number;
    readonly minimum: number;
    readonly maximum: number;
  };
  constructor(
    field: LensEffectsInvalidParameterError['detail']['field'],
    value: number,
    minimum: number,
    maximum: number,
  ) {
    super(`LensEffects.${field} is invalid`);
    this.name = 'LensEffectsInvalidParameterError';
    this.expected = `finite LensEffects.${field} in [${minimum}, ${maximum}]`;
    this.hint = `repair LensEffects.${field} on the camera and retry`;
    this.detail = { field, value, minimum, maximum };
  }
}

export interface BarrelDistortionInvalidParameterDetail {
  readonly field: 'width' | 'height' | 'strength' | 'centerX' | 'centerY';
  readonly value: number;
  readonly expected: string;
}

export class BarrelDistortionInvalidParameterError extends Error {
  readonly code = 'barrel-distortion-invalid-parameter' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: BarrelDistortionInvalidParameterDetail;

  constructor(detail: BarrelDistortionInvalidParameterDetail) {
    super(`BarrelDistortion.${detail.field} is invalid`);
    this.name = 'BarrelDistortionInvalidParameterError';
    this.expected = `BarrelDistortion.${detail.field} must be ${detail.expected}`;
    this.hint = `set BarrelDistortion.${detail.field} to a value that is ${detail.expected}`;
    this.detail = detail;
  }
}

export interface OwnerStageFailedDetail {
  readonly owner: 'environment' | 'temporal' | 'fog' | 'renderer';
  readonly stage: 'extract' | 'prepare' | 'record' | 'finish' | 'submit';
}

export class OwnerStageFailedError extends Error {
  readonly code = 'owner-stage-failed' as const;
  readonly expected = 'the owner completes its current frame stage';
  readonly hint = 'inspect the owner and stage, keep the last-known-good frame, and retry';
  readonly detail: OwnerStageFailedDetail;

  constructor(owner: OwnerStageFailedDetail['owner'], stage: OwnerStageFailedDetail['stage']) {
    super(`${owner} owner failed during ${stage}`);
    this.name = 'OwnerStageFailedError';
    this.detail = { owner, stage };
  }
}

export interface RendererOperationCause {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

export interface RendererOperationDetailByCode {
  readonly 'frame-submit-rejected': {
    readonly operation: 'draw';
    readonly stage: 'submit';
    readonly accepted: false;
  };
  readonly 'world-lease-invalid': {
    readonly operation: 'attach' | 'draw';
    readonly cause: RendererOperationCause;
  };
  readonly 'frame-input-invalid': {
    readonly operation: 'draw' | 'set-profile' | 'set-output-color-space' | 'request-observation';
    readonly cause: RendererOperationCause;
  };
  readonly 'scene-projection-failed': {
    readonly operation: 'draw';
    readonly cause: RendererOperationCause;
  };
  readonly 'asset-binding-failed': {
    readonly operation: 'draw';
    readonly cause: RendererOperationCause;
  };
  readonly 'feature-plan-failed': {
    readonly operation: 'draw';
    readonly cause: RendererOperationCause;
  };
  readonly 'graph-build-failed': {
    readonly operation: 'draw' | 'set-profile';
    readonly cause: RendererOperationCause;
  };
  readonly 'device-operation-failed': {
    readonly operation: 'draw' | 'complete-frame' | 'renderer-event';
    readonly frameId?: number;
    readonly deviceGeneration?: number;
    readonly cause: RendererOperationCause;
  };
  readonly 'surface-unavailable': {
    readonly operation: 'release-surface' | 'restore-surface';
    readonly cause: RendererOperationCause;
  };
  readonly 'renderer-state-invalid': {
    readonly operation:
      | 'draw'
      | 'set-profile'
      | 'set-output-color-space'
      | 'request-observation'
      | 'recover'
      | 'dispose';
    readonly state: string;
    readonly cause?: RendererOperationCause;
  };
  readonly 'recovery-failed': {
    readonly operation: 'recover';
    readonly phase: RecoveryPhase;
    readonly oldGeneration: number;
    readonly candidateGeneration: number;
    readonly attempt: number;
    readonly elapsedMs: number;
    readonly retryable: boolean;
    readonly guidance: 'retry' | 'repair-owner' | 'rebuild-renderer';
    readonly owner: string;
    readonly resourceKind: string;
    readonly lastOutcome: RecoveryOutcome;
    readonly rehydratedRoots: number;
    readonly staleLossEvents: number;
    readonly cleanupFailures: readonly RendererOperationCause[];
    readonly cause: RendererOperationCause;
  };
  readonly 'cleanup-failed': {
    readonly operation: 'dispose';
    readonly causes: readonly RendererOperationCause[];
  };
}

export type RendererOperationErrorCode = keyof RendererOperationDetailByCode;

const RENDERER_OPERATION_ERROR_POLICY = {
  'frame-submit-rejected': {
    expected: 'the frame reaches queue acceptance before submission facts advance',
    hint: 'the aborted frame was not accepted; retain dependent gameplay isolation and retry through the frame owner',
  },
  'world-lease-invalid': {
    expected: 'every render World is represented by a live lease owned by this Renderer',
    hint: 'attach the World to this Renderer and use the returned lease',
  },
  'frame-input-invalid': {
    expected: 'the frame input references attached leases and a valid immutable RenderProfile',
    hint: 'repair the frame input and retry draw or setProfile',
  },
  'scene-projection-failed': {
    expected: 'the attached World projects into the renderer-owned RenderScene',
    hint: 'inspect the structured cause, repair the World publication, and retry draw',
  },
  'asset-binding-failed': {
    expected: 'all frame assets resolve to valid renderer-owned bindings',
    hint: 'inspect the structured cause, rebuild or cold-cook the asset, and retry draw',
  },
  'feature-plan-failed': {
    expected: 'every installed RenderFeature produces a valid declarative plan',
    hint: 'inspect the feature cause, repair its plan, and retry draw',
  },
  'graph-build-failed': {
    expected: 'the Standard graph builds from the active profile and feature plans',
    hint: 'inspect the graph cause, repair the profile or plan, and retry',
  },
  'device-operation-failed': {
    expected: 'the active device generation completes the renderer-owned operation',
    hint: 'inspect renderer state and the structured cause, then retry or recover',
  },
  'surface-unavailable': {
    expected: 'the presentation surface accepts the requested lifecycle operation',
    hint: 'inspect renderer state, then restore the surface or create a new Renderer',
  },
  'renderer-state-invalid': {
    expected: 'the Renderer is in a state that accepts the requested operation',
    hint: 'inspect renderer state and choose retry, restoreSurface, recover, or stop',
  },
  'recovery-failed': {
    expected: 'one recovery attempt publishes a complete replacement device generation',
    hint: 'inspect the structured cause and retry recover after the host-selected delay',
  },
  'cleanup-failed': {
    expected: 'Renderer disposal completes every registered cleanup in reverse ownership order',
    hint: 'inspect the ordered cleanup causes; the Renderer remains disposed and must not be reused',
  },
} as const satisfies Readonly<
  Record<RendererOperationErrorCode, { readonly expected: string; readonly hint: string }>
>;

/** Public renderer-operation failure with a code-narrowed structured detail. */
export class RendererOperationError<Code extends RendererOperationErrorCode> extends Error {
  readonly code: Code;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RendererOperationDetailByCode[Code];

  constructor(code: Code, detail: RendererOperationDetailByCode[Code], options?: ErrorOptions) {
    const policy = RENDERER_OPERATION_ERROR_POLICY[code];
    super(`${code}: ${policy.expected}`, options);
    this.name = 'RendererOperationError';
    this.code = code;
    this.expected = policy.expected;
    this.hint = policy.hint;
    this.detail = detail;
  }
}

export type RendererExpectedOperationError = {
  readonly [Code in RendererOperationErrorCode]: RendererOperationError<Code>;
}[RendererOperationErrorCode];

// -- Points/Lines admission errors -------------------------------------------

export interface PointsLinesInvalidStyleDetail {
  readonly entity: number;
  readonly component: 'Points' | 'Lines' | 'Points/Lines';
  readonly field: string;
  readonly value: number | string | undefined;
  readonly expected: string;
}

export class PointsLinesInvalidStyleError extends Error {
  readonly code = 'points-lines-invalid-style' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointsLinesInvalidStyleDetail;

  constructor(detail: PointsLinesInvalidStyleDetail) {
    super(`invalid ${detail.component} style at ${detail.field}`);
    this.name = 'PointsLinesInvalidStyleError';
    this.expected = detail.expected;
    this.hint = `repair entity ${detail.entity} ${detail.component}.${detail.field} and retry admission`;
    this.detail = detail;
  }
}

export interface PointsLinesTopologyMismatchDetail {
  readonly entity: number;
  readonly submesh: number;
  readonly expected: string;
  readonly actual: string;
}

export class PointsLinesTopologyMismatchError extends Error {
  readonly code = 'points-lines-topology-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointsLinesTopologyMismatchDetail;

  constructor(detail: PointsLinesTopologyMismatchDetail) {
    super(`Points/Lines topology mismatch at submesh ${detail.submesh}`);
    this.name = 'PointsLinesTopologyMismatchError';
    this.expected = `submesh ${detail.submesh} topology is ${detail.expected}`;
    this.hint = `rebuild entity ${detail.entity} with ${detail.expected} geometry before retrying Points/Lines admission`;
    this.detail = detail;
  }
}

export interface PointsLinesStyleUnsupportedDetail {
  readonly lane: string;
  readonly field: string;
  readonly member: string;
  readonly supported: readonly string[];
}

export class PointsLinesStyleUnsupportedError extends Error {
  readonly code = 'points-lines-style-unsupported' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointsLinesStyleUnsupportedDetail;

  constructor(detail: PointsLinesStyleUnsupportedDetail) {
    super(`unsupported Points/Lines ${detail.field} member ${detail.member}`);
    this.name = 'PointsLinesStyleUnsupportedError';
    this.expected = `${detail.field} is one of ${detail.supported.join(', ')}`;
    this.hint = `use a supported Points/Lines ${detail.field} member or wait for a later milestone`;
    this.detail = detail;
  }
}

export interface PointsLinesMaterialUnsupportedDetail {
  readonly entity: number;
  readonly material: string;
  readonly pass: string;
  readonly module: string;
  readonly reason: string;
}

export class PointsLinesMaterialUnsupportedError extends Error {
  readonly code = 'points-lines-material-unsupported' as const;
  readonly expected = 'one engine-owned unlit forward MaterialAsset pass';
  readonly hint: string;
  readonly detail: PointsLinesMaterialUnsupportedDetail;

  constructor(detail: PointsLinesMaterialUnsupportedDetail) {
    super(`Points/Lines material is unsupported on entity ${detail.entity}`);
    this.name = 'PointsLinesMaterialUnsupportedError';
    this.hint = `use Materials.unlit without a shadow-caster pass for entity ${detail.entity}`;
    this.detail = detail;
  }
}

export interface PointsLinesBudgetExceededDetail {
  readonly lane: string;
  readonly requested: number;
  readonly limit: number;
  readonly unit: 'points' | 'segments' | 'vertices' | 'indices' | 'bytes' | 'draws';
}

export class PointsLinesBudgetExceededError extends Error {
  readonly code = 'points-lines-budget-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointsLinesBudgetExceededDetail;

  constructor(detail: PointsLinesBudgetExceededDetail) {
    super(`Points/Lines ${detail.unit} budget exceeded`);
    this.name = 'PointsLinesBudgetExceededError';
    this.expected = `${detail.unit} <= ${detail.limit}`;
    this.hint = `reduce Points/Lines ${detail.unit} or split the entity into bounded equivalent batches`;
    this.detail = detail;
  }
}

export interface PointsLinesPrepareFailedDetail {
  readonly owner: string;
  readonly generation: number;
  readonly stage: 'prepare';
  readonly cause: string;
  readonly lastKnownGood: boolean;
}

export class PointsLinesPrepareFailedError extends Error {
  readonly code = 'points-lines-prepare-failed' as const;
  readonly expected = 'the complete Points/Lines candidate validates before publication';
  readonly hint: string;
  readonly detail: PointsLinesPrepareFailedDetail;

  constructor(detail: PointsLinesPrepareFailedDetail) {
    super(`Points/Lines prepare failed at generation ${detail.generation}`);
    this.name = 'PointsLinesPrepareFailedError';
    this.hint = detail.lastKnownGood
      ? 'retain the last known good candidate, repair the producer, and retry prepare'
      : 'repair the producer and retry prepare; the failed first candidate produces zero draw';
    this.detail = detail;
  }
}

// -- RenderTarget errors ------------------------------------------------------

export interface RenderTargetDescriptorInvalidDetail {
  readonly field: string;
  readonly value: unknown;
  readonly expected: string;
}

export class RenderTargetDescriptorInvalidError extends Error {
  readonly code = 'render-target-descriptor-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderTargetDescriptorInvalidDetail;

  constructor(detail: RenderTargetDescriptorInvalidDetail) {
    super(`render-target-descriptor-invalid: ${detail.field} does not satisfy ${detail.expected}`);
    this.name = 'RenderTargetDescriptorInvalidError';
    this.expected = detail.expected;
    this.hint = `set RenderTargetDescriptor.${detail.field} to the expected value, then retry create or resize`;
    this.detail = detail;
  }
}

export interface RenderTargetCapabilityMissingDetail {
  readonly operation: 'create' | 'resize' | 'source' | 'readback';
  readonly requested: string;
  readonly capability: string;
  readonly actual: string;
}

export class RenderTargetCapabilityMissingError extends Error {
  readonly code = 'render-target-capability-missing' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderTargetCapabilityMissingDetail;

  constructor(detail: RenderTargetCapabilityMissingDetail) {
    super(
      `render-target-capability-missing: ${detail.capability} does not admit ${detail.requested}`,
    );
    this.name = 'RenderTargetCapabilityMissingError';
    this.expected = `${detail.capability} admits ${detail.requested}`;
    this.hint = `choose an admitted target descriptor or use a backend providing ${detail.capability}`;
    this.detail = detail;
  }
}

export interface RenderTargetLayerInvalidDetail {
  /** `write` is a `Camera.targetLayer` writer; `readback` a readback request. */
  readonly operation: 'write' | 'readback';
  readonly layer: unknown;
  readonly shape: import('../targets/contracts').RenderTargetShape;
  readonly layerCount: number;
}

/**
 * A writer or readback named a layer outside the target: a cube face, array
 * layer, or 3D depth slice must be an integer in `[0, layerCount - 1]`.
 */
export class RenderTargetLayerInvalidError extends Error {
  readonly code = 'render-target-layer-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderTargetLayerInvalidDetail;

  constructor(detail: RenderTargetLayerInvalidDetail) {
    super(
      `render-target-layer-invalid: ${detail.operation} layer ${String(detail.layer)} is outside a ${detail.shape} target with ${detail.layerCount} layer(s)`,
    );
    this.name = 'RenderTargetLayerInvalidError';
    this.expected = `an integer layer in [0, ${detail.layerCount - 1}]`;
    this.hint =
      detail.operation === 'write'
        ? 'set Camera.targetLayer to a layer (cube face, array layer, or 3D depth slice) of its Camera.target'
        : 'request a layer (cube face, array layer, or 3D depth slice) that exists in the target';
    this.detail = detail;
  }
}

export type RenderTargetStateInvalidReason =
  | 'foreign-renderer'
  | 'destroyed'
  | 'uninitialized'
  | 'generation-mismatch'
  | 'readback-without-intent';

export interface RenderTargetStateInvalidDetail {
  readonly operation: 'inspect' | 'resize' | 'source' | 'readback' | 'snapshot' | 'destroy';
  readonly reason: RenderTargetStateInvalidReason;
  readonly state: 'uninitialized' | 'candidate' | 'active' | 'rebuilding' | 'destroyed';
  readonly generation: number;
}

export class RenderTargetStateInvalidError extends Error {
  readonly code = 'render-target-state-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderTargetStateInvalidDetail;

  constructor(detail: RenderTargetStateInvalidDetail) {
    super(`render-target-state-invalid: ${detail.operation} cannot use ${detail.reason}`);
    this.name = 'RenderTargetStateInvalidError';
    this.expected = `target state permits ${detail.operation}`;
    this.hint =
      'use the Renderer that created the target, then initialize, recover, or stop using the destroyed token';
    this.detail = detail;
  }
}

export interface RenderTargetOperationFailedDetail {
  readonly operation: 'create' | 'resize' | 'source' | 'readback' | 'destroy' | 'recover';
  readonly stage: 'allocation' | 'compile' | 'write' | 'submit' | 'copy' | 'retire';
  readonly generation: number;
  readonly cause: unknown;
  readonly recovery: 'retry' | 'recover' | 'retain-last-known-good';
}

export class RenderTargetOperationFailedError extends Error {
  readonly code = 'render-target-operation-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderTargetOperationFailedDetail;

  constructor(detail: RenderTargetOperationFailedDetail) {
    super(`render-target-operation-failed: ${detail.operation} failed during ${detail.stage}`);
    this.name = 'RenderTargetOperationFailedError';
    this.expected = `${detail.operation} completes ${detail.stage}`;
    this.hint =
      'inspect detail.cause, then retry, recover the Renderer, or retain the last-known-good generation';
    this.detail = detail;
  }
}

export type FramebufferSnapshotFailureReason =
  | 'request-invalid'
  | 'target-incompatible'
  | 'writer-conflict'
  | 'source-unavailable'
  | 'source-out-of-bounds'
  | 'destination-out-of-bounds'
  | 'destination-invalidated';

export interface FramebufferSnapshotFailedDetail {
  readonly reason: FramebufferSnapshotFailureReason;
  readonly expected: string;
  readonly actual: unknown;
  /** Receipt frame the failure is bound to; absent for request-time rejection. */
  readonly frameId?: number;
}

const FRAMEBUFFER_SNAPSHOT_HINTS: Readonly<Record<FramebufferSnapshotFailureReason, string>> = {
  'request-invalid':
    'pass non-negative integer region/destination values with width and height >= 1',
  'target-incompatible':
    'create a 2d rgba16float RenderTarget with sampleCount 1, mipLevels 1 and sampled=true',
  'writer-conflict':
    'give the snapshot its own target; a camera, capture or other snapshot already writes it this frame',
  'source-unavailable':
    'draw a frame whose Standard scene color is rendered by the requested camera (CameraView frames need request.camera)',
  'source-out-of-bounds':
    'keep the region inside the camera scene-color extent reported in detail.actual',
  'destination-out-of-bounds': 'keep destination + region inside the current target extent',
  'destination-invalidated':
    'the target was resized, recovered or rewritten before observe; request a new snapshot',
};

export class FramebufferSnapshotFailedError extends Error {
  readonly code = 'framebuffer-snapshot-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: FramebufferSnapshotFailedDetail;

  constructor(detail: FramebufferSnapshotFailedDetail) {
    super(`framebuffer-snapshot-failed: ${detail.reason}`);
    this.name = 'FramebufferSnapshotFailedError';
    this.expected = detail.expected;
    this.hint = FRAMEBUFFER_SNAPSHOT_HINTS[detail.reason];
    this.detail = detail;
  }
}

export interface ReflectionProbeBudgetExceededDetail {
  readonly actual: number;
  readonly budget: number;
}

export type ExternalTextureInvalidReason =
  | 'format'
  | 'dimension'
  | 'usage'
  | 'device-mismatch'
  | 'device-lost'
  | 'source-unsupported'
  | 'capability-absent';

export interface ExternalTextureInvalidDetail {
  readonly operation: 'import' | 'replace' | 'native-device';
  readonly kind: 'gpu-texture' | 'video';
  readonly reason: ExternalTextureInvalidReason;
  readonly actual: string;
}

/** An `importTexture` input the renderer cannot bind as a material texture. */
export class ExternalTextureInvalidError extends Error {
  readonly code = 'external-texture-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ExternalTextureInvalidDetail;

  constructor(detail: ExternalTextureInvalidDetail, expected: string, hint: string) {
    super(`external-texture-invalid: ${detail.kind} ${detail.reason} (${detail.actual})`);
    this.name = 'ExternalTextureInvalidError';
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

export type ExternalTextureStateInvalidReason =
  | 'released'
  | 'stale-generation'
  | 'source-expired'
  | 'foreign-renderer';

export interface ExternalTextureStateInvalidDetail {
  readonly operation: 'bind' | 'replace' | 'release';
  readonly reason: ExternalTextureStateInvalidReason;
  readonly generation: number;
}

/** A released, pre-recovery, or foreign external texture reached a material or handle call. */
export class ExternalTextureStateInvalidError extends Error {
  readonly code = 'external-texture-state-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ExternalTextureStateInvalidDetail;

  constructor(detail: ExternalTextureStateInvalidDetail) {
    super(`external-texture-state-invalid: ${detail.operation} cannot use ${detail.reason}`);
    this.name = 'ExternalTextureStateInvalidError';
    this.expected = 'a live external texture imported by this renderer at its current generation';
    this.hint =
      detail.reason === 'stale-generation'
        ? 'after recover(), create a GPUTexture on renderer.nativeDevice() and replace() or import it again'
        : detail.reason === 'released'
          ? 'import the texture again; a released handle never binds'
          : detail.reason === 'source-expired'
            ? 'replace() with a decoded source: an open VideoFrame, or a video with readyState >= HAVE_CURRENT_DATA'
            : 'bind the source only in Worlds drawn by the Renderer that imported it';
    this.detail = detail;
  }
}

export class ReflectionProbeBudgetExceededError extends Error {
  readonly code = 'reflection-probe-budget-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ReflectionProbeBudgetExceededDetail;

  constructor(actual: number, budget: number) {
    super(`reflection-probe-budget-exceeded: ${actual} > ${budget}`);
    this.name = 'ReflectionProbeBudgetExceededError';
    this.expected = `reflection probe work <= ${budget}`;
    this.hint = 'reduce probe updates for this frame or raise the RenderProfile probe budget';
    this.detail = { actual, budget };
  }
}

export interface RenderIntentInvalidDetail {
  readonly component: 'CubeCamera' | 'ReflectionProbe';
  readonly field: 'updateIntent';
  readonly value: number;
  readonly allowed: readonly [0, 1, 2];
}

export class RenderIntentInvalidError extends Error {
  readonly code = 'render-intent-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RenderIntentInvalidDetail;

  constructor(component: RenderIntentInvalidDetail['component'], value: number) {
    super(`render-intent-invalid: ${component}.updateIntent is not an admitted value`);
    this.name = 'RenderIntentInvalidError';
    this.expected = `${component}.updateIntent is one of 0, 1, or 2`;
    this.hint = `set ${component}.updateIntent to 0, 1, or 2`;
    this.detail = { component, field: 'updateIntent', value, allowed: [0, 1, 2] };
  }
}

export interface VolumeOwnerConflictDetail {
  readonly ownerCount: number;
}

export class VolumeOwnerConflictError extends Error {
  readonly code = 'volume-owner-conflict' as const;
  readonly expected = 'at most eleven local VolumetricFog owners per rendered World';
  readonly hint = 'reduce simultaneously visible volume owners and retry extraction';
  readonly detail: VolumeOwnerConflictDetail;

  constructor(ownerCount: number) {
    super(`volume-owner-conflict: received ${ownerCount} owners`);
    this.name = 'VolumeOwnerConflictError';
    this.detail = { ownerCount };
  }
}

export interface VolumeDensityShapeMismatchDetail {
  readonly guid: string;
  readonly viewDimension: string;
}

export class VolumeDensityShapeMismatchError extends Error {
  readonly code = 'volume-density-shape-mismatch' as const;
  readonly expected = 'density is a linear 3D TextureAsset';
  readonly hint = 'bind a verified linear texture with viewDimension 3d';
  readonly detail: VolumeDensityShapeMismatchDetail;

  constructor(guid: string, viewDimension: string) {
    super(`volume-density-shape-mismatch: ${viewDimension} density is not 3d`);
    this.name = 'VolumeDensityShapeMismatchError';
    this.detail = { guid, viewDimension };
  }
}

export interface VolumeInvalidBoundsDetail {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export class VolumeInvalidBoundsError extends Error {
  readonly code = 'volume-invalid-bounds' as const;
  readonly expected = 'bounds are finite and max is greater than min on every axis';
  readonly hint = 'set finite non-degenerate volume bounds';
  readonly detail: VolumeInvalidBoundsDetail;

  constructor(bounds: VolumeInvalidBoundsDetail) {
    super('volume-invalid-bounds: bounds must be finite and non-degenerate');
    this.name = 'VolumeInvalidBoundsError';
    this.detail = bounds;
  }
}

export interface VolumeInvalidParametersDetail {
  readonly field: string;
  readonly value: unknown;
}

export class VolumeInvalidParametersError extends Error {
  readonly code = 'volume-invalid-parameters' as const;
  readonly expected = 'volume parameters remain finite and inside their closed ranges';
  readonly hint =
    'repair optics or sampling; density-albedo requires linear rgba8unorm or rgba16float';
  readonly detail: VolumeInvalidParametersDetail;

  constructor(
    input: {
      readonly maxDistance?: number;
      readonly anisotropy?: number;
      readonly sampling?: string;
    },
    detail?: VolumeInvalidParametersDetail,
  ) {
    const invalidSampling =
      input.sampling !== undefined &&
      input.sampling !== 'noise' &&
      input.sampling !== 'density' &&
      input.sampling !== 'density-albedo';
    const field = invalidSampling
      ? 'sampling'
      : input.maxDistance !== undefined && input.maxDistance <= 0
        ? 'maxDistance'
        : 'parameters';
    const value = invalidSampling
      ? input.sampling
      : field === 'maxDistance'
        ? input.maxDistance
        : input.anisotropy;
    super(`volume-invalid-parameters: ${detail?.field ?? field} is outside the authored range`);
    this.name = 'VolumeInvalidParametersError';
    this.detail = detail ?? { field, value };
  }
}

export type VolumeError =
  | VolumeOwnerConflictError
  | VolumeDensityShapeMismatchError
  | VolumeInvalidBoundsError
  | VolumeInvalidParametersError;

export interface ProjectorBindingDetail {
  readonly guid: string;
  readonly status: 'pending' | 'invalid' | 'bind-failed';
}

export class ProjectorBindingError extends Error {
  readonly code = 'projector-binding-failed' as const;
  readonly expected = 'authored projector is accepted and bound for both surface and volume';
  readonly hint =
    'inspect the projector Meta/Pack receipt, repair the source, and retry with the same GUID';
  readonly detail: ProjectorBindingDetail;

  constructor(guid: string, status: ProjectorBindingDetail['status']) {
    super(`projector binding failed for ${guid}: ${status}`);
    this.name = 'ProjectorBindingError';
    this.detail = { guid, status };
  }
}

// -- RenderErrorCode / RenderError closed unions --------------------------------

/**
 * Closed union of render-cluster error codes. AI users perform exhaustive
 * `switch (err.code)` without default; TS guards completeness.
 */
export type RenderErrorCode = RenderError['code'];

/**
 * Closed union of the render-cluster structured error classes, each carrying a
 * `RenderErrorCode` discriminant on `.code`.
 */
export class CameraViewInvalidError extends Error {
  readonly code = 'camera-view-invalid';
  readonly hint: string;
  readonly detail: { readonly field: string; readonly value: unknown };
  constructor(
    field: string,
    value: unknown,
    readonly expected: string,
  ) {
    super(`Invalid CameraView.${field}`);
    this.name = 'CameraViewInvalidError';
    this.hint = `repair CameraView.${field} before drawing again`;
    this.detail = { field, value };
  }
}

/** Invalid StereoCamera authoring; `detail.field` names the rejected fact. */
export class StereoCameraInvalidError extends Error {
  readonly code = 'stereo-camera-invalid';
  readonly hint: string;
  readonly detail: {
    readonly field: import('../components/stereo-camera').StereoCameraInvalidField;
    readonly value: unknown;
  };
  constructor(
    field: import('../components/stereo-camera').StereoCameraInvalidField,
    value: unknown,
    readonly expected: string,
  ) {
    super(`Invalid StereoCamera.${field}`);
    this.name = 'StereoCameraInvalidError';
    this.hint =
      field === 'projection' || field === 'target' || field === 'planarReflection'
        ? `remove StereoCamera or the conflicting Camera ${field} before drawing again`
        : `repair StereoCamera.${field} before drawing again`;
    this.detail = { field, value };
  }
}

export type RenderError =
  | SceneSdfUnavailableError
  | CameraViewInvalidError
  | StereoCameraInvalidError
  | import('../decals/component').ProjectedDecalInvalidError
  | import('../components/planar-reflection').PlanarReflectionInvalidError
  | RenderPublicationError
  | LifecycleConstructionError
  | AutoExposureError
  | RendererExpectedOperationError
  | FrameReceiptStaleError
  | RendererContractFailureError
  | ObservationUnavailableError
  | SceneDataUnavailableError
  | TaaUnavailableError
  | ShadowInvalidConfigError
  | EquirectProjectionFailedError
  | StandardLightBudgetExceededError
  | StandardClusterIndexOverflowError
  | StandardClusterTransportUnavailableError
  | StandardProfileInvalidError
  | PointShadowAtlasUninitializedError
  | PointShadowAtlasBoundsViolationError
  | VideoUploadUnsupportedError
  | VertexStorageBufferUnavailableError
  | VertexColorVariantConflictError
  | SkinPaletteOverflowError
  | SkinMaterialMismatchError
  | MaterialSkinAttrMissingError
  | TransmissionCapabilityMissingError
  | MaterialSampledTextureBudgetExceededError
  | RenderFeatureRegistrationConflictError
  | RenderFeatureStageFailedError
  | RenderFeatureCapabilityMissingError
  | RenderFeaturePassOrderConflictError
  | RenderFeaturePreparationFailedError
  | RenderFeaturePreparedStateMismatchError
  | RenderFeatureDrawRecordingFailedError
  | EnvironmentSourceConflictError
  | FogCardinalityError
  | SunCardinalityError
  | TaaCapsInsufficientError
  | EnvironmentGenerationFailedError
  | AtmosphereInvalidParameterError
  | OutlineInvalidParameterError
  | BarrelDistortionInvalidParameterError
  | LensEffectsInvalidParameterError
  | LensFlareInvalidParameterError
  | CloudLayerError
  | DynamicResolutionInvalidParameterError
  | DynamicResolutionRequiresTaaError
  | DynamicResolutionTimingUnavailableError
  | MotionBlurValidationError
  | OwnerStageFailedError
  | PointsLinesInvalidStyleError
  | PointsLinesTopologyMismatchError
  | PointsLinesStyleUnsupportedError
  | PointsLinesMaterialUnsupportedError
  | PointsLinesBudgetExceededError
  | PointsLinesPrepareFailedError
  | LightResourceUnavailableError
  | RenderTargetDescriptorInvalidError
  | RenderTargetCapabilityMissingError
  | RenderTargetLayerInvalidError
  | RenderTargetStateInvalidError
  | RenderTargetOperationFailedError
  | FramebufferSnapshotFailedError
  | ExternalTextureInvalidError
  | ExternalTextureStateInvalidError
  | ReflectionProbeBudgetExceededError
  | RenderIntentInvalidError
  | ProjectorBindingError
  | VolumeError;
