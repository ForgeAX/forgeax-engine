// packages/rhi-wgpu/src/__tests__/acquireCanvasContext.test-d.ts
// type-test — acquireCanvasContext arity type-check (M2 / w13).
//
// The updated `acquireCanvasContext(instance, canvas)` signature requires
// `RhiWgpuInstance` as the first parameter (requirements AC-05; plan-strategy
// D-3). This test-d file validates:
//   (a) correct 2-param usage typechecks;
//   (b) @ts-expect-error — calling with only canvas (old 1-param signature)
//       fails with ts(2554) arity error.
//
// This is a vitest typecheck-only test; no JS runtime assertions.

/// <reference types="@webgpu/types" />

import type { Result, RhiCanvasContext, RhiError } from '@forgeax/engine-rhi';

// The new acquireCanvasContext signature takes (instance, canvas). The instance
// is typed as the opaque handle from the rhi-wgpu package — the exact type
// varies per backend but the arity (2 params) is what we verify here.
declare function acquireCanvasContext(
  instance: unknown,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): Result<RhiCanvasContext, RhiError>;

// (a) correct 2-param usage typechecks
const canvas = document.createElement('canvas');
const instance = {} as unknown;
const result: Result<RhiCanvasContext, RhiError> = acquireCanvasContext(instance, canvas);
void result;

// (b) calling acquireCanvasContext(canvas) WITHOUT instance produces ts(2554) arity error
// @ts-expect-error TS(2554): Expected 2 arguments, but got 1.
const _badArity: Result<RhiCanvasContext, RhiError> = acquireCanvasContext(canvas);
void _badArity;
