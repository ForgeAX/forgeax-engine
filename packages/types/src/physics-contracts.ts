// Physics error contracts.

// === PhysicsErrorCode / PhysicsError / PhysicsErrorDetail -- physics error SSOT (feat-20260528-rapier-physics-2d-3d M1 / t6; extended feat-20260617-kinematic M1) ===
//
// Decision anchors:
//   - requirements AC-11 (PhysicsErrorCode closed union registration + AGENTS.md update)
//   - plan-strategy D-5 (PhysicsErrorCode closed union / PhysicsError 4-field surface / PhysicsErrorDetail discriminated)
//   - charter P3 (explicit failure: exhaustive switch without default; .hint provides recovery)
//   - charter P4 (consistent abstraction: structurally parallel to AssetError / AudioError / GltfError)
//   - architecture-principles #1 SSOT (the code literals + class + hints table live here once;
//     engine-physics package re-exports from here)

/**
 * Closed `PhysicsErrorCode` union -- 8 members (plan-strategy D-5;
 * requirements AC-11). Exhaustive `switch (err.code)` needs no default
 * fallback -- TypeScript guards union completeness at compile time
 * (charter P3 explicit failure).
 *
 * Domain-separated from `AssetErrorCode` (runtime registry, 13 members)
 * and `AudioErrorCode` (audio engine, 5 members). AI users face these 8
 * alternatives at the physics engine surface.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'wasm-load-failed'` | dynamic import() of Rapier WASM rejected (network / file not found). |
 * | `'wasm-simd-unsupported'` | WebAssembly.validate returned false for SIMD test module; compat fallback also unavailable. |
 * | `'step-failed'` | Rapier World.step threw a WASM trap (invalid body parameters / NaN values). |
 * | `'invalid-body-config'` | mass <= 0 for dynamic bodies, or other validation failure. |
 * | `'body-not-found'` | entity handle resolved to no Rapier rigid body (no RigidBody spawned or handle was freed). |
 * | `'collider-not-found'` | entity handle resolved to no Rapier collider (no Collider spawned or handle was freed). |
 * | `'backend-not-registered'` | PhysicsWorld resource missing from World; use createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }) or manual registration. |
 * | `'controller-requires-kinematic'` | moveAndSlide() called on a non-kinematic body. |
 */
export type PhysicsErrorCode =
  | 'wasm-load-failed'
  | 'wasm-simd-unsupported'
  | 'step-failed'
  | 'invalid-body-config'
  | 'body-not-found'
  | 'collider-not-found'
  | 'backend-not-registered'
  | 'controller-requires-kinematic';

/**
 * Per-code `PhysicsError` detail shapes -- discriminated payloads narrowed
 * by `PhysicsError.code` so AI users writing `switch (err.code)` get
 * control-flow-tightened access to the relevant detail fields (charter P3).
 */

/** `wasm-load-failed` payload: carries the original error reason. */
export interface PhysicsWasmLoadFailedDetail {
  readonly code: 'wasm-load-failed';
  readonly reason: string;
}

/** `wasm-simd-unsupported` payload: carries the detection failure reason. */
export interface PhysicsWasmSimdUnsupportedDetail {
  readonly code: 'wasm-simd-unsupported';
  readonly reason: string;
}

/** `step-failed` payload: carries the WASM trap reason. */
export interface PhysicsStepFailedDetail {
  readonly code: 'step-failed';
  readonly reason: string;
}

/** `invalid-body-config` payload: carries the violating field + value. */
export interface PhysicsInvalidBodyConfigDetail {
  readonly code: 'invalid-body-config';
  readonly field: string;
  readonly value: unknown;
}

/** `body-not-found` payload: carries the entity that was not found. */
export interface PhysicsBodyNotFoundDetail {
  readonly code: 'body-not-found';
  readonly entity: number;
}

/** `collider-not-found` payload: carries the entity that was not found. */
export interface PhysicsColliderNotFoundDetail {
  readonly code: 'collider-not-found';
  readonly entity: number;
}

/** `backend-not-registered` payload: carries the attempted backend name. */
export interface PhysicsBackendNotRegisteredDetail {
  readonly code: 'backend-not-registered';
  readonly attemptedBackend: string;
}

/** `controller-requires-kinematic` payload: carries the entity + actual body type. */
export interface PhysicsControllerRequiresKinematicDetail {
  readonly code: 'controller-requires-kinematic';
  readonly entity: number;
  readonly bodyType: string;
}

