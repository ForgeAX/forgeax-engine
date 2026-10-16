/** Import-time enclosure of linear/step TRS animation, including the intervals between keys. */
export interface AnimatedBoundsNode {
  readonly parent: number | null;
  readonly translation: ArrayLike<number>;
  readonly rotation: ArrayLike<number>;
  readonly scale: ArrayLike<number>;
}
export interface AnimatedBoundsChannel {
  readonly node: number;
  readonly property: 'translation' | 'rotation' | 'scale';
  readonly values: ArrayLike<number>;
  readonly interpolation: 'LINEAR' | 'STEP';
}
export interface AnimatedBoundsMesh {
  readonly node: number;
  readonly positions: ArrayLike<number>;
  readonly joints: ArrayLike<number>;
  readonly weights: ArrayLike<number>;
  /** Absolute position-delta envelope across the imported morph weight closure. */
  readonly morphExtent?: ArrayLike<number>;
}
type Box = [number, number, number, number, number, number];
type Range = readonly [number, number];
const empty = (): Box => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
function union(out: Box, box: Box): void {
  for (let axis = 0; axis < 3; axis++) {
    out[axis] = Math.min(out[axis] ?? NaN, box[axis] ?? NaN);
    out[axis + 3] = Math.max(out[axis + 3] ?? NaN, box[axis + 3] ?? NaN);
  }
}
function multiply(a: Range, b: Range): Range {
  const values = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [Math.min(...values), Math.max(...values)];
}
function linear(box: Box, matrix: ArrayLike<number>, translation: ArrayLike<number>): Box {
  const out = empty();
  for (let axis = 0; axis < 3; axis++) {
    let lo = translation[axis] ?? NaN,
      hi = lo;
    for (let column = 0; column < 3; column++) {
      const coefficient = matrix[column * 3 + axis] ?? NaN;
      const range = multiply(
        [box[column] ?? NaN, box[column + 3] ?? NaN],
        [coefficient, coefficient],
      );
      lo += range[0];
      hi += range[1];
    }
    out[axis] = lo;
    out[axis + 3] = hi;
  }
  return out;
}
function rotationMatrix(q: ArrayLike<number>, inverse: boolean): number[] {
  const length = Math.hypot(q[0] ?? NaN, q[1] ?? NaN, q[2] ?? NaN, q[3] ?? NaN);
  if (!(length > 0)) return Array(9).fill(NaN);
  const sign = inverse ? -1 : 1;
  const x = ((q[0] ?? NaN) / length) * sign,
    y = ((q[1] ?? NaN) / length) * sign,
    z = ((q[2] ?? NaN) / length) * sign,
    w = (q[3] ?? NaN) / length;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ];
}
interface NodeEnvelope {
  readonly translation: readonly Range[];
  readonly scale: readonly Range[];
  readonly rotation: ArrayLike<number>;
  readonly animatedRotation: boolean;
}
function boxRadius(box: Box): number {
  return Math.hypot(
    ...[0, 1, 2].map((axis) =>
      Math.max(Math.abs(box[axis] ?? NaN), Math.abs(box[axis + 3] ?? NaN)),
    ),
  );
}
interface BoundedBox {
  readonly box: Box;
  readonly radius: number;
}
function transform(bound: BoundedBox, node: NodeEnvelope, inverse: boolean): BoundedBox {
  let out: Box = [...bound.box];
  let radius = bound.radius;
  const translate = (subtract: boolean): void => {
    radius += Math.hypot(
      ...node.translation.map((range) => Math.max(Math.abs(range[0]), Math.abs(range[1]))),
    );
    for (let axis = 0; axis < 3; axis++) {
      const range = node.translation[axis] ?? [NaN, NaN];
      out[axis] = (out[axis] ?? NaN) + (subtract ? -range[1] : range[0]);
      out[axis + 3] = (out[axis + 3] ?? NaN) + (subtract ? -range[0] : range[1]);
    }
  };
  const scale = (invert: boolean): void => {
    radius *= Math.max(
      ...node.scale.map((range) =>
        invert
          ? 1 / Math.min(Math.abs(range[0]), Math.abs(range[1]))
          : Math.max(Math.abs(range[0]), Math.abs(range[1])),
      ),
    );
    for (let axis = 0; axis < 3; axis++) {
      let range = node.scale[axis] ?? [NaN, NaN];
      if (invert)
        range = range[0] <= 0 && range[1] >= 0 ? [NaN, NaN] : [1 / range[1], 1 / range[0]];
      const result = multiply([out[axis] ?? NaN, out[axis + 3] ?? NaN], range);
      out[axis] = result[0];
      out[axis + 3] = result[1];
    }
  };
  const rotate = (): void => {
    if (node.animatedRotation) {
      // A unit-quaternion interpolation stays on the rotation group. Enclosing
      // the complete orbit avoids the missed extrema of frame/key sampling.
      radius = Math.min(radius, boxRadius(out));
      out = [-radius, -radius, -radius, radius, radius, radius];
    } else out = linear(out, rotationMatrix(node.rotation, inverse), [0, 0, 0]);
  };
  if (inverse) {
    translate(true);
    rotate();
    scale(true);
  } else {
    scale(false);
    rotate();
    translate(false);
  }
  return { box: out, radius: Math.min(radius, boxRadius(out)) };
}

