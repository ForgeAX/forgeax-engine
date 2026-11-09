/** Qualify the restricted operation only for an explicit non-core adapter request. */
export async function probeDepthTextureLoad(device: GPUDevice): Promise<boolean> {
  device.pushErrorScope('validation');
  try {
    const module = device.createShaderModule({
      label: 'depth-texture-load-admission',
      code: `
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var<storage,read_write> output:array<f32>;
@compute @workgroup_size(1) fn main() { output[0]=textureLoad(depth,vec2i(0),0); }
`,
    });
    device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  } catch (cause) {
    await device.popErrorScope();
    throw cause;
  }
  return (await device.popErrorScope()) === null;
}
