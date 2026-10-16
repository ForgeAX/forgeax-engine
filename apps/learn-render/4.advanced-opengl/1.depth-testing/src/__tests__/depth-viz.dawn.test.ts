import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('visualizes physical distance from the demo Reverse-Z fragment depth', async () => {
  const { compileShader } = await import(
    /* @vite-ignore */ new URL(
      '../../../../../../packages/shader-compiler/dist/index.mjs',
      import.meta.url,
    ).href
  );
  const source = readFileSync(new URL('../depth-viz.wgsl', import.meta.url), 'utf8');
  const compiled = await compileShader(
    `${source}
@vertex fn probeVertex(@builtin(vertex_index) vertex: u32) -> VsOut {
  let triangle = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let distance = select(10.0, 50.0, vertex >= 3u);
  let depth = (0.1 / distance - 0.001) / 0.999;
  var out: VsOut;
  out.clip = vec4<f32>(triangle[vertex % 3u], depth, 1.0);
  return out;
}`,
    {
      id: 'learn_render::depth_viz',
      imports: {
        'forgeax_view::common': readFileSync('packages/shader/src/common.wgsl', 'utf8'),
      },
    },
  );
  if (!compiled.ok) throw compiled.error;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('Dawn adapter unavailable');
  const device = await adapter.requestDevice();
  device.pushErrorScope('validation');
  try {
    const module = device.createShaderModule({ code: compiled.value.wgsl });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'probeVertex' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
    });
    const target = device.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: 0x11 });
    const readback = device.createBuffer({ size: 256, usage: 0x9 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setViewport(0, 0, 1, 1, 0, 1);
    pass.draw(3);
    pass.setViewport(1, 0, 1, 1, 0, 1);
    pass.draw(3, 1, 3);
    pass.end();
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readback, bytesPerRow: 256 },
      [2, 1],
    );
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const pixels = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    expect(Math.abs((pixels[0] ?? 0) - 26)).toBeLessThanOrEqual(1);
    expect(Math.abs((pixels[4] ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(await device.popErrorScope()).toBeNull();
  } finally {
    device.destroy();
  }
});
