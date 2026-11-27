/** Geometry controls author logical RGB/support/hit/measure rows independently
 * of the production packet. This codec transports those point samples; it is
 * not an oracle for the sampled cosine estimator or distribution mixtures.
 */
export function packPointRadiance(
  values: Float32Array,
  probes: number,
  first = 0,
  probeStride = 64 * 8,
): Float32Array {
  const pointFloats = SCREEN_PROBE_RADIANCE_BYTES / Float32Array.BYTES_PER_ELEMENT;
  const stride = probeStride + 64 * (pointFloats - 8);
  const packed = new Float32Array(probes * stride);
  const words = new Uint32Array(packed.buffer);
  for (let probe = 0; probe < probes; probe++) {
    packed.set(values.subarray(probe * probeStride, probe * probeStride + first), probe * stride);
    packed.set(
      values.subarray(probe * probeStride + first + 64 * 8, (probe + 1) * probeStride),
      probe * stride + first + 64 * pointFloats,
    );
    for (let texel = 0; texel < 64; texel++) {
      const src = first + probe * probeStride + texel * 8,
        dst = first + probe * stride + texel * pointFloats;
      packed.set(
        [
          values[src] ?? 0,
          values[src + 1] ?? 0,
          values[src + 2] ?? 0,
          values[src + 5] ?? 0,
          0,
          0,
          0,
          0,
          values[src + 3] ?? 0,
          values[src + 4] ?? 0,
        ],
        dst,
      );
      const u = Math.round((((texel % 8) + 0.5) / 8) * 1023),
        v = Math.round(((Math.floor(texel / 8) + 0.5) / 8) * 1023);
      words[dst + 4] = u | (v << 10);
    }
  }
  return packed;
}

function decodeDiagnosticDistribution(words: Uint32Array, src: number) {
  const vectors = Array.from({ length: 4 }, () => [0, 0, 0]);
  for (let i = 0; i < 4; i++) {
    const color = words[src + i * 2] ?? 0,
      word = words[src + i * 2 + 1] ?? 0,
      v = [(word << 22) >> 22, (word << 12) >> 22, (word << 2) >> 22].map((x) => (x * 4) / 511);
    const scale = 2 ** (Math.max(color >>> 24, 1) - 127) / 128,
      channels = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
    for (let c = 0; c < 4; c++)
      for (let a = 0; a < 3; a++) {
        const row = vectors[c];
        if (row)
          row[a] = (row[a] ?? 0) + (v[a] ?? 0) * (c === 3 ? 1 : (channels[c] ?? 0) * scale) * 0.25;
      }
  }
  const rgb = vectors.slice(0, 3).map((v) => Math.hypot(...v));
  const measure = Math.hypot(...(vectors[3] ?? []));

  return { rgb, measure };
}

/** Decode geometry-control point values into logical rows. Distribution output
 * uses its directional first moments for diagnostic amplitude fields only;
 * physical correctness is checked by independent query-time quadrature.
 */
export function unpackRadianceAmplitudes(
  values: Float32Array,
  probes: number,
  first = 0,
  probeStride = 64 * 8,
): void {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  const bits = new Uint32Array(1),
    f32 = new Float32Array(bits.buffer),
    pointFloats = SCREEN_PROBE_RADIANCE_BYTES / Float32Array.BYTES_PER_ELEMENT;
  const srcStride = probeStride + 64 * (pointFloats - 8);
  for (let probe = 0; probe < probes; probe++) {
    values.copyWithin(probe * probeStride, probe * srcStride, probe * srcStride + first);
    for (let texel = 0; texel < 64; texel++) {
      const src = first + probe * srcStride + texel * pointFloats,
        dst = first + probe * probeStride + texel * 8;
      const metadata = words[src + 8] ?? 0,
        isSet = ((words[src + 7] ?? 0) & 0x80000000) !== 0;
      bits[0] = metadata;
      const age = f32[0] ?? NaN,
        hit = values[src + 9] ?? NaN;
      let rgb = Array.from(values.slice(src, src + 3)),
        measure = values[src + 3] ?? NaN;
      if ((words[src + 7] ?? 0) >>> 30 === 3) {
        const m = readResidualMoments(values, src);
        rgb = m.slice(0, 3).map((v) => Math.hypot(...v));
        measure = Math.hypot(...(m[3] ?? []));
      } else if (isSet) {
        ({ rgb, measure } = decodeDiagnosticDistribution(words, src));
      }
      if (isSet && age <= 0) {
        rgb = [0, 0, 0];
      }
      values.set([rgb[0] ?? NaN, rgb[1] ?? NaN, rgb[2] ?? NaN, age, hit, measure, 0, 0], dst);
    }
    values.copyWithin(
      probe * probeStride + first + 64 * 8,
      probe * srcStride + first + 64 * pointFloats,
      (probe + 1) * srcStride,
    );
  }
}

