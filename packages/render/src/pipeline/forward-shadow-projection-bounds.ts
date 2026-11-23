import { type Mat4, mat4 } from '@forgeax/engine-math';
import type { PointLightSnapshot, SpotLightSnapshot } from '../render-system-extract';

interface ClipBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nearest: number;
  volume?: 'front' | 'back';
}

function lane(data: ArrayLike<number>, index: number): number {
  return data[index] ?? NaN;
}

const viewport = { minX: -1, minY: -1, maxX: 1, maxY: 1, nearest: 1 };

function include(bounds: ClipBounds, x: number, y: number, z: number, w: number) {
  bounds.minX = Math.min(bounds.minX, x / w);
  bounds.minY = Math.min(bounds.minY, y / w);
  bounds.maxX = Math.max(bounds.maxX, x / w);
  bounds.maxY = Math.max(bounds.maxY, y / w);
  bounds.nearest = Math.max(bounds.nearest, z / w);
}

/** Clip the shadow frustum at the camera's reverse-Z near plane before division. */
function includeFrustum(cameraFromShadow: Mat4, corners: Float64Array, bounds: ClipBounds) {
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) === 0 ? -1 : 1;
    const y = (i & 2) === 0 ? -1 : 1;
    const z = i >> 2;
    for (let row = 0; row < 4; row++)
      corners[i * 4 + row] =
        lane(cameraFromShadow, row) * x +
        lane(cameraFromShadow, 4 + row) * y +
        lane(cameraFromShadow, 8 + row) * z +
        lane(cameraFromShadow, 12 + row);
  }
  let allInFront = true;
  for (let i = 0; i < 8; i++) {
    const a = i * 4;
    const distance = lane(corners, a + 3) - lane(corners, a + 2);
    allInFront &&= distance > 1e-6 && lane(corners, a + 3) > 1e-6;
    if (distance >= 0 && lane(corners, a + 3) > 0)
      include(
        bounds,
        lane(corners, a),
        lane(corners, a + 1),
        lane(corners, a + 2),
        lane(corners, a + 3),
      );
    for (const step of [1, 2, 4]) {
      if ((i & step) !== 0) continue;
      const b = (i | step) * 4;
      const other = lane(corners, b + 3) - lane(corners, b + 2);
      if (distance < 0 === other < 0) continue;
      const t = distance / (distance - other);
      const w = lane(corners, a + 3) + (lane(corners, b + 3) - lane(corners, a + 3)) * t;
      if (w > 0)
        include(
          bounds,
          lane(corners, a) + (lane(corners, b) - lane(corners, a)) * t,
          lane(corners, a + 1) + (lane(corners, b + 1) - lane(corners, a + 1)) * t,
          w,
          w,
        );
    }
  }
  if (allInFront) bounds.volume = 'front';
}

