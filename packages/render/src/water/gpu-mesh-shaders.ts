const TYPES = /* wgsl */ `
struct Params { p: array<vec4<u32>, 7>, mips: array<vec4<u32>> };
struct Body { routes: vec4<u32>, bounds: vec4<f32>, waveOrigin: vec4<f32> };
struct Node { packed: u32, low: f32, high: f32, height: f32 };
struct View { observer: vec4<f32>, vp: mat4x4<f32>, planes: array<vec4<f32>, 6>, inverseVp: mat4x4<f32>, lod: vec4<f32> };
struct Candidate { node: u32, material: u32, tiles: u32, lod: u32, morph: f32, body: u32, transition: u32, visible: u32 };
fn primary(node: Node) -> u32 { return node.packed & 32767u; }
fn transition(node: Node) -> u32 { return (node.packed >> 15u) & 32767u; }
`;
const params = '@group(0) @binding(0) var<storage, read> params: Params;';

export function waterGpuMergeWgsl(msaa: boolean): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var source: ${msaa ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>'};
@group(0) @binding(2) var heights: ${msaa ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>'};
@group(0) @binding(3) var<storage, read> bodies: array<Body>;
@group(0) @binding(4) var<storage, read_write> nodes: array<Node>;
@compute @workgroup_size(8, 8)
fn merge(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = params.p[0].xy;
  if (any(id.xy >= size)) { return; }
  var body = vec2<f32>(0.0); var bounds = vec2<f32>(0.0);
  let supersampling = params.p[4].x;
  let rasterSize = textureDimensions(source);
  for (var y = 0u; y < supersampling; y++) { for (var x = 0u; x < supersampling; x++) {
    let pixel = id.xy * supersampling + vec2<u32>(x, y);
    if (any(pixel >= rasterSize)) { continue; }
    for (var sample = 0u; sample < params.p[4].y; sample++) {
      body = max(body, textureLoad(source, vec2<i32>(pixel), ${msaa ? 'i32(sample)' : '0'}).rg);
      bounds = max(bounds, textureLoad(heights, vec2<i32>(pixel), ${msaa ? 'i32(sample)' : '0'}).rg);
    }
  } }
  let nonRiver = u32(round(body.x * 1023.0)) & 127u;
  let river = u32(round(body.y * 1023.0)) & 127u;
  let owner = select(nonRiver, river, river != 0u);
  let transitionBody = select(0u, nonRiver, river != 0u);
  let range = bitcast<vec4<f32>>(params.p[3]);
  var node = Node(0u, range.y, range.x, 0.0);
  if (owner != 0u) {
    let height = bodies[select(owner, transitionBody, transitionBody != 0u)].bounds.x;
    let slopePadding = length(bitcast<vec4<f32>>(params.p[2]).zw / vec2<f32>(size)) * 0.05;
    node = Node(owner | (transitionBody << 15u) | 0xc0000000u,
      mix(range.x, range.y, 1.0 - bounds.x) - slopePadding,
      mix(range.x, range.y, bounds.y) + slopePadding, height);
  }
  nodes[id.y * size.x + id.x] = node;
}
`
  );
}

export function waterGpuMipWgsl(mip: number): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> nodes: array<Node>;
@compute @workgroup_size(8, 8)
fn mip(@builtin(global_invocation_id) id: vec3<u32>) {
  let current = params.mips[${mip}]; let previous = params.mips[${mip - 1}];
  if (any(id.xy >= current.yz)) { return; }
  var complete = true; var same = true; var owner = 0u; var transitionBody = 0u;
  var low = 1e30; var high = -1e30; var height = 0.0;
  for (var y = 0u; y < 2u; y++) { for (var x = 0u; x < 2u; x++) {
    let coord = id.xy * 2u + vec2<u32>(x, y);
    let child = min(coord, previous.yz - vec2<u32>(1u));
    let node = nodes[previous.x + child.y * previous.y + child.x];
    if (x == 0u && y == 0u) { owner = primary(node); transitionBody = transition(node); }
    same = same && primary(node) == owner && transition(node) == transitionBody;
    complete = complete && (node.packed & 0x40000000u) != 0u;
    if (primary(node) != 0u) { low = min(low, node.low); high = max(high, node.high); }
    height += node.height * 0.25;
  } }
  let collapse = same && owner != 0u;
  let packed = select(0u, owner | (transitionBody << 15u) | 0x80000000u, collapse) | select(0u, 0x40000000u, complete);
  nodes[current.x + id.y * current.y + id.x] = Node(packed, low, high, height);
}
`
  );
}

