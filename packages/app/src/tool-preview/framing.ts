export interface ToolPreviewCameraFrame {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly distance: number;
  readonly near: number;
  readonly far: number;
}

export function fitToolPreviewCameraToAabb(
  aabb: readonly [number, number, number, number, number, number],
  options: { readonly aspect: number; readonly fov: number; readonly padding?: number },
): ToolPreviewCameraFrame {
  const [minX, minY, minZ, maxX, maxY, maxZ] = aabb;
  if (
    ![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite) ||
    minX > maxX ||
    minY > maxY ||
    minZ > maxZ ||
    !Number.isFinite(options.aspect) ||
    options.aspect <= 0 ||
    !Number.isFinite(options.fov) ||
    options.fov <= 0 ||
    options.fov >= Math.PI
  ) {
    throw new TypeError('tool preview camera framing requires a finite AABB, aspect, and FOV');
  }
  const center: readonly [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const radius = Math.max(
    Math.hypot((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2),
    0.001,
  );
  const verticalHalfFov = options.fov / 2;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * options.aspect);
  const limitingHalfFov = Math.min(verticalHalfFov, horizontalHalfFov);
  const padding = options.padding ?? 1.15;
  if (!Number.isFinite(padding) || padding < 1) {
    throw new TypeError('tool preview camera framing padding must be finite and at least one');
  }
  const distance = (radius / Math.sin(limitingHalfFov)) * padding;
  const depthMargin = radius * (padding - 1);
  return {
    center,
    radius,
    distance,
    near: Math.max(0.001, distance - radius - depthMargin),
    far: distance + radius + depthMargin,
  };
}
