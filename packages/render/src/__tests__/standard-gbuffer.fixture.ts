import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import gbuffer from '../../../shader/src/standard-gbuffer.wgsl?raw';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_STORAGE } from '../gpu-usage';

export const gbufferSource = gbuffer;

// Existing analytic fixtures author XYZ in [0, 1]. Convert to signed normals
// and use the production GPU encoder, not a second CPU packing algorithm.
export function writePackedNormals(
  device: RhiDevice,
  texture: Texture,
  width: number,
  height: number,
  values: Float32Array | number[],
) {
  const input = device
    .createBuffer({
      size: width * height * 16,
      usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
    .unwrap();
  try {
    device.queue.writeBuffer(input, 0, new Float32Array(values)).unwrap();
    const module = createShaderModuleImmediate(device, {
      code: `${gbuffer.replace(/^#define_import_path.*$/gm, '')}
@group(0) @binding(0) var<storage, read> input: array<vec4<f32>>;
@group(0) @binding(1) var output: texture_storage_2d<r32uint, write>;
@compute @workgroup_size(8, 8) fn seed(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (any(id.xy >= size)) { return; }
  let value = input[id.y * size.x + id.x];
  textureStore(output, vec2<i32>(id.xy),
    vec4<u32>(encodeStandardNormalRoughness(value.xyz * 2.0 - 1.0, value.w)));
}`,
    }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
          {
            binding: 1,
            visibility: 4,
            storageTexture: { access: 'write-only', format: 'r32uint', viewDimension: '2d' },
          },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'seed' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: input } } },
          {
            binding: 1,
            resource: {
              kind: 'textureView',
              value: device.createTextureView(texture, {}).unwrap(),
            },
          },
        ],
      })
      .unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  } finally {
    device.destroyBuffer(input).unwrap();
  }
}