const TRAVERSAL = /* wgsl */ `
fn locate(index: u32) -> vec3<u32> {
  for (var mip = 0u; mip < params.p[4].w; mip++) {
    let descriptor = params.mips[mip];
    if (index < descriptor.x + descriptor.y * descriptor.z) {
      let local = index - descriptor.x;
      return vec3<u32>(local % descriptor.y, local / descriptor.y, mip);
    }
  }
  return vec3<u32>(0u);
}
fn boundsAt(coord: vec3<u32>, node: Node) -> mat2x3<f32> {
  let zone = bitcast<vec4<f32>>(params.p[2]);
  let size = vec2<f32>(params.p[0].xy);
  let scale = exp2(f32(coord.z));
  let low = zone.xy + vec2<f32>(coord.xy) * scale * zone.zw / size;
  let high = min(zone.xy + zone.zw, low + scale * zone.zw / size);
  return mat2x3<f32>(vec3<f32>(low.x, node.low, low.y), vec3<f32>(high.x, node.high, high.y));
}
fn maximumLod() -> u32 { return min(params.p[4].w, params.p[5].y) - 1u; }
fn lowestLod(observerY: f32, height: f32) -> vec2<f32> {
  let scale = bitcast<f32>(params.p[3].z);
  let distance = max(abs(observerY - height) / scale - 2.0, 0.0) * 2.0;
  let lod = clamp(log2(max(distance, 1.0)), 0.0, f32(maximumLod()));
  return vec2<f32>(floor(lod), fract(lod));
}
fn canRender(node: Node, density: u32) -> bool {
  if (primary(node) == 0u || (node.packed & 0x80000000u) == 0u) { return false; }
  let complete = (node.packed & 0x40000000u) != 0u;
  let forced = bitcast<i32>(params.p[4].z);
  return i32(density) > forced || complete;
}
fn radius(lod: u32) -> f32 { return exp2(f32(lod + 1u)) * bitcast<f32>(params.p[3].z); }
fn distanceTo(coord: vec3<u32>, node: Node, view: View) -> f32 {
  let bounds = boundsAt(coord, node);
  return length(view.observer.xz - clamp(view.observer.xz, bounds[0].xz, bounds[1].xz));
}
fn visible(bounds: mat2x3<f32>, view: View) -> bool {
  if (any(bounds[0].xz >= bounds[1].xz)) { return false; }
  for (var i = 0u; i < 6u; i++) {
    let plane = view.planes[i];
    let positive = select(bounds[0], bounds[1], plane.xyz >= vec3<f32>(0.0));
    if (dot(plane.xyz, positive) + plane.w < 0.0) { return false; }
  }
  return true;
}
`;

export function waterGpuTraverseWgsl(): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> nodes: array<Node>;
@group(0) @binding(3) var<storage, read_write> views: array<View>;
@group(0) @binding(4) var<storage, read_write> candidates: array<Candidate>;
` +
    TRAVERSAL +
    /* wgsl */ `
@compute @workgroup_size(64)
fn viewLod(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[1].y) { return; }
  let size = params.p[0].xy;
  let extent = bitcast<vec4<f32>>(params.p[2]);
  let observer = views[id.x].observer;
  let pixel = vec2<u32>(clamp(floor((observer.xz - extent.xy) / extent.zw * vec2<f32>(size)), vec2<f32>(0.0), vec2<f32>(size - vec2<u32>(1u))));
  let waterHeight = nodes[pixel.y * size.x + pixel.x].height;
  views[id.x].lod = vec4<f32>(lowestLod(observer.y, waterHeight), 0.0, 0.0);
}
@compute @workgroup_size(64)
fn traverse(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[0].z * params.p[1].y) { return; }
  let viewIndex = id.x / params.p[0].z; let index = id.x % params.p[0].z;
  let coord = locate(index); let node = nodes[index]; let owner = primary(node); let transitionBody = transition(node);
  candidates[id.x] = Candidate(index, 0u, 0u, 0u, 0.0, owner, transitionBody, 0u);
  if (owner == 0u) { return; }
  if (coord.z > maximumLod()) { return; }
  let view = views[viewIndex];
  if (!visible(boundsAt(coord, node), view)) { return; }
  let height = view.lod.xy;
  let lowest = u32(height.x); let distance = distanceTo(coord, node, view);
  let outside = distance > radius(coord.z) || coord.z < lowest;
  var density = 0u; var shouldRender = false;
  if (coord.z < maximumLod() && outside) {
    let parentCoord = vec3<u32>(coord.xy >> vec2<u32>(1u), coord.z + 1u);
    let descriptor = params.mips[parentCoord.z];
    let parent = nodes[descriptor.x + parentCoord.y * descriptor.y + parentCoord.x];
    let parentIntersects = distanceTo(parentCoord, parent, view) <= radius(coord.z) && coord.z >= lowest;
    if (parentIntersects || !canRender(parent, 0u)) {
      for (var parentLod = coord.z + 1u; parentLod <= maximumLod(); parentLod++) {
        density = parentLod - coord.z;
        let ancestorCoord = vec3<u32>(coord.xy >> vec2<u32>(density), parentLod);
        let ancestorDescriptor = params.mips[parentLod];
        let ancestor = nodes[ancestorDescriptor.x + ancestorCoord.y * ancestorDescriptor.y + ancestorCoord.x];
        if (distanceTo(ancestorCoord, ancestor, view) <= radius(parentLod) && parentLod >= lowest) { break; }
      }
      shouldRender = true;
    }
  } else if (coord.z == maximumLod() || coord.z == lowest || (coord.z > 0u && distance > radius(coord.z - 1u))) { shouldRender = true; }
  if (!shouldRender || !canRender(node, density)) { return; }
  let bodyOffset = viewIndex * params.p[0].w;
  let body = bodies[bodyOffset + owner]; var material = body.routes.y;
  if (transitionBody != 0u) {
    let targetType = u32(bodies[bodyOffset + transitionBody].bounds.w);
    if (targetType == 1u && body.routes.z != 0u) { material = body.routes.z - 1u; }
    if (targetType == 2u && body.routes.w != 0u) { material = body.routes.w - 1u; }
  }
  let clampedDensity = min(density, params.p[5].y - 1u);
  let tiles = max(params.p[1].z, params.p[5].x >> clampedDensity) / params.p[1].z;
  candidates[id.x] = Candidate(index, material, tiles, density, height.y, owner, transitionBody, 1u);
}
`
  );
}

export function waterGpuCountWgsl(): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>>;
@compute @workgroup_size(64)
fn reset(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < params.p[1].x * params.p[1].y) { atomicStore(&counts[id.x], 0u); }
}
@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[0].z * params.p[1].y) { return; }
  let candidate = candidates[params.p[5].z * params.p[0].z + id.x]; if (candidate.visible == 0u) { return; }
  let row = candidate.material;
  atomicAdd(&counts[row], candidate.tiles * candidate.tiles);
}
`
  );
}

