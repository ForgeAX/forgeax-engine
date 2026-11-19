import type { TerrainAsset } from '@forgeax/engine-types';
import { requireWaterValue, type WaterDependencyMeshView } from '@forgeax/engine-water/internal';

/** Triangle vertices, capture metadata, three interpolated flow values, and alignment padding. */
export const WATER_INFO_TRIANGLE_STRIDE_FLOATS = 24;
export const WATER_INFO_TRIANGLE_STRIDE_BYTES = WATER_INFO_TRIANGLE_STRIDE_FLOATS * 4;

const WATER_INFO_MERGE_WGSL = /* wgsl */ `
struct Zone { values: array<vec4<u32>, 4> };
@group(0) @binding(0) var waterSource: texture_2d<f32>;
@group(0) @binding(1) var groundSource: texture_2d<f32>;
@group(0) @binding(2) var dilationSource: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> zones: array<Zone>;
@group(0) @binding(4) var output: texture_storage_2d<OUTPUT_FORMAT, write>;
fn normalizeRange(value: f32, minimum: f32, maximum: f32) -> f32 {
  return select(clamp((value - minimum) / max(maximum - minimum, 1e-6), 0.0, 1.0), 1.0, abs(maximum - minimum) <= 1e-6);
}
@compute @workgroup_size(8, 8, 1)
fn merge(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let zone = zones[0];
  let resolution = zone.values[0].xy;
  if (id.x >= resolution.x || id.y >= resolution.y) { return; }
  let ranges = bitcast<vec4<f32>>(zone.values[2]);
  let geometry = zone.values[3];
  let pixel = vec2<i32>(id.xy);
  let water = textureLoad(waterSource, pixel, 0);
  let groundDepth = textureLoad(groundSource, pixel, 0).r;
  let dilationDepth = textureLoad(dilationSource, pixel, 0).r;
  let captureZ = ranges.w;
  let groundY = select(ranges.z, max(captureZ - groundDepth, ranges.z), groundDepth > 0.0);
  let waterY = captureZ - water.b;
  let dilationY = captureZ - dilationDepth;
  let hasDilation = dilationY >= ranges.x && dilationY <= ranges.y;
  let hasWater = water.b > 0.0 && waterY >= ranges.x && waterY <= ranges.y && !(hasDilation && waterY + 1.28 < groundY);
  let groundNormalized = normalizeRange(groundY, ranges.z, ranges.y);
  if (hasWater) {
    let waterNormalized = normalizeRange(waterY, ranges.x, ranges.y);
    let maxVelocity = max(bitcast<f32>(geometry.w), 1e-6);
    let velocity = clamp(vec2<f32>(0.5) + water.rg / (2.0 * maxVelocity), vec2<f32>(0.0), vec2<f32>(1.0));
    textureStore(output, vec2<i32>(id.xy), vec4<f32>(velocity, waterNormalized, groundNormalized));
  } else if (hasDilation) {
    let mergedDilationY = select(dilationY, groundY - max(bitcast<f32>(geometry.z), 0.0), dilationY > groundY);
    let waterNormalized = normalizeRange(mergedDilationY, ranges.x, ranges.y);
    textureStore(output, vec2<i32>(id.xy), vec4<f32>(0.0, 0.0, waterNormalized, groundNormalized));
  } else {
    textureStore(output, vec2<i32>(id.xy), vec4<f32>(0.0, 0.0, 0.0, groundNormalized));
  }
}
`;

export function waterInfoMergeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return WATER_INFO_MERGE_WGSL.replace('OUTPUT_FORMAT', format);
}

const WATER_INFO_BLUR_WGSL = /* wgsl */ `
struct Zone { values: array<vec4<u32>, 4> };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> zones: array<Zone>;
@group(0) @binding(2) var output: texture_storage_2d<OUTPUT_FORMAT, write>;
@compute @workgroup_size(8, 8, 1)
fn blur(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let zone = zones[0];
  let resolution = zone.values[0].xy;
  if (id.x >= resolution.x || id.y >= resolution.y) { return; }
  let ranges = bitcast<vec4<f32>>(zone.values[2]);
  let radius = min(zone.values[0].z, 16u);
  let center = textureLoad(source, vec2<i32>(id.xy), 0);
  var sum = vec2<f32>(0.0);
  var count = 0.0;
  for (var y = -i32(radius); y <= i32(radius); y += 1) {
    for (var x = -i32(radius); x <= i32(radius); x += 1) {
      let q = clamp(
        vec2<i32>(id.xy) + vec2<i32>(x, y),
        vec2<i32>(0),
        vec2<i32>(resolution) - vec2<i32>(1),
      );
      let sample = textureLoad(source, q, 0);
      let groundY = sample.a * (ranges.y - ranges.z) + ranges.z;
      let waterY = sample.b * (ranges.y - ranges.x) + ranges.x;
      if (waterY > groundY) { sum += sample.rg; count += 1.0; }
    }
  }
  let velocity = select(center.rg, sum / max(count, 1.0), count > 0.0);
  textureStore(output, vec2<i32>(id.xy), vec4<f32>(velocity, center.ba));
}
`;

