import { Worker } from 'node:worker_threads';
import { defineFeature } from '../../lab/feature';

interface Probe {
  readonly profile: string;
  readonly expectedProfile: string;
  readonly backend: string;
  readonly submitted: boolean;
  readonly mapped: readonly number[];
  readonly refused: boolean;
}

export default defineFeature({
  title: 'WebGPU CPU diagnostics',
  catalog: 'WebGPU CPU diagnostics',
  kind: 'headless',
  summary:
    'An isolated Node Worker installs the diagnostic GPU before selecting the ordinary WebGPU RHI. The Lab runner and every real browser GPU remain untouched.',
  expect:
    'Checks pass: the captured profile is installed, the normal webgpu backend submits without GPU work, mapped bytes are zero-filled, and unsupported adapter features are refused. This is CPU-path evidence, never pixels, GPU timing or FPS.',
  async run(checks) {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const rhi = await import(workerData);
        rhi.installWebGpuStub(rhi.DEFAULT_WEBGPU_STUB_PROFILE);
        const adapter = (await rhi.requestAdapter()).unwrap();
        const device = (await adapter.requestDevice()).unwrap();
        const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }).unwrap();
        let result;
        try {
          const encoder = device.createCommandEncoder().unwrap();
          encoder.beginComputePass().end();
          const submitted = device.queue.submit([encoder.finish().unwrap()]).ok;
          const mapped = (await buffer.mapAsync(GPUMapMode.READ)).unwrap();
          let refused = false;
          const nativeAdapter = await navigator.gpu.requestAdapter();
          try { await nativeAdapter.requestDevice({ requiredFeatures: ['unsupported-feature'] }); }
          catch { refused = true; }
          result = { profile: rhi.installedWebGpuStub(), expectedProfile: rhi.DEFAULT_WEBGPU_STUB_PROFILE.name,
            backend: device.caps.backendKind, submitted, mapped: [...new Uint8Array(mapped.getMappedRange().unwrap())], refused };
          mapped.unmap();
        } finally {
          device.destroyBuffer(buffer).unwrap();
          rhi.disposeDevice(device);
        }
        parentPort.postMessage(result);
        parentPort.close();
      })().catch(error => { throw error; });
    `,
      { eval: true, workerData: import.meta.resolve('@forgeax/engine/rhi-webgpu') },
    );
    try {
      const result = await new Promise<Probe>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Diagnostic Worker exceeded 15 seconds')),
          15_000,
        );
        worker.once('message', (value: Probe) => {
          clearTimeout(timer);
          resolve(value);
        });
        worker.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Diagnostic Worker exited before its result (${code})`));
        });
      });
      checks.equal(
        'profile is installed before adapter selection',
        result.profile,
        result.expectedProfile,
      );
      checks.equal('ordinary backend identity is retained', result.backend, 'webgpu');
      checks.equal('ordinary queue accepts submission', result.submitted, true);
      checks.equal('mapped bytes are zero-filled', result.mapped, new Array(16).fill(0));
      checks.equal('unsupported feature is refused', result.refused, true);
    } finally {
      await worker.terminate();
    }
  },
});