/** Independently authored physical directions/colors for a four-sample cell. */
export function writeDistributionSamples(
  data: Float32Array,
  offset: number,
  probe: number,
  texel: number,
): void {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length),
    age = words[offset + 8] ?? 0;
  for (let sample = 0; sample < 4; sample++) {
    const x = ((texel % 8) + 0.25 + 0.5 * (sample & 1)) / 4 - 1,
      y = (Math.floor(texel / 8) + 0.25 + 0.5 * (sample >> 1)) / 4 - 1,
      z = 1 - Math.abs(x) - Math.abs(y);
    const raw = [
        z < 0 ? (1 - Math.abs(y)) * (x < 0 ? -1 : 1) : x,
        z < 0 ? (1 - Math.abs(x)) * (y < 0 ? -1 : 1) : y,
        z,
      ],
      length = Math.hypot(...raw),
      direction = raw.map((v) => v / length),
      jacobian = direction.reduce((s, v) => s + Math.abs(v), 0) ** 3;
    const rgb = [
      0.25 + probe * 0.4 + sample * 0.15,
      0.7 + probe * 0.2 + sample * 0.31,
      sample === 1 ? 0 : 1 + probe * 0.13 + sample * 0.23,
    ];
    const exponent = Math.floor(Math.log2(Math.max(...rgb))),
      scale = 2 ** exponent;
    const m = rgb.map((v) => Math.round((v / scale) * 128));
    if (m.some((v) => v > 255))
      throw Error('Fixture RGB exponent boundary requires explicit rounding');
    words[offset + sample * 2] =
      ((exponent + 127) << 24) | ((m[0] ?? 0) << 16) | ((m[1] ?? 0) << 8) | (m[2] ?? 0);
    const v = direction.map((d) => Math.round(((d * jacobian) / 4) * 511) & 1023);
    words[offset + sample * 2 + 1] = (v[0] ?? 0) | ((v[1] ?? 0) << 10) | ((v[2] ?? 0) << 20);
  }
  words[offset + 3] = ((words[offset + 3] ?? 0) & 0x3fffffff) | (3 << 30);
  words[offset + 5] = (words[offset + 5] ?? 0) & 0x3fffffff;
  words[offset + 7] = ((words[offset + 7] ?? 0) & 0x3fffffff) | 0x80000000;
  words[offset + 8] = age;
  data[offset + 9] = -1;
}

export function distributionPhase(
  pixel: number,
  texel: number,
  stage: number,
  depth = 1,
  frameIndex = 0,
): number {
  const hash = (x: number) => {
    let v = (Math.imul(x, 747796405) + 2891336453) >>> 0;
    v = Math.imul((v >>> ((v >>> 28) + 4)) ^ v, 277803737) >>> 0;
    return ((v >>> 22) ^ v) >>> 0;
  };
  return (hash(pixel ^ hash(frameIndex + stage) ^ hash(texel + depth * 64)) >>> 8) / 16777216;
}

/** Flat inverse-CDF reference, independent of the kernel's two-level PPS selection. */
function sampleAxisCodes(vector: number[]): Set<number> {
  const total = vector.reduce((sum, value) => sum + Math.abs(value), 0);
  let x = (vector[0] ?? NaN) / total,
    y = (vector[1] ?? NaN) / total;
  if ((vector[2] ?? NaN) < 0) {
    const u = (1 - Math.abs(y)) * Math.sign(x || 1);
    y = (1 - Math.abs(x)) * Math.sign(y || 1);
    x = u;
  }
  // Sixteen f32 operations bound a genuine rounding-boundary ambiguity.
  const error = 16 * 2 ** -23 * 1023;
  const possible = (value: number) =>
    [Math.floor(value + 0.5 - error), Math.floor(value + 0.5 + error)].map((code) =>
      Math.max(0, Math.min(1023, code)),
    );
  const codes = new Set<number>();
  for (const u of possible((x * 0.5 + 0.5) * 1023))
    for (const v of possible((y * 0.5 + 0.5) * 1023)) codes.add(u | (v << 10));
  return codes;
}
function residualLineage(
  inputs: readonly { data: Float32Array; offset: number; weight: number }[],
  phase: number,
) {
  const candidates: { color: number; axes: Set<number>; mass: number }[] = [];
  let totalWeight = 0;
  for (const input of inputs) {
    const words = new Uint32Array(input.data.buffer, input.data.byteOffset, input.data.length);
    if ((words[input.offset + 7] ?? 0) >>> 30 !== 2)
      throw Error('This geometry-mixture control requires independently authored refined packets');
    const count = ((words[input.offset + 3] ?? 0) >>> 30) + 1;
    totalWeight += input.weight;
    for (let i = 0; i < count; i++) {
      const word = words[input.offset + i * 2 + 1] ?? 0;
      const vector = [(word << 22) >> 22, (word << 12) >> 22, (word << 2) >> 22].map(
        (v) => (v * 4) / 511,
      );
      candidates.push({
        color: words[input.offset + i * 2] ?? 0,
        axes: sampleAxisCodes(vector),
        mass: (input.weight * Math.hypot(...vector)) / count,
      });
    }
  }
  const totalMass = candidates.reduce((sum, candidate) => sum + candidate.mass, 0);
  const position = phase * totalMass,
    rounding = 64 * 2 ** -23 * totalMass;
  const possible = [];
  let start = 0;
  for (const candidate of candidates) {
    if (position >= start - rounding && position <= start + candidate.mass + rounding)
      possible.push(candidate);
    start += candidate.mass;
  }
  return { possible, mass: totalMass / totalWeight };
}

