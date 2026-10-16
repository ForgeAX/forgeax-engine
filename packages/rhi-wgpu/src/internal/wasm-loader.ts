// packages/rhi-wgpu/src/internal/wasm-loader.ts — wgpu-wasm SSOT lazy-init
// wrapper (feat-20260511-naga-rhi-wgpu-merge M3 / w9). Before this loop the
// rhi-wgpu package shipped its own wasm-pack output at `packages/rhi-wgpu/pkg/`
// and the default factory dynamic-imported that local pkg; from M3 onward the
// merged wgpu 30 + naga 30 wasm bundle lives at `@forgeax/engine-wgpu-wasm` and is
// shared with `@forgeax/engine-naga` (D-P1 / D-P3 / D-P4). The default factory now
// dynamic-imports `@forgeax/engine-wgpu-wasm` and forwards to its `ensureReady` —
// research F-5 single ensureReady SSOT, charter proposition 5 consistent
// abstraction red line (rhi-wgpu remains the TS-only thin shell over wgpu-wasm
// raw bindings).
//
// Shape contract (unchanged from w13 / w52 — the public surface is preserved
// byte-for-byte so AI users and the engine auto-select facade need 0 changes):
//   - `ensureRhiWgpuReady({initFn?})` memoises a Promise around the underlying
//     init factory (research R-04 default export form). First call invokes
//     the factory; subsequent calls share the cached Promise so the
//     first-paint wasm fetch cost is paid once.
//   - On init rejection the cached Promise is dropped before propagating the
//     rejection — research R-04 contract: init() reject is the only failure
//     channel; the caller may retry by simply calling `ensureRhiWgpuReady`
//     again.
//   - `getRhiWgpuModule()` is the synchronous accessor; returns `undefined`
//     before `ensureRhiWgpuReady` has settled successfully (charter
//     proposition 4 explicit-failure baseline: do not throw).
//   - `__resetForTests()` clears module-level state. The hook is intentionally
//     prefixed `__` so it is grep-able as an internal API; unit tests consume
//     it via the `internal/wasm-loader` path.
//
// Default factory (M3 / w9 SSOT switch — engine `createRenderer.ts` channel 3
// calls `mod.ensureReady()` with no args, AI users likewise consume
// `await ensureReady()` directly so the default factory must resolve the real
// wasm bundle):
//
//   const mod = await import('@forgeax/engine-wgpu-wasm');
//   return mod.ensureReady();
//
// `@forgeax/engine-wgpu-wasm` owns the single wasm bundle (`pkg/wgpu_wasm_bg.wasm`,
// 0.51 MB gzip per the merged baseline at .forgeax-harness/.../bundle-size-baseline.json).
// Its `ensureReady` resolves to the wasm namespace; rhi-wgpu's own memoisation
// caches that namespace reference so the public `ensureRhiWgpuReady()` Promise
// stays semantically identical to the pre-M3 form.
//
// Browser callers can use the no-arg form forwarding to the canonical owner.
// Native builds require the existing `initFn` seam and cannot include that
// browser loader; both conditions retain this one module cache.
//
// Reverse-coupling guard: rhi-wgpu MUST NOT import @forgeax/engine-naga (the other
// wgpu-wasm consumer). This is enforced by the M4 grep gate
// `scripts/check-shader-no-compiler-import.mjs` (concern D-P6 + AC-05).
//
// Anchors: plan-strategy §6 M3 + §2 D-P1 / D-P3 / D-P4 + research F-4 / F-5
//          single ensureReady SSOT + R-04 init() Promise contract.

import { initializeWgpu as defaultInitFn } from '@forgeax/engine-rhi-wgpu/wasm-runtime';

/**
 * The init factory shape — matches the wasm-pack `--target web` default
 * export signature when called with the bound `wasmUrl` argument. The factory
 * returns a Promise resolving to the wasm module's exports namespace.
 *
 * The generic `T` lets the rhi-wgpu wasm bindings (w11 lib.rs) and the unit
 * test fake module share this shape without leaking the wasm-pack-generated
 * `InitOutput` type into the public API surface.
 */
// forgeax-async-whitelist: wasm-bindgen — wasm-pack `__wbg_init` factory Promise
export type InitFn<T = unknown> = () => Promise<T>;

/**
 * Options for `ensureRhiWgpuReady`. The `initFn` injection seam supports
 * native Hosts and tests. The default browser condition forwards to
 * `@forgeax/engine-wgpu-wasm.ensureReady`; native builds require this initializer.
 */
export interface EnsureRhiWgpuReadyOptions<T = unknown> {
  /**
   * Optional init factory override. If omitted, the default factory is used
   * (M3 / w9 SSOT switch): dynamic-imports `@forgeax/engine-wgpu-wasm` and calls its
   * `ensureReady` export with no args, which resolves the merged wgpu 30 +
   * naga 30 wasm bundle via the wgpu-wasm package's three-scenario asset
   * resolution (browser ?url / Node fs.readFile / vitest), see
   * packages/wgpu-wasm/src/index.ts (research F-4 single ensureReady SSOT).
   *
   * The seam is required by the forgeax-native condition and by tests that mock the init Promise
   * without requiring the wgpu-wasm wasm bundle to exist at vitest
   * collection time. Default browser callers use the no-arg form.
   */
  readonly initFn?: InitFn<T>;
}