function pointBounds(light: PointLightSnapshot, matrix: Mat4): ClipBounds | undefined {
  const radius = 1.0001 / Math.sqrt(light.invRangeSquared);
  if (!Number.isFinite(radius)) return viewport;
  const center = (row: number) =>
    lane(matrix, row) * lane(light.position, 0) +
    lane(matrix, row + 4) * lane(light.position, 1) +
    lane(matrix, row + 8) * lane(light.position, 2) +
    lane(matrix, row + 12);
  const extent = (row: number) =>
    radius * Math.hypot(lane(matrix, row), lane(matrix, row + 4), lane(matrix, row + 8));
  const w = center(3);
  const radiusW = extent(3);
  if (w + radiusW <= 0) return undefined;
  // The icosahedron's outer radius is at most 1.26 times the actual range.
  const proxyInsideFar = center(2) > 1.26 * extent(2) + 1e-5;
  if (w - radiusW <= 1e-5) return proxyInsideFar ? { ...viewport, volume: 'back' } : viewport;
  const denominator = w * w - radiusW * radiusW;
  // The extrema are the two planes through the eye tangent to the sphere.
  // Solving in homogeneous clip space retains off-axis and orthographic View support.
  const axisBounds = (row: number): readonly [number, number] => {
    const numerator = center(row);
    const axisRadius = extent(row);
    const correlation =
      radius *
      radius *
      (lane(matrix, row) * lane(matrix, 3) +
        lane(matrix, row + 4) * lane(matrix, 7) +
        lane(matrix, row + 8) * lane(matrix, 11));
    const midpoint = numerator * w - correlation;
    const separation = Math.sqrt(
      Math.max(
        0,
        midpoint * midpoint - denominator * (numerator * numerator - axisRadius * axisRadius),
      ),
    );
    return [(midpoint - separation) / denominator, (midpoint + separation) / denominator];
  };
  const nearExtent =
    1.26 *
    radius *
    Math.hypot(
      lane(matrix, 3) - lane(matrix, 2),
      lane(matrix, 7) - lane(matrix, 6),
      lane(matrix, 11) - lane(matrix, 10),
    );
  const [minX, maxX] = axisBounds(0);
  const [minY, maxY] = axisBounds(1);
  const [, nearest] = axisBounds(2);
  const volume = w - center(2) > nearExtent + 1e-5 ? 'front' : proxyInsideFar ? 'back' : undefined;
  return { minX, minY, maxX, maxY, nearest, ...(volume === undefined ? {} : { volume }) };
}

export function prepareForwardShadowBounds() {
  const corners = new Float64Array(32);
  return (
    light: PointLightSnapshot | SpotLightSnapshot,
    worldToClip: Mat4,
    spotVolumes: readonly Mat4[],
    width: number,
    height: number,
  ) => {
    let bounds = light.kind === 'point' ? pointBounds(light, worldToClip) : undefined;
    if (light.kind === 'spot' && light.lightViewProj !== undefined) {
      if (light.authoredShadowMatrix === true) {
        // Author matrices may have unconventional homogeneous coordinates.
        bounds = viewport;
      } else {
        const fromShadow = spotVolumes[light.shadowAtlasTile];
        if (fromShadow === undefined) return undefined;
        bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, nearest: 0 };
        includeFrustum(fromShadow, corners, bounds);
      }
    }
    if (bounds === undefined) return undefined;
    const x = Math.max(0, Math.floor((bounds.minX * 0.5 + 0.5) * width) - 1);
    const y = Math.max(0, Math.floor((0.5 - bounds.maxY * 0.5) * height) - 1);
    const endX = Math.min(width, Math.ceil((bounds.maxX * 0.5 + 0.5) * width) + 1);
    const endY = Math.min(height, Math.ceil((0.5 - bounds.minY * 0.5) * height) + 1);
    if (!(endX > x && endY > y)) return undefined;
    return {
      x,
      y,
      width: endX - x,
      height: endY - y,
      depth: Math.min(1, Math.max(0, bounds.nearest + 1e-5)),
      volume: bounds.volume,
    };
  };
}

// Use the actual authored shadow frustum for projection admission. The
// unjittered view is padded by the same one-pixel guard as the final draw.
export function prepareForwardShadowVisibility(view: Mat4, projection: Mat4) {
  const worldToClip = mat4.multiply(mat4.create(), projection, view);
  const spotVolumes = Array.from({ length: 4 }, () => mat4.create());
  const shadowToWorld = mat4.create();
  const bounds = prepareForwardShadowBounds();
  return (light: PointLightSnapshot | SpotLightSnapshot, width: number, height: number) => {
    if (light.kind === 'spot' && light.authoredShadowMatrix !== true) {
      const volume = spotVolumes[light.shadowAtlasTile];
      if (volume === undefined || light.lightViewProj === undefined) return undefined;
      mat4.multiply(volume, worldToClip, mat4.invert(shadowToWorld, light.lightViewProj));
    }
    return bounds(light, worldToClip, spotVolumes, width, height);
  };
}
