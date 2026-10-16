// @forgeax/engine-rhi/src/errors - RhiError + closed RhiErrorCode union + Result<T, E>.
//
// Shape:
// - RhiErrorCode = closed union 23 members (charter P3: closed-union
//   exhaustive switch needs no default fallback; tsc strict mode guards
//   completeness). Extended from 6 to 10 in feat-20260508-rhi-surface-completion
//   w7 (D-S3): added 'command-encoder-finished' / 'render-pass-not-ended' /
//   'queue-submit-failed' / 'queue-write-buffer-out-of-bounds'.
//   Extended from 10 to 14 in feat-20260509-ecs-render-bridge-mvp w6 (D-S7):
//   added 'render-system-no-camera' / 'render-system-multi-camera' /
//   'render-system-multi-light' / 'asset-not-registered'.
//   Extended from 14 to 17 in feat-20260511-rhi-spec-realign-aggressive w6
//   (D-P4 + R-02 §2.1 W3C spec 22.2 subtypes): added 'device-lost' / 'oom' /
//   'internal-error' so the onError fan-out can disambiguate spec error
//   subclasses without falling back to the bucket 'webgpu-runtime-error'.
//   Extended from 17 to 18 in feat-20260511-asset-system-v1 w4
//   (D-P2 + requirements §9 row 8 + AC-04 + AC-21): added
//   'hierarchy-broken' for `propagateTransforms` stale ChildOf ref fail-fast
//   (ChildOf component references a destroyed entity); same
//   render-system / schedule semantic domain as
//   'render-system-multi-camera' / 'render-system-no-camera'. Minor add-only
//   per AGENTS.md evolution contract (no reorder / rename / deprecate).
//   Extended from 18 to 19 in feat-20260612-rhi-destroy-renderer-dispose-gpu-
//   lifecycle M1 (D-6 + D-7 + AC-02 / AC-03): added 'destroy-after-destroy'
//   for second `destroyBuffer` / `destroyTexture` on the same handle. The
//   shim layer (rhi-webgpu + rhi-wgpu) tracks per-handle `destroyed: boolean`
//   in WeakMap-backed meta and fail-fasts the second call rather than
//   forwarding it to the underlying GPU (research F-1 wgpu wasm `destroy()`
//   is idempotent void; F-8 WebGPU spec is also idempotent void; D-7 prefers
//   fail-fast over silent idempotency because double-destroy is almost always
//   a lifecycle bug). Minor add-only per AGENTS.md evolution contract.
//   Extended from 19 to 20 in feat-20260619-wasm-fault-isolation M3 w7:
//   added 'rhi-descriptor-invalid' for `createRenderPipeline` (and other
//   create* entries) descriptor parse failures surfaced through the wgpu-wasm
//   backend (Rust `#[wasm_bindgen(catch)]` Err). The prefix-based
//   classification (D-1 / D-2) routes wasm exceptions with the stable marker
//   `[wgpu-wasm] failed to parse` to this code; exceptions without the prefix
//   remain in 'webgpu-runtime-error'. Semantics: descriptor parse failure =
//   caller bug (malformed descriptor data passed from TS), distinct from
//   'webgpu-runtime-error' = runtime condition (valid descriptor rejected by
//   wgpu backend). Minor add-only per AGENTS.md evolution contract.
//   Extended from 20 to 21 in feat-20260622-chunk-gpu-instancing-sprite-
//   tilemap M2 w10 (D-2 + AC-05 + research N-1): added
//   'instancing-exceeds-uniform-cap' for the WebGL2 uniform-fallback path
//   when a record-stage fold bucket carries more than 128 instances
//   (128 = MAX_UNIFORM_INSTANCES; 128 * 64B = 8192B comfortably fits the
//   WebGL2 minimum 16384B UBO size, leaving headroom for the per-frame
//   material UBO slice — research N-1 implements the locked value). The
//   record-stage dispatch site fires the error AND falls the offending
//   bucket back to per-entity drawIndexed (the same exit the mode-gate
//   bypass uses — plan-strategy D-9 "shared fallback exit"). Semantics:
//   distinct from 'limit-exceeded' (byte-cap against
//   maxStorageBufferBindingSize) — this code targets the per-bucket
//   instance-count cap, which is a backend-capability ceiling rather than
//   an allocation-size ceiling. AI users branch on .code first then read
//   detail.requested / .limit / .scope through property access (charter
//   P3 + plan-strategy 8.3 actionable hint). Minor add-only
//   per AGENTS.md evolution contract.
//   Extended from 21 to 23 in feat-20260708-composited-multi-world-rendering
//   M3 (D-5): added 'render-system-empty-worlds' + 'render-system-owner-out-of-
//   range' for draw(worlds, { cameraOwner, resourceOwner }) entry validation. The
//   owner-out-of-range path exposes .detail = RhiOwnerOutOfRangeDetail
//   ({ role, owner, worldCount } after feat-20260709-editor-world-partition
//   M1 / w7: role ∈ {'camera','resource'} names which of the two split draw
//   owners is out of range); empty-worlds carries no .detail. The pure
//   validateDrawArgs(worldCount, { cameraOwner, resourceOwner })
//   helper (World-free primitives) emits both and is consumed by the runtime
//   createRenderer draw entry (the codes' SSOT stays in rhi). Checks run
//   empty-worlds -> cameraOwner -> resourceOwner; the first out-of-range owner
//   wins (role='camera' when both offend). Add-only (no new code, 0 net Δ per
//   D-3) per AGENTS.md evolution contract.
// - RhiError class has readonly .code / .expected / .hint three-field surface
//   (AGENTS.md "Errors are structured" / D-5); the 'shader-compile-failed' path
//   exposes .detail = RhiShaderCompileDetail (compilerMessages array);
//   the 'asset-not-registered' path exposes .detail = RhiAssetNotRegisteredDetail
//   ({ assetHandle: number }, D-S6); the 'webgpu-runtime-error' path optionally
//   exposes .detail = RhiWebgpuRuntimeDetail ({ error: RhiError | fallback }, D-S8) for
//   RenderSystem internal exception fan-out; the 'limit-exceeded' path
//   exposes .detail = LimitExceededDetail ({ maxStorageBufferBindingSize,
//   requestedBytes }, feat-20260513-instanced-mesh M5 reshape from legacy
//   { renderableCount, limit }); the other 15 paths leave
//   .detail = undefined per charter proposition 4 baseline.
// - Result<T, E> = binary tag union ('ok' / 'err'), per AGENTS.md "Errors are
//   structured" convention.
//
// Related: requirements AC AC-10 + MVP-1.7 + AC-RSC-07 + hard-constraint 8 +
//          AI User Affordances; plan-strategy 2 S-6 (types/rhi single source) +
//          7.3 error-info table; plan-decisions OQ-P2 (forward all 6 fields of
//          GPUCompilationMessage); D-S3 (4 command/queue members) + D-S6 / D-S7
//          / D-S8 (4 RenderSystem / AssetRegistry members + .detail structure).

