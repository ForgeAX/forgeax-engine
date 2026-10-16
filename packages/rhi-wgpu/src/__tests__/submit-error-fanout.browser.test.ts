// submit-error-fanout.browser.test.ts — bug-20260622 R5 WS2 / M4 (m4-1).
//
// Trigger: root vitest.config.ts `browser` project (`*.browser.test.ts` glob).
//
// Scope (plan-strategy D-3 / D-4, requirements AC-04 / AC-05 / AC-06 / AC-08):
//   The wgpu-wasm submit() (rhi.rs) registers an on_uncaptured_error global
//   callback that captures submit-period validation errors into a JS-visible
//   slot, then returns Result so the failure surfaces as a catchable Err with a
//   stable `[rhi-code:<code>]` prefix (Rust = classification SSOT via M3's
//   classify_uncaptured_error). The TS shim (queue.ts) parses that prefix and
//   fans the failure out as a structured RhiError through the Result channel.
//
//   The real device-bound submit-period validation trigger (a malformed GPU
//   command on a live wgpu-wasm WebGL2 device) CANNOT be exercised here: the
//   chromium provider on GH-hosted runners does not expose a wgpu-wasm GL
//   adapter (same reason renderer-wgpu-wasm.browser.test.ts is skipped). That
//   end-to-end path is M5's WebKit Playwright probe. This test covers the
//   browser-reachable contract: shim routing + AC-05 exhaustive switch + AC-06
//   instance survival, exercised through makeRhiQueue with a fake RawQueueLike
//   that emits the wasm marker shape.
//
// Charter awareness:
//   - P3 explicit failure: a swallowed submit error (the pre-fix error-sink
//     drop) becomes a loud RhiError.code consumers can switch on.
//   - P4 consistent abstraction: classification lives once in Rust (M3); the
//     shim only routes by prefix — no duplicated classification logic.

import type { CommandBuffer, RhiError, RhiErrorCode } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';

import { makeRhiQueue, type RawQueueLike } from '../queue';

// Exhaustive recovery hint per RhiErrorCode. The `switch (code)` has NO
// `default` branch: TS enforces completeness, so adding a new RhiErrorCode
// member would fail compilation here (AC-05 — exhaustive narrowing is a real
// compile-time gate, not an isolated `expectTypeOf`).
function recoveryHint(code: RhiErrorCode): string {
  switch (code) {
    case 'queue-submit-failed':
      return 'fix the bad command data and submit next frame';
    case 'webgpu-runtime-error':
      return 're-create the device';
    case 'adapter-unavailable':
    case 'feature-not-enabled':
    case 'limit-exceeded':
    case 'shader-compile-failed':
    case 'rhi-not-available':
    case 'command-encoder-finished':
    case 'render-pass-not-ended':
    case 'queue-write-buffer-out-of-bounds':
    case 'render-system-no-camera':
    case 'render-system-multi-camera':
    case 'render-system-multi-light':
    case 'asset-not-registered':
    case 'device-lost':
    case 'oom':
    case 'internal-error':
    case 'hierarchy-broken':
    case 'destroy-after-destroy':
    case 'rhi-descriptor-invalid':
    case 'instancing-exceeds-uniform-cap':
    case 'render-system-empty-worlds':
    case 'render-system-owner-out-of-range':
    case 'rhi-texture-format-capability-unavailable':
      return 'inspect RhiError.expected / .hint';
  }
}

/**
 * Fake wgpu-wasm queue handle. The first `failTimes` submit() calls throw the
 * given marker string (simulating the rhi.rs `#[wasm_bindgen(catch)]` Err);
 * subsequent calls succeed — modelling AC-06 (the queue instance stays alive
 * and the next frame's submit proceeds normally).
 */
function makeFakeRawQueue(
  marker: string,
  failTimes: number,
): {
  raw: RawQueueLike;
  submitCount: () => number;
} {
  let calls = 0;
  const raw: RawQueueLike = {
    submit(_buffers: readonly unknown[]): void {
      calls += 1;
      if (calls <= failTimes) {
        throw new Error(marker);
      }
    },
  };
  return { raw, submitCount: () => calls };
}

const NO_BUFFERS: readonly CommandBuffer[] = [];

describe('submit-error-fanout.browser - WS2 submit failure fans out as structured RhiError (m4-1)', () => {
  it('queue-submit-failed marker -> RhiError.code === queue-submit-failed (AC-05)', () => {
    const { raw } = makeFakeRawQueue(
      '[rhi-code:queue-submit-failed] Validation { description: "bad bind group" }',
      1,
    );
    const queue = makeRhiQueue(raw);

    const result = queue.submit(NO_BUFFERS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error: RhiError = result.error;
    expect(error.code).toBe('queue-submit-failed');
    // Exhaustive switch narrows on the live error code (not a type-only check).
    expect(recoveryHint(error.code)).toBe('fix the bad command data and submit next frame');
    // The underlying GPU message reaches the hint for AI-user triage.
    expect(error.hint).toContain('bad bind group');
  });

  it('webgpu-runtime-error marker -> RhiError.code === webgpu-runtime-error', () => {
    const { raw } = makeFakeRawQueue(
      '[rhi-code:webgpu-runtime-error] OutOfMemory { source: ... }',
      1,
    );
    const queue = makeRhiQueue(raw);

    const result = queue.submit(NO_BUFFERS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('webgpu-runtime-error');
  });

  it('non-marker exception falls through to webgpu-runtime-error (no swallow)', () => {
    const { raw } = makeFakeRawQueue('memory access out of bounds', 1);
    const queue = makeRhiQueue(raw);

    const result = queue.submit(NO_BUFFERS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('webgpu-runtime-error');
  });

  it('instance survives a failed submit; the next submit succeeds (AC-06)', () => {
    const { raw, submitCount } = makeFakeRawQueue(
      '[rhi-code:queue-submit-failed] Validation { description: "transient" }',
      1,
    );
    const queue = makeRhiQueue(raw);

    const first = queue.submit(NO_BUFFERS);
    expect(first.ok).toBe(false);

    // Same instance — no re-creation. AC-06: a bad submit must not wedge the
    // queue; the next frame proceeds.
    const second = queue.submit(NO_BUFFERS);
    expect(second.ok).toBe(true);
    expect(submitCount()).toBe(2);
  });

  it('two consecutive bad submits each surface a structured error (R-6)', () => {
    const { raw } = makeFakeRawQueue(
      '[rhi-code:queue-submit-failed] Validation { description: "again" }',
      2,
    );
    const queue = makeRhiQueue(raw);

    const first = queue.submit(NO_BUFFERS);
    const second = queue.submit(NO_BUFFERS);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) return;
    expect(first.error.code).toBe('queue-submit-failed');
    expect(second.error.code).toBe('queue-submit-failed');
  });
});
