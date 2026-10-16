/** Continuous screen-size selection, bounded by the actually resident mip range. */
export function terrainLod(
  projectedDiameter: number,
  lod0Diameter: number,
  maxLod: number,
): number {
  if (!Number.isFinite(projectedDiameter) || projectedDiameter <= 0) return maxLod;
  return Math.max(0, Math.min(maxLod, Math.log2(lod0Diameter / projectedDiameter)));
}

/** UE-style grid remap: both horizontal position and sampled height morph. */
export function terrainVertexCoordinates(
  x: number,
  z: number,
  vertices: number,
  drawLod: number,
  vertexLod: number,
): {
  readonly x: number;
  readonly z: number;
  readonly currentX: number;
  readonly currentZ: number;
  readonly nextX: number;
  readonly nextZ: number;
  readonly mip: number;
  readonly alpha: number;
} {
  const f = Math.fround;
  vertexLod = f(vertexLod);
  const mip = Math.min(Math.log2(vertices) - 1, Math.floor(vertexLod));
  const alpha = f(Math.min(1, Math.max(0, vertexLod - mip)));
  const n = vertices / 2 ** mip;
  const nn = Math.max(2, n / 2);
  const cx = Math.floor(x * 2 ** (drawLod - mip));
  const cz = Math.floor(z * 2 ** (drawLod - mip));
  const nx = Math.floor(cx / 2),
    nz = Math.floor(cz / 2);
  const currentX = f(cx / (n - 1)),
    currentZ = f(cz / (n - 1));
  const nextX = n === 2 ? currentX : f(nx / (nn - 1)),
    nextZ = n === 2 ? currentZ : f(nz / (nn - 1));
  return {
    x: f(f(currentX * f(1 - alpha)) + f(nextX * alpha)),
    z: f(f(currentZ * f(1 - alpha)) + f(nextZ * alpha)),
    currentX,
    currentZ,
    nextX,
    nextZ,
    mip,
    alpha,
  };
}
