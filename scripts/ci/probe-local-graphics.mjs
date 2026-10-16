#!/usr/bin/env node
import { createServer } from 'node:http';
import { teardownDawnInstance } from '../lib/dawn-teardown.mjs';
import browserLaunch from './browser-launch.json' with { type: 'json' };

// This function also runs in the browser realm; keep its inputs POD and WebGPU.
async function renderProbe(gpu, canvas, teardown) {
  let stage = 'adapter';
  let device;
  try {
    const adapter = await gpu?.requestAdapter();
    if (!adapter) throw new Error('adapter-unavailable');
    const info = adapter.info;
    const identity = Object.fromEntries(
      ['vendor', 'architecture', 'device', 'description'].map((key) => [key, info[key]]),
    );
    stage = 'device';
    device = await adapter.requestDevice({
      requiredLimits: {
        maxDynamicUniformBuffersPerPipelineLayout: Math.min(
          8,
          adapter.limits.maxDynamicUniformBuffersPerPipelineLayout,
        ),
        maxDynamicStorageBuffersPerPipelineLayout: Math.min(
          4,
          adapter.limits.maxDynamicStorageBuffersPerPipelineLayout,
        ),
      },
    });
    const errors = [];
    device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    device.pushErrorScope('validation');
    stage = 'render';
    const context = canvas?.getContext('webgpu');
    if (canvas && !context) throw new Error('surface-unavailable');
    context?.configure({ device, format: 'rgba8unorm', usage: 0x10 | 0x01 });
    const texture = context
      ? context.getCurrentTexture()
      : device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: 0x10 | 0x01 });
    const shader = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
        return vec4f(p[i], 0., 1.);
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.); }
    `,
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    const buffer = device.createBuffer({ size: 256 * 64, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]);
    stage = 'completion';
    await device.queue.onSubmittedWorkDone();
    stage = 'readback';
    await buffer.mapAsync(0x01);
    const pixel = Array.from(
      new Uint8Array(buffer.getMappedRange()).slice(32 * 256 + 32 * 4, 32 * 256 + 32 * 4 + 4),
    );
    buffer.unmap();
    buffer.destroy();
    const error = await device.popErrorScope();
    if (error) errors.push(error.message);
    if (
      errors.length ||
      pixel.some((value, index) => Math.abs(value - [64, 128, 191, 255][index]) > 1)
    )
      throw new Error(JSON.stringify({ pixel, errors }));
    const software = /software|swiftshader|llvmpipe|lavapipe/i.test(
      Object.values(identity).join(' '),
    );
    if (!software) throw new Error(`software adapter requested, got ${JSON.stringify(identity)}`);
    return { status: 'passed', adapter: identity, software, pixel, completed: true, errors };
  } catch (error) {
    return { status: 'failed', stage, message: error.message };
  } finally {
    if (teardown) await teardown(device);
    else device?.destroy();
  }
}

const backend = process.argv[2];
let browser;
let server;
try {
  let result;
  if (backend === 'dawn') {
    const { create, globals } = await import('@forgeax/engine-dawn-node');
    Object.assign(globalThis, globals);
    let gpu = create([]);
    result = await renderProbe(gpu, undefined, (device) =>
      teardownDawnInstance(device ? [device] : [], () => {
        gpu = undefined;
      }),
    );
  } else if (backend === 'browser') {
    const { chromium } = await import('playwright');
    server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<canvas width="64" height="64"></canvas>');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    browser = await chromium.launch({
      ...browserLaunch,
      headless: true,
      args: [...browserLaunch.args, '--use-angle=swiftshader'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    result = await page.evaluate(
      `(${renderProbe.toString()})(navigator.gpu, document.querySelector('canvas'))`,
    );
    result.browser = browser.version();
  } else throw new Error('graphics-usage: probe backend must be dawn or browser');
  console.log(
    JSON.stringify({
      scope: 'capability-preflight',
      backend,
      icd: process.env.VK_DRIVER_FILES,
      ...result,
    }),
  );
  process.exitCode = result.status === 'passed' ? 0 : 1;
} catch (error) {
  console.error(
    JSON.stringify({
      scope: 'capability-preflight',
      backend,
      status: 'failed',
      stage: 'runtime',
      message: error.message,
      hint: 'Install the checkout dependencies, system Vulkan loader and Chrome Beta; run pnpm ci:graphics setup. This is not a rendering-test PASS.',
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
