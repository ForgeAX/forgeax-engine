import { RhiError } from '@forgeax/engine-rhi';

/** Native targets provide their initialized binding through the existing initFn seam. */
// forgeax-async-whitelist: wasm-bindgen — rejects the missing native initialization owner
export async function initializeWgpu(): Promise<never> {
  throw new RhiError({
    code: 'rhi-not-available',
    expected: 'the native wgpu namespace initialized by its explicit Host',
    hint: 'Call ensureReady({ initFn }) with the native Host initializer before requesting an adapter.',
  });
}