/// <reference types="@webgpu/types" />

import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Closed RhiErrorCode union. `switch` exhaustive checks need no default
 * fallback - tsc strict mode guards union completeness (charter proposition 4
 * + proposition 3: machine-readable union > prose).
 *
 *
 * The executable union below is the machine-readable source of truth for
 * the 23 members. The package README owns the AI-facing trigger and recovery
 * table; keeping that projection in one documentation owner avoids a second
 * member ledger drifting from the union.
 *
 * @example AI-user exhaustive switch on the 4 command/queue members (no default fallback)
 * ```ts
 * import type { RhiError, RhiErrorCode } from '@forgeax/engine-rhi';
 *
 * function recover(code: RhiErrorCode): string {
 *   switch (code) {
 *     // ... 6 baseline members elided ...
 *     case 'command-encoder-finished':       return 'recreate encoder via device.createCommandEncoder()';
 *     case 'render-pass-not-ended':          return 'call pass.end() before next beginRenderPass()';
 *     case 'queue-submit-failed':            return 'audit buffer/pipeline lifetimes before submit';
 *     case 'queue-write-buffer-out-of-bounds': return 'realign offset and re-check buffer.size';
 *     default:                               return 'baseline path';
 *   }
 * }
 * ```
 */
export type RhiErrorCode =
  | 'adapter-unavailable'
  | 'feature-not-enabled'
  | 'limit-exceeded'
  | 'shader-compile-failed'
  | 'rhi-not-available'
  | 'webgpu-runtime-error'
  | 'command-encoder-finished'
  | 'render-pass-not-ended'
  | 'queue-submit-failed'
  | 'queue-write-buffer-out-of-bounds'
  | 'render-system-no-camera'
  | 'render-system-multi-camera'
  | 'render-system-multi-light'
  | 'asset-not-registered'
  | 'device-lost'
  | 'oom'
  | 'internal-error'
  | 'hierarchy-broken'
  | 'destroy-after-destroy'
  | 'rhi-descriptor-invalid'
  | 'instancing-exceeds-uniform-cap'
  | 'render-system-empty-worlds'
  | 'render-system-owner-out-of-range'
  | 'rhi-texture-format-capability-unavailable';

