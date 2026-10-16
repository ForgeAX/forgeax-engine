import type { AnimationChannel, AnimationSampler } from '@forgeax/engine-types';

type ChannelKind = Exclude<AnimationChannel['property'], 'property'>;

/**
 * Sample an animation sampler at the given time.
 *
 * Returns an array of floats whose length matches the property element count:
 *   - translation / scale: 3 floats (vec3)
 *   - rotation: 4 floats (quat)
 */
export function sampleChannel(
  sampler: AnimationSampler,
  time: number,
  property: ChannelKind,
): number[] | undefined {
  const { input, output, interpolation } = sampler;
  if (input.length === 0) return undefined;

  const cubic = interpolation === 'CUBICSPLINE';
  const elementCount = output.length / input.length / (cubic ? 3 : 1);
  const valuesAt = (index: number) =>
    sliceOutput(output, cubic ? index * 3 + 1 : index, elementCount);

  // Clamp if before first key.
  if (time <= (input[0] as number)) {
    return valuesAt(0);
  }

  // Clamp if after last key.
  const lastIdx = input.length - 1;
  if (time >= (input[lastIdx] as number)) {
    return valuesAt(lastIdx);
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

  if (interpolation === 'STEP') {
    return valuesAt(prev);
  }

  // LINEAR interpolation.
  const t0 = input[prev] as number;
  const t1 = input[next] as number;
  const alpha = (time - t0) / (t1 - t0);

  const prevValues = valuesAt(prev);
  const nextValues = valuesAt(next);
  if (cubic) {
    const a2 = alpha * alpha,
      a3 = a2 * alpha,
      dt = t1 - t0;
    const result = prevValues.map(
      (value, c) =>
        (2 * a3 - 3 * a2 + 1) * value +
        (a3 - 2 * a2 + alpha) * dt * (output[(prev * 3 + 2) * elementCount + c] ?? 0) +
        (-2 * a3 + 3 * a2) * (nextValues[c] ?? 0) +
        (a3 - a2) * dt * (output[next * 3 * elementCount + c] ?? 0),
    );
    if (property === 'rotation') {
      const length = Math.hypot(...result);
      return length > 0 ? result.map((value) => value / length) : undefined;
    }
    return result;
  }

  if (property === 'rotation') {
    // Per-sampler quat slerp at the bracket level — multi-slot blending is
    // a separate stage (nlerp at the entity level, in advanceAnimationPlayer).
    const px = prevValues[0] ?? 0;
    const py = prevValues[1] ?? 0;
    const pz = prevValues[2] ?? 0;
    const pw = prevValues[3] ?? 1;
    let nx = nextValues[0] ?? 0;
    let ny = nextValues[1] ?? 0;
    let nz = nextValues[2] ?? 0;
    let nw = nextValues[3] ?? 1;
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
      return len > 0 ? [lx / len, ly / len, lz / len, lw / len] : [0, 0, 0, 1];
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const sa = Math.sin((1 - alpha) * theta) / sinTheta;
    const sb = Math.sin(alpha * theta) / sinTheta;
    return [px * sa + nx * sb, py * sa + ny * sb, pz * sa + nz * sb, pw * sa + nw * sb];
  }

  return prevValues.map((value, index) => value + alpha * ((nextValues[index] ?? value) - value));
}

function sliceOutput(output: Float32Array, index: number, elementCount: number): number[] {
  const result: number[] = [];
  const base = index * elementCount;
  for (let i = 0; i < elementCount; i++) {
    result.push(output[base + i] as number);
  }
  return result;
}
