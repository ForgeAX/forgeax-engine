import { execFile } from 'node:child_process';
import { createHash, Hash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizePackageProduct,
  finalizePackageTransportSource,
  type PackageProduct,
  packageTransportRevision,
} from '../package-finalizer.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

function legacyRevision(value: unknown): string {
  function stable(input: unknown): unknown {
    if (input instanceof Uint8Array) {
      return {
        byteLength: input.byteLength,
        digest: createHash('sha256').update(input).digest('hex'),
      };
    }
    if (Array.isArray(input)) {
      return Object.hasOwn(input, 'toJSON') ||
        input.some((item) => item !== null && typeof item === 'object')
        ? input.map(stable)
        : input;
    }
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, stable(item)]),
      );
    }
    return input;
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

function product(overrides: Partial<PackageProduct> = {}): PackageProduct {
  return {
    assets: [
      {
        guid: GUID,
        kind: 'texture',
        payload: { kind: 'texture', width: 1, height: 1 },
        refs: [],
        artifacts: {
          source: { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
        },
      },
    ],
    receipts: [
      {
        guid: GUID,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: 'sha256:source',
      },
    ],
    diagnostics: [],
    sourceRevision: 'sha256:source',
    sourceKey: 'texture/source',
    ...overrides,
  };
}

describe('engine-pack terminal product and finalizer contract', () => {
  it('preserves native escaping, scalar omission and custom serializer order', () => {
    const make = (calls: string[]) => {
      const original = {
        toJSON(key: string) {
          calls.push(`object ${key} ${this === original ? 'original' : 'clone'}`);
          return { z: 2, a: undefined };
        },
      };
      const values = [1, undefined, NaN, Infinity, -Infinity, -0, () => 1, Symbol('omitted')];
      values.length = 10;
      const inherited = Object.setPrototypeOf(
        [1, 2],
        Object.create(Array.prototype, {
          toJSON: {
            get() {
              calls.push('get array serializer');
              return (key: string) => {
                calls.push(`array ${key}`);
                return { z: 1, a: 2 };
              };
            },
          },
        }),
      );
      return {
        get z() {
          calls.push('get z');
          return 1;
        },
        get a() {
          calls.push('get a');
          return original;
        },
        values,
        inherited,
        ownArray: Object.assign([1, 2], {
          toJSON() {
            throw new Error('own array serializer is removed by the ordering pass');
          },
        }),
        date: new Date(0),
        omitted: undefined,
        text: `${'x'.repeat(48 * 1024 - 1)}\ud83d\ude80\ud800\udc00\ud800\u0000\n"\\`,
      };
    };
    const oldCalls: string[] = [];
    const newCalls: string[] = [];
    expect(packageTransportRevision(make(newCalls))).toBe(legacyRevision(make(oldCalls)));
    expect(newCalls).toEqual(oldCalls);
    expect(newCalls).toEqual([
      'get z',
      'get a',
      'object a clone',
      'get array serializer',
      'array inherited',
    ]);
  });

  it('preserves unsupported root and cyclic/custom serializer failures', () => {
    expect(() => packageTransportRevision(undefined)).toThrow(TypeError);
    expect(() => packageTransportRevision(1n)).toThrow(TypeError);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => packageTransportRevision(cycle)).toThrow(RangeError);
    expect(() => packageTransportRevision({ toJSON: () => cycle })).toThrow(TypeError);
  });

  it('invokes author serializers without reading their own call property', () => {
    const toJSON = Object.assign((key: string) => ({ key, z: 1, a: 2 }), {
      call() {
        throw new Error('native JSON must not read the callback call property');
      },
    });
    const input = { nested: { toJSON } };
    expect(packageTransportRevision(input)).toBe(legacyRevision(input));
  });

  it('publishes a repeated-text package larger than its real Node heap limit', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types',
      '--max-old-space-size=64',
      '--max-semi-space-size=4',
      fileURLToPath(new URL('./package-finalizer-memory.fixture.mjs', import.meta.url)),
      'repeated-text',
    ]);
    const result = JSON.parse(stdout);
    expect(result.sourceRevision).toBe(
      'c3ae6819f04e8805bfdfaf82742ddb547955810bbd64f3e754adfd32aaa828f1',
    );
    expect(result.digest).toBe(
      'sha256:07ff97e6dbac8395ec6975efde0d4dd161b676c29f91d714519a7669ccde5183',
    );
    expect(result.semanticBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(result.semanticBytes).toBeGreaterThan(result.heapLimit);
    expect(result.digest).toBe(`sha256:${result.semanticDigest}`);
    expect(result.retainedPayload).toBe(true);
    expect(result.payloadValues).toBe(96);
  }, 30_000);
  it('bounds native JSON writes across revision, digest and package publication', async () => {
    const payload = {
      text: [
        ...Array(96).fill('x'.repeat(2048)),
        `${'x'.repeat(48 * 1024 - 1)}\ud83d\ude80\ud800\n`,
      ],
    };
    const input = { assets: [{ guid: GUID, kind: 'material', payload, refs: [], artifacts: {} }] };
    const expectedRevision = legacyRevision(input);
    const expectedPublication = JSON.stringify({
      assets: [{ artifacts: {}, guid: GUID, kind: 'material', payload, refs: [] }],
      kind: 'internal-text-package',
      schemaVersion: '2.0.0',
    });
    const stringify = JSON.stringify;
    // Reproduce the production single-string limit at a small, deterministic
    // threshold. The real producer must never submit a whole package to JSON.
    const limited = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      const json = stringify(value, ...args);
      if (json !== undefined && json.length > 64 * 1024) {
        throw new RangeError('package exceeds the bounded native JSON write');
      }
      return json;
    });
    try {
      let publication: Uint8Array | undefined;
      const result = await finalizePackageTransportSource(input, {
        base: '/',
        packagePath: 'bounded.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
        sink: (_path, bytes) => {
          publication = bytes;
        },
      });
      expect(result.pack.assets[0]?.payload).toBe(payload);
      if (publication === undefined) throw new Error('missing publication');
      expect(new TextDecoder().decode(publication)).toBe(expectedPublication);
      expect(JSON.parse(new TextDecoder().decode(publication)).assets[0].payload).toEqual(payload);
      expect(result.sourceRevision).toBe(expectedRevision);
      expect(result.digest).toBe(
        `sha256:${createHash('sha256').update(expectedPublication).digest('hex')}`,
      );
    } finally {
      limited.mockRestore();
    }
  });
  it('returns one package authority without retaining an unused serialized copy', async () => {
    const input = product();
    const finalized = await finalizePackageTransportSource(input, {
      base: '/',
      packagePath: 'texture.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    });
    expect(finalized).not.toHaveProperty('semantic');
    expect(finalized.pack.assets[0]?.payload).toBe(input.assets[0]?.payload);
  });
  it('finalizes complete scalar arrays under a bounded real Node heap without changing transport', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types',
      '--max-old-space-size=256',
      fileURLToPath(new URL('./package-finalizer-memory.fixture.mjs', import.meta.url)),
    ]);
    expect(JSON.parse(stdout)).toEqual({
      sourceRevision: 'df1e4a792aa8c0a082f1558027d28cb94f4df73f703ed4cc86fed82e9642823d',
      digest: 'sha256:92b7b13bfe45170593e186c46a1e4ac23ae607d31586e31f7373f94def00a4f8',
      semanticDigest: '92b7b13bfe45170593e186c46a1e4ac23ae607d31586e31f7373f94def00a4f8',
      semanticBytes: 33554663,
      payloadValues: 16777216,
      retainedPayload: true,
    });
  }, 30_000);

  it('preserves nested ordering, byte encoding and revision identity without mutating inputs', async () => {
    const payload = {
      z: [{ z: 3, a: 1 }, new Uint8Array([3, 4]), Buffer.from([5, 6]), null, undefined],
      A: [1, null, undefined],
      a: { z: 2, A: 1, _key: false },
      _key: 'order',
    };
    const before = structuredClone(payload);
    let publication: Uint8Array | undefined;
    const result = await finalizePackageTransportSource(
      { assets: [{ guid: GUID, kind: 'material', payload, refs: [], artifacts: {} }] },
      {
        base: '/',
        packagePath: 'nested.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
        sink: (_path, bytes) => {
          publication = bytes;
        },
      },
    );
    // Immutable receipts from the previous finalizer, including its distinct
    // transport-revision and package-document key ordering.
    expect(result.sourceRevision).toBe(
      '13c09d3216ceb18ad45ebe050a759a77b4aaa69efaf95cb176042dfaefdea1f7',
    );
    expect(result.digest).toBe(
      'sha256:515370abd64723eec2dc1fd2fcc2c5addaf7d39d07bb400526bba5dded01dce1',
    );
    expect(JSON.parse(new TextDecoder().decode(publication)).assets[0].payload).toEqual({
      A: [1, null, null],
      _key: 'order',
      a: { A: 1, _key: false, z: 2 },
      z: [{ a: 1, z: 3 }, 'AwQ=', 'BQY=', null, null],
    });
    expect(structuredClone(payload)).toEqual(before);
    expect(result.pack.assets[0]?.payload).toBe(payload);
  });

  it('retains exact revision identity for transported arrays and native binary facts', () => {
    const scalar = [0, -0, 1.5, null, undefined, NaN, Infinity];
    scalar.length = 8;
    const value = {
      10: 'ten',
      2: 'two',
      z: undefined,
      a: scalar,
      nested: {
        b: Uint8Array.of(115, 104, 97, 100, 101, 114),
        a: [115, 104, 97, 100, 101, 114],
      },
    };
    // Recorded from the original finalizer, including integer-key ordering,
    // sparse/non-finite scalars and the distinct native-byte digest contract.
    expect(packageTransportRevision(value)).toBe(
      'e10e79abf5aba4281e6f060beaf05d544621ef21825c4d91d58ef66888782b4a',
    );
    value.nested.a[0] = 114;
    expect(packageTransportRevision(value)).toBe(
      '20b07b3dbd89397ef4484fe988b5fde2313d174bc3b4d7d06bca26f9489c9be0',
    );
  });

  it('retains streaming delivery and includes it in publication identity', async () => {
    const input = product();
    const asset = input.assets[0];
    const body = asset?.artifacts.source;
    if (!asset || !body) throw new Error('missing artifact fixture');
    const streamed = product({
      assets: [{ ...asset, artifacts: { source: { ...body, delivery: 'stream' } } }],
    });
    const policy = { base: '/', packagePath: 'audio.pack.json', artifactPath: () => 'audio.wav' };
    const buffered = await finalizePackageTransportSource(input, policy);
    const result = await finalizePackageTransportSource(streamed, policy);
    expect(result.pack.assets[0]?.artifacts.source?.delivery).toBe('stream');
    expect(result.digest).not.toBe(buffered.digest);
    expect(result.sourceRevision).not.toBe(buffered.sourceRevision);
  });
  it('shares artifact integrity with transport revision within one finalization', async () => {
    const input = product();
    const body = input.assets[0]?.artifacts.source?.bytes;
    if (body === undefined) throw new Error('missing artifact fixture');
    const policy = {
      base: '/',
      packagePath: 'texture.pack.json',
      artifactPath: (guid: string, key: string) => `${guid}/${key}.bin`,
    };
    const revision = packageTransportRevision(input);
    const expected = await finalizePackageProduct(input, policy);
    if (!expected.ok) throw expected.error;
    const update = vi.spyOn(Hash.prototype, 'update');
    try {
      const finalized = await finalizePackageTransportSource(input, policy);
      expect(finalized.sourceRevision).toBe(revision);
      expect(finalized.pack).toEqual(expected.value.pack);
      expect(finalized.digest).toBe(expected.value.digest);
      // One content hash and one package stream; no second identical content hash.
      expect(update.mock.calls.filter(([data]) => data === body)).toHaveLength(2);
    } finally {
      update.mockRestore();
    }
  });

  it('rehashes mutable artifact subviews on each independent finalization', async () => {
    const storage = new Uint8Array([99, 1, 2, 3, 77]);
    const body = storage.subarray(1, 4);
    const asset = product().assets[0];
    if (asset === undefined) throw new Error('missing asset fixture');
    const input = product({
      assets: [
        {
          ...asset,
          artifacts: {
            body: { mediaType: 'application/octet-stream', bytes: body },
            tail: { mediaType: 'application/octet-stream', bytes: storage.subarray(2, 4) },
          },
        },
      ],
    });
    const policy = {
      base: '/',
      packagePath: 'mesh.pack.json',
      artifactPath: (_guid: string, key: string) => `${key}.bin`,
    };
    const first = await finalizePackageTransportSource(input, policy);
    expect(first.pack.assets[0]?.artifacts.body?.integrity).toBeDefined();
    expect(first.pack.assets[0]?.artifacts.tail?.integrity).toBeDefined();
    storage[0] = 88;
    const outside = await finalizePackageTransportSource(input, policy);
    expect(outside).toEqual(first);
    body[0] = 4;
    const changed = await finalizePackageTransportSource(input, policy);
    expect(changed.sourceRevision).not.toBe(first.sourceRevision);
    expect(changed.digest).not.toBe(first.digest);
    expect(changed.pack.assets[0]?.artifacts.body?.integrity).not.toEqual(
      first.pack.assets[0]?.artifacts.body?.integrity,
    );
    expect(changed.pack.assets[0]?.artifacts.tail?.integrity).toEqual(
      first.pack.assets[0]?.artifacts.tail?.integrity,
    );
  });

  it('finalizes one complete product with source identity and receipts', async () => {
    const result = await finalizePackageProduct(product(), {
      base: '/assets',
      packagePath: 'packages/texture.pack.json',
      artifactPath: (guid, key) => `artifacts/${guid}/${key}.bin`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pack.assets).toHaveLength(1);
    expect(result.value.digest).toMatch(/^sha256:/);
    expect(result.value.receipts).toHaveLength(1);
    expect(result.value.sourceRevision).toBe('sha256:source');
    expect(result.value.sourceKey).toBe('texture/source');
  });

  it('fails closed on duplicate GUIDs and incomplete receipt evidence', async () => {
    const firstAsset = product().assets[0];
    if (firstAsset === undefined) throw new Error('test product asset is missing');
    const duplicate = product({ assets: [firstAsset, firstAsset] });
    const duplicateResult = await finalizePackageProduct(duplicate, {
      base: '/',
      packagePath: 'packages/duplicate.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    });
    expect(duplicateResult.ok).toBe(false);

    const missingReceipt = product({ receipts: [] });
    const missingReceiptResult = await finalizePackageProduct(missingReceipt, {
      base: '/',
      packagePath: 'packages/missing-receipt.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
    });
    expect(missingReceiptResult.ok).toBe(false);
  });

  it('hashes and transports large artifact bodies without JSON-expanding the bytes', async () => {
    const body = new Uint8Array(4 * 1024 * 1024);
    const artifact = { mediaType: 'application/octet-stream', bytes: body };
    const asset = product().assets[0];
    if (asset === undefined) throw new Error('test product asset is missing');
    const large = product({
      assets: [{ ...asset, artifacts: { body: artifact } }],
    });

    const revision = packageTransportRevision(large);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);

    const writes = new Map<string, Uint8Array>();
    const result = await finalizePackageProduct(large, {
      base: '/',
      packagePath: 'large.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
      sink: (path, bytes) => {
        writes.set(path, bytes);
      },
    });
    expect(result.ok).toBe(true);
    const packageBytes = writes.get('large.pack.json');
    expect(packageBytes).toBeDefined();
    const published = JSON.parse(new TextDecoder().decode(packageBytes)) as {
      assets: readonly [{ artifacts: { body: { byteLength: number } } }];
    };
    expect(published.assets[0]?.artifacts.body.byteLength).toBe(body.byteLength);
    expect(writes.get(`${GUID}/body.bin`)).toBe(body);
  });

  it('publishes a mesh LOD relation and keeps the lower mesh in the closure', async () => {
    const lodGuid = '019e3969-1d48-7c3b-ac24-6d68f4570660';
    const root = product().assets[0];
    if (root === undefined) throw new Error('test product asset is missing');
    const result = await finalizePackageProduct(
      product({
        assets: [
          {
            ...root,
            kind: 'mesh',
            payload: {
              kind: 'mesh',
              lods: [{ mesh: lodGuid, screenCoverage: 0.5 }],
            },
            refs: [lodGuid],
          },
          {
            ...root,
            guid: lodGuid,
            kind: 'mesh',
            payload: { kind: 'mesh' },
            refs: [],
          },
        ],
        receipts: [
          {
            guid: GUID,
            origin: 'sourceMeta',
            status: 'succeeded',
            inputFingerprint: 'sha256:source',
          },
          {
            guid: lodGuid,
            origin: 'sourceMeta',
            status: 'succeeded',
            inputFingerprint: 'sha256:source',
          },
        ],
      }),
      {
        base: '/',
        packagePath: 'mesh.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const publishedRoot = result.value.pack.assets.find((asset) => asset.guid === GUID);
    expect(publishedRoot?.refs).toEqual([lodGuid]);
    expect(publishedRoot?.payload).toMatchObject({
      lods: [{ mesh: lodGuid, screenCoverage: 0.5 }],
    });
    expect(result.value.pack.assets.map((asset) => asset.guid)).toContain(lodGuid);
  });
});