export function waterGpuPrefixWgsl(): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read> counts: array<u32>;
@group(0) @binding(2) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> blocks: array<u32>;
@group(0) @binding(4) var<storage, read_write> tiles: array<u32>;
@group(0) @binding(5) var<storage, read_write> args: array<u32>;
var<workgroup> scan: array<u32, 256>;
@compute @workgroup_size(128)
fn prefixLocal(@builtin(local_invocation_index) lane: u32, @builtin(workgroup_id) group: vec3<u32>) {
  let total = params.p[1].x * params.p[1].y;
  let a = group.x * 256u + lane * 2u; let b = a + 1u;
  scan[lane * 2u] = 0u; scan[lane * 2u + 1u] = 0u;
  if (a < total) { scan[lane * 2u] = counts[a]; }
  if (b < total) { scan[lane * 2u + 1u] = counts[b]; }
  var stride = 1u;
  for (var laneCount = 128u; laneCount > 0u; laneCount >>= 1u) {
    workgroupBarrier();
    if (lane < laneCount) { let right = stride * (2u * lane + 2u) - 1u; scan[right] += scan[right - stride]; }
    stride <<= 1u;
  }
  workgroupBarrier();
  if (lane == 0u) { blocks[group.x] = scan[255]; scan[255] = 0u; }
  for (var laneCount = 1u; laneCount < 256u; laneCount <<= 1u) {
    stride >>= 1u; workgroupBarrier();
    if (lane < laneCount) { let right = stride * (2u * lane + 2u) - 1u; let left = scan[right - stride]; scan[right - stride] = scan[right]; scan[right] += left; }
  }
  workgroupBarrier();
  if (a < total) { offsets[a] = scan[lane * 2u]; }
  if (b < total) { offsets[b] = scan[lane * 2u + 1u]; }
}
@compute @workgroup_size(64)
fn prefixBlocks(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x != 0u) { return; }
  let rows = params.p[1].x * params.p[1].y;
  let count = (rows + 255u) / 256u;
  var total = 0u;
  for (var block = 0u; block < count; block++) { let sum = blocks[block]; blocks[block] = total; total += sum; }
  args[rows * 5u] = select(0u, total, total > params.p[1].w * params.p[1].y);
}
@compute @workgroup_size(64)
fn prefixFinalize(@builtin(global_invocation_id) id: vec3<u32>) {
  let rows = params.p[1].x * params.p[1].y;
  if (id.x >= rows) { return; }
  let prefix = offsets[id.x] + blocks[id.x / 256u]; offsets[id.x] = prefix;
  let header = id.x * 64u;
  for (var word = 0u; word < 64u; word++) { tiles[header + word] = 0u; }
  tiles[header] = rows * 64u + prefix * 24u - header;
  tiles[header + 15u] = params.p[1].z;
  tiles[header + 23u] = 0x57474d31u;
  args[id.x * 5u] = params.p[1].z * params.p[1].z * 6u;
  args[id.x * 5u + 1u] = 0u; args[id.x * 5u + 2u] = 0u; args[id.x * 5u + 3u] = 0u; args[id.x * 5u + 4u] = 0u;
}
`
  );
}

export function waterGpuScatterWgsl(): string {
  return (
    TYPES +
    params +
    /* wgsl */ `
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> nodes: array<Node>;
@group(0) @binding(3) var<storage, read> views: array<View>;
@group(0) @binding(4) var<storage, read> candidates: array<Candidate>;
@group(0) @binding(5) var<storage, read> offsets: array<u32>;
@group(0) @binding(6) var<storage, read_write> tiles: array<u32>;
@group(0) @binding(7) var<storage, read_write> args: array<atomic<u32>>;
` +
    TRAVERSAL +
    /* wgsl */ `
