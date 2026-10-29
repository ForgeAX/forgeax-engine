import { err, ok, type Result } from '@forgeax/engine-types';

/** Artifact key holding every numeric sampler array of one animation clip. */
export const ANIMATION_CLIP_SAMPLES_ARTIFACT = 'animation-clip/samples.bin' as const;

/** Element window into the clip's little-endian f32 samples artifact. */
export interface AnimationClipSampleWindow {
  readonly offset: number;
  readonly count: number;
}

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value: unknown): ArrayLike<number> | undefined {
  if (value instanceof Float32Array) return value;
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number')
    ? value
    : undefined;
}

function window(value: unknown): value is AnimationClipSampleWindow {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.offset) &&
    Number.isSafeInteger(value.count) &&
    (value.offset as number) >= 0 &&
    (value.count as number) > 0
  );
}

function mapSamplers(
  payload: Record<string, unknown>,
  map: (value: unknown) => unknown,
): Record<string, unknown> {
  if (!Array.isArray(payload.channels)) return payload;
  return {
    ...payload,
    channels: payload.channels.map((channel: unknown) => {
      if (!record(channel) || !record(channel.sampler)) return channel;
      const { input, output } = channel.sampler;
      return {
        ...channel,
        sampler: { ...channel.sampler, input: map(input), output: map(output) },
      };
    }),
  };
}

/**
 * Move numeric sampler arrays into one f32 artifact so the Pack document keeps only
 * channel structure. String and boolean property outputs stay inline.
 */
export function encodeAnimationClipSamples(
  payload: Record<string, unknown>,
): { readonly payload: Record<string, unknown>; readonly bytes: Uint8Array } | undefined {
  const arrays: ArrayLike<number>[] = [];
  let count = 0;
  const encoded = mapSamplers(payload, (value) => {
    const values = numeric(value);
    if (values === undefined) return value;
    const sampleWindow: AnimationClipSampleWindow = { offset: count, count: values.length };
    arrays.push(values);
    count += values.length;
    return sampleWindow;
  });
  if (arrays.length === 0) return undefined;
  const samples = new Float32Array(count);
  let offset = 0;
  for (const values of arrays) {
    samples.set(values, offset);
    offset += values.length;
  }
  const bytes = new Uint8Array(samples.buffer);
  if (!littleEndian) {
    const view = new DataView(samples.buffer);
    for (let index = 0; index < count; index++)
      view.setFloat32(index * 4, samples[index] ?? 0, true);
  }
  return { payload: encoded, bytes };
}

/** Resolve sample windows into Float32Array views of a verified samples artifact. */
export function decodeAnimationClipSamples(
  payload: Record<string, unknown>,
  bytes: Uint8Array,
): Result<Record<string, unknown>, string> {
  if (bytes.byteLength % 4 !== 0)
    return err('samples artifact is not a whole number of f32 values');
  let samples: Float32Array;
  if (littleEndian) {
    const owned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
    samples = new Float32Array(owned.buffer, owned.byteOffset, owned.byteLength / 4);
  } else {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    samples = new Float32Array(bytes.byteLength / 4);
    for (let index = 0; index < samples.length; index++)
      samples[index] = view.getFloat32(index * 4, true);
  }
  let invalid = false;
  const decoded = mapSamplers(payload, (value) => {
    if (!window(value)) return value;
    if (value.offset + value.count > samples.length) {
      invalid = true;
      return value;
    }
    return samples.subarray(value.offset, value.offset + value.count);
  });
  return invalid ? err('sample window exceeds the samples artifact') : ok(decoded);
}
