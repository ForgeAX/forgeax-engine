import { CheckList, defineFeature } from '../../lab/feature';
import { bootWebgl2App, submittedFrames } from './support/webgl2-app';

export default defineFeature({
  title: 'WebGL2 downlevel lane',
  catalog: 'WebGL2 downlevel lane',
  kind: 'probe',
  summary:
    "Without WebGPU, rhi-wgpu runs the restricted 'wgpu-webgl2' path. A second App on that lane (bottom-right inset) keeps rendering while its caps honestly report the missing compute/storage features.",
  expect:
    "All checks pass: the inset App runs on 'wgpu-webgl2', caps.compute / storageBuffer / timestampQuery are false, the GPU Scene reports 'unsupported' instead of a fake table, and frames keep submitting with the main lane on the CPU path.",
  async setup({ hud }) {
    const booted = await bootWebgl2App();
    hud.status(booted.ok ? 'inset App on wgpu-webgl2' : `boot failed: ${booted.reason}`);
    return {
      async checks() {
        const checks = new CheckList();
        checks.ok('App boots on rhi-wgpu', booted.ok, booted.ok ? undefined : booted.reason);
        if (!booted.ok) return checks.items;
        const frames = await submittedFrames(booted.app, 10);
        checks.ok('frames keep submitting', frames >= 10, `frames=${frames}`);
        const inspection = booted.app.renderer.inspect();
        const caps = inspection.capabilities;
        checks.equal('backendKind', caps.backendKind, 'wgpu-webgl2');
        checks.equal('caps.compute', caps.compute, false);
        checks.equal('caps.storageBuffer', caps.storageBuffer, false);
        checks.equal('caps.timestampQuery', caps.timestampQuery, false);
        checks.ok(
          'caps.maxColorAttachments reported',
          caps.maxColorAttachments > 0,
          String(caps.maxColorAttachments),
        );
        const gpu = inspection.renderScene.gpu;
        checks.equal('GPU Scene status', gpu.status, 'unsupported');
        const channels = inspection.renderScene.gpuDriven?.channels ?? [];
        checks.ok(
          'no channel claims the GPU lane',
          channels.every((channel) => channel.lane !== 'gpu'),
          JSON.stringify(
            channels.map((channel) => ({ lane: channel.lane, reason: channel.reason })),
          ),
        );
        return checks.items;
      },
    };
  },
});