@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.p[0].z * params.p[1].y) { return; }
  if (atomicLoad(&args[params.p[1].x * params.p[1].y * 5u]) != 0u) { return; }
  let candidate = candidates[params.p[5].z * params.p[0].z + id.x]; if (candidate.visible == 0u) { return; }
  let viewIndex = params.p[5].z; let row = candidate.material;
  let count = candidate.tiles * candidate.tiles;
  let first = atomicAdd(&args[row * 5u + 1u], count);
  let capacity = params.p[1].w * params.p[1].y;
  let coord = locate(candidate.node); let node = nodes[candidate.node]; let bounds = boundsAt(coord, node);
  let extent = (bounds[1].xz - bounds[0].xz) / f32(candidate.tiles);
  let bodyOffset = viewIndex * params.p[0].w;
  let body = bodies[bodyOffset + candidate.body]; let waveBody = bodies[bodyOffset + select(candidate.body, candidate.transition, candidate.transition != 0u)];
  for (var subTile = 0u; subTile < count; subTile++) {
    let slot = offsets[row] + first + subTile;
    if (slot >= capacity) { continue; }
    let offset = params.p[1].x * params.p[1].y * 64u + slot * 24u;
    let origin = bounds[0].xz + vec2<f32>(f32(subTile % candidate.tiles), f32(subTile / candidate.tiles)) * extent;
    for (var word = 0u; word < 24u; word++) { tiles[offset + word] = 0u; }
    let worldOrigin = origin + bitcast<vec2<f32>>(params.p[6].xy);
    tiles[offset] = bitcast<u32>(worldOrigin.x); tiles[offset + 1u] = bitcast<u32>(worldOrigin.y);
    tiles[offset + 2u] = bitcast<u32>(extent.x); tiles[offset + 3u] = bitcast<u32>(extent.y);
    tiles[offset + 4u] = bitcast<u32>(node.height); tiles[offset + 5u] = bitcast<u32>(node.low); tiles[offset + 6u] = bitcast<u32>(node.high);
    tiles[offset + 7u] = body.routes.x + 1u;
    tiles[offset + 8u] = select(0u, waveBody.routes.x + 1u, candidate.transition != 0u);
    let logicalLod = coord.z + candidate.lod;
    let maxMorphLod = max(logicalLod, maximumLod());
    let heightMorph = select(0.0, candidate.morph, logicalLod == u32(views[viewIndex].lod.x));
    tiles[offset + 9u] = logicalLod; tiles[offset + 10u] = min(logicalLod + 1u, params.p[4].w - 1u);
    tiles[offset + 11u] = params.p[3].z; tiles[offset + 12u] = candidate.material; tiles[offset + 13u] = candidate.lod;
    let morphFlags = select(0u, 2u, logicalLod < maxMorphLod) | select(0u, 4u, logicalLod + 1u < maxMorphLod);
    tiles[offset + 14u] = (morphFlags | (u32(round(heightMorph * 8191.0)) << 3u)) << 16u;
    tiles[offset + 15u] = params.p[1].z;
    tiles[offset + 16u] = bitcast<u32>(origin.x + waveBody.waveOrigin.x);
    tiles[offset + 17u] = bitcast<u32>(origin.y + waveBody.waveOrigin.y);
    tiles[offset + 20u] = bitcast<u32>(views[viewIndex].observer.x - origin.x); tiles[offset + 21u] = bitcast<u32>(views[viewIndex].observer.z - origin.y);
    tiles[offset + 22u] = maxMorphLod;
    tiles[offset + 23u] = select(0u, u32(body.waveOrigin.w), candidate.transition == 0u);
  }
}

`
  );
}

export { TRAVERSAL as WATER_GPU_MESH_TRAVERSAL_WGSL, TYPES as WATER_GPU_MESH_WGSL_TYPES };
