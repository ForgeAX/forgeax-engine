import type { CameraSnapshot } from '../render-contract';

/** Rows per LOD chain; matches the GPU-driven view candidate capacity. */
export const LOD_PROJECTION_ROW_CAPACITY = 8;
/** Byte size of `LodViewConstants`: vec3 position + projection + heightScale, 16-aligned. */
export const LOD_VIEW_CONSTANTS_BYTES = 32;

export type LodViewCamera = Pick<
  CameraSnapshot,
  'position' | 'projection' | 'fov' | 'orthoTop' | 'orthoBottom'
>;

/**
 * Projection-dependent scale such that projected height is
 * `2 * radius * scale / depth` (perspective) or `2 * radius * scale`
 * (orthographic). Non-positive means the camera cannot rank LODs; the kernel
 * then reports an invalid height and selection falls back to the root.
 * Resolving `tan` on the host keeps the kernel free of the loose Vulkan
 * trigonometric precision bound.
 */
export function lodHeightScale(camera: LodViewCamera): number {
  if (camera.projection === 'perspective') {
    if (!Number.isFinite(camera.fov) || camera.fov <= 0) return 0;
    const scale = 1 / Math.tan(camera.fov / 2);
    return Number.isFinite(scale) && scale > 0 ? scale : 0;
  }
  const height = Math.abs(camera.orthoTop - camera.orthoBottom);
  return Number.isFinite(height) && height > 0 ? 1 / height : 0;
}

/**
 * Writes the WGSL `LodViewConstants` row at `byteOffset`. `clamp` marks the
 * reference row a shadow view bounds its own selection with.
 */
export function writeLodViewConstants(
  target: DataView,
  byteOffset: number,
  camera: LodViewCamera,
  clamp = false,
): void {
  target.setFloat32(byteOffset, camera.position[0] ?? 0, true);
  target.setFloat32(byteOffset + 4, camera.position[1] ?? 0, true);
  target.setFloat32(byteOffset + 8, camera.position[2] ?? 0, true);
  target.setUint32(byteOffset + 12, camera.projection === 'perspective' ? 0 : 1, true);
  target.setFloat32(byteOffset + 16, lodHeightScale(camera), true);
  target.setUint32(byteOffset + 20, clamp ? 1 : 0, true);
  target.setUint32(byteOffset + 24, 0, true);
  target.setUint32(byteOffset + 28, 0, true);
}

/**
 * Per-view LOD kernels. The including shader must declare the GPU Scene
 * `GpuSceneLod` row (`gpuSceneWgsl(GPU_SCENE_LAYOUTS.lod)`); row zero is the
 * root with coverage 1, row `n > 0` carries the absolute projected-height
 * threshold that introduces level `n`, and row zero's hysteresis governs the
 * chain. The functions are exact ports of the CPU references:
 * `projectedHeight` of `projectedHeightForCandidate` (the distance is measured
 * from the transformed local bounds centre), `selectLodLevel` of
 * `selectLod`, and `lodCrossfade` of `lodDraws`. An invalid height is reported
 * as a negative value because WGSL cannot portably produce or test NaN.
 */