/**
 * Detail structure exclusive to the `shader-compile-failed` path.
 *
 * `compilerMessages` directly forwards the 6 standardized fields of
 * `GPUCompilationMessage` from `@webgpu/types` v0.1.69 (`message` / `type` /
 * `lineNum` / `linePos` / `offset` / `length`); research F-3 finding;
 * plan-decisions OQ-P2 locks full-field forwarding.
 *
 * @see {@link GPUCompilationMessage}
 */
export interface RhiShaderCompileDetail {
  readonly compilerMessages: readonly GPUCompilationMessage[];
}

/**
 * Detail structure exclusive to the `asset-not-registered` path (D-S6).
 *
 * `assetHandle` carries the offending u32 handle the caller passed via
 * `MeshFilter.assetHandle`; AI users access it through property access
 * (`err.detail.assetHandle`) rather than parsing the message string
 * (charter proposition 4 + F-3 contract surface).
 */
export interface RhiAssetNotRegisteredDetail {
  readonly assetHandle: number;
}

/**
 * Detail structure exclusive to the `webgpu-runtime-error` path (D-S8).
 *
 * `error` carries the underlying exception object so AI users can inspect the
 * root cause (`.code` / `.expected` / `.hint` for `RhiError` paths, or
 * `.code` + `.message` for non-RhiError falls) without parsing the
 * RhiError.message field. Optional: the K-9 silent-skip fan-out root path
 * may emit `webgpu-runtime-error` without `.detail` when the underlying
 * exception is unavailable.
 *
 * feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M4 / T-M4-02:
 * `error` field type widened from `string` to `RhiError | { code: string;
 * message: string }` so downstream `switch (err.code)` handlers can narrow
 * the inner error (`.code` / `.expected` / `.hint`) without an `as` cast.
 */
/**
 * Structured non-RHI causes carried by a `webgpu-runtime-error` wrapper.
 *
 * Pipeline-spec failures retain their own detail record here so callers can
 * reach the backend cause without parsing `Error.message` or losing the
 * producer-owned fields during initialization fan-out.
 */
export interface RhiWebgpuRuntimeCause {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly detail?: object;
}

export interface RhiWebgpuRuntimeDetail {
  readonly error: RhiError | RhiWebgpuRuntimeCause;
}

/**
 * Detail structure exclusive to the `limit-exceeded` path.
 *
 * `maxStorageBufferBindingSize` carries the device-reported storage cap
 * (`device.limits.maxStorageBufferBindingSize`); `requestedBytes`
 * carries the byte count the caller attempted to allocate. AI users
 * access these through typed property access (`err.detail.maxStorageBufferBindingSize`
 * / `err.detail.requestedBytes`) rather than parsing the message string
 * — charter proposition 4 structured-error consumption path; `err.hint`
 * is for human eyeballs only.
 *
 * Single live emit point: the RenderSystem record stage per-entity
 * instance buffer upload path
 * (`packages/runtime/src/render-system-record.ts`). The 18-member
 * `RhiErrorCode` union is unchanged (`'limit-exceeded'` discriminant
 * preserved); evolution major rename + replace of the discriminated
 * `detail` shape per AGENTS.md Change stance + plan-strategy D-3.
 *
 * Migration history:
 *   - feat-20260513-instanced-mesh M5: detail reshape from
 *     `{ renderableCount, limit }` to `{ maxStorageBufferBindingSize,
 *     requestedBytes }`. Emit point at the time was
 *     `AssetRegistry.createInstancedBuffer`.
 *   - feat-20260907-case01-case05-engine-convergence: explicit instance
 *     matrices are supplied by the renderer-owned collection projection;
 *     `requestedBytes` describes the resident record payload at the record
 *     stage, independent of ECS managed-array capacity.
 */
