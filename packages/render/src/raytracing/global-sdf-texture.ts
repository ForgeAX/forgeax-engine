import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { GlobalSdfCompositionInputs, GlobalSdfGrid } from './global-sdf';

/** Derived sampling projection of the region's authoritative voxel buffer.
 * A texture keeps live-field consumers within WebGPU's eight storage-buffer limit.
 * Status is numeric f32, rather than a subnormal bitcast that a GPU may flush. */
export const GLOBAL_SDF_TEXTURE_WGSL = `
struct Voxel { distance: f32, coverage: f32, status: u32, nearestInstance: u32 }
struct Grid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
@group(0) @binding(0) var<storage,read> voxels: array<Voxel>;
@group(0) @binding(1) var<uniform> grid: Grid;
@group(0) @binding(2) var output: texture_storage_3d<rg32float,write>;
@compute @workgroup_size(64) fn projectGlobalSdf(@builtin(global_invocation_id) gid:vec3u) {
 let dims=grid.dimensionsCount.xyz;let i=gid.x;
 if(i>=dims.x*dims.y*dims.z){return;}
 let v=voxels[i];
 textureStore(output,vec3i(vec3u(i%dims.x,(i/dims.x)%dims.y,i/(dims.x*dims.y))),vec4f(v.distance,f32(v.status),0,0));
}`;

export function createGlobalSdfTexture(
  device: RhiDevice,
  module: ShaderModule,
  region: { readonly grid: GlobalSdfGrid; readonly input: GlobalSdfCompositionInputs },
) {
  const [width, height, depthOrArrayLayers] = region.grid.dimensions;
  const descriptor = {
    label: 'irradiance-field.visibility',
    size: { width, height, depthOrArrayLayers },
    dimension: '3d' as const,
    textureBindingViewDimension: '3d' as const,
    format: 'rg32float' as const,
    usage: 4 | 8,
  };
  const texture = device.createTexture(descriptor).unwrap();
  try {
    const view = device.createTextureView(texture, { dimension: '3d' }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
          {
            binding: 2,
            visibility: 4,
            storageTexture: { access: 'write-only', format: 'rg32float', viewDimension: '3d' },
          },
        ],
      })
      .unwrap();
    const pipeline = device
      .createComputePipeline({
        label: 'irradiance-field.visibility',
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
        compute: { module, entryPoint: 'projectGlobalSdf' },
      })
      .unwrap();
    const group = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: region.input.voxels } },
          { binding: 1, resource: { kind: 'buffer', value: region.input.settings } },
          { binding: 2, resource: { kind: 'textureView', value: view } },
        ],
      })
      .unwrap();
    return { texture, view, descriptor, pipeline, group };
  } catch (error) {
    device.destroyTexture(texture);
    throw error;
  }
}