// forgeax-async-whitelist: wasm-bindgen — cached `__wbg_init` Promise memoisation
let cachedPromise: Promise<unknown> | null = null;
let cachedModule: unknown | undefined;

/**
 * The default init factory (M3 / w9 SSOT switch): dynamic-imports
 * `@forgeax/engine-wgpu-wasm` and forwards to its `ensureReady` export. The wgpu-wasm
 * package owns the single merged wasm bundle (charter proposition 3 SSOT —
 * one wasm boundary per page lifecycle regardless of how many thin shells
 * consume it; research F-5).
 *
 * Charter proposition 5 consistent abstraction: the engine
 * `createRenderer.ts` channel 3 calls `mod.ensureReady()` with no args, and
 * AI users likewise consume `await ensureReady()` directly without supplying
 * an init factory — the rhi-wgpu auto-select path mirrors the rhi-webgpu
 * dynamic-import path's "no manual wiring" UX (charter proposition 1
 * progressive disclosure).
 *
 * Failure path: when the wasm bundle is missing / network fails / wasm
 * instantiate rejects, the underlying `@forgeax/engine-wgpu-wasm.ensureReady`
 * Promise rejects with an Error; that rejection propagates up through
 * `ensureRhiWgpuReady` and is caught by `createRenderer.ts` loadBackendPack
 * channel 3's outer try/catch, which wraps the cause into a structured
 * `RhiError({ code: 'rhi-not-available' })` (charter proposition 4 explicit
 * failure + AGENTS.md "Errors are structured").
 */
// The package condition selects only the default factory, not another cache.
// Native builds retain the ordinary initFn and module-adoption path without a
// reachable dependency on the browser WASM loader or its downloadable binary.

/**
 * Lazy-initialise the rhi-wgpu wasm module. Subsequent calls reuse the
 * cached Promise so the wasm fetch + instantiate cost is paid once
 * (charter proposition 1 progressive disclosure: first-paint stays cheap).
 *
 * On rejection, the cache is cleared so callers may retry (R-04 contract).
 *
 * Returns the wasm module's exports namespace. Callers should not rely on
 * the concrete `unknown` shape — they go through the
 * `getRhiWgpuModule()` accessor after settle (or accept the Promise's
 * resolution value), and then type-narrow at the consumption site.
 */
export function ensureRhiWgpuReady<T = unknown>(
  options: EnsureRhiWgpuReadyOptions<T> = {},
  // forgeax-async-whitelist: wasm-bindgen — `ensureRhiWgpuReady` factory return
): Promise<T> {
  // Synchronous body (NOT `async fn`) — the memoisation contract requires
  // that two calls in flight return the *same* Promise object (`p1 === p2`
  // via `Object.is`). An `async fn` would wrap every call in a fresh outer
  // Promise, breaking that identity even when the inner cached Promise is
  // identical. The unit test (w12 case b) asserts on identity, so the
  // function body stays synchronous and returns the cached Promise directly.
  if (cachedPromise !== null) {
    // forgeax-async-whitelist: wasm-bindgen — memoised cached init Promise
    return cachedPromise as Promise<T>;
  }
  const initFn = (options.initFn ?? defaultInitFn) as InitFn<T>;
  // forgeax-async-whitelist: wasm-bindgen — init factory invocation Promise
  const p: Promise<T> = initFn().then(
    (mod) => {
      cachedModule = mod;
      return mod;
    },
    (err: unknown): never => {
      // R-04 retry contract — drop the cached Promise before rethrowing so
      // the next `ensureRhiWgpuReady` invocation triggers init again.
      cachedPromise = null;
      cachedModule = undefined;
      throw err;
    },
  );
  // forgeax-async-whitelist: wasm-bindgen — write-through cache assignment
  cachedPromise = p as Promise<unknown>;
  return p;
}

/**
 * Synchronous accessor for the resolved module. Returns `undefined` before
 * `ensureRhiWgpuReady` has settled successfully (charter proposition 4
 * explicit-failure baseline: do not throw).
 *
 * Typical pattern (consumption site):
 *   await ensureRhiWgpuReady();
 *   const mod = getRhiWgpuModule();
 *   if (mod === undefined) { /* unreachable after a successful ensure ... *\/ }
 */
export function getRhiWgpuModule<T = unknown>(): T | undefined {
  return cachedModule as T | undefined;
}

/**
 * Reset module-level cache (test seam, w12). The `__` prefix marks the
 * symbol as internal-only; production callers go through
 * `ensureRhiWgpuReady` + `getRhiWgpuModule`.
 */
export function __resetForTests(): void {
  cachedPromise = null;
  cachedModule = undefined;
}
