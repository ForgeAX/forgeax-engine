import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { derive } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import coordinatesSource from '../../../shader/src/texture-coordinates.wgsl?raw';
import { generateParameterModule } from '../../../shader-compiler/src/material/cook';
import { GPU_SHADER_STAGE_FRAGMENT } from '../gpu-stage';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from '../gpu-texture-usage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { writeMaterialTextureCoordinateRecord } from '../material-texture-coordinates';
import { buildPipelineForMaterialShader } from '../pipeline-builder';
import { deriveTextureUvScale } from '../render-data';

it.each([
  false,
  true,
])('matches GPU rotation and block-rounded physical coordinates, padded=%s', async (padded) => {
  const physicalScale = deriveTextureUvScale(padded ? 'bc7-rgba-unorm' : 'rgba8unorm', 5, 7);
  const expectedScale = padded ? [5 / 8, 7 / 8] : [1, 1];
  const schema = [{ name: 'albedo', type: 'texture2d' }] as const;
  const record = derive(schema).coordinateRecords[0];
  if (record === undefined) throw new Error('missing coordinate ABI');
  const parameters = generateParameterModule(schema, { includeResources: false });
  const source =
    [parameters, coordinatesSource].join('\n').replace(/^#.*$/gm, '') +
    `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>,3>(vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
  return vec4(p[index],0.0,1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  let uv = vec2<f32>(0.37,-0.22);
  let optimized = materialUvLinear(uv, material.albedoCoordinatesTransform, material.albedoCoordinatesRotation) * material.albedoCoordinatesMetadata.zw;
  let scaled = uv * material.albedoCoordinatesTransform.zw;
  let c = cos(material.albedoCoordinatesMetadata.y);
  let s = sin(material.albedoCoordinatesMetadata.y);
  let previous = vec2<f32>(scaled.x*c-scaled.y*s,scaled.x*s+scaled.y*c) * vec2<f32>(${expectedScale[0]}, ${expectedScale[1]});
  return vec4<f32>(optimized,previous);
}`;
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const uniform = device
    .createBuffer({
      size: record.size,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
    })
    .unwrap();
  const readback = device
    .createBuffer({ size: 256, usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ })
    .unwrap();
  const output = device
    .createTexture({
      size: { width: 1, height: 1 },
      format: 'rgba32float',
      usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    .unwrap();
  try {
    const empty = device.createBindGroupLayout({ entries: [] }).unwrap();
    const materialLayout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPU_SHADER_STAGE_FRAGMENT, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const layout = device
      .createPipelineLayout({ bindGroupLayouts: [empty, materialLayout] })
      .unwrap();
    const group = device
      .createBindGroup({
        layout: materialLayout,
        entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer: uniform } } }],
      })
      .unwrap();
    const view = device.createTextureView(output, {}).unwrap();
    const pipeline = buildPipelineForMaterialShader(
      'cpu-uv-coefficients',
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
      },
      { cullMode: 'none' },
    ).unwrap();
    for (const rotation of [0, -0, Math.PI / 2, -Math.PI / 3, 0.713]) {
      const payload = new Float32Array(record.size / 4);
      writeMaterialTextureCoordinateRecord(
        payload,
        0,
        {
          set: 7,
          transform: { offset: [0.2, -0.3], scale: [-2, 0.5], rotation },
        },
        physicalScale,
      );
      device.queue.writeBuffer(uniform, 0, payload).unwrap();
      for (let frame = 0; frame < 60; frame++) {
        const encoder = device.createCommandEncoder().unwrap();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(1, group);
        pass.draw(3);
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: output },
          { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
          { width: 1, height: 1 },
        );
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const mapped = (await readback.mapAsync(GPU_BUFFER_USAGE_MAP_READ)).unwrap();
        const values = new Float32Array(mapped.getMappedRange().unwrap().slice(0, 16));
        mapped.unmap();
        expect(values[0], `rotation ${rotation}, frame ${frame}, u`).toBeCloseTo(
          values[2] as number,
          6,
        );
        expect(values[1], `rotation ${rotation}, frame ${frame}, v`).toBeCloseTo(
          values[3] as number,
          6,
        );
      }
    }
  } finally {
    device.destroyBuffer(uniform).unwrap();
    device.destroyBuffer(readback).unwrap();
    device.destroyTexture(output).unwrap();
  }
}, 60_000);
