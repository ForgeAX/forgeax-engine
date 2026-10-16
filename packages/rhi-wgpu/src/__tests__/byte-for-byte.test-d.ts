// packages/rhi-wgpu/src/__tests__/byte-for-byte.test-d.ts — call-site
// byte-for-byte type-layer assertion (feat-20260511-naga-rhi-wgpu-merge M3
// w9, plan-tasks.json acceptanceCheck).
//
// The thin-shell refactor (M3) routes rhi-wgpu's wasm bundle through
// `@forgeax/engine-wgpu-wasm` instead of a local wasm-pack output. AI users must NOT
// observe any signature change at the call sites — D-P4 / AC-02 / charter
// proposition 5 consistent abstraction red line.
//
// This file is a TS type-check-only test (vitest typecheck:enabled) — it
// never runs at the JS layer. The `surface-mirror.test-d.ts` file already
// covers the full 46-name surface; this file zooms in on the four call-site
// shapes AI users hit on day one:
//   1. `rhi.requestAdapter()`               -> Promise<Result<RhiAdapter, RhiError>>
//   2. `adapter.requestDevice()`            -> Promise<Result<RhiDevice, RhiError>>
//   3. `rhi.acquireCanvasContext(canvas)`    -> Result<RhiCanvasContext, RhiError>
//   4. `ensureReady()`                      -> Promise<unknown>
//
// If any of these signatures drifts during the SSOT switch, this test-d
// fails with a TS2322 / TS2345 at the offending line — the failure mode is
// debuggable through the line-precise error rather than a vague runtime
// regression (charter proposition 4 explicit failure + AGENTS.md "Errors
// are structured").
//
// Anchors: plan-tasks.json w9 acceptanceCheck + plan-strategy D-P4 + AC-02
//          + charter proposition 5 red line.

/// <reference types="@webgpu/types" />

import type {
  Result,
  RhiAdapter,
  RhiCanvasContext,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { expectTypeOf, test } from 'vitest';
import { ensureReady, rhi } from '../index';

test('rhi.requestAdapter signature is byte-for-byte aligned with @forgeax/engine-rhi', () => {
  expectTypeOf(rhi.requestAdapter).returns.toEqualTypeOf<Promise<Result<RhiAdapter, RhiError>>>();
});

test('adapter.requestDevice signature is byte-for-byte aligned (typeof RhiAdapter.requestDevice)', () => {
  type AdapterT = RhiAdapter;
  expectTypeOf<AdapterT['requestDevice']>().returns.toEqualTypeOf<
    Promise<Result<RhiDevice, RhiError>>
  >();
});

test('rhi.acquireCanvasContext signature returns Result<RhiCanvasContext, RhiError>', () => {
  expectTypeOf(rhi.acquireCanvasContext).returns.toEqualTypeOf<
    Result<RhiCanvasContext, RhiError>
  >();
});

test('ensureReady is a no-arg-callable Promise factory (default form, M3 / w9 SSOT switch)', () => {
  // M3 / w9: the no-arg ensureReady forwards to @forgeax/engine-wgpu-wasm.ensureReady;
  // the public Promise signature stays unchanged so AI users call sites do
  // not need any edit (charter proposition 5 consistent abstraction). The
  // function carries a single optional `options` parameter (defaults to
  // `{}` so the no-arg form `await ensureReady()` is valid — both the
  // engine `createRenderer.ts` channel 3 + apps consume the no-arg form).
  expectTypeOf(ensureReady).toBeFunction();
  // Calling with no args must type-check (compile-time assertion that the
  // first parameter is optional in the surface).
  const probe = (): Promise<unknown> => ensureReady();
  expectTypeOf(probe).returns.toMatchTypeOf<Promise<unknown>>();
});
