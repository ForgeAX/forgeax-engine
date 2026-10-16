/// <reference types="vite/client" />

import type { BindGroup, MappedBuffer, Texture } from '@forgeax/engine/rhi';
import { createShaderModule, ensureReady, requestAdapter } from '@forgeax/engine/rhi-wgpu';
import { composeShader } from '@forgeax/engine-naga';
import { expect, it } from 'vitest';
import brdfSource from '../../../shader/src/brdf.wgsl?raw';
import { directDfgLutBytes } from '../../../shader/src/direct-dfg-lut-data';
import { referenceBytes, referenceFit } from './direct-dfg-reference';

// Centers, interpolation and clamp edges exercise the actual compiled providers.
// Full native texture comparison remains in direct-dfg-lut.dawn.test.ts.
const samples = [
  [-0.25, -0.25],
  [0.03125, 0.03125],
  [0.5, 0.5],
  [0.40625, 0.65625],
  [0.046875, 0.25],
  [1.25, 0.75],
  [0.75, 1.25],
  [1.25, 1.25],
] as const;

it.each([
  'fit',
  'lut',
] as const)('runs direct DFG %s without shader arrays on the real WebGL backend', async (mode) => {
  const canvas = document.createElement('canvas');
  canvas.width = samples.length;
  canvas.height = 1;
  document.body.append(canvas);
  await ensureReady();
  const device = (
    await (await requestAdapter(undefined, canvas)).unwrap().requestDevice()
  ).unwrap();
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('DFG code generation regression requires the real WebGL2 backend');
  const target = device
    .createTexture({ size: [samples.length, 1], format: 'rgba32float', usage: 0x10 | 0x01 })
    .unwrap();
  const staging = device.createBuffer({ size: 256, usage: 0x01 | 0x08 }).unwrap();
  const textures: Texture[] = [];
  let read: MappedBuffer | undefined;
  let failure: unknown;
  const fragmentSources: string[] = [];
  const shaderSource = gl.shaderSource;
  try {
    let group: BindGroup | undefined;
    const layouts = [];
    if (mode === 'lut') {
      expect(directDfgLutBytes()).toEqual(referenceBytes);
      for (const bytes of [directDfgLutBytes(), referenceBytes]) {
        const texture = device
          .createTexture({ size: [16, 16], format: 'rg16float', usage: 0x02 | 0x04 })
          .unwrap();
        textures.push(texture);
        device.queue
          .writeTexture({ texture }, bytes, { bytesPerRow: 64, rowsPerImage: 16 }, [16, 16])
          .unwrap();
      }
      const [productionTexture, referenceTexture] = textures;
      if (!productionTexture || !referenceTexture) throw new Error('Missing DFG test textures');
      const layout = device
        .createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 1, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
          ],
        })
        .unwrap();
      layouts.push(layout);
      group = device
        .createBindGroup({
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'textureView',
                value: device.createTextureView(productionTexture, {}).unwrap(),
              },
            },
            {
              binding: 1,
              resource: {
                kind: 'textureView',
                value: device.createTextureView(referenceTexture, {}).unwrap(),
              },
            },
            {
              binding: 2,
              resource: {
                kind: 'sampler',
                value: device
                  .createSampler({
                    magFilter: 'linear',
                    minFilter: 'linear',
                    addressModeU: 'clamp-to-edge',
                    addressModeV: 'clamp-to-edge',
                  })
                  .unwrap(),
              },
            },
          ],
        })
        .unwrap();
    }
    const code = await composeShader(
      `
#import forgeax_pbr::brdf::{sampleDirectDfg}
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(0) @binding(0) var production: texture_2d<f32>;
@group(0) @binding(1) var reference: texture_2d<f32>;
@group(0) @binding(2) var filtering: sampler;
#endif
const coordinates = array<vec2<f32>, ${samples.length}>(
  ${samples.map(([u, v]) => `vec2<f32>(${u}, ${v})`).join(',\n  ')}
);
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = coordinates[u32(position.x)];
#ifdef DIRECT_DFG_LUT_AVAILABLE
  return vec4<f32>(sampleDirectDfg(uv.x, uv.y, true, production, filtering),
    textureSampleLevel(reference, filtering, uv, 0.0).xy);
#else
  return vec4<f32>(sampleDirectDfg(uv.x, uv.y, false), 0.0, 1.0);
#endif
}
`,
      { 'forgeax_pbr::brdf': brdfSource },
      mode === 'lut' ? { DIRECT_DFG_LUT_AVAILABLE: true } : {},
    );
    // Observe the source actually given to this canvas's GL driver; forward
    // every call unchanged and restore the method after pipeline creation.
    gl.shaderSource = function (shader, source) {
      if (this.getShaderParameter(shader, this.SHADER_TYPE) === this.FRAGMENT_SHADER) {
        fragmentSources.push(source);
      }
      shaderSource.call(this, shader, source);
    };
    const shader = (await createShaderModule(device, { code })).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }).unwrap(),
        vertex: { module: shader, entryPoint: 'vs', buffers: [] },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    gl.shaderSource = shaderSource;
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: device.createTextureView(target, {}).unwrap(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: -1, g: -1, b: -1, a: -1 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    if (group) pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: staging, bytesPerRow: 256 }, [
      samples.length,
      1,
      1,
    ]);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    read = (await staging.mapAsync(1)).unwrap();
    const values = new Float32Array(read.getMappedRange().unwrap());
    for (const [index, [u, v]] of samples.entries()) {
      const expected =
        mode === 'fit'
          ? referenceFit(u, v)
          : [values[index * 4 + 2] ?? NaN, values[index * 4 + 3] ?? NaN];
      for (const [channel, value] of expected.entries()) {
        const actual = values[index * 4 + channel];
        expect(actual, `DFG(${u}, ${v}) channel ${channel}`).toBeTypeOf('number');
        expect(Math.abs((actual ?? NaN) - value)).toBeLessThan(0.000002);
      }
    }

    expect(fragmentSources).toHaveLength(1);
    const fragment = fragmentSources[0] ?? '';
    // Keep the performance regression on the actual driver input, regardless
    // of whether Naga chooses helpers or inlines the selected provider.
    expect(fragment).not.toMatch(/\buint\s+\w+\s*\[\s*256\s*\]/);
    expect(fragment).not.toContain('three_r184_dfg_lut');
    if (mode === 'fit') expect(fragment).not.toMatch(/uniform\s+\w*sampler/);
    else expect(fragment).toContain('sampler2D');
  } catch (error) {
    failure = error;
  } finally {
    gl.shaderSource = shaderSource;
    try {
      read?.unmap();
      device.destroyBuffer(staging).unwrap();
      device.destroyTexture(target).unwrap();
      for (const texture of textures) device.destroyTexture(texture).unwrap();
    } catch (cleanupError) {
      failure =
        failure === undefined
          ? cleanupError
          : new AggregateError([failure, cleanupError], 'DFG draw and cleanup failed');
    } finally {
      // RHI has no device/view/pipeline destroy methods. The owning GL context
      // releases its remaining driver resources, including the compiled program.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
    }
  }
  if (failure !== undefined) throw failure;
});
