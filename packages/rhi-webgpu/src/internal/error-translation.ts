// @forgeax/engine-rhi-webgpu/src/internal/error-translation — spec GPUError +
// GPUDeviceLostInfo -> 17-member RhiErrorCode dispatch translator (D-P4 literal).
//
// Charter: proposition 4 (explicit failure) — every WebGPU async dispatch
// error reachable through onuncapturederror / device.lost has a closed-union
// RhiErrorCode mapping; proposition 5 (consistent abstraction) — the dual
// backends (rhi-webgpu / rhi-wgpu) translate the SAME spec event shape to the
// SAME 17-member union so engine.onError listeners see byte-for-byte aligned
// .code values regardless of which backend dispatched the error.
//
// Mapping rules (plan-strategy D-P4 table literal):
//   (a) GPUValidationError — sub-pattern on the message text:
//         - /shader|compile|wgsl/i  -> 'shader-compile-failed'
//         - /size|alignment|out of bounds/i -> 'queue-write-buffer-out-of-bounds'
//         - /encoder.*finished|finished encoder/i -> 'command-encoder-finished'
//         - /render pass.*not ended|not ended/i -> 'render-pass-not-ended'
//         - /submit/i -> 'queue-submit-failed'
//         - default -> 'limit-exceeded' (the broadest spec validation bucket
//           reachable from validation messages; AI users still get a
//           structured code, not 'webgpu-runtime-error' which is reserved for
//           unrecognised types).
//   (b) GPUOutOfMemoryError -> 'oom' (RhiErrorCode 17-member addition w6).
//   (c) GPUInternalError -> 'internal-error' (RhiErrorCode 17-member addition w6).
//   (d) GPUDeviceLostInfo -> 'device-lost' (RhiErrorCode 17-member addition w6).
//   (e) Unrecognised event type -> 'webgpu-runtime-error' (catch-all bucket;
//       AI users `switch (err.code)` still exhausts the closed union).
//
// Dual-channel responsibility boundary (D-PD4):
//   - createX entries return Result.ok / Result.err *synchronously* — sync
//     validation errors (size=0, missing layout, etc.) flow through this
//     channel via the existing errors.ts factories.
//   - device.lost + onuncapturederror channels carry *async* dispatch errors
//     — this translator is the sole gateway from spec event -> RhiError in
//     that async channel. The engine RhiErrorListenerRegistry fan-out happens
//     downstream (packages/engine/src/renderer.ts).
//
// Anchors: requirements AC-02 + AC-04; research R-02 §2.1 spec / wgpu / dawn
// three-way fact; plan-strategy D-P4 mapping table literal; charter propositions
// 4 + 5; AGENTS.md "## RHI / Shader / error model contract" evolution contract
// minor add-only.

/// <reference types="@webgpu/types" />

import { err, type Result, RhiError } from '@forgeax/engine-rhi';

/** Translate a spec async-dispatch error event into a closed-union RhiError.
 *
 * This is the single gateway from `GPUUncapturedErrorEvent` / `device.lost`
 * Promise into the 17-member `RhiErrorCode` union (charter proposition 5
 * consistent abstraction: dual-backend dispatch tables align byte-for-byte).
 *
 * @note GPUValidationError dispatch defaults to the 'limit-exceeded' bucket when the device-side message does not match any narrower regex pattern; see L12-21 module-level mapping rules comment for the full sub-pattern table (5 narrower regexes + default fallback). AI users still receive a structured `.code` rather than `'webgpu-runtime-error'` (reserved for unrecognised event types only); charter proposition 4 explicit failure — every spec event maps to a real union member.
 * @param event one of:
 *   - `GPUUncapturedErrorEvent` (carries a `.error` of `GPUValidationError |
 *     GPUOutOfMemoryError | GPUInternalError`);
 *   - `GPUDeviceLostInfo` (carries `.reason` + `.message`);
 *   - opaque (catch-all → 'webgpu-runtime-error').
 */
