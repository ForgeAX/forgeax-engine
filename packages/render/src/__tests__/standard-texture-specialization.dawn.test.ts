import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_TEXTURE_MASK_OVERRIDE,
  standardTextureMask,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { lowerStandardPhysicalBindings } from '../../../shader-compiler/src/material/lower-standard-contract';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { buildPipelineForMaterialShader } from '../pipeline-builder';

it('applies all schema-derived texture specialization bits through the real material PSO owner', async () => {
  const fields = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) => entry.type === 'texture2d');
  const body = fields
    .map((field, index) => {
      const name = field.name[0]?.toUpperCase() + field.name.slice(1);
      return `if (standardUses${name}()) { result += ${2 ** index}.0 * textureLoad(poison, vec2<i32>(0), 0).r; }`;
    })
    .join('\n');
  // Use the compiler's real shared-entry projection and Render's real PSO
  // builder. Omitting the fragment overrides turns every absent map on and
  // makes the first (zero-map) readback fail, independent of image judgment.
  const source = lowerStandardPhysicalBindings(
    `
@group(0) @binding(0) var poison: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2<f32>(-1.0,-1.0), vec2<f32>(3.0,-1.0), vec2<f32>(-1.0,3.0));
  return vec4<f32>(p[index], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  var result = 0.0;
  ${body}
  return vec4<f32>(result, 0.0, 0.0, 1.0);
}`,
    DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
    true,
  );
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const input = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    })
    .unwrap();
  const output = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba32float',
      textureBindingViewDimension: '2d',
      usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    .unwrap();
  const readback = device
    .createBuffer({ size: 256, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  try {
    device.queue
      .writeTexture(
        { texture: input },
        new Uint8Array([255, 0, 0, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      )
      .unwrap();
    const inputView = device.createTextureView(input, {}).unwrap();
    const outputView = device.createTextureView(output, {}).unwrap();
    const groupLayout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPU_SHADER_STAGE_FRAGMENT,
            texture: { sampleType: 'float', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [groupLayout] }).unwrap();
    const group = device
      .createBindGroup({
        layout: groupLayout,
        entries: [{ binding: 0, resource: { kind: 'textureView', value: inputView } }],
      })
      .unwrap();
    for (const mask of [
      0,
      ...fields.map((field) => standardTextureMask([field])),
      standardTextureMask(fields),
    ]) {
      const pipeline = buildPipelineForMaterialShader(
        `texture-mask-${mask}`,
        { source, paramSchema: [] },
        {
          device,
          shaderModuleFactory: {
            createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
          },
          pipelineLayout: layout,
          colorFormat: 'rgba32float',
          depthFormat: undefined,
          vertexBuffers: [],
          constants: { [STANDARD_TEXTURE_MASK_OVERRIDE]: mask },
        },
        { cullMode: 'none' },
      ).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: output },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const values = Array.from(new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16)));
      mapped.unmap();
      expect(values, `texture mask ${mask}`).toEqual([mask, 0, 0, 1]);
    }
  } finally {
    device.destroyTexture(input).unwrap();
    device.destroyTexture(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});

it('writes opaque depth without a fragment stage while retaining authored shadow discard', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const depth = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'depth32float',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
    })
    .unwrap();
  const readback = device
    .createBuffer({ size: 256, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  const source = `
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  return vec4(positions[i], 0.25, 1.0);
}
@fragment fn fs_shadow() { discard; }
@fragment fn authored_depth() -> @builtin(frag_depth) f32 { return 0.5; }
`;
  try {
    const view = device.createTextureView(depth, {}).unwrap();
    const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
    for (const [fragmentEntry, expected] of [
      [null, 0.25],
      [undefined, 0],
      ['authored_depth', 0.5],
    ] as const) {
      const pipeline = buildPipelineForMaterialShader(
        'shadow-depth',
        { source, paramSchema: [] },
        {
          device,
          shaderModuleFactory: {
            createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
          },
          pipelineLayout: layout,
          colorFormat: 'rgba8unorm',
          depthFormat: 'depth32float',
          vertexBuffers: [],
        },
        { cullMode: 'none' },
        undefined,
        undefined,
        fragmentEntry,
        undefined,
        'shadow-caster',
      ).unwrap();
      const encoder = device.createCommandEncoder().unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view,
          depthClearValue: 0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer(
        { texture: depth, aspect: 'depth-only' },
        { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
        { width: 1, height: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
      const value = new Float32Array(mapped.getMappedRange().unwrap().slice(0, 4))[0];
      mapped.unmap();
      expect(value, `shadow fragment ${String(fragmentEntry)}`).toBe(expected);
    }
  } finally {
    device.destroyTexture(depth).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