export const LOD_PROJECTION_WGSL = /* wgsl */ `
const LOD_PROJECTION_PERSPECTIVE: u32 = 0u;
const LOD_PROJECTION_ORTHOGRAPHIC: u32 = 1u;
const LOD_INVALID_HEIGHT: f32 = -1.0;

struct LodViewConstants {
  cameraPosition: vec3<f32>,
  projection: u32,
  heightScale: f32,
  clamp: u32,
};

struct LodCrossfade {
  // When paired, draw (level, +fade) and (level + 1, -fade); otherwise draw
  // level with full coverage.
  level: u32,
  fade: f32,
  paired: bool,
};

fn lodFinite(value: f32) -> bool {
  return (bitcast<u32>(value) & 0x7f800000u) != 0x7f800000u;
}

fn projectedHeight(
  boundsMin: vec3<f32>,
  boundsMax: vec3<f32>,
  world: mat4x4<f32>,
  view: LodViewConstants,
) -> f32 {
  let half = abs(boundsMax - boundsMin) * 0.5;
  let worldHalf =
    abs(world[0].xyz) * half.x + abs(world[1].xyz) * half.y + abs(world[2].xyz) * half.z;
  let radius = length(worldHalf);
  let center = (world * vec4<f32>((boundsMin + boundsMax) * 0.5, 1.0)).xyz;
  let depth = length(center - view.cameraPosition);
  if (!lodFinite(radius) || radius <= 0.0 || !lodFinite(depth)) { return LOD_INVALID_HEIGHT; }
  if (!lodFinite(view.heightScale) || view.heightScale <= 0.0) { return LOD_INVALID_HEIGHT; }
  if (view.projection == LOD_PROJECTION_PERSPECTIVE) {
    if (depth <= 0.0) { return LOD_INVALID_HEIGHT; }
    return 2.0 * radius * view.heightScale / depth;
  }
  return 2.0 * radius * view.heightScale;
}

fn selectLodLevel(
  height: f32,
  previousLevel: u32,
  historyValid: bool,
  rows: array<GpuSceneLod, ${LOD_PROJECTION_ROW_CAPACITY}>,
  levelCount: u32,
) -> u32 {
  if (levelCount <= 1u || !lodFinite(height) || height <= 0.0) { return 0u; }
  let lowest = min(levelCount, ${LOD_PROJECTION_ROW_CAPACITY}u) - 1u;
  var selected = lowest;
  for (var level = 0u; level < lowest; level += 1u) {
    if (height >= rows[level + 1u].screenCoverage) {
      selected = level;
      break;
    }
  }
  if (historyValid && previousLevel <= lowest && selected != previousLevel) {
    // A downgrade crosses the threshold below the previous level; an upgrade
    // the one that introduced it. Both stay adjacent to the previous level
    // even when the raw choice jumps several levels.
    let hysteresis = clamp(rows[0].hysteresis, 0.0, 0.99);
    if (selected > previousLevel) {
      if (height >= rows[previousLevel + 1u].screenCoverage * (1.0 - hysteresis)) {
        selected = previousLevel;
      }
    } else if (height < rows[previousLevel].screenCoverage * (1.0 + hysteresis)) {
      selected = previousLevel;
    }
  }
  for (var level = selected; level > 0u; level -= 1u) {
    if (rows[level].ready != 0u) { return level; }
  }
  return 0u;
}

fn lodCrossfade(
  height: f32,
  rows: array<GpuSceneLod, ${LOD_PROJECTION_ROW_CAPACITY}>,
  levelCount: u32,
) -> LodCrossfade {
  let hysteresis = rows[0].hysteresis;
  if (lodFinite(height) && height > 0.0 && hysteresis > 0.0) {
    let lowest = min(levelCount, ${LOD_PROJECTION_ROW_CAPACITY}u) - 1u;
    for (var level = 0u; level < lowest; level += 1u) {
      let threshold = rows[level + 1u].screenCoverage;
      // Midpoints to both neighbouring thresholds bound the band, so even
      // dense authoring never admits three levels at once.
      var halfWidth = threshold * min(hysteresis, 0.99);
      if (level > 0u) {
        halfWidth = min(halfWidth, (rows[level].screenCoverage - threshold) * 0.5);
      }
      var next = 0.0;
      if (level + 1u < lowest) { next = rows[level + 2u].screenCoverage; }
      halfWidth = min(halfWidth, (threshold - next) * 0.5);
      if (
        halfWidth <= 0.0 ||
        height <= threshold - halfWidth ||
        height >= threshold + halfWidth
      ) {
        continue;
      }
      if (rows[level].ready == 0u || rows[level + 1u].ready == 0u) { break; }
      let fade = 0.5 + (threshold - height) / (2.0 * halfWidth);
      return LodCrossfade(level, fade, true);
    }
  }
  return LodCrossfade(selectLodLevel(height, 0u, false, rows, levelCount), 0.0, false);
}

// Finest level a view draws for a height: the paired cross-fade keeps its
// finer level.
fn lodFinestLevel(
  height: f32,
  crossfade: bool,
  rows: array<GpuSceneLod, ${LOD_PROJECTION_ROW_CAPACITY}>,
  levelCount: u32,
) -> u32 {
  if (crossfade) { return lodCrossfade(height, rows, levelCount).level; }
  return selectLodLevel(height, 0u, false, rows, levelCount);
}

// Lowest height that keeps a view within maxCoarser levels of reference:
// it clears the threshold introducing level reference + maxCoarser + 1 by the
// hysteresis band, so neither selection nor cross-fade reaches that level.
fn lodClampHeight(
  reference: u32,
  maxCoarser: u32,
  rows: array<GpuSceneLod, ${LOD_PROJECTION_ROW_CAPACITY}>,
  levelCount: u32,
) -> f32 {
  let level = reference + maxCoarser + 1u;
  if (level >= min(levelCount, ${LOD_PROJECTION_ROW_CAPACITY}u)) { return 0.0; }
  return rows[level].screenCoverage * (1.0 + rows[0].hysteresis);
}
`;
