import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeColorAccessor } from '../accessor/decode-color.js';
import { dataUriBase64Payload, decodeBase64 } from '../data-uri.js';

type Fixture = {
  readonly buffers: readonly { readonly uri: string; readonly byteLength: number }[];
  readonly bufferViews: readonly {
    readonly buffer: number;
    readonly byteLength: number;
    readonly byteOffset?: number;
    readonly byteStride?: number;
  }[];
  readonly accessors: readonly import('../accessor/decode-accessor').AccessorJson[];
};

type ColorError = {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly semantic: string;
    readonly accessorIndex: number;
    readonly reason: string;
  };
};

function readFixture(name: string): Fixture {
  const url = new URL(`./fixtures/color-0/${name}.gltf`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Fixture;
}

function inputFor(name: string, accessorIndex = 0) {
  const fixture = readFixture(name);
  const accessor = fixture.accessors[accessorIndex];
  if (accessor === undefined) throw new Error(`missing fixture accessor ${accessorIndex}`);
  const view = fixture.bufferViews[accessor.bufferView ?? -1];
  if (view === undefined) throw new Error(`missing fixture bufferView ${accessor.bufferView}`);
  const source = fixture.buffers[view.buffer];
  if (source === undefined) throw new Error(`missing fixture buffer ${view.buffer}`);
  const payload = dataUriBase64Payload(source.uri);
  if (payload === undefined) throw new Error('fixture buffer must be a base64 data URI');
  return {
    accessorIndex,
    accessor,
    bufferViews: fixture.bufferViews,
    buffers: [decodeBase64(payload)],
    semantic: 'COLOR_0' as const,
  };
}

function expectColorError(result: unknown, code: string, reason: string, accessorIndex: number) {
  expect(result).toMatchObject({ ok: false });
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok) {
    throw new Error('expected a structured color error');
  }
  const error = (result as unknown as { readonly error: ColorError }).error;
  expect(error.code).toBe(code);
  expect(error.expected).toEqual(expect.any(String));
  expect(error.hint).toEqual(expect.any(String));
  expect(error.detail).toMatchObject({ semantic: 'COLOR_0', accessorIndex, reason });
}

describe('COLOR_0 accessor support matrix', () => {
  function expectFloat32Values(actual: Float32Array, expected: readonly number[]) {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) => {
      expect(actual[index]).toBeCloseTo(value, 6);
    });
  }

  it('decodes VEC3 FLOAT and supplies alpha=1, including endpoint and midpoint values', () => {
    const result = decodeColorAccessor(inputFor('float-vec3', 1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.value)).toEqual([0, 0.5, 1, 1, 1, 0.25, 0, 1]);
  });

  it('decodes normalized UBYTE VEC4 to linear RGBA endpoints and midpoint', () => {
    const result = decodeColorAccessor(inputFor('normalized-ubyte'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectFloat32Values(result.value, [0, 128 / 255, 1, 64 / 255, 1, 32 / 255, 128 / 255, 1]);
  });

  it('decodes normalized USHORT VEC4 without sRGB conversion', () => {
    const result = decodeColorAccessor(inputFor('normalized-ushort'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectFloat32Values(result.value, [
      0,
      32768 / 65535,
      1,
      16384 / 65535,
      1,
      8192 / 65535,
      49152 / 65535,
      1,
    ]);
  });

  it('walks each element of a valid interleaved byteStride', () => {
    const result = decodeColorAccessor(inputFor('interleaved-vec3'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.value)).toEqual([0, 0.25, 1, 1, 1, 0.5, 0, 1]);
  });

  it.each([
    ['component', { componentType: 5120 }],
    ['type', { type: 'VEC2' }],
    ['normalized', { normalized: false }],
  ] as const)('classifies unsupported %s as unsupported, not absent', (reason, patch) => {
    const base = inputFor('float-vec3', 1);
    const result = decodeColorAccessor({ ...base, accessor: { ...base.accessor, ...patch } });
    expectColorError(result, 'gltf-color-accessor-unsupported', reason, 1);
  });

  it.each([
    ['count', { count: 0 }],
    ['bounds', { byteOffset: 20 }],
    ['range', { byteOffset: 0 }],
  ] as const)('classifies malformed %s with accessor context', (reason, patch) => {
    const base = inputFor('float-vec3', 1);
    const accessor = { ...base.accessor, ...patch };
    if (reason === 'range') {
      const bytes = requireValue(base.buffers[0]).slice();
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(24, 2, true);
      const result = decodeColorAccessor({ ...base, accessor, buffers: [bytes] });
      expectColorError(result, 'gltf-color-accessor-malformed', reason, 1);
      return;
    }
    const result = decodeColorAccessor({ ...base, accessor });
    expectColorError(result, 'gltf-color-accessor-malformed', reason, 1);
  });

  it('rejects non-finite FLOAT values as malformed rather than publishing partial data', () => {
    const base = inputFor('float-vec3', 1);
    const bytes = requireValue(base.buffers[0]).slice();
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(24, Number.NaN, true);
    const result = decodeColorAccessor({ ...base, buffers: [bytes] });
    expectColorError(result, 'gltf-color-accessor-malformed', 'finite', 1);
  });

  it('rejects a bad buffer reference as malformed', () => {
    const base = inputFor('float-vec3', 1);
    const result = decodeColorAccessor({
      ...base,
      bufferViews: [{ ...requireValue(base.bufferViews[0]), buffer: 4 }],
    });
    expectColorError(result, 'gltf-color-accessor-malformed', 'reference', 1);
  });

  it('reports sparse and morph COLOR_0 as deferred unsupported', () => {
    const base = inputFor('float-vec3', 1);
    const sparse = decodeColorAccessor({
      ...base,
      accessor: {
        ...base.accessor,
        sparse: {
          count: 1,
          indices: { bufferView: 9, componentType: 5121 },
          values: { bufferView: 10 },
        },
      },
    });
    expectColorError(sparse, 'gltf-color-accessor-malformed', 'bounds', 1);

    const morph = decodeColorAccessor(base, { morph: true });
    expectColorError(morph, 'gltf-color-accessor-unsupported', 'morph', 1);
  });
});

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