export function translateErrorEventToRhiError(
  event: GPUUncapturedErrorEvent | GPUDeviceLostInfo | unknown,
): Result<never, RhiError> {
  // (d) device-lost branch — GPUDeviceLostInfo shape has `.reason` enum.
  if (
    typeof event === 'object' &&
    event !== null &&
    'reason' in event &&
    typeof (event as { reason: unknown }).reason === 'string'
  ) {
    const info = event as GPUDeviceLostInfo;
    return err(
      new RhiError({
        code: 'device-lost',
        expected: 'device must remain alive (driver / browser must not destroy the GPUDevice)',
        hint: `device-lost reason: ${info.reason}; message: ${info.message ?? '<empty>'}`,
      }),
    );
  }

  // GPUUncapturedErrorEvent branch — carries `.error` of GPUError subtype.
  if (
    typeof event === 'object' &&
    event !== null &&
    'error' in event &&
    typeof (event as { error: unknown }).error === 'object' &&
    (event as { error: unknown }).error !== null
  ) {
    const error = (event as { error: unknown }).error as object;
    const message =
      typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '<no message>';

    // (b) GPUOutOfMemoryError → 'oom' — detected by constructor name.
    if (error.constructor.name === 'GPUOutOfMemoryError') {
      return err(
        new RhiError({
          code: 'oom',
          expected: 'sufficient GPU memory to satisfy the allocation',
          hint: `GPU out-of-memory: ${message}`,
        }),
      );
    }

    // (c) GPUInternalError → 'internal-error' — detected by constructor name.
    if (error.constructor.name === 'GPUInternalError') {
      return err(
        new RhiError({
          code: 'internal-error',
          expected: 'driver / browser must report a recognised validation error',
          hint: `GPU internal error: ${message}`,
        }),
      );
    }

    // (a) GPUValidationError → sub-pattern dispatch via message text.
    if (error.constructor.name === 'GPUValidationError') {
      if (/shader|compile|wgsl/i.test(message)) {
        return err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'valid WGSL source + matching pipeline layout',
            hint: `GPU validation: ${message}`,
          }),
        );
      }
      if (/size|alignment|out of bounds/i.test(message)) {
        return err(
          new RhiError({
            code: 'queue-write-buffer-out-of-bounds',
            expected: 'writeBuffer offset + data.byteLength must be within buffer.size',
            hint: `GPU validation: ${message}`,
          }),
        );
      }
      if (/encoder.*finished|finished encoder/i.test(message)) {
        return err(
          new RhiError({
            code: 'command-encoder-finished',
            expected: 'command encoder must not be finished before recording new commands',
            hint: `GPU validation: ${message}`,
          }),
        );
      }
      if (/render pass.*not ended|pass.*not ended/i.test(message)) {
        return err(
          new RhiError({
            code: 'render-pass-not-ended',
            expected: 'previous render pass must be ended before beginning a new pass',
            hint: `GPU validation: ${message}`,
          }),
        );
      }
      if (/submit/i.test(message)) {
        return err(
          new RhiError({
            code: 'queue-submit-failed',
            expected: 'command buffer references must be valid at submit time',
            hint: `GPU validation: ${message}`,
          }),
        );
      }
      // Default validation bucket — limit-exceeded is the broadest reachable
      // spec validation code (AI users still get a structured code, not the
      // catch-all 'webgpu-runtime-error').
      return err(
        new RhiError({
          code: 'limit-exceeded',
          expected: 'descriptor field values within device limits',
          hint: `GPU validation: ${message}`,
        }),
      );
    }
  }

  // (e) Catch-all — unrecognised event type → 'webgpu-runtime-error'.
  const repr =
    typeof event === 'object' && event !== null && 'toString' in event
      ? String(event)
      : '<unknown>';
  return err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'spec-recognised GPUUncapturedErrorEvent or GPUDeviceLostInfo',
      hint: `unrecognised async-dispatch event: ${repr}`,
    }),
  );
}
