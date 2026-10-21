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

// RGBA8 stores little-endian IEEE f32 bytes. Filtering encoded channels would
// change their bits, so both raster and shadow paths exclusively textureLoad.
fn terrainDecodeHeight(encoded: vec4<f32>) -> f32 {
  let bytes = vec4<u32>(round(encoded * 255.0));
  return bitcast<f32>(bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u));
}

fn terrainSectionIndex(section: vec4<f32>, sectionCounts: vec2<f32>) -> vec2<u32> {
  // The author sample budget bounds each coordinate below 2^21, keeping the
  // f32 position/width round trip within half an integer even on long strips.
  return min(vec2<u32>(round(section.xy / section.z)), vec2<u32>(sectionCounts) - vec2<u32>(1u));
}

fn terrainHeightAt(heightMap: texture_2d<f32>, sectionIndex: vec2<u32>, coordinate: vec2<u32>,
    vertices: u32, mip: u32, sectionCounts: vec2<f32>) -> f32 {
  let size = vertices >> mip;
  let tileColumns = textureDimensions(heightMap, i32(mip)).x / size;
  let index = sectionIndex.y * u32(sectionCounts.x) + sectionIndex.x;
  let tile = vec2<u32>(index % tileColumns, index / tileColumns);
  return terrainDecodeHeight(textureLoad(heightMap, vec2<i32>(tile * size + coordinate), i32(mip)));
}

// Convert a global mip-grid coordinate into one canonical section endpoint.
// Crossing a tile skips its duplicated edge, including the coarsest 2x2 grid.
fn terrainNeighborHeight(heightMap: texture_2d<f32>, global: vec2<i32>, vertices: u32,
    mip: u32, sectionCounts: vec2<f32>) -> f32 {
  let quads = (vertices >> mip) - 1u;
  let last = vec2<u32>(sectionCounts) * quads;
  let point = vec2<u32>(clamp(global, vec2<i32>(0), vec2<i32>(last)));
  let sectionIndex = min(point / quads, vec2<u32>(sectionCounts) - vec2<u32>(1u));
  return terrainHeightAt(heightMap, sectionIndex, point - sectionIndex * quads, vertices, mip, sectionCounts);
}

fn terrainNormalAt(heightMap: texture_2d<f32>, section: vec4<f32>, coordinate: vec2<u32>,
    mip: u32, sectionCounts: vec2<f32>) -> vec3<f32> {
  let vertices = u32(section.w);
  let quads = (vertices >> mip) - 1u;
  let point = vec2<i32>(terrainSectionIndex(section, sectionCounts) * quads + coordinate);
  let last = vec2<i32>(vec2<u32>(sectionCounts) * quads);
  let left = max(point.x - 1, 0);
  let right = min(point.x + 1, last.x);
  let top = max(point.y - 1, 0);
  let bottom = min(point.y + 1, last.y);
  let hL = terrainNeighborHeight(heightMap, vec2<i32>(left, point.y), vertices, mip, sectionCounts);
  let hR = terrainNeighborHeight(heightMap, vec2<i32>(right, point.y), vertices, mip, sectionCounts);
  let hT = terrainNeighborHeight(heightMap, vec2<i32>(point.x, top), vertices, mip, sectionCounts);
  let hB = terrainNeighborHeight(heightMap, vec2<i32>(point.x, bottom), vertices, mip, sectionCounts);
  let step = section.z / f32(quads);
  // Scale before subtraction: opposite finite f32 heights may have a span
  // greater than f32::MAX. The normalization is invariant under this scale.
  let scale = max(max(max(abs(hL), abs(hR)), max(abs(hT), abs(hB))), step);
  let dx = (hR / scale - hL / scale) / f32(right - left);
  let dz = (hB / scale - hT / scale) / f32(bottom - top);
  if (dx == 0.0 && dz == 0.0) { return vec3<f32>(0.0, 1.0, 0.0); }
  let normal = vec3<f32>(-dx, step / scale, -dz);
  return normalize(normal / max(max(abs(normal.x), abs(normal.y)), abs(normal.z)));
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
  let sectionIndex = terrainSectionIndex(section, lod.zw);
  let a = terrainHeightAt(heightMap, sectionIndex, currentGrid, vertices, mip, lod.zw);
  let b = terrainHeightAt(heightMap, sectionIndex, nextGrid, vertices, min(mip + 1u, maxMip), lod.zw);
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
  let a = terrainNormalAt(heightMap, section, coord, mip, lod.zw);
  let b = terrainNormalAt(heightMap, section, nextCoord, nextMip, lod.zw);
  return normalize(mix(a, b, clamp(vertexLod - f32(mip), 0.0, 1.0)));
}