/**
 * Encloses every imported clip and their convex TRS blends in each mesh's local
 * coordinates. Common ancestors cancel before interval propagation. Invalid,
 * singular or incomplete input has no certified bound; the caller retains its
 * explicit author metadata or the renderer's CPU deformation lane.
 */
export function deriveConservativeAnimatedBounds(input: {
  readonly nodes: readonly AnimatedBoundsNode[];
  readonly channels: readonly AnimatedBoundsChannel[];
  readonly jointNodes: readonly number[];
  readonly inverseBindMatrices: ArrayLike<number>;
  readonly meshes: readonly AnimatedBoundsMesh[];
}): Float32Array | undefined {
  const { nodes, channels, jointNodes, inverseBindMatrices, meshes } = input;
  if (
    jointNodes.length === 0 ||
    inverseBindMatrices.length !== jointNodes.length * 16 ||
    meshes.length === 0
  )
    return undefined;
  if (
    channels.some(
      (channel) => channel.interpolation !== 'LINEAR' && channel.interpolation !== 'STEP',
    )
  )
    return undefined;
  if (
    Array.from(inverseBindMatrices).some((value) => !Number.isFinite(value)) ||
    nodes.some(
      (node) =>
        [
          ...Array.from(node.translation),
          ...Array.from(node.scale),
          ...Array.from(node.rotation),
        ].some((value) => !Number.isFinite(value)) ||
        Math.hypot(...Array.from(node.rotation)) === 0,
    ) ||
    channels.some(
      (channel) =>
        nodes[channel.node] === undefined ||
        Array.from(channel.values).some((value) => !Number.isFinite(value)) ||
        channel.values.length % (channel.property === 'rotation' ? 4 : 3) !== 0,
    )
  )
    return undefined;
  const envelopes = nodes.map((node, index): NodeEnvelope => {
    const ranges = (property: 'translation' | 'scale'): Range[] =>
      [0, 1, 2].map((axis) => {
        let lo = node[property][axis] ?? NaN,
          hi = lo;
        for (const channel of channels)
          if (channel.node === index && channel.property === property) {
            if (channel.values.length % 3 !== 0) return [NaN, NaN];
            for (let key = axis; key < channel.values.length; key += 3) {
              lo = Math.min(lo, channel.values[key] ?? NaN);
              hi = Math.max(hi, channel.values[key] ?? NaN);
            }
          }
        return [lo, hi];
      });
    return {
      translation: ranges('translation'),
      scale: ranges('scale'),
      rotation: node.rotation,
      animatedRotation: channels.some(
        (channel) => channel.node === index && channel.property === 'rotation',
      ),
    };
  });
  const ancestry = (index: number): number[] | undefined => {
    const chain: number[] = [];
    let current: number | null = index;
    while (current !== null) {
      const node: AnimatedBoundsNode | undefined = nodes[current];
      if (node === undefined || chain.includes(current)) return undefined;
      chain.push(current);
      current = node.parent;
    }
    return chain;
  };
  const result = empty();
  for (const mesh of meshes) {
    const count = mesh.positions.length / 3;
    if (
      !Number.isInteger(count) ||
      mesh.joints.length !== count * 4 ||
      mesh.weights.length !== count * 4
    )
      return undefined;
    const meshChain = ancestry(mesh.node);
    if (meshChain === undefined) return undefined;
    const jointBoxes = jointNodes.map(empty);
    let minWeightSum = Infinity,
      maxWeightSum = 0;
    for (let vertex = 0; vertex < count; vertex++) {
      const p = [
        mesh.positions[vertex * 3] ?? NaN,
        mesh.positions[vertex * 3 + 1] ?? NaN,
        mesh.positions[vertex * 3 + 2] ?? NaN,
      ];
      if (!p.every(Number.isFinite)) return undefined;
      let sum = 0;
      for (let lane = 0; lane < 4; lane++) {
        const weight = mesh.weights[vertex * 4 + lane] ?? NaN;
        if (!Number.isFinite(weight) || weight < 0) return undefined;
        sum += weight;
        if (weight === 0) continue;
        const joint = mesh.joints[vertex * 4 + lane] ?? NaN;
        const box = jointBoxes[joint];
        if (!Number.isInteger(joint) || box === undefined) return undefined;
        const offset = joint * 16;
        const extent = [0, 1, 2].map((axis) => mesh.morphExtent?.[vertex * 3 + axis] ?? 0);
        if (!extent.every((value) => Number.isFinite(value) && value >= 0)) return undefined;
        const local = [
          ...p.map((value, axis) => value - (extent[axis] ?? NaN)),
          ...p.map((value, axis) => value + (extent[axis] ?? NaN)),
        ] as Box;
        const matrix = [0, 1, 2, 4, 5, 6, 8, 9, 10].map(
          (index) => inverseBindMatrices[offset + index] ?? NaN,
        );
        union(
          box,
          linear(local, matrix, [
            inverseBindMatrices[offset + 12] ?? NaN,
            inverseBindMatrices[offset + 13] ?? NaN,
            inverseBindMatrices[offset + 14] ?? NaN,
          ]),
        );
      }
      if (!(sum > 0)) return undefined;
      minWeightSum = Math.min(minWeightSum, sum);
      maxWeightSum = Math.max(maxWeightSum, sum);
    }
    const meshBounds = empty();
    for (let joint = 0; joint < jointNodes.length; joint++) {
      const jointBox = jointBoxes[joint];
      if (jointBox === undefined) return undefined;
      if (jointBox[0] === Infinity) continue;
      let bound: BoundedBox = { box: jointBox, radius: boxRadius(jointBox) };
      const jointChain = ancestry(jointNodes[joint] ?? NaN);
      if (jointChain === undefined) return undefined;
      const common = jointChain.find((index) => meshChain.includes(index));
      for (const index of jointChain) {
        if (index === common) break;
        const envelope = envelopes[index];
        if (envelope === undefined) return undefined;
        bound = transform(bound, envelope, false);
      }
      const inverseChain = meshChain.slice(
        0,
        common === undefined ? meshChain.length : meshChain.indexOf(common),
      );
      for (const index of inverseChain.reverse()) {
        const envelope = envelopes[index];
        if (envelope === undefined) return undefined;
        bound = transform(bound, envelope, true);
      }
      union(meshBounds, bound.box);
    }
    for (let axis = 0; axis < 3; axis++) {
      const range = multiply(
        [meshBounds[axis] ?? NaN, meshBounds[axis + 3] ?? NaN],
        [minWeightSum, maxWeightSum],
      );
      meshBounds[axis] = range[0];
      meshBounds[axis + 3] = range[1];
    }
    union(result, meshBounds);
  }
  if (!result.every(Number.isFinite)) return undefined;
  // Round outward through Float32 publication and accumulated transform error.
  const margin = Math.max(1, ...result.map(Math.abs)) * 1e-5;
  return Float32Array.from(result.map((value, index) => value + (index < 3 ? -margin : margin)));
}

/** Cubic Hermite intervals lie inside the convex hull of their Bezier control points. */
export function cubicValueEnvelope(
  input: ArrayLike<number>,
  output: ArrayLike<number>,
  width: number,
): Float32Array {
  const values = new Float32Array(input.length * width * 3);
  for (let key = 0; key < input.length; key++) {
    const before = key > 0 ? ((input[key] ?? NaN) - (input[key - 1] ?? NaN)) / 3 : 0;
    const after = key + 1 < input.length ? ((input[key + 1] ?? NaN) - (input[key] ?? NaN)) / 3 : 0;
    for (let c = 0; c < width; c++) {
      const base = key * width * 3 + c,
        value = output[base + width] ?? NaN;
      values[base] = value - before * (output[base] ?? NaN);
      values[base + width] = value;
      values[base + width * 2] = value + after * (output[base + width * 2] ?? NaN);
    }
  }
  return values;
}
