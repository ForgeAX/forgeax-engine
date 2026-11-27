// Layout matches the shared DoF optics block.
struct DepthOfFieldTileParams {
  optics : vec4<f32>,
  image : vec4<f32>,
  camera : vec4<f32>,
  reserved : vec4<f32>,
};

@group(0) @binding(0) var tileInput : texture_2d<f32>;
@group(0) @binding(1) var tileOutput : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> tileParams : DepthOfFieldTileParams;

var<workgroup> nearRadius : atomic<u32>;
var<workgroup> farRadius : atomic<u32>;

@compute @workgroup_size(8, 8)
fn reduce_tiles(
  @builtin(local_invocation_id) lane : vec3<u32>,
  @builtin(local_invocation_index) laneIndex : u32,
  @builtin(workgroup_id) group : vec3<u32>,
) {
  // One invocation owns a 2x2 CoC footprint in the 16x16 tile. Clamped
  // padding repeats the last texel and cannot change either extremum.
  let tile = vec2<i32>(group.xy);
  let first = tile * DOF_TILE_SIZE + vec2<i32>(lane.xy) * 2;
  let last = vec2<i32>(textureDimensions(tileInput)) - 1;
  let a = textureLoad(tileInput, min(first, last), 0).r;
  let b = textureLoad(tileInput, min(first + vec2<i32>(1, 0), last), 0).r;
  let c = textureLoad(tileInput, min(first + vec2<i32>(0, 1), last), 0).r;
  let d = textureLoad(tileInput, min(first + 1, last), 0).r;
  let radius = dofEligibleRadii(-min(min(a, b), min(c, d)), max(max(a, b), max(c, d)), tileParams.image.z);
  if (radius.x > 0.0) { atomicMax(&nearRadius, u32(ceil(radius.x))); }
  if (radius.y > 0.0) { atomicMax(&farRadius, u32(ceil(radius.y))); }
  workgroupBarrier();
  if (laneIndex == 0u) {
    let bounds = vec2<f32>(f32(atomicLoad(&nearRadius)), f32(atomicLoad(&farRadius))) / 255.0;
    textureStore(tileOutput, tile, vec4<f32>(bounds, 0.0, 0.0));
  }
}

@compute @workgroup_size(8, 8)
fn expand_tiles(@builtin(global_invocation_id) id : vec3<u32>) {
  let tile = vec2<i32>(id.xy);
  if (any(id.xy >= textureDimensions(tileOutput))) { return; }
  let outputSize = max(vec2<f32>(tileParams.camera.z, tileParams.image.x), vec2<f32>(1.0));
  let sides = dofTileHasInfluence(tileInput, tile, outputSize, tileParams.image.y);
  textureStore(tileOutput, tile, vec4<f32>(select(vec2<f32>(0.0), vec2<f32>(1.0), sides), 0.0, 0.0));
}