export interface LimitExceededDetail {
  readonly maxStorageBufferBindingSize: number;
  readonly requestedBytes: number;
}

/**
 * Detail structure exclusive to the `'render-system-multi-light'` path.
 * The only remaining cardinality rule is one global DirectionalLight; all
 * PointLight, SpotLight, and RectArea lights are admitted through the shared
 * shared Cluster corpus and are admitted by the same local-light contract.
 */
export interface RhiMultiLightDetail {
  readonly type: 'directional';
  readonly got: number;
}

/**
 * Detail structure exclusive to the `'instancing-exceeds-uniform-cap'` path
 * (feat-20260622-chunk-gpu-instancing-sprite-tilemap M2 / w10 +
 * plan-strategy 2 D-2 + research N-1).
 *
 * Emitted by the record-stage fold dispatch loop
 * (`packages/runtime/src/render-system-record.ts`) when
 * `caps.storageBuffer === false` AND a fold bucket carries more than
 * `limit` instances. The engine fires the error AND falls the offending
 * bucket back to per-entity drawIndexed via the same exit the mode-gate
 * bypass uses (plan-strategy D-9 "shared fallback exit"), so the frame
 * is still visually correct (no identity-collapse / black screen) and
 * the cap event surfaces structurally for AI users to observe.
 *
 * Fields:
 *   - `requested` — the offending bucket's instance count
 *     (`FoldBucket.bucketSize`); always strictly greater than `limit` at
 *     emit time (the cap-check helper guards `requested > limit`).
 *   - `limit` — the literal 128. The value is locked at the type level
 *     because the cap is structurally tied to the WebGL2 minimum 16384 B
 *     UBO size (128 * 64 B mat4 stride = 8192 B leaves headroom for the
 *     per-frame material UBO slice — research N-1). A future cap change
 *     would be a major evolution, not a runtime knob.
 *   - `scope` — closed `'sprite' | 'tilemap-chunk'` discriminator that
 *     pinpoints the dispatch site (sprite-pass entry that came directly
 *     from a user-spawned Sprite vs one derived by
 *     `tilemap-chunk-extract-system`). AI users branch on `.scope` to
 *     decide whether to shrink the sprite batch size or the tilemap
 *     chunk size.
 *
 * AI-user consumption (charter P3 + plan-strategy 8.3):
 * ```ts
 * if (err.code === 'instancing-exceeds-uniform-cap') {
 *   const d = err.detail as RhiInstancingExceedsUniformCapDetail;
 *   if (d.scope === 'sprite')        shrinkSpriteBatchSize(d.requested);
 *   else if (d.scope === 'tilemap-chunk') shrinkTileChunkSize(d.requested);
 * }
 * ```
 * — never parse `err.message`. The discriminated `detail` field is the
 * surface; the human-readable `err.message` is for logs only.
 */
export interface RhiInstancingExceedsUniformCapDetail {
  readonly requested: number;
  readonly limit: 128;
  readonly scope: 'sprite' | 'tilemap-chunk';
}

/**
 * Detail structure exclusive to the `'render-system-owner-out-of-range'` path
 * (feat-20260708-composited-multi-world-rendering M3 / D-5).
 *
 * Emitted by `renderer.draw(worlds, { cameraOwner, resourceOwner })` when one
 * owner index is not valid for `worlds` (`owner < 0` or `owner >= worlds.length`).
 * An out-of-range index cannot resolve, so the frame is skipped before extract.
 *
 * Fields:
 *   - `role` — WHICH of the two draw-owner indices was out of range
 *     (feat-20260709-editor-world-partition M1 / w7). `draw(worlds, {
 *     cameraOwner, resourceOwner })` carries two independent indices; `role`
 *     tells the AI user whether the camera-source index (`'camera'`) or the
 *     singleton-resource index (`'resource'`) is the offender, so the fix is
 *     unambiguous from the text channel (no new error code — D-3 keeps 0 net
 *     new codes; the discriminator lives in `.detail`). When both indices are
 *     out of range the first offender is reported: `cameraOwner` is validated
 *     before `resourceOwner`, so `role === 'camera'`.
 *   - `owner` — the offending index the caller passed (the `role` index's
 *     value).
 *   - `worldCount` — `worlds.length` at call time (the valid range is
 *     `0 .. worldCount - 1`).
 *
 * AI users branch via property access (`err.detail.role` / `err.detail.owner` /
 * `err.detail.worldCount`) after narrowing on `.code`, rather than parsing the
 * message string (charter P3 structured-failure surface).
 *
 * The sibling `'render-system-empty-worlds'` path carries no `.detail` — an
 * empty array is fully described by `.code`, and the entry check short-circuits
 * to that code before the owner-range check runs (the two codes are
 * non-exclusive).
 */
