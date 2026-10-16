// @forgeax/engine-debug-draw -- error model SSOT (feat-20260615-debug-draw M1 / w2)
//
// Closed outer DebugDrawErrorCode with correlated detail payloads,
// and structured DebugDrawError carrying .code / .expected / .hint / .detail.
//
// Decision anchors:
// - plan-strategy D-11: destroy-then-flush returns Result.err, shape calls no-op + warn once
// - requirements sec 3.6: error code closed union 4 members
// - AGENTS.md Error model: structured errors with .expected / .hint, never throw
// - architecture-principles #5 Fail Fast: validate at entry, non-conforming data never flows downstream

import { err, type Result } from '@forgeax/engine-types';

/** {@link pipeline-create-failed} payload: carries the RHI-level error detail. */
export interface PipelineCreateFailedDetail {
  readonly rhiError: string;
}

/** {@link buffer-allocation-failed} payload: carries the RHI-level error detail. */
export interface BufferAllocationFailedDetail {
  readonly rhiError: string;
}

/** {@link flushed-after-destroy} carries no additional payload. */
export type FlushedAfterDestroyDetail = Readonly<Record<string, never>>;

/** {@link viewProj-required} carries no additional payload. */
export type ViewProjRequiredDetail = Readonly<Record<string, never>>;

interface DebugDrawErrorDetailByCode {
  'pipeline-create-failed': PipelineCreateFailedDetail;
  'buffer-allocation-failed': BufferAllocationFailedDetail;
  'flushed-after-destroy': FlushedAfterDestroyDetail;
  'viewProj-required': ViewProjRequiredDetail;
}

/**
 * Closed {@link DebugDrawErrorCode} union.
 * Exhaustive `switch (err.code)` needs no default fallback.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'pipeline-create-failed'` | `device.createRenderPipeline(...)` rejected or threw |
 * | `'buffer-allocation-failed'` | `device.createBuffer(...)` for GPU vbo allocation failed |
 * | `'flushed-after-destroy'` | `flush()` called on an already-destroyed DebugDraw instance |
 * | `'viewProj-required'` | `flush()` called with `undefined` or missing `viewProj` |
 */
export type DebugDrawErrorCode = keyof DebugDrawErrorDetailByCode;

/**
 * Discriminated detail union for {@link DebugDrawError}, narrowed per
 * `DebugDrawError.code`. AI users obtain the concrete shape via
 * `switch (err.code)` without a fallback `as` cast.
 */
export type DebugDrawErrorDetail = DebugDrawErrorDetailByCode[DebugDrawErrorCode];

/**
 * Structured debug-draw error -- four-field surface
 * (`.code` / `.expected` / `.hint` / `.detail`).
 *
 * AI users consume the structured triple by fields, not by parsing `.message`.
 */
type DebugDrawErrorVariant<C extends DebugDrawErrorCode> = {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DebugDrawErrorDetailByCode[C];
};

export type DebugDrawError = {
  [C in DebugDrawErrorCode]: DebugDrawErrorVariant<C>;
}[DebugDrawErrorCode];

function makeError<C extends DebugDrawErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: DebugDrawErrorDetailByCode[C],
): DebugDrawErrorVariant<C> {
  const error = {
    code,
    expected,
    hint,
    detail,
    get message(): string {
      return `[${code}] ${hint}`;
    },
  };
  return error;
}

/** Result-returning helpers consuming engine-types `Result<T, E>` + `err()`. */

export function pipelineCreateFailed(rhiError: string): Result<never, DebugDrawError> {
  return err(
    makeError(
      'pipeline-create-failed',
      'PSO creation should succeed with valid WGSL + layout',
      `Pipeline creation failed: ${rhiError}. Check WGSL syntax, vertex layout, and depth-stencil state.`,
      { rhiError },
    ),
  );
}

export function bufferAllocationFailed(rhiError: string): Result<never, DebugDrawError> {
  return err(
    makeError(
      'buffer-allocation-failed',
      'GPU vertex buffer allocation should succeed for the requested byte size',
      `Buffer allocation failed: ${rhiError}. Check available device memory and buffer usage flags.`,
      { rhiError },
    ),
  );
}

export function flushedAfterDestroy(): Result<never, DebugDrawError> {
  return err(
    makeError(
      'flushed-after-destroy',
      'DebugDraw instance is alive and not yet destroyed',
      'DebugDraw was destroyed; create a new instance via createDebugDraw().',
      {},
    ),
  );
}

export function viewProjRequired(): Result<never, DebugDrawError> {
  return err(
    makeError(
      'viewProj-required',
      'viewProj must be provided as a Mat4 for flush to transform vertices',
      'Pass a viewProj Mat4 to flush(encoder, view, viewProj).',
      {},
    ),
  );
}
