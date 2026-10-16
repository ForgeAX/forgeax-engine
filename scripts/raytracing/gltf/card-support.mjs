import assert from 'node:assert/strict';

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const normalize = (v) => {
  const length = Math.hypot(...v);
  assert(Number.isFinite(length) && length > 1e-10, 'degenerate Card normal');
  return v.map((x) => x / length);
};
const oct = ([x, y]) => {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0)
    [x, y] = [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
  return normalize([x, y, z]);
};

/** Independent, double-precision inspection of the GPU-selected support only.
 * Numeric slack is reported separately; it does not expand the runtime policy.
 * This does not reproduce candidate selection or establish a geometric first hit.
 */
export function inspectCardSupport({
  projection,
  position,
  hitNormal,
  allowance,
  resolution,
  width,
  card,
  texels,
  weights,
  readNormal,
  readDepth,
  outputNormalDepth,
}) {
  assert(
    [...projection, ...position, ...hitNormal, allowance, ...weights, ...outputNormalDepth].every(
      Number.isFinite,
    ),
    'nonfinite Card support input',
  );
  const u = projection.slice(4, 7),
    v = projection.slice(8, 11),
    n = projection.slice(12, 15);
  const size = [projection[7], projection[11]],
    depthScale = projection[15];
  assert(size.every((x) => x > 0) && depthScale > 0 && allowance >= 0);
  const rel = position.map((x, i) => x - projection[i]);
  const uv = [dot(rel, u) / size[0], dot(rel, v) / size[1]];
  const edgeDistance = Math.hypot(...uv.map((x, i) => (x - Math.max(0, Math.min(1, x))) * size[i]));
  const projectedDepth = -dot(rel, n) / depthScale;
  const pixelRadius = (0.5 * Math.hypot(...size)) / resolution;
  const depthTolerance = allowance + pixelRadius + depthScale / 1024;
  // Covers f32 projection/dot arithmetic; a borderline result stays visible.
  const numericSlack =
    16 * 2 ** -23 * Math.max(1, ...position.map(Math.abs), ...projection.map(Math.abs));
  const cardAlignment = dot(hitNormal, n);
  assert(cardAlignment >= 0.5 - 2e-6, 'Card orientation rejects selected support');
  assert(edgeDistance <= allowance + numericSlack, 'Card silhouette rejects selected support');
  const xy = uv.map((x) => Math.max(0, Math.min(resolution - 1, x * resolution - 0.5)));
  const columns = width / resolution,
    tile = [(card % columns) * resolution, Math.floor(card / columns) * resolution];
  const normal = [0, 0, 0],
    samplePosition = [0, 0, 0],
    taps = [];
  let depth = 0;
  for (let tap = 0; tap < 4; tap++) {
    if (weights[tap] === 0) continue;
    const pixel = texels[tap],
      local = [(pixel % width) - tile[0], Math.floor(pixel / width) - tile[1]];
    // The neighborhood can change at an integer boundary after f32 rounding.
    for (let axis = 0; axis < 2; axis++)
      assert(
        local[axis] >= 0 &&
          local[axis] < resolution &&
          Math.abs(local[axis] - xy[axis]) <= 1 + (numericSlack * resolution) / size[axis],
        'selected texel lies outside the bilinear neighborhood',
      );
    const frame = readNormal(pixel),
      sampleDepth = readDepth(pixel);
    assert([...frame, sampleDepth].every(Number.isFinite), 'nonfinite Card atlas sample');
    const geometricAlignment = dot(oct(frame.slice(2, 4)), hitNormal);
    const depthError = Math.abs(projectedDepth - sampleDepth) * depthScale;
    assert(geometricAlignment >= 0.5 - 2e-6, 'Card geometric normal rejects selected support');
    assert(depthError <= depthTolerance + numericSlack, 'Card depth rejects selected support');
    const shading = oct(frame.slice(0, 2));
    // Texel centers and raster depth locate the actual sampled surface. The
    // query position can be on a different layer even when support is admitted.
    const tapPosition = projection
      .slice(0, 3)
      .map(
        (origin, axis) =>
          origin +
          u[axis] * ((local[0] + 0.5) / resolution) * size[0] +
          v[axis] * ((local[1] + 0.5) / resolution) * size[1] -
          n[axis] * sampleDepth * depthScale,
      );
    for (let axis = 0; axis < 3; axis++) {
      normal[axis] += shading[axis] * weights[tap];
      samplePosition[axis] += tapPosition[axis] * weights[tap];
    }
    depth += sampleDepth * weights[tap];
    taps.push({
      pixel,
      weight: weights[tap],
      geometricAlignment,
      depthError,
      samplePosition: tapPosition,
    });
  }
  assert(taps.length > 0);
  const expected = [...normalize(normal), depth];
  const reconstructionError = Math.max(
    ...expected.map((x, i) => Math.abs(x - outputNormalDepth[i])),
  );
  assert(reconstructionError <= 3e-6, 'Card shading normal or depth reconstruction mismatch');
  return {
    uv,
    projectedDepth,
    cardAlignment,
    edgeDistance,
    allowance,
    pixelRadius,
    depthTolerance,
    numericSlack,
    borderline:
      cardAlignment < 0.5 ||
      edgeDistance > allowance ||
      taps.some((tap) => tap.geometricAlignment < 0.5 || tap.depthError > depthTolerance),
    reconstructionError,
    samplePosition,
    taps,
  };
}
