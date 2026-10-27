import { CheckList, defineFeature } from '../../lab/feature';
import { readBack, webgpuDevice } from './support/gpu';

export default defineFeature({
  title: 'Browser WebGPU backend',
  catalog: 'Browser WebGPU backend',
  kind: 'probe',
  summary:
    'rhi-webgpu is a thin shim over the browser GPUDevice: the lab App renders on it, and a standalone RHI device records, submits, and reads back real GPU work.',
  expect:
    "All checks pass: the lab renderer reports backendKind 'webgpu', a queue.writeBuffer -> copyBufferToBuffer -> mapAsync round trip returns the written words, and a second finish() is refused with 'command-encoder-finished'.",
  setup({ app }) {
    return {
      async checks() {
        const checks = new CheckList();
        checks.equal(
          'lab renderer backendKind',
          app.renderer.inspect().capabilities.backendKind,
          'webgpu',
        );
        const gpu = await webgpuDevice(checks);
        if (gpu === undefined) return checks.items;
        const { device } = gpu;
        checks.equal('standalone device caps.backendKind', device.caps.backendKind, 'webgpu');
        const pending = device.pipelineLibrary?.inspect().pending;
        checks.ok('native compilation inspection is available', pending !== undefined);
        checks.equal('new device has no unidentified compilations', pending?.unidentified, 0);
        checks.equal('new device has no pending pipelines', pending?.pipelines.length, 0);
        checks.ok(
          'ordinary inspection does not materialize runtime history',
          device.pipelineLibrary?.inspect().runtimeRequests === undefined,
        );
        const snapshot = device.pipelineLibrary?.inspect({ runtimeRequests: true });
        checks.equal(
          'history mode omits the hashing pending snapshot',
          snapshot?.pending,
          undefined,
        );
        const history = snapshot?.runtimeRequests;
        checks.equal('runtime history has a fixed capacity', history?.capacity, 32);
        checks.equal('new device has no runtime demands', history?.requests.length, 0);

        const src = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const dst = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        checks.ok('buffers created', src.ok && dst.ok);
        if (!src.ok || !dst.ok) return checks.items;
        checks.ok(
          'queue.writeBuffer ok',
          device.queue.writeBuffer(src.value, 0, new Uint32Array([7, 11, 13, 17])).ok,
        );
        const encoder = device.createCommandEncoder({ label: 'lab-webgpu-roundtrip' });
        if (!encoder.ok)
          return checks.ok('createCommandEncoder ok', false, encoder.error.code).items;
        encoder.value.copyBufferToBuffer(src.value, 0, dst.value, 0, 16);
        const finished = encoder.value.finish();
        checks.ok('finish ok', finished.ok);
        if (!finished.ok) return checks.items;
        checks.ok('queue.submit ok', device.queue.submit([finished.value]).ok);
        const bytes = await readBack(device, dst.value, 16);
        checks.equal(
          'GPU readback words',
          typeof bytes === 'string' ? bytes : Array.from(new Uint32Array(bytes)),
          [7, 11, 13, 17],
        );

        const again = encoder.value.finish();
        checks.equal(
          'second finish code',
          again.ok ? 'ok' : again.error.code,
          'command-encoder-finished',
        );
        device.destroyBuffer(src.value);
        device.destroyBuffer(dst.value);
        return checks.items;
      },
    };
  },
});
