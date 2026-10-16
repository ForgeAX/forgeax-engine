import { rhi } from '@forgeax/engine/rhi-wgpu';
import { CheckList, defineFeature } from '../../lab/feature';
import { bootWebgl2App, submittedFrames } from './support/webgl2-app';

export default defineFeature({
  title: 'wgpu WASM backend',
  catalog: 'wgpu WASM backend',
  kind: 'probe',
  summary:
    'rhi-wgpu implements the same RHI through the Rust wgpu+naga WASM substrate. The probe boots a second App on it (bottom-right inset) and drives a standalone device.',
  expect:
    "All checks pass: after ensureReady() the second App renders frames on backendKind 'wgpu-webgl2', a standalone rhi-wgpu device round-trips a buffer through the GPU, and a second finish() is refused with the same 'command-encoder-finished' code the WebGPU backend uses.",
  async setup({ hud }) {
    const booted = await bootWebgl2App();
    hud.status(
      booted.ok
        ? 'second App running on rhi-wgpu (inset)'
        : `rhi-wgpu boot failed: ${booted.reason}`,
    );
    return {
      async checks() {
        const checks = new CheckList();
        checks.ok(
          'App boots on rhi-wgpu after ensureReady()',
          booted.ok,
          booted.ok ? undefined : booted.reason,
        );
        if (!booted.ok) return checks.items;
        const frames = await submittedFrames(booted.app, 10);
        checks.ok('wgpu App submits frames', frames >= 10, `frames=${frames}`);
        checks.equal(
          'wgpu App backendKind',
          booted.app.renderer.inspect().capabilities.backendKind,
          'wgpu-webgl2',
        );

        // The wgpu GL backend enumerates adapters only against a WebGL2-capable surface.
        const surface = Object.assign(document.createElement('canvas'), { width: 4, height: 4 });
        const adapter = await rhi.requestAdapter(undefined, surface);
        checks.ok(
          'rhi-wgpu requestAdapter ok',
          adapter.ok,
          adapter.ok ? undefined : adapter.error.code,
        );
        if (!adapter.ok) return checks.items;
        const created = await adapter.value.requestDevice();
        checks.ok(
          'rhi-wgpu requestDevice ok',
          created.ok,
          created.ok ? undefined : created.error.code,
        );
        if (!created.ok) return checks.items;
        const device = created.value;
        const src = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        const dst = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        if (!src.ok || !dst.ok) return checks.ok('buffers created', false).items;
        device.queue.writeBuffer(src.value, 0, new Uint32Array([2, 4, 6, 8]));
        const encoder = device.createCommandEncoder({ label: 'lab-wgpu-roundtrip' });
        if (!encoder.ok)
          return checks.ok('createCommandEncoder ok', false, encoder.error.code).items;
        encoder.value.copyBufferToBuffer(src.value, 0, dst.value, 0, 16);
        const finished = encoder.value.finish();
        if (!finished.ok) return checks.ok('finish ok', false, finished.error.code).items;
        checks.ok('queue.submit ok', device.queue.submit([finished.value]).ok);
        await device.queue.onSubmittedWorkDone();
        const mapped = await dst.value.mapAsync(GPUMapMode.READ);
        if (mapped.ok) {
          const range = mapped.value.getMappedRange(0, 16);
          checks.equal(
            'wgpu readback words',
            range.ok ? Array.from(new Uint32Array(range.value.slice(0))) : range.error.code,
            [2, 4, 6, 8],
          );
          mapped.value.unmap();
        } else {
          checks.ok('mapAsync ok', false, mapped.error.code);
        }
        const again = encoder.value.finish();
        checks.equal(
          'second finish code (cross-backend parity)',
          again.ok ? 'ok' : again.error.code,
          'command-encoder-finished',
        );
        return checks.items;
      },
    };
  },
});
