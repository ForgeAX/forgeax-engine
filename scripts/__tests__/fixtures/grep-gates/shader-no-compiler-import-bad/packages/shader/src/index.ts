// Violation fixture: @forgeax/engine-shader runtime package must not import
// @forgeax/engine-wgpu-wasm (build-core). check-shader-no-compiler-import.mjs
// should exit 1.
import { ensureReady } from '@forgeax/engine-wgpu-wasm';

export const init = async () => ensureReady();
