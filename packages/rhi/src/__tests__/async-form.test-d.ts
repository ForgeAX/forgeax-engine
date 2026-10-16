// Type-level — async function form contract: all forgeax async RHI functions
// return `Promise<Result<T, E>>` (never `Promise<T>` that rejects).
//
// Introduced in feat-20260511-rhi-spec-realign-aggressive w5 (red) -> w11 +
// w26 + w29 (green) per requirements AC-12 + plan-strategy D-P9 + §7.2
// whitelist comment.
//
// Three whitelist categories permitted to keep `Promise<T>` shape:
//   (a) wasm-bindgen bridge — output of wasm-pack JS shim that we cannot
//       restructure at the type layer (wasm-loader.ts edge);
//   (b) DOM native Promise passthrough — e.g. `device.lost` Promise re-exposed
//       verbatim from `GPUDevice.lost`;
//   (c) render-loop frame internal — non-fallible drivers (requestAnimationFrame
//       wrappers) whose only outcome is a tick.
//
// Each whitelist exemption must be tagged with `// forgeax-async-whitelist:
// <category>` near the signature site; the grep gate
// (scripts/check-async-form.mjs) asserts the count of `Promise<` not followed
// by `Result` equals the count of whitelist comments.
//
// charter mapping: proposition 4 (Promise never rejects — failure rides
// Result.err) + proposition 5 (one async idiom, discoverable exceptions).

import { describe, expectTypeOf, it } from 'vitest';
import type { Buffer, Result, RhiAdapter, RhiError, RhiInstance } from '../index';

describe('async function form — Promise<Result<T, E>>', () => {
  it('RhiInstance.requestAdapter returns Promise<Result<RhiAdapter, RhiError>>', () => {
    type T = ReturnType<RhiInstance['requestAdapter']>;
    expectTypeOf<T>().toMatchTypeOf<Promise<Result<RhiAdapter, RhiError>>>();
  });

  it('Buffer.mapAsync returns Promise<Result<MappedBuffer, RhiError>>', () => {
    type T = ReturnType<Buffer['mapAsync']>;
    // After w10 the success branch is MappedBuffer; here we only assert the
    // outer Promise<Result<*, RhiError>> shape (charter proposition 4 single
    // axis).
    expectTypeOf<T>().toMatchTypeOf<Promise<Result<unknown, RhiError>>>();
  });
});