export function waterInfoBlurWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return WATER_INFO_BLUR_WGSL.replace('OUTPUT_FORMAT', format);
}

const WATER_INFO_FINALIZE_WGSL = /* wgsl */ `
struct Zone { values: array<vec4<u32>, 4> };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> zones: array<Zone>;
@group(0) @binding(2) var output: texture_storage_2d_array<OUTPUT_FORMAT, write>;
@compute @workgroup_size(8, 8, 1)
fn finalize(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let resolution = zones[0].values[0].xy;
  if (id.x >= resolution.x || id.y >= resolution.y) { return; }
  let value = textureLoad(source, vec2<i32>(id.xy), 0);
  textureStore(output, vec2<i32>(id.xy), i32(zones[0].values[0].w), value);
}
`;

export function waterInfoFinalizeWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return WATER_INFO_FINALIZE_WGSL.replace('OUTPUT_FORMAT', format);
}

const WATER_INFO_CLEAR_WGSL = /* wgsl */ `
@group(0) @binding(0) var output: texture_storage_2d_array<OUTPUT_FORMAT, write>;
@compute @workgroup_size(8, 8, 1)
fn clear(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(output);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(output, vec2<i32>(id.xy), i32(id.z), vec4<f32>(0.0));
}
`;

export function waterInfoClearWgsl(format: 'rgba16float' | 'rgba32float'): string {
  return WATER_INFO_CLEAR_WGSL.replace('OUTPUT_FORMAT', format);
}

export interface WaterInfoGpuZoneParams {
  readonly width: number;
  readonly height: number;
  readonly slice: number;
  readonly blurRadius: number;
  readonly centerXZ: readonly [number, number];
  readonly extentXZ: readonly [number, number];
  readonly waterYMinM: number;
  readonly waterYMaxM: number;
  readonly groundYMinM: number;
  readonly captureZM: number;
  readonly triangleOffset: number;
  readonly triangleCount: number;
  readonly undergroundDilationOffsetM: number;
  readonly maxVelocityMPerSec: number;
}

/** Storage-buffer ABI: four 16-byte lanes consumed by the WGSL Zone struct. */
export function encodeWaterInfoGpuZoneParams(params: WaterInfoGpuZoneParams): Uint32Array {
  const bytes = new ArrayBuffer(64);
  const data = new DataView(bytes);
  for (const [value, offset] of [
    [params.width, 0],
    [params.height, 4],
    [params.blurRadius, 8],
    [params.slice, 12],
  ] as const)
    data.setUint32(offset, value, true);
  for (const [value, offset] of [
    [params.centerXZ[0], 16],
    [params.centerXZ[1], 20],
    [params.extentXZ[0], 24],
    [params.extentXZ[1], 28],
    [params.waterYMinM, 32],
    [params.waterYMaxM, 36],
    [params.groundYMinM, 40],
    [params.captureZM, 44],
  ] as const)
    data.setFloat32(offset, value, true);
  data.setUint32(48, params.triangleOffset, true);
  data.setUint32(52, params.triangleCount, true);
  data.setFloat32(56, params.undergroundDilationOffsetM, true);
  data.setFloat32(60, params.maxVelocityMPerSec, true);
  return new Uint32Array(bytes);
}

export type WaterInfoTriangleKind = 'water' | 'dilation' | 'ground';

export interface WaterInfoTriangleSource {
  readonly mesh: WaterDependencyMeshView;
  readonly worldMatrixM: readonly number[];
  readonly kind: WaterInfoTriangleKind;
  readonly velocityXZ?: readonly [number, number];
  readonly flowXZByVertex?: Float32Array;
}

