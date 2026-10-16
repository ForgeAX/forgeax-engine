/** Default browser/Node route retains the single wgpu-wasm initialization owner. */
// forgeax-async-whitelist: wasm-bindgen — delegates to the canonical WASM owner
export async function initializeWgpu(): Promise<unknown> {
  const module = await import('@forgeax/engine-wgpu-wasm');
  return module.ensureReady();
}
