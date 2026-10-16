#define_import_path forgeax_material::terrain_vertex

// Admitted Terrain transforms are translation-only. A nondegenerate height
// triangle therefore has positive-Y outward geometry. Restore camera-facing
// orientation when a fragment derivative disagrees with its raster face.
// Zero Y cannot establish this height-surface orientation; do not route it
// using a shading fallback. The correction is idempotent.
fn terrainGeometryNormal(raw: vec3<f32>, frontFacing: bool) -> vec3<f32> {
  if (!(abs(raw.y) > 0.0)) { return vec3<f32>(0.0); }
  return raw * select(-1.0, 1.0, (raw.y > 0.0) == frontFacing);
}

// Only the original, nondegenerate outward triangle establishes the opaque
// height-surface ray proof. In particular, oct-decoded normals cannot route it.
fn terrainShadowLayerBase(rawCameraNormal: vec3<f32>, frontFacing: bool,
  lightDirection: vec3<f32>, family: f32, cascadeCount: f32, filterProfile: f32) -> u32 {
  let outward = terrainGeometryNormal(rawCameraNormal, frontFacing) * select(-1.0, 1.0, frontFacing);
  if (!(dot(outward, outward) > 0.0 &&
    dot(outward, -lightDirection) > 0.0 && cascadeCount > 0.0 && filterProfile < 4.0)) {
    return 0u;
  }
  return u32(family) * u32(cascadeCount);
}

// Grid identities and edge membership are integer facts; only UV and morph interpolate.
fn terrainEdgeLod(position: vec3<f32>, vertices: u32, drawMip: u32, lod: f32, neighbors: vec4<f32>) -> f32 {
  let grid = vec2<u32>(position.xz) >> vec2<u32>(drawMip);
  let last = (vertices >> drawMip) - 1u;
  var result = lod;
  if (grid.x == 0u) { result = max(result, neighbors.x); }
  if (grid.x == last) { result = max(result, neighbors.y); }
  if (grid.y == 0u) { result = max(result, neighbors.z); }
  if (grid.y == last) { result = max(result, neighbors.w); }
  return result;
}

// Recover the integer RG16 code before doing floating point height arithmetic.
// Anchor at the nearest endpoint to avoid cancelling a large minimum at q=65535.
fn terrainDecodeHeight(encoded: vec2<f32>, range: vec2<f32>) -> f32 {
  let bytes = vec2<u32>(round(encoded * 255.0));
  let q = (bytes.x << 8u) | bytes.y;
  if (q == 0u) { return range.x; }
  if (q == 65535u) { return range.y; }
  let step = (range.y - range.x) / 65535.0;
  if (q <= 32767u) { return range.x + f32(q) * step; }
  return range.y - f32(65535u - q) * step;
}

// GLSL ES 3.0 (WebGL2) has no findLSB, the GLSL form of firstTrailingBit. The
// isolated lowest bit is a power of two, so its f32 log2 is exact.
fn terrainLowestBit(value: u32) -> u32 {
  return u32(round(log2(f32(value & (0u - value)))));
}

// Both raster and shadow wrappers call this same two-mip Landscape kernel.
fn terrainVertex(position: vec3<f32>, heightMap: texture_2d<f32>, section: vec4<f32>,
    lod: vec4<f32>, neighbors: vec4<f32>) -> vec3<f32> {
  let vertices = u32(section.w);
  let vertexLod = terrainEdgeLod(position, vertices, u32(lod.x), lod.y, neighbors);
  let maxMip = terrainLowestBit(vertices) - 1u;
  let mip = min(u32(floor(vertexLod)), maxMip);
  let alpha = clamp(vertexLod - f32(mip), 0.0, 1.0);
  let n = vertices >> mip;
  let nextN = max(2u, n >> 1u);
  let currentGrid = vec2<u32>(position.xz) >> vec2<u32>(mip);
  let nextGrid = select(currentGrid >> vec2<u32>(1u), currentGrid, n <= 2u);
  let currentUv = vec2<f32>(currentGrid) / f32(n - 1u);
  let nextUv = vec2<f32>(nextGrid) / f32(nextN - 1u);
  let h0 = textureLoad(heightMap, vec2<i32>(currentGrid), i32(mip)).rg;
  let h1 = textureLoad(heightMap, vec2<i32>(nextGrid), i32(min(mip + 1u, maxMip))).rg;
  let a = terrainDecodeHeight(h0, lod.zw);
  let b = terrainDecodeHeight(h1, lod.zw);
  let xy = mix(currentUv, nextUv, alpha) * section.z + section.xy;
  return vec3<f32>(xy.x, mix(a, b, alpha), xy.y);
}

fn terrainNormal(position: vec3<f32>, heightMap: texture_2d<f32>, section: vec4<f32>, lod: vec4<f32>, neighbors: vec4<f32>) -> vec3<f32> {
  let vertices = u32(section.w);
  let vertexLod = terrainEdgeLod(position, vertices, u32(lod.x), lod.y, neighbors);
  let maxMip = terrainLowestBit(vertices) - 1u;
  let mip = min(u32(floor(vertexLod)), maxMip);
  let coord = vec2<u32>(position.xz) >> vec2<u32>(mip);
  let nextMip = min(mip + 1u, maxMip);
  let nextCoord = select(coord >> vec2<u32>(1u), coord, mip == nextMip);
  let xy = mix(textureLoad(heightMap, vec2<i32>(coord), i32(mip)).ba, textureLoad(heightMap, vec2<i32>(nextCoord), i32(nextMip)).ba, clamp(vertexLod - f32(mip), 0.0, 1.0)) * 2.0 - 1.0;
  return normalize(vec3<f32>(xy.x, sqrt(max(1e-6, 1.0-dot(xy,xy))), xy.y));
}
