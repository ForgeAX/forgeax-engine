import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { composeShader } from '../../../naga/src/index';

it('rasterizes the Default Lit, Subsurface Profile and Two Sided Foliage A-D words and leaves uncovered model IDs zero', async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error('Legacy GBuffer test requires a GPU adapter');
  const device = await adapter.requestDevice();
  const formats = ['rgba16float', 'r32uint', 'r32uint', 'r32uint', 'r32uint'] as const;
  const colors = formats.map((format) =>
    device.createTexture({
      size: [4, 1],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    }),
  );
  const readback = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  try {
    const code = await composeShader(
      `
#import forgeax_pbr::gbuffer_output::{CompactGBufferOutput, encodeCompactStandardGBuffer, compactSubsurfaceCustomData}
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(points[index], 0, 1);
}
@fragment fn fs(@builtin(position) position: vec4f) -> CompactGBufferOutput {
  if (position.x > 3.0) { discard; }
  var profiles : array<vec4u, 4>;
  profiles[0] = vec4u(0x004080ffu, 0x004080bfu, 0u, 0u);
  let subsurface = select(vec4f(0), vec4f(9.0, 6.0, 3.0, 0.5), position.x > 1.0 && position.x < 2.0);
  let customData = compactSubsurfaceCustomData(subsurface, profiles);
  return encodeCompactStandardGBuffer(vec3f(0, 0, 1), 0.6,
    vec3f(0.001, 0.18, 0.8), 0.2, 0.032, 0.4, vec3f(0), 1.0, vec4u(0xffffffffu, 0u, 0u, 0u), customData, select(1u, 3u, position.x > 1.0), position.x > 2.0);
}
`,
      {
        'forgeax_pbr::gbuffer': readFileSync(
          new URL('../standard-gbuffer.wgsl', import.meta.url),
          'utf8',
        ),
        'forgeax_pbr::gbuffer_output': readFileSync(
          new URL('../standard-gbuffer-output.wgsl', import.meta.url),
          'utf8',
        ),
      },
      {},
    );
    const module = device.createShaderModule({ code });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: formats.map((format) => ({ format })) },
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: colors.map((texture) => ({
        view: texture.createView(),
        loadOp: 'clear',
        storeOp: 'store',
      })),
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    for (const [index, texture] of colors.slice(1).entries()) {
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, offset: index * 16 }, [4, 1]);
    }
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    expect(Array.from(new Uint32Array(readback.getMappedRange()))).toEqual([
      0x7ff80200,
      0xfff80200,
      0xfff80200,
      0, // A: XYZ10 and contact/capsule object flags.
      0xa1996633,
      0xa5996633,
      0xa6996633,
      0, // B: Default Lit (1), Subsurface Profile (5), Two Sided Foliage (6), uncovered (0).
      0x66e77603,
      0x66e77603,
      0x66e77603,
      0, // C: sRGB=(3,118,231), AO=102.
      0,
      0x80000002,
      0,
      0, // D: Profile ID 2 in R and scattering opacity 128 in A.
    ]);
  } finally {
    readback.destroy();
    for (const texture of colors) texture.destroy();
    device.destroy();
  }
});
