import type { AnimationSampler, AnimationTransformChannel } from '@forgeax/engine-types';

/**
 * Sample an animation sampler at the given time.
 *
 * Returns an array of floats whose length matches the property element count:
 *   - translation / scale: 3 floats (vec3)
 *   - rotation: 4 floats (quat)
 * A supplied result is overwritten; omitted results remain independent arrays.
 */
export function sampleChannel(
  sampler: AnimationSampler,
  time: number,
  property: AnimationTransformChannel['property'],
  result: number[] = [],
): number[] | undefined {
  const { input, output, interpolation } = sampler;
  if (input.length === 0) return undefined;

  const cubic = interpolation === 'CUBICSPLINE';
  const elementCount = output.length / input.length / (cubic ? 3 : 1);
  const lastIdx = input.length - 1;
  if (time <= (input[0] as number) || time >= (input[lastIdx] as number)) {
    const key = time <= (input[0] as number) ? 0 : lastIdx;
    const base = (cubic ? key * 3 + 1 : key) * elementCount;
    result.length = Math.ceil(elementCount);
    for (let i = 0; i < elementCount; i++) result[i] = output[base + i] as number;
    return result;
  }

  // Binary search for the bracket.
  let lo = 0;
  let hi = input.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((input[mid] as number) <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const prev = lo;
  const next = hi;
  const prevBase = (cubic ? prev * 3 + 1 : prev) * elementCount;
  const nextBase = (cubic ? next * 3 + 1 : next) * elementCount;
  result.length = Math.ceil(elementCount);

  if (interpolation === 'STEP') {
    for (let i = 0; i < elementCount; i++) result[i] = output[prevBase + i] as number;
    return result;
  }

  // LINEAR interpolation.
  const t0 = input[prev] as number;
  const t1 = input[next] as number;
  const alpha = (time - t0) / (t1 - t0);

  if (cubic) {
    const a2 = alpha * alpha,
      a3 = a2 * alpha,
      dt = t1 - t0;
    for (let c = 0; c < elementCount; c++) {
      result[c] =
        (2 * a3 - 3 * a2 + 1) * (output[prevBase + c] as number) +
        (a3 - 2 * a2 + alpha) * dt * (output[(prev * 3 + 2) * elementCount + c] ?? 0) +
        (-2 * a3 + 3 * a2) * (output[nextBase + c] ?? 0) +
        (a3 - a2) * dt * (output[next * 3 * elementCount + c] ?? 0);
    }
    if (property === 'rotation') {
      const length = Math.hypot(...result);
      if (!(length > 0)) return undefined;
      for (let i = 0; i < result.length; i++) result[i] = (result[i] as number) / length;
    }
    return result;
  }

  if (property === 'rotation') {
    // Per-sampler quat slerp at the bracket level — multi-slot blending is
    // a separate stage (nlerp at the entity level, in advanceAnimationPlayer).
    const width = result.length;
    const px = width > 0 ? (output[prevBase] ?? 0) : 0;
    const py = width > 1 ? (output[prevBase + 1] ?? 0) : 0;
    const pz = width > 2 ? (output[prevBase + 2] ?? 0) : 0;
    const pw = width > 3 ? (output[prevBase + 3] ?? 1) : 1;
    let nx = width > 0 ? (output[nextBase] ?? 0) : 0;
    let ny = width > 1 ? (output[nextBase + 1] ?? 0) : 0;
    let nz = width > 2 ? (output[nextBase + 2] ?? 0) : 0;
    let nw = width > 3 ? (output[nextBase + 3] ?? 1) : 1;
    result.length = 4;
    let dot = px * nx + py * ny + pz * nz + pw * nw;
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      nw = -nw;
      dot = -dot;
    }
    if (dot > 0.9995) {
      // Near-parallel — fall back to nlerp to avoid sin(theta) -> 0 blowup.
      const lx = px + alpha * (nx - px);
      const ly = py + alpha * (ny - py);
      const lz = pz + alpha * (nz - pz);
      const lw = pw + alpha * (nw - pw);
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz + lw * lw);
      result[0] = len > 0 ? lx / len : 0;
      result[1] = len > 0 ? ly / len : 0;
      result[2] = len > 0 ? lz / len : 0;
      result[3] = len > 0 ? lw / len : 1;
      return result;
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const sa = Math.sin((1 - alpha) * theta) / sinTheta;
    const sb = Math.sin(alpha * theta) / sinTheta;
    result[0] = px * sa + nx * sb;
    result[1] = py * sa + ny * sb;
    result[2] = pz * sa + nz * sb;
    result[3] = pw * sa + nw * sb;
    return result;
  }

  for (let i = 0; i < elementCount; i++) {
    const value = output[prevBase + i] as number;
    result[i] = value + alpha * ((output[nextBase + i] ?? value) - value);
  }
  return result;
}