export interface WaterInfoTerrainSource {
  readonly terrain: TerrainAsset;
  readonly worldMatrixM: readonly number[];
}

const TRIANGLE_KIND: Record<WaterInfoTriangleKind, number> = { water: 0, dilation: 1, ground: 2 };

function transformPoint(
  matrix: readonly number[],
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  return [
    requireWaterValue(matrix[0]) * x +
      requireWaterValue(matrix[4]) * y +
      requireWaterValue(matrix[8]) * z +
      requireWaterValue(matrix[12]),
    requireWaterValue(matrix[1]) * x +
      requireWaterValue(matrix[5]) * y +
      requireWaterValue(matrix[9]) * z +
      requireWaterValue(matrix[13]),
    requireWaterValue(matrix[2]) * x +
      requireWaterValue(matrix[6]) * y +
      requireWaterValue(matrix[10]) * z +
      requireWaterValue(matrix[14]),
  ];
}

/** Flatten accepted source geometry into GPU triangles; no output pixels are generated on CPU. */
export function buildWaterInfoTriangleBuffer(
  sources: readonly WaterInfoTriangleSource[],
): Float32Array {
  const rows: number[] = [];
  for (const source of sources) {
    const positions = source.mesh.position;
    const indices = source.mesh.indices;
    if (source.worldMatrixM.length !== 16) continue;
    for (const submesh of source.mesh.submeshes) {
      if (submesh.topology !== 'triangle-list') continue;
      const start = submesh.indexOffset;
      const end = start + submesh.indexCount;
      if (start < 0 || end > indices.length || submesh.indexCount % 3 !== 0) continue;
      for (let index = start; index < end; index += 3) {
        const triangle: number[] = [];
        let valid = true;
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = requireWaterValue(indices[index + corner]);
          const offset = positions.offset + vertex * positions.stride;
          if (vertex >= positions.count) {
            valid = false;
            break;
          }
          const p = transformPoint(
            source.worldMatrixM,
            requireWaterValue(positions.data[offset]),
            requireWaterValue(positions.data[offset + 1]),
            requireWaterValue(positions.data[offset + 2]),
          );
          if (!p.every(Number.isFinite)) {
            valid = false;
            break;
          }
          triangle.push(p[0], p[1], p[2], 0);
        }
        if (!valid) continue;
        rows.push(
          ...triangle,
          TRIANGLE_KIND[source.kind],
          source.velocityXZ?.[0] ?? 0,
          source.velocityXZ?.[1] ?? 0,
          source.flowXZByVertex === undefined ? 0 : 1,
        );
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = requireWaterValue(indices[index + corner]);
          const flowOffset = vertex * 2;
          const hasFlow =
            source.flowXZByVertex !== undefined && flowOffset + 1 < source.flowXZByVertex.length;
          rows.push(
            hasFlow ? requireWaterValue(source.flowXZByVertex[flowOffset]) : 0,
            hasFlow ? requireWaterValue(source.flowXZByVertex[flowOffset + 1]) : 0,
          );
        }
        rows.push(0, 0);
      }
    }
  }
  return new Float32Array(rows);
}

/** Triangulate the accepted, version-matched top-view Landscape heightfield. */
export function appendWaterInfoTerrainTriangles(
  output: number[],
  source: WaterInfoTerrainSource,
): void {
  const { terrain, worldMatrixM: matrix } = source;
  if (
    terrain.columns < 2 ||
    terrain.rows < 2 ||
    !(terrain.spacing > 0) ||
    terrain.heights.length !== terrain.columns * terrain.rows ||
    matrix.length !== 16
  )
    return;
  const point = (x: number, z: number): readonly [number, number, number] => {
    const height = requireWaterValue(terrain.heights[z * terrain.columns + x]);
    return transformPoint(matrix, x * terrain.spacing, height, z * terrain.spacing);
  };
  for (let z = 0; z < terrain.rows - 1; z += 1)
    for (let x = 0; x < terrain.columns - 1; x += 1) {
      const a = point(x, z),
        b = point(x + 1, z),
        c = point(x, z + 1),
        d = point(x + 1, z + 1);
      for (const triangle of [
        [a, b, c],
        [b, d, c],
      ] as const) {
        for (const p of triangle) output.push(p[0], p[1], p[2], 0);
        output.push(TRIANGLE_KIND.ground, 0, 0, 0);
        output.push(0, 0, 0, 0, 0, 0, 0, 0);
      }
    }
}