/** Independent decoding of residual-packet linear statistics: global 12-bit axes and 16-bit positive amplitudes. */
export function readResidualMoments(data: Float32Array, offset: number): number[][] {
  const w = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const a = w[offset] ?? 0,
    b = w[offset + 1] ?? 0,
    c = w[offset + 2] ?? 0;
  const d = w[offset + 3] ?? 0,
    e = w[offset + 4] ?? 0;
  const amplitudes = [a & 65535, (b >>> 8) & 65535, c >>> 16, (d >>> 24) | ((e & 255) << 8)];
  const codes = [
    (a >>> 16) | ((b & 255) << 16),
    (b >>> 24) | ((c & 65535) << 8),
    d & 0xffffff,
    e >>> 8,
  ];
  return codes.map((code, channel) => {
    const x = ((code & 4095) * 2) / 4095 - 1,
      y = ((code >>> 12) * 2) / 4095 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    const v = [
      z < 0 ? (1 - Math.abs(y)) * Math.sign(x || 1) : x,
      z < 0 ? (1 - Math.abs(x)) * Math.sign(y || 1) : y,
      z,
    ];
    const amplitude =
      new Float32Array(Uint32Array.of((amplitudes[channel] ?? 0) << 15).buffer)[0] ?? NaN;
    const length = Math.hypot(...v);
    return v.map((value) => (value / length) * amplitude);
  });
}

function sampledInputMoments(
  inputs: readonly { data: Float32Array; offset: number; weight: number }[],
) {
  const moments = Array.from({ length: 4 }, () => [0, 0, 0]),
    bounds = [0, 0, 0, 0],
    total = inputs.reduce((s, v) => s + v.weight, 0);
  for (const input of inputs) {
    const w = new Uint32Array(input.data.buffer, input.data.byteOffset, input.data.length);
    for (let i = 0; i < 4; i++) {
      const color = w[input.offset + i * 2] ?? 0,
        word = w[input.offset + i * 2 + 1] ?? 0,
        scale = 2 ** ((color >>> 24) - 127) / 128;
      if (color >= 0xfffffffe)
        throw Error('The complete mixture fixture contains an unknown color');
      const rgb = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255].map((v) => v * scale),
        vector = [(word << 22) >> 22, (word << 12) >> 22, (word << 2) >> 22].map(
          (v) => (v * 4) / 511,
        );
      for (let c = 0; c < 4; c++) {
        const weight = (input.weight / total / 4) * (c === 3 ? 1 : (rgb[c] ?? NaN)),
          row = moments[c];
        if (!row) throw Error('Moment channel missing');
        for (let axis = 0; axis < 3; axis++)
          row[axis] = (row[axis] ?? NaN) + (vector[axis] ?? NaN) * weight;
        bounds[c] = (bounds[c] ?? NaN) + Math.hypot(...vector) * Math.abs(weight);
      }
    }
  }
  return { moments, bounds };
}

/** Check exact sample ancestry and linear-statistics error independently. */
export function verifyMixturePacket(
  data: Float32Array,
  offset: number,
  texel: number,
  inputs: readonly { data: Float32Array; offset: number; weight: number }[],
  phase: number,
): number[] {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
  if ((words[offset + 7] ?? 0) >>> 30 !== 3)
    throw Error('Mixture must retain linear statistics and a residual sample');
  if ((((words[offset + 7] ?? 0) >>> 20) & 63) !== texel)
    throw Error('Mixture angular cell changed');
  const lineage = residualLineage(inputs, phase),
    color = words[offset + 5] ?? 0,
    axis = (words[offset + 7] ?? 0) & 0xfffff,
    mass = data[offset + 6] ?? NaN;
  if (!lineage.possible.some((candidate) => candidate.color === color && candidate.axes.has(axis)))
    throw Error('Residual sample differs from the independent flat PPS distribution');
  if (!(Math.abs(mass - lineage.mass) <= 32 * 2 ** -23 * lineage.mass))
    throw Error('Mixture angular mass is not the convex input mean');
  const actual = readResidualMoments(data, offset),
    reference = sampledInputMoments(inputs),
    result = [mass];
  for (let c = 0; c < 4; c++) {
    const row = actual[c],
      expected = reference.moments[c];
    if (!row || !expected) throw Error('Linear statistic channel missing');
    const error = Math.hypot(...row.map((value, index) => value - (expected[index] ?? NaN)));
    // Global axis rounding and positive amplitude rounding have independent bounds.
    const bound = Math.max(
      (reference.bounds[c] ?? NaN) * ((2 * Math.sqrt(18)) / 4095 + 2 ** -9 + 8e-6),
      2 ** -135,
    );
    if (!(error <= bound)) throw Error(`Linear statistic error ${error} exceeds ${bound}`);
    result.push(error, bound);
  }
  return result;
}

import { SCREEN_PROBE_RADIANCE_BYTES } from '../../raytracing/screen-probe-plan';