/**
 * Discriminated detail union for `PhysicsError`, narrowed per `PhysicsError.code`.
 * AI users obtain the concrete detail shape via `switch (err.code)` without
 * needing a fallback `as` cast (charter P3).
 */
export type PhysicsErrorDetail =
  | PhysicsWasmLoadFailedDetail
  | PhysicsWasmSimdUnsupportedDetail
  | PhysicsStepFailedDetail
  | PhysicsInvalidBodyConfigDetail
  | PhysicsBodyNotFoundDetail
  | PhysicsColliderNotFoundDetail
  | PhysicsBackendNotRegisteredDetail
  | PhysicsControllerRequiresKinematicDetail;

/**
 * Structured physics error -- four-field surface (`.code` / `.expected` /
 * `.hint` / `.detail`) structurally parallel to `@forgeax/engine-types`
 * `AssetError` + `AudioError` + `GltfError` (charter P4 consistent abstraction).
 *
 * AI users consume the structured triple via property access:
 * `switch (err.code) { case 'wasm-load-failed': ... err.hint ... }`
 * -- never by parsing `.message` (charter P3 explicit failure red line).
 *
 * @example AI-user exhaustive switch on the 8 members (no default fallback)
 * ```ts
 * import { PhysicsError, type PhysicsErrorCode } from '@forgeax/engine-types';
 *
 * function recover(code: PhysicsErrorCode): string {
 *   switch (code) {
 *     case 'wasm-load-failed':            return 'check the physics backend WASM payload';
 *     case 'wasm-simd-unsupported':       return 'check browser supports WASM SIMD';
 *     case 'step-failed':                 return 'check for NaN values in transforms';
 *     case 'invalid-body-config':         return 'ensure mass > 0 for dynamic bodies';
 *     case 'body-not-found':              return 'ensure RigidBody was spawned before use';
 *     case 'collider-not-found':          return 'ensure Collider was spawned before use';
 *     case 'backend-not-registered':      return 'use createApp(canvas, { plugins: [physicsPlugin(...)] })';
 *     case 'controller-requires-kinematic': return 'set RigidBody.type to kinematic';
 *   }
 * }
 * ```
 */
export class PhysicsError extends Error {
  readonly code: PhysicsErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: PhysicsErrorDetail;

  constructor(args: {
    code: PhysicsErrorCode;
    expected: string;
    hint: string;
    detail?: PhysicsErrorDetail;
  }) {
    super(`[PhysicsError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'PhysicsError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    if (args.detail !== undefined) {
      this.detail = args.detail;
    }
  }
}

/**
 * Per-code `.hint` string literals SSOT (plan-strategy D-5 lock-in).
 * Exported so engine-physics error helpers and tests consume the same SSOT.
 *
 * The shape is a `Record<PhysicsErrorCode, string>` so future additions to
 * the closed union are a compile-time error here as well (reinforces
 * charter P3 explicit failure).
 */
export const PHYSICS_ERROR_HINTS: Readonly<Record<PhysicsErrorCode, string>> = {
  'wasm-load-failed':
    'dynamic import() or initialization of Rapier WASM failed; verify the physics backend payload and file path',
  'wasm-simd-unsupported':
    'WebAssembly.validate returned false for the SIMD test module; ensure browser supports WASM SIMD (Chrome 91+, Firefox 89+, Safari 16.4+)',
  'step-failed':
    'Rapier World.step threw a WASM trap; check for invalid body parameters or NaN values in transforms',
  'invalid-body-config':
    'check mass > 0 for dynamic bodies and valid shape parameters; see PhysicsError.detail.field',
  'body-not-found':
    'the entity handle did not resolve to a Rapier rigid body; ensure RigidBody was spawned before calling physics APIs',
  'collider-not-found':
    'the entity handle did not resolve to a Rapier collider; ensure Collider was spawned before calling physics APIs',
  'backend-not-registered':
    "PhysicsWorld resource not found; use createApp(canvas, { plugins: [physicsPlugin('rapier-3d')] }) or manually register a backend",
  'controller-requires-kinematic':
    "moveAndSlide requires a kinematic RigidBody; set the entity's RigidBody.type to 'kinematic'",
};

// Runtime-layer contracts are re-exported by the public index barrel. Keeping
// this owner module independent prevents a reverse type dependency cycle.
