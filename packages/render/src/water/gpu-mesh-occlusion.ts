import { WATER_GPU_MESH_TRAVERSAL_WGSL, WATER_GPU_MESH_WGSL_TYPES } from './gpu-mesh-shaders';

/** Reverse-Z furthest HZB and raster visibility share the selected view's actual opaque depth. */
export function waterGpuOcclusionWgsl(mipCount: number, msaa: boolean): string {
  return (
    WATER_GPU_MESH_WGSL_TYPES +
    /* wgsl */ `
struct Occlusion { p: array<vec4<u32>> };
@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> views: array<View>;
@group(0) @binding(3) var<storage, read_write> candidates: array<Candidate>;
@group(0) @binding(4) var depth: ${msaa ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@group(0) @binding(5) var<storage, read_write> pyramid: array<f32>;
@group(0) @binding(6) var<storage, read> occlusion: Occlusion;
@group(0) @binding(7) var<storage, read_write> visibility: array<atomic<u32>>;
` +
    WATER_GPU_MESH_TRAVERSAL_WGSL +
    /* wgsl */ `
@compute @workgroup_size(8, 8)
fn depthBase(@builtin(global_invocation_id) id: vec3<u32>) {
  let descriptor = occlusion.p[1];
  if (any(id.xy >= descriptor.yz)) { return; }
  var value = 0.0;
  if (all(id.xy < textureDimensions(depth))) {
    ${msaa ? 'value = 1.0; for (var sample = 0; sample < 4; sample++) { value = min(value, textureLoad(depth, vec2<i32>(id.xy), sample)); }' : 'value = textureLoad(depth, vec2<i32>(id.xy), 0);'}
  }
  pyramid[descriptor.x + id.y * descriptor.y + id.x] = value;
}
` +
    Array.from({ length: mipCount - 1 }, (_, index) => {
      const mip = index + 1;
      return /* wgsl */ `
@compute @workgroup_size(8, 8)
fn depthMip${mip}(@builtin(global_invocation_id) id: vec3<u32>) {
  let current = occlusion.p[${mip + 1}]; let previous = occlusion.p[${mip}];
  if (any(id.xy >= current.yz)) { return; }
  var value = 1.0;
  for (var y = 0u; y < 2u; y++) { for (var x = 0u; x < 2u; x++) {
    let child = min(id.xy * 2u + vec2<u32>(x, y), previous.yz - vec2<u32>(1u));
    value = min(value, pyramid[previous.x + child.y * previous.y + child.x]);
  } }
  pyramid[current.x + id.y * current.y + id.x] = value;
}
`;
    }).join('') +
    /* wgsl */ `
@compute @workgroup_size(64)
fn occlude(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[0].z) { return; }
  let index = occlusion.p[0].x * params.p[0].z + id.x;
  atomicStore(&visibility[index], 0u);
  let candidate = candidates[index]; if (candidate.visible == 0u) { return; }
  let view = views[occlusion.p[0].x];
  let node = nodes[candidate.node]; let bounds = boundsAt(locate(candidate.node), node);
  var minimum = vec2<f32>(1e30); var maximum = vec2<f32>(-1e30); var closest = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let point = vec3<f32>(select(bounds[0].x, bounds[1].x, (corner & 1u) != 0u), select(bounds[0].y, bounds[1].y, (corner & 2u) != 0u), select(bounds[0].z, bounds[1].z, (corner & 4u) != 0u));
    let clip = view.vp * vec4<f32>(point, 1.0);
    // Near-plane crossings retain visibility in both selected paths.
    if (clip.w <= 0.000001 || clip.z >= clip.w) {
      atomicStore(&visibility[index], 1u); candidates[index].visible = 2u; return;
    }
    let ndc = clip.xyz / clip.w;
    let pixel = (ndc.xy * vec2<f32>(0.5, -0.5) + 0.5) * vec2<f32>(textureDimensions(depth));
    minimum = min(minimum, pixel); maximum = max(maximum, pixel); closest = max(closest, ndc.z);
  }
  let size = vec2<i32>(textureDimensions(depth));
  let low = clamp(vec2<i32>(floor(minimum)), vec2<i32>(0), size - vec2<i32>(1));
  let high = clamp(vec2<i32>(ceil(maximum)), vec2<i32>(0), size - vec2<i32>(1));
  if ((occlusion.p[0].y & 1u) != 0u) {
    let span = max(high.x - low.x + 1, high.y - low.y + 1);
    let mip = min(u32(ceil(log2(f32(max(span, 1))))), occlusion.p[0].z - 1u);
    let descriptor = occlusion.p[1u + mip];
    let first = vec2<u32>(low) >> vec2<u32>(mip); let last = vec2<u32>(high) >> vec2<u32>(mip);
    var furthest = 1.0;
    for (var y = first.y; y <= last.y; y++) { for (var x = first.x; x <= last.x; x++) {
      furthest = min(furthest, pyramid[descriptor.x + y * descriptor.y + x]);
    } }
    if (furthest > closest) { candidates[index].visible = 0u; return; }
  }
  if ((occlusion.p[0].y & 2u) == 0u) { atomicStore(&visibility[index], 1u); }
}
@compute @workgroup_size(64)
fn applyVisibility(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[0].z) { return; }
  let index = occlusion.p[0].x * params.p[0].z + id.x;
  candidates[index].visible = atomicLoad(&visibility[index]);
}
`
  );
}
