#define_import_path forgeax_material::water_mesh_precise
struct Params { p: array<vec4<u32>, 7>, mips: array<vec4<u32>> };
struct Node { packed: u32, low: f32, high: f32, height: f32 };
struct View { observer: vec4<f32>, vp: mat4x4<f32>, planes: array<vec4<f32>, 6>, inverseVp: mat4x4<f32>, lod: vec4<f32> };
struct Candidate { node: u32, material: u32, tiles: u32, lod: u32, morph: f32, body: u32, transition: u32, visible: u32 };
struct Occlusion { p: array<vec4<u32>> };
@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> views: array<View>;
@group(0) @binding(3) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(4) var<storage, read_write> visibility: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> occlusion: Occlusion;
#ifdef WATER_PRECISE_MSAA
@group(0) @binding(6) var opaqueDepth: texture_depth_multisampled_2d;
#else
@group(0) @binding(6) var opaqueDepth: texture_depth_2d;
#endif
struct Input { @location(0) position: vec4<f32>, @location(1) unused: vec2<f32> };
struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) candidate: u32,
};
@vertex fn vs_main(input: Input, @builtin(instance_index) instance: u32) -> Output {
  let viewIndex = occlusion.p[0].x;
  let index = viewIndex * params.p[0].z + instance;
  let candidate = candidates[index];
  if (candidate.visible != 1u) { return Output(vec4<f32>(2.0, 2.0, 2.0, 1.0), index); }
  var coordinate = vec3<u32>(0u);
  for (var mip = 0u; mip < params.p[4].w; mip++) {
    let descriptor = params.mips[mip];
    if (candidate.node < descriptor.x + descriptor.y * descriptor.z) {
      let local = candidate.node - descriptor.x;
      coordinate = vec3<u32>(local % descriptor.y, local / descriptor.y, mip); break;
    }
  }
  let zone = bitcast<vec4<f32>>(params.p[2]);
  let extent = exp2(f32(coordinate.z)) * zone.zw / vec2<f32>(params.p[0].xy);
  let low = zone.xy + vec2<f32>(coordinate.xy) * extent;
  let high = min(zone.xy + zone.zw, low + extent);
  let node = nodes[candidate.node];
  let point = mix(vec3<f32>(low.x, node.low, low.y), vec3<f32>(high.x, node.high, high.y), input.position.xyz);
  return Output(views[viewIndex].vp * vec4<f32>(point, 1.0), index);
}
#ifdef WATER_PRECISE_MSAA
@fragment fn fs_shadow(input: Output, @builtin(sample_index) sample: u32) {
#else
@fragment fn fs_shadow(input: Output) {
  let sample = 0u;
#endif
  let pixel = vec2<i32>(input.position.xy);
  // Explicit comparison preserves late-depth-test implementations' fragment side effects.
  if (input.position.z >= textureLoad(opaqueDepth, pixel, i32(sample))) {
    atomicStore(&visibility[input.candidate], 1u);
  }
}
