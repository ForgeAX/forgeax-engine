// webgpu-backend.dawn.test.ts -- vitest dawn project (AC-06) real-GPU command
// recording.
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: node + setupFiles ./vitest.setup-webgpu.ts injects
//   globalThis.navigator.gpu (provided by dawn.node native binding, not
//   chromium).
//
// w9 refactor (feat-20260508-rhi-surface-completion / AC-RSC-04 / AC-RSC-06):
//   the recording chain end-to-end runs through the RHI surface:
//   rhi.requestAdapter -> adapter.requestDevice -> device.createCommandEncoder
//   -> encoder.beginRenderPass -> pass.setPipeline + pass.draw + pass.end ->
//   encoder.finish -> device.queue.submit. The recording path goes through
//   the RHI surface end-to-end with no escape-hatch device reverse-lookup
//   (charter proposition 5 consistent abstraction red line).
//
// w43 (feat-20260510-rhi-resource-creation, M6): migrated the requestDevice
// entry to the strict two-step `rhi.requestAdapter()` -> `adapter.requestDevice()`
// path (break-point #2) and replaced the raw createView() cast with the
// spec idiom `device.createTextureView(tex, {})` (K-4 view-narrow).
//
// Test focus: command recording + queue.submit; no canvas DOM dependency
// (research 1.4 dawn.node lacks HTMLCanvasElement / VideoFrame). Texture /
// TextureView use RHI `device.createTexture` + `device.createTextureView`.
//
// F-1 / D-P2 revision -- skipIf reason as a structured literal:
//   `it.skipIf(cond)('<reason-literal> -- ...', fn)` puts the reason literal
//   as a test-name prefix (vitest reporter prints it directly); the
//   `*.dawn.test.ts` grep checks the second skipIf curried argument is non-
//   empty.
//
// F-2 / D-P3 revision -- silent-pass machine gate:
//   on the normal path the condition must be false (no skip pass-through;
//   charter proposition 4 silent-pass explicit-failure floor: fail-fast
//   machine gate `pnpm test:dawn -- --reporter=json |
//   jq '...skipped...length'` == 0). skipIf is reserved for the
//   dawn-adapter-unavailable class of extreme environments (not a fail-fast
//   safety net).

import { rhi, createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';

describe('webgpu-backend.dawn - RHI surface command recording + queue.submit end-to-end (AC-06 / AC-RSC-06)', () => {
  // pre-check: did the dawn.node binding inject globalThis.navigator.gpu
  // successfully (provided by vitest.setup-webgpu.ts)? If the setup file
  // fails, vitest already throws structured (code: 'dawn-binding-failed');
  // this assertion only safeguards the navigator reference layer.
  const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

  it.skipIf(!dawnReady)(
    "'dawn-binding-missing' -- dawn.node binding injection failed (setup-webgpu.ts already throws structured as a safety net)",
    () => {
      // On the normal path this `it` is not skipped -- dawnReady === true
      // (the setup file's injection succeeded). The failure path throws in
      // the setup file (code: 'dawn-binding-failed') and never reaches here.
      expect(dawnReady).toBe(true);
    },
  );

  it('rhi.requestAdapter -> adapter.requestDevice -> device.createCommandEncoder -> encoder.beginRenderPass -> pass.draw -> encoder.finish -> device.queue.submit end-to-end', async () => {
    // (a) Strict two-step requestAdapter -> requestDevice (break-point #2 /
    // K-5 + K-6); driven by globalThis.navigator.gpu (dawn.node).
    const adapterResult = await rhi.requestAdapter();
    expect(adapterResult.ok).toBe(true);
    if (!adapterResult.ok) return;
    const deviceResult = await adapterResult.value.requestDevice();
    expect(deviceResult.ok).toBe(true);
    if (!deviceResult.ok) return;
    const device = deviceResult.value;

    // (b) Create the offscreen render target through RHI device.createTexture
    // returning an opaque Texture handle. dawn.node lacks HTMLCanvasElement,
    // so this offscreen render target replaces the canvas context (research
    // 1.4 dawn.node real-GPU pattern).
    const textureResult = device.createTexture({
      label: 'dawn-render-target',
      size: { width: 64, height: 64, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    expect(textureResult.ok).toBe(true);
    if (!textureResult.ok) return;
    const renderTarget = textureResult.value;
    // (c2) Texture view through the RHI surface (M2 view-narrow: K-4 spec
    // idiom `device.createTextureView(tex, {})`).
    const viewResult = device.createTextureView(renderTarget, {});
    expect(viewResult.ok).toBe(true);
    if (!viewResult.ok) return;
    const view = viewResult.value;

    // (c) shader module - call the top-level async createShaderModule entry
    // (the shader-compile-failed path forwards every field of
    // GPUCompilationInfo.messages).
    const shaderResult = await createShaderModule(device, {
      code: `
@vertex
fn vs(@builtin(vertex_index) idx: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>( 0.0,  0.5),
    vec2<f32>(-0.5, -0.5),
    vec2<f32>( 0.5, -0.5),
  );
  return vec4<f32>(pos[idx], 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.5, 0.0, 1.0);
}
`,
    });
    expect(shaderResult.ok).toBe(true);
    if (!shaderResult.ok) return;
    const shaderModule = shaderResult.value;

    // (d) render pipeline through RHI device.createRenderPipeline.
    const pipelineResult = device.createRenderPipeline({
      label: 'dawn-pipeline',
      layout: 'auto',
      vertex: {
        module: shaderModule as unknown as GPUShaderModule,
        entryPoint: 'vs',
      } as unknown as GPUVertexState,
      fragment: {
        module: shaderModule as unknown as GPUShaderModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      } as unknown as GPUFragmentState,
      primitive: { topology: 'triangle-list' },
      depthStencil: undefined,
      multisample: undefined,
    });
    expect(pipelineResult.ok).toBe(true);
    if (!pipelineResult.ok) return;
    const pipeline = pipelineResult.value;

    // (e) Command recording through the M1 RHI surface
    // (device.createCommandEncoder / encoder.beginRenderPass / pass.* /
    // encoder.finish). Each step uses Result.ok guards (charter proposition
    // 4 explicit failure + AGENTS.md "Errors are structured").
    const encoderResult = device.createCommandEncoder({ label: 'dawn-frame' });
    expect(encoderResult.ok).toBe(true);
    if (!encoderResult.ok) return;
    const encoder = encoderResult.value;

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: view as never,
          clearValue: { r: 0.06, g: 0.06, b: 0.08, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    } as never);
    pass.setPipeline(pipeline);
    pass.draw(3, 1, 0, 0); // 3 vertex / 1 instance — hello-triangle.
    pass.end();

    const finishResult = encoder.finish();
    expect(finishResult.ok).toBe(true);
    if (!finishResult.ok) return;
    const commandBuffer = finishResult.value;
    expect(commandBuffer).toBeDefined();

    // (f) queue.submit through RHI device.queue.submit; Result.ok signals
    // the full record + submit chain succeeded (charter proposition 4
    // explicit failure: failure paths come back through Result.err).
    const submitResult = device.queue.submit([commandBuffer]);
    expect(submitResult.ok).toBe(true);
  });
});