export interface RhiOwnerOutOfRangeDetail {
  readonly role: 'camera' | 'resource';
  readonly owner: number;
  readonly worldCount: number;
}

/** Detail for an incomplete device-owned texture-format profile probe. */
export interface RhiTextureFormatCapabilityUnavailableDetail {
  readonly stage: string;
  readonly deviceGeneration: number;
  readonly reason: string;
}

/**
 * Tagged union of `.detail` shapes carried by structured errors.
 *
 * Entries:
 *   - `RhiShaderCompileDetail` (carries `compilerMessages`) - emitted on the
 *     `'shader-compile-failed'` path.
 *   - `RhiAssetNotRegisteredDetail` (carries `assetHandle`) - emitted on the
 *     `'asset-not-registered'` path (D-S6).
 *   - `RhiWebgpuRuntimeDetail` (carries `error: RhiError | { code, message }`) - optionally emitted
 *     on the `'webgpu-runtime-error'` path when a captured `Error.message` is
 *     available (D-S8).
 *   - `LimitExceededDetail` (carries `maxStorageBufferBindingSize` +
 *     `requestedBytes`) - emitted on the `'limit-exceeded'` path when
 *     the RenderSystem record stage's per-entity Instances upload
 *     exceeds `device.limits.maxStorageBufferBindingSize`
 *     (feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15;
 *     emit point migrated from the deleted
 *     `AssetRegistry.createInstancedBuffer` factory).
 *
 * The other 15 paths leave `.detail = undefined` (charter proposition 4
 * baseline).
 */
export type RhiErrorDetail =
  | RhiShaderCompileDetail
  | RhiAssetNotRegisteredDetail
  | RhiWebgpuRuntimeDetail
  | LimitExceededDetail
  | RhiMultiLightDetail
  | RhiInstancingExceedsUniformCapDetail
  | RhiOwnerOutOfRangeDetail
  | RhiTextureFormatCapabilityUnavailableDetail;

/**
 * Structured RHI error.
 *
 * Three readonly fields aligned with AGENTS.md "Errors are structured":
 * - `.code` - closed union member (L1 key signal).
 * - `.expected` - expected-state description (L2 detail).
 * - `.hint` - actionable recovery guidance (L2 detail; charter proposition 3:
 *   machine-readable hint > prose).
 *
 * `.detail` is populated on four paths:
 *   - `code === 'shader-compile-failed'` -> `RhiShaderCompileDetail`
 *   - `code === 'asset-not-registered'`  -> `RhiAssetNotRegisteredDetail`
 *   - `code === 'webgpu-runtime-error'`  -> `RhiWebgpuRuntimeDetail` (optional)
 *   - `code === 'limit-exceeded'`        -> `LimitExceededDetail`
 *     (feat-20260513-instanced-mesh M5 reshape; carries
 *     `maxStorageBufferBindingSize` + `requestedBytes`)
 *
 * The other 15 paths leave `.detail = undefined` (charter proposition 4
 * baseline).
 *
 * Note: `RhiErrorDetail` is currently a flat tagged union without a
 * `code` discriminant field on each variant; AI users perform typed
 * narrowing via outer `switch (err.code)` then a one-time `as` cast on
 * `err.detail` per the documented variant. Full discriminated-union
 * refactor (each variant carrying its own `code` literal field) is left
 * to `feat-future-rhi-error-detail-discriminant` spinoff.
 */
export class RhiError extends Error {
  readonly code: RhiErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: RhiErrorDetail | undefined;

