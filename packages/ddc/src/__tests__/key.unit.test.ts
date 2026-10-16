import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalDdcDigest,
  canonicalDdcReadbackDigest,
  canonicalDdcReadbackDigests,
} from '../canonical-json.js';
import { ddcOutputDigest } from '../entry-store.js';
import { canonicalDdcJson, type SemanticDdcInput, semanticDdcKey } from '../key.js';

const baseInput = (): SemanticDdcInput => ({
  schemaVersion: 'asset-pack@2',
  importer: 'image@4',
  codec: 'basis@3',
  settings: { colorSpace: 'srgb', mipmap: true },
  sourceBytes: [new Uint8Array([1, 2, 3, 4])],
  declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  targetProfile: 'webgpu-release',
  producer: 'image-importer@4',
});

describe('canonical DDC byte identity', () => {
  it.each([
    'canonical',
    'whitespace',
    'different',
  ])('retains all three digests with %s payload file text', async (kind) => {
    // The surrogate pair straddles the reused JSON fragment's 48 KiB boundary.
    const payload = JSON.parse(
      JSON.stringify({
        a: `${'x'.repeat(49_145)}\u{1f600}\n\ud800`,
        z: Array.from({ length: 2051 }, (_, index) => index % 251),
      }),
    );
    const output = {
      payload,
      refs: ['b', 'a'],
      artifacts: { bytes: new Uint8Array(49_153).fill(173) },
    };
    const values = { payload, output, entry: { output, payload, receipt: 'receipt' } };
    const json =
      kind === 'canonical'
        ? canonicalDdcJson(payload)
        : kind === 'whitespace'
          ? JSON.stringify(payload, null, 2)
          : '{"unrelated":true}';
    const expected = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, canonicalDdcDigest(value)]),
    );
    await expect(canonicalDdcReadbackDigests(values, Buffer.from(json))).resolves.toEqual(expected);
  });

  it.each([
    undefined,
    null,
    'text',
    3,
    false,
  ])('retains scalar payload and nested omission semantics for %s', async (payload) => {
    const values = { payload, output: { payload }, entry: [payload, { payload }] };
    const expected = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, canonicalDdcDigest(value)]),
    );
    await expect(
      canonicalDdcReadbackDigests(values, Buffer.from(canonicalDdcJson(payload))),
    ).resolves.toEqual(expected);
  });

  it('does not reuse root callback bytes in a nested property context', async () => {
    const payload = { toJSON: (key: string) => ({ key }) };
    const values = { payload, output: { payload }, entry: { nested: payload } };
    const expected = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, canonicalDdcDigest(value)]),
    );
    await expect(
      canonicalDdcReadbackDigests(values, Buffer.from(canonicalDdcJson(payload))),
    ).resolves.toEqual(expected);
  });

  it('retains native property ordering and prototype assignment on owned readback', async () => {
    const value = JSON.parse(
      '{"10":"ten","2":"two","01":"one","__proto__":{"inherited":true},"nested":{"__proto__":null,"value":1}}',
    );
    const expected = '{"2":"two","10":"ten","01":"one","nested":{"value":1}}';
    const hash = createHash('sha256').update(expected).digest('hex');
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(hash);
    await expect(canonicalDdcReadbackDigest(value)).resolves.toBe(hash);
  });

  it('preserves integer key order, binary wrapper order and JSON omission rules', () => {
    const array: unknown[] = [undefined, Number.NaN, Infinity, -0];
    array.length = 6;
    array[5] = Symbol('omitted');
    const value = {
      z: undefined,
      10: 'ten',
      2: 'two',
      '01': 'one',
      bytes: new Uint8Array([0, 1, 255]),
      array,
      date: new Date(0),
      fn: () => 1,
    };
    const expected =
      '{"2":"two","10":"ten","01":"one","array":[null,null,null,0,null,null],"bytes":{"encoding":"base64","bytes":"AAH/"},"date":{}}';
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(canonicalDdcJson(undefined)).toBe('null');
    expect(canonicalDdcJson(Symbol('omitted'))).toBe('null');
    expect(() => canonicalDdcJson(1n)).toThrow(TypeError);
  });

  it.each([
    0, 1, 2, 3, 49_151, 49_152, 49_153, 98_305,
  ])('preserves base64 padding and byte offsets across a %i-byte input', async (length) => {
    const buffer = new Uint8Array(length + 6);
    for (let index = 0; index < buffer.length; index++) buffer[index] = index % 251;
    const bytes = buffer.subarray(3, length + 3);
    const expected = JSON.stringify({
      encoding: 'base64',
      bytes: Buffer.from(bytes).toString('base64'),
    });
    expect(canonicalDdcJson(bytes)).toBe(expected);
    expect(canonicalDdcDigest(bytes)).toBe(createHash('sha256').update(expected).digest('hex'));
    await expect(canonicalDdcReadbackDigest(bytes)).resolves.toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('retains canonical ordering inside parsed arrays without cloning their values', async () => {
    const value = JSON.parse(
      '{"z":[{"10":"ten","2":"two","01":"one","__proto__":{"inherited":true}},[0,-2,1e30,"\\ud800","end"]],"a":{"nested":{"y":2,"x":1}}}',
    );
    const expected = canonicalDdcJson(value);
    await expect(canonicalDdcReadbackDigest(value)).resolves.toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('preserves escaping and surrogate pairs across string chunks', () => {
    const value = `${'a'.repeat(49_151)}\u{1f600}\n\r\t\\"\ud800${'b'.repeat(49_149)}\udfff`;
    const expected = JSON.stringify(value);
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('preserves UTF-8 bytes while combining scalar and binary chunks for hashing', () => {
    const array = Array.from({ length: 30_000 }, (_, i) =>
      i % 7 === 0 ? '\ud800' : i % 3 === 0 ? '\u{1f600}' : i,
    );
    const bytes = new Uint8Array(49_153).fill(173);
    const value = { array, bytes };
    const expected = JSON.stringify({
      array,
      bytes: { encoding: 'base64', bytes: Buffer.from(bytes).toString('base64') },
    });
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('retains native JSON number spelling across finite and exponent boundaries', async () => {
    const value = [
      -0,
      NaN,
      Infinity,
      -Infinity,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      1e-7,
      1e-6,
      1e20,
      1e21,
      -1e-7,
      -1e21,
      1.0000000000000002,
      1 / 3,
    ];
    const expected = JSON.stringify(value);
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
    await expect(canonicalDdcReadbackDigest(value)).resolves.toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('retains native toJSON keys and canonical binary values observed by callbacks', () => {
    const value = {
      child: {
        bytes: new Uint8Array([1, 2]),
        toJSON(this: { bytes: unknown }, key: string) {
          return { key, bytes: this.bytes };
        },
      },
      omitted: { toJSON: () => undefined },
    };
    const expected = '{"child":{"key":"child","bytes":{"encoding":"base64","bytes":"AQI="}}}';
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('retains native spelling and separators across mixed numeric run boundaries', async () => {
    const spellings = [-0, NaN, Infinity, -Infinity, 1e-7, 1e21, Number.MIN_VALUE, 1 / 3];
    const value: unknown[] = Array.from({ length: 2051 }, (_, index) => spellings[index % 8]);
    value.splice(1023, 0, 'separator', undefined, null, [1, -0, Infinity]);
    delete value[2049];
    const expected = JSON.stringify(value);
    const digest = createHash('sha256').update(expected).digest('hex');
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(digest);
    await expect(canonicalDdcReadbackDigest(value)).resolves.toBe(digest);
  });

  it('does not expose internal numeric buffers to prototype callbacks installed during emission', () => {
    const prototype = Array.prototype;
    const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    let prototypeCalls = 0;
    const install = Object.assign(() => undefined, {
      toJSON() {
        Object.defineProperty(prototype, 'toJSON', {
          configurable: true,
          value() {
            prototypeCalls++;
            return 'unexpected internal callback';
          },
        });
        return 'installed';
      },
    });
    const numbers = Array.from({ length: 2051 }, (_, index) => index);
    const expected = `["installed",${JSON.stringify(numbers).slice(1, -1)}]`;
    const value = [install, ...numbers];
    const restore = () => {
      if (previous === undefined) Reflect.deleteProperty(prototype, 'toJSON');
      else Object.defineProperty(prototype, 'toJSON', previous);
    };
    try {
      expect(canonicalDdcJson(value)).toBe(expected);
      expect(prototypeCalls).toBe(0);
      restore();
      expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
      expect(prototypeCalls).toBe(0);
    } finally {
      restore();
    }
  });

  it('snapshots binary values before reading subsequent author getters', () => {
    const canonical = () => {
      const bytes = new Uint8Array([1, 2]);
      return {
        a: bytes,
        get z() {
          bytes.fill(9);
          return 1;
        },
      };
    };
    const expected = '{"a":{"encoding":"base64","bytes":"AQI="},"z":1}';
    expect(canonicalDdcJson(canonical())).toBe(expected);
    expect(canonicalDdcDigest(canonical())).toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('retains ordinary writable binary wrappers for native toJSON callbacks', () => {
    const value = {
      bytes: new Uint8Array([1, 2]),
      toJSON(this: { bytes: { encoding: string; bytes: string } }) {
        this.bytes.bytes = 'replacement';
        return this.bytes;
      },
    };
    const expected = '{"encoding":"base64","bytes":"replacement"}';
    expect(canonicalDdcJson(value)).toBe(expected);
    expect(canonicalDdcDigest(value)).toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('retains every identity field, byte, artifact name and ordered reference', () => {
    const source = {
      guid: 'identity',
      payload: { enabled: true },
      refs: ['a', 'b'],
      artifacts: {
        b: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
        a: { mediaType: 'text/plain', bytes: new Uint8Array([4, 5]) },
      },
    };
    const digest = ddcOutputDigest(source);
    expect(
      ddcOutputDigest({ ...source, artifacts: { a: source.artifacts.a, b: source.artifacts.b } }),
    ).toBe(digest);
    for (const change of [
      { guid: 'different' },
      { payload: { enabled: false } },
      { refs: ['b', 'a'] },
      {
        artifacts: {
          ...source.artifacts,
          b: { ...source.artifacts.b, bytes: new Uint8Array([1, 2, 4]) },
        },
      },
      { artifacts: { ...source.artifacts, b: { ...source.artifacts.b, mediaType: 'text/wgsl' } } },
      { artifacts: { a: source.artifacts.a, renamed: source.artifacts.b } },
    ])
      expect(ddcOutputDigest({ ...source, ...change })).not.toBe(digest);
  });
});

it('hashes artifact bytes beyond the V8 string limit without materializing one JSON string', () => {
  // The reproduced Node 22/V8 limit; keep the same bounded workload on Bun.
  const v8StringLimit = 536_870_888;
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(173);
  const encoded = Buffer.from(bytes).toString('base64');
  const count = Math.floor(v8StringLimit / encoded.length) + 1;
  const artifacts = Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `artifact-${String(index).padStart(4, '0')}`,
      { mediaType: 'application/octet-stream', bytes },
    ]),
  );
  const expected = createHash('sha256').update('{"artifacts":{');
  for (const [index, key] of Object.keys(artifacts).entries()) {
    expected.update(`${index === 0 ? '' : ','}"${key}":{"bytes":{"encoding":"base64","bytes":"`);
    expected.update(encoded);
    expected.update('"},"mediaType":"application/octet-stream"}');
  }
  expected.update('},"guid":"large","payload":null,"refs":[]}');
  expect(count * encoded.length).toBeGreaterThan(v8StringLimit);
  expect(ddcOutputDigest({ guid: 'large', payload: null, refs: [], artifacts })).toBe(
    `sha256:${expected.digest('hex')}`,
  );
}, 30_000);

describe('semantic DDC key', () => {
  it('keeps the published pre-streaming semantic identity', () => {
    expect(semanticDdcKey(baseInput())).toBe(
      'f14474ef6cfa15e8c794c40fb2cbe7788129392dc802daa4c111c9ad0814103a',
    );
  });

  it('is deterministic for equal semantic inputs', () => {
    expect(semanticDdcKey(baseInput())).toBe(semanticDdcKey(baseInput()));
  });

  it('does not include author path or publication environment', () => {
    const input = baseInput();
    const moved = { ...input, sourceBytes: [new Uint8Array([1, 2, 3, 4])] };
    expect(semanticDdcKey(input)).toBe(semanticDdcKey(moved));
  });

  it.each([
    ['schemaVersion', { schemaVersion: 'asset-pack@3' }],
    ['importer', { importer: 'image@5' }],
    ['codec', { codec: 'basis@4' }],
    ['settings', { settings: { colorSpace: 'linear', mipmap: true } }],
    ['sourceBytes', { sourceBytes: [new Uint8Array([1, 2, 3, 5])] }],
    ['declaredGuids', { declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065e'] }],
    ['targetProfile', { targetProfile: 'webgpu-debug' }],
    ['producer', { producer: 'image-importer@5' }],
  ])('misses when %s changes', (_name, change) => {
    expect(semanticDdcKey({ ...baseInput(), ...change })).not.toBe(semanticDdcKey(baseInput()));
  });

  it('canonicalizes object and GUID ordering without changing the digest', () => {
    const input = baseInput();
    expect(
      semanticDdcKey({
        ...input,
        settings: { mipmap: true, colorSpace: 'srgb' },
        declaredGuids: [...input.declaredGuids].reverse(),
      }),
    ).toBe(semanticDdcKey(input));
  });
});
