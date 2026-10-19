import { initializeWgpu as defaultInitFn } from '@forgeax/engine-rhi-wgpu/wasm-runtime';

/** Browser builds select the shared wgpu loader; native Hosts inject their initializer. */
export interface EnsureRhiWgpuReadyOptions {
  // forgeax-async-whitelist: wasm-bindgen — native Host or browser WASM initialization
  readonly initFn?: () => Promise<unknown>;
}

// forgeax-async-whitelist: wasm-bindgen — pending and settled initialization share one Promise
let cachedPromise: Promise<unknown> | null = null;

/** Initializes once, shares the same Promise, and clears failed attempts for retry. */
export function ensureRhiWgpuReady(
  options: EnsureRhiWgpuReadyOptions = {},
  // forgeax-async-whitelist: wasm-bindgen — cached WASM namespace initialization
): Promise<unknown> {
  // Stay synchronous so callers receive the cached Promise itself.
  cachedPromise ??= Promise.resolve()
    .then(options.initFn ?? defaultInitFn)
    .catch((cause: unknown) => {
      cachedPromise = null;
      throw cause;
    });
  return cachedPromise;
}

/** Internal test seam. */
export function __resetForTests(): void {
  cachedPromise = null;
}
