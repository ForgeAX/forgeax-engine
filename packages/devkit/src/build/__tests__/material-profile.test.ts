import { expect, it } from 'vitest';
import { materialBuildCapabilityGuard } from '../material-profile.js';

it('requires actual WebGPU compute/storage facts in both local and Render Worker startup', async () => {
  expect(materialBuildCapabilityGuard(undefined)).toBe('');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const run = new AsyncFunction(
    'app',
    'workerExecution',
    materialBuildCapabilityGuard('webgpu-storage'),
  );
  for (const worker of [false, true]) {
    for (const capabilities of [
      undefined,
      { backendKind: 'null', compute: true, storageBuffer: true },
      { backendKind: 'wgpu-webgl2', compute: false, storageBuffer: false },
      { backendKind: 'webgpu', compute: false, storageBuffer: true },
      { backendKind: 'webgpu', compute: true, storageBuffer: false },
    ]) {
      const app = {
        renderer: { inspect: () => ({ capabilities }) },
        remoteEval: async () => capabilities,
      };
      await expect(run(app, worker)).rejects.toThrow(/requires actual WebGPU compute\/storage/);
    }
    const capabilities = { backendKind: 'webgpu', compute: true, storageBuffer: true };
    const app = {
      renderer: { inspect: () => ({ capabilities }) },
      remoteEval: async () => capabilities,
    };
    await expect(run(app, worker)).resolves.toBeUndefined();
  }
});