  constructor(args: {
    code: RhiErrorCode;
    expected: string;
    hint: string;
    detail?: RhiErrorDetail | undefined;
  }) {
    super(`[RhiError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'RhiError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * The two split draw-owner indices carried by
 * `draw(worlds, { cameraOwner, resourceOwner })`
 * (feat-20260709-editor-world-partition M1 / w6). `cameraOwner` selects the
 * world whose cameras are surfaced; `resourceOwner` selects the world whose
 * skylight / skybox / postProcessParams are surfaced. Declared here (World-free
 * primitives) so the validator and the `RhiOwnerOutOfRangeDetail.role`
 * discriminator live in one SSOT package (architecture-principles §1).
 */
export interface DrawOwnerSplit {
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

/**
 * Validate `renderer.draw(worlds, { cameraOwner, resourceOwner })` arguments at
 * the draw entry (feat-20260708 M3 / D-5, extended by
 * feat-20260709-editor-world-partition M1 / w6-w7).
 *
 * The validator takes primitives (`worldCount = worlds.length`, plus the owner
 * index/indices) — no `World`, no math — so it lives in `@forgeax/engine-rhi`
 * alongside the `RhiErrorCode` members it emits (architecture-principles §1
 * SSOT). The runtime `createRenderer` draw entry calls it before any extract; a
 * non-`ok` result skips the frame with a structured error (charter P3), never a
 * silent no-op.
 *
 * Checks, in order (D-5 + w6):
 *   1. `worldCount === 0` -> `'render-system-empty-worlds'` (no `.detail`).
 *   2. `cameraOwner` is not a valid index -> `'render-system-owner-out-of-range'`
 *      with `.detail = { role: 'camera', owner: cameraOwner, worldCount }`.
 *   3. `resourceOwner` is not a valid index -> `'render-system-owner-out-of-range'`
 *      with `.detail = { role: 'resource', owner: resourceOwner, worldCount }`.
 * The `Number.isInteger` guard rejects a `NaN` / fractional / undefined-coerced
 * index a JS caller could pass despite the compile-time requirement. When both
 * indices are out of range the FIRST offender wins: `cameraOwner` is checked
 * before `resourceOwner`, so `role === 'camera'` (D-3 / w3 contract).
 *
 * The empty-worlds guard short-circuits before either owner-range check.
 */
export function validateDrawArgs(
  worldCount: number,
  owner: DrawOwnerSplit,
): Result<void, RhiError> {
  if (worldCount === 0) {
    return err(
      new RhiError({
        code: 'render-system-empty-worlds',
        expected: 'worlds array has at least one world',
        hint: 'pass at least one world: draw([world], { cameraOwner: 0, resourceOwner: 0 })',
      }),
    );
  }
  const { cameraOwner, resourceOwner } = owner;
  const outOfRange = (index: number): boolean =>
    !Number.isInteger(index) || index < 0 || index >= worldCount;
  // cameraOwner is validated first: it is the first offender when both indices
  // are out of range (w3 contract). role names which index the AI user fixes.
  if (outOfRange(cameraOwner)) {
    return err(
      new RhiError({
        code: 'render-system-owner-out-of-range',
        expected: 'cameraOwner is an index into worlds (0 <= cameraOwner < worlds.length)',
        hint: 'cameraOwner must be in 0..worlds.length-1; the cameraOwner world supplies the surfaced cameras',
        detail: { role: 'camera', owner: cameraOwner, worldCount },
      }),
    );
  }
  if (outOfRange(resourceOwner)) {
    return err(
      new RhiError({
        code: 'render-system-owner-out-of-range',
        expected: 'resourceOwner is an index into worlds (0 <= resourceOwner < worlds.length)',
        hint: 'resourceOwner must be in 0..worlds.length-1; the resourceOwner world supplies skylight/skybox/postProcess',
        detail: { role: 'resource', owner: resourceOwner, worldCount },
      }),
    );
  }
  return ok(undefined);
}

// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types). They were duplicated here ("byte-for-byte aligned" by prose) and
// in packages/ecs/src/result.ts; SSOT consolidated upstream. The barrel here
// re-exports them so existing `import { err, ok, Result, ResultOk, ResultErr }
// from '@forgeax/engine-rhi'` consumers stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';
