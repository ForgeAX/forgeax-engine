// Job-level preload for native Dawn entry points. The shared adapter prototype
// patch is installed before any smoke/test module imports webgpu, so custom
// scripts and the renderer-owned RHI path receive the same normalization as
// config/vitest.setup-webgpu.ts. Missing webgpu is expected during setup actions and
// before dependency hydration; those processes continue without a patch.
import { patchDawnAdapterPrototype } from './normalize-dawn-device-limits.mjs';

try {
  const { globals } = await import('@forgeax/engine-dawn-node');
  const patched = patchDawnAdapterPrototype(globals);
  if (!patched) {
    throw new Error(
      '[dawn-device-limits] webgpu does not expose a patchable GPUAdapter.requestDevice entry',
    );
  }
  if (process.env.FORGEAX_DAWN_DEVICE_LIMITS_DEBUG === '1') {
    console.error('[dawn-device-limits] adapter requestDevice preload installed');
  }
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') process.exitCode = 0;
  else throw error;
}
