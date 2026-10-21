import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materialShaderSourceEquals,
  readShaderManifestPublication,
  shaderSourceDigestInput,
} from '../manifest-publication.js';

const nativeSubtle = crypto.subtle;

afterEach(() => vi.unstubAllGlobals());

const wgsl = 'fn main() {}\n';
const sourceDigest = (parts: readonly string[]) =>
  createHash('sha256')
    .update(
      shaderSourceDigestInput(parts.map((part) => createHash('sha256').update(part).digest())),
    )
    .digest('hex');
const digest = sourceDigest([wgsl]);

function publication() {
  return {
    schemaVersion: '5.0.0',
    receipts: [],
    entryPoints: [],
    fragments: ['fn main() {}\n'],
    sources: { [digest]: [0] },
    entries: [{ hash: 'a', bindings: '[]', sourceDigest: digest }],
    materialShaders: [
      {
        identifier: 'material',
        sourcePath: 'material.wgsl',
        paramSchema: '[]',
        sourceDigest: digest,
        variants: [{ definesKey: '', defines: {}, sourceDigest: digest }],
      },
    ],
  };
}

describe('shader publication admission', () => {
  it('owns shared entry-read facts before awaiting and rejects invalid or unused references', async () => {
    const fields = ['roughness'];
    const reads = [
      {
        name: 'main',
        stage: 'fragment',
        bindings: [{ group: 1, binding: 0, fields }],
      },
    ];
    const value = {
      ...publication(),
      entryPoints: [reads, []],
      entries: [{ ...publication().entries[0], entryPointsIndex: 0 }],
      materialShaders: [
        {
          ...publication().materialShaders[0],
          entryPointsIndex: 0,
          variants: [{ ...publication().materialShaders[0]?.variants[0], entryPointsIndex: 1 }],
        },
      ],
    };
    const pending = readShaderManifestPublication(value);
    fields[0] = 'changed during verification';
    const expanded = (await pending) as {
      entries: { entryPoints: typeof reads }[];
      materialShaders: { entryPoints: typeof reads; variants: { entryPoints: typeof reads }[] }[];
    };
    expect(expanded.entries[0]?.entryPoints[0]?.bindings[0]?.fields).toEqual(['roughness']);
    expect(expanded.materialShaders[0]?.entryPoints).toBe(expanded.entries[0]?.entryPoints);
    expect(expanded.materialShaders[0]?.variants[0]?.entryPoints).toEqual([]);
    expect(Object.isFrozen(expanded.entries[0]?.entryPoints[0]?.bindings[0]?.fields)).toBe(true);
    for (const entryPointsIndex of [-1, 2, 0.5, '0', null, undefined]) {
      await expect(
        readShaderManifestPublication({
          ...value,
          entries: [{ ...value.entries[0], entryPointsIndex }],
        }),
      ).rejects.toThrow('entry points reference');
    }
    await expect(
      readShaderManifestPublication({ ...value, entryPoints: [...value.entryPoints, []] }),
    ).rejects.toThrow('entry points table has unused entries');
    await expect(
      readShaderManifestPublication({ ...value, entryPoints: [null, []] }),
    ).rejects.toThrow('Invalid shader manifest publication');
    await expect(
      readShaderManifestPublication({
        ...value,
        entries: [{ ...value.entries[0], entryPoints: reads }],
      }),
    ).rejects.toThrow('one source digest');
    await expect(
      readShaderManifestPublication({ ...value, schemaVersion: '4.0.0' }),
    ).rejects.toThrow('Unsupported shader manifest publication version');
  });

  it('matches boot aliases without expanding unselected material sources', async () => {
    const expanded = (await readShaderManifestPublication(publication())) as {
      materialShaders: { composedWgsl: string; variants: { composedWgsl: string }[] }[];
    };
    const row = expanded.materialShaders[0];
    if (row === undefined || row.variants[0] === undefined)
      throw new Error('missing fixture variant');
    const joins: string[] = [];
    const join = Array.prototype.join;
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      const result = Reflect.apply(join, this, [separator]) as string;
      if (separator === '' && result === wgsl) joins.push(result);
      return result;
    });
    try {
      expect(materialShaderSourceEquals(row, wgsl)).toBe(true);
      expect(materialShaderSourceEquals(row.variants[0], wgsl)).toBe(true);
      expect(materialShaderSourceEquals(row, `${wgsl}// different`)).toBe(false);
      expect(materialShaderSourceEquals(row, wgsl.slice(0, -1))).toBe(false);
      expect(joins).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it('preserves complete literal equality across fragments and UTF-16 boundaries', async () => {
    const fragments = ['// \uD83D', '\uDE00\n', '', 'fn main() {}\n'];
    const source = fragments.join('');
    const digest = sourceDigest(fragments);
    const value = publication();
    const expanded = (await readShaderManifestPublication({
      ...value,
      fragments,
      sources: { [digest]: [0, 1, 2, 3] },
      entries: [],
      materialShaders: value.materialShaders.map((row) => ({
        ...row,
        sourceDigest: digest,
        variants: row.variants.map((variant) => ({ ...variant, sourceDigest: digest })),
      })),
    })) as { materialShaders: { composedWgsl: string }[] };
    const row = expanded.materialShaders[0];
    if (row === undefined) throw new Error('missing fragmented fixture material');
    for (const candidate of [
      source,
      source.slice(0, -1),
      `${source}x`,
      source.replace('main', 'other'),
      '',
    ]) {
      expect(materialShaderSourceEquals(row, candidate)).toBe(source === candidate);
      expect(materialShaderSourceEquals({ composedWgsl: source }, candidate)).toBe(
        source === candidate,
      );
    }
  });
  it('verifies every source but only retains composed strings selected by a consumer', async () => {
    const fragments = Array.from({ length: 40 }, (_, index) => `fn shader_${index}() {}\n`);
    const digests = fragments.map((source) => sourceDigest([source]));
    const joins: string[] = [];
    const join = Array.prototype.join;
    const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator?: string,
    ) {
      const result = Reflect.apply(join, this, [separator]) as string;
      if (separator === '' && result.startsWith('fn shader_')) joins.push(result);
      return result;
    });
    try {
      const expanded = (await readShaderManifestPublication({
        schemaVersion: '5.0.0',
        receipts: [],
        entryPoints: [],
        fragments,
        sources: Object.fromEntries(digests.map((hash, index) => [hash, [index]])),
        entries: digests.map((sourceDigest, index) => ({
          hash: String(index),
          bindings: '[]',
          sourceDigest,
        })),
        materialShaders: [],
      })) as { entries: { wgsl: string }[] };
      expect(joins).toEqual([]); // Admission hashes pooled fragments without composing WGSL.
      expect(expanded.entries[7]?.wgsl).toBe(fragments[7]);
      expect(expanded.entries[7]?.wgsl).toBe(fragments[7]);
      expect(joins).toEqual([fragments[7]]); // One selected source, cached once.
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects corrupt receipt references and unused or inline receipt payloads', async () => {
    const valid = { ...publication(), receipts: [{ byteLength: 64 }] };
    valid.materialShaders = valid.materialShaders.map((row) => ({ ...row, receiptIndex: 0 }));
    expect(await readShaderManifestPublication(valid)).toBeDefined();
    for (const receiptIndex of [-1, 1, 0.5, '0']) {
      await expect(
        readShaderManifestPublication({
          ...valid,
          materialShaders: valid.materialShaders.map((row) => ({ ...row, receiptIndex })),
        }),
      ).rejects.toThrow('receipt reference');
    }
    await expect(readShaderManifestPublication({ ...valid, receipts: [{}, {}] })).rejects.toThrow(
      'unused',
    );
    await expect(
      readShaderManifestPublication({
        ...valid,
        materialShaders: valid.materialShaders.map((row) => ({ ...row, receipt: {} })),
      }),
    ).rejects.toThrow('one source digest');
  });

  it('rejects obsolete compact transports instead of admitting unexpanded rows', async () => {
    await expect(
      readShaderManifestPublication({ ...publication(), schemaVersion: '2.0.0' }),
    ).rejects.toThrow('Unsupported shader manifest publication version: 2.0.0');
    await expect(readShaderManifestPublication({ ...publication(), receipts: {} })).rejects.toThrow(
      'Invalid shader manifest publication',
    );
  });

  it('checks integrity in a native host without Web Crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      expect(await readShaderManifestPublication(publication())).toHaveProperty('entries');
      const corrupt = publication();
      corrupt.fragments[0] += '// changed';
      await expect(readShaderManifestPublication(corrupt)).rejects.toThrow('digest mismatch');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('restores exact WGSL into program and material rows', async () => {
    expect(await readShaderManifestPublication(publication())).toEqual({
      entries: [{ hash: 'a', bindings: '[]', wgsl }],
      materialShaders: [
        {
          identifier: 'material',
          sourcePath: 'material.wgsl',
          paramSchema: '[]',
          composedWgsl: wgsl,
          variants: [{ definesKey: '', defines: {}, composedWgsl: wgsl }],
        },
      ],
    });
  });

  it('rejects corrupted bytes and missing source refs before publication', async () => {
    const corrupted = publication();
    corrupted.fragments[0] = 'fn main() { broken }\n';
    await expect(readShaderManifestPublication(corrupted)).rejects.toThrow('digest mismatch');
    const missing = publication();
    const first = missing.entries[0];
    if (first === undefined) throw new Error('missing fixture entry');
    first.sourceDigest = '0'.repeat(64);
    await expect(readShaderManifestPublication(missing)).rejects.toThrow('missing or unused');
  });

  it('binds the order of shared fragments and rejects obsolete publication versions', async () => {
    const fragments = ['fn a() {}\n', 'fn b() {}\n'];
    const digest = sourceDigest(fragments);
    const value = {
      schemaVersion: '5.0.0',
      receipts: [],
      entryPoints: [],
      fragments,
      sources: { [digest]: [0, 1] },
      entries: [{ hash: 'ordered', bindings: '[]', sourceDigest: digest }],
      materialShaders: [],
    };
    expect(await readShaderManifestPublication(value)).toEqual({
      entries: [{ hash: 'ordered', bindings: '[]', wgsl: fragments.join('') }],
      materialShaders: [],
    });
    await expect(
      readShaderManifestPublication({
        ...value,
        sources: { [digest]: [1, 0] },
      }),
    ).rejects.toThrow('digest mismatch');
    await expect(
      readShaderManifestPublication({ ...value, schemaVersion: '3.0.0' }),
    ).rejects.toThrow('Unsupported shader manifest publication version');
  });

  it('hashes a shared block once across source variants', async () => {
    const fragments = ['fn shared() {}\n', 'fn a() {}\n', 'fn b() {}\n'];
    const first = sourceDigest([fragments[0] as string, fragments[1] as string]);
    const second = sourceDigest([fragments[0] as string, fragments[2] as string]);
    const submitted: number[] = [];
    const subtle: Pick<SubtleCrypto, 'digest'> = {
      digest(algorithm, data) {
        submitted.push(data.byteLength);
        return nativeSubtle.digest(algorithm, data);
      },
    };
    vi.stubGlobal('crypto', { subtle });
    await readShaderManifestPublication({
      schemaVersion: '5.0.0',
      receipts: [],
      entryPoints: [],
      fragments,
      sources: { [first]: [0, 1], [second]: [0, 2] },
      entries: [first, second].map((sourceDigest) => ({ sourceDigest })),
      materialShaders: [],
    });
    expect(submitted).toHaveLength(5);
    expect(submitted.slice(0, 3)).toEqual(fragments.map((fragment) => Buffer.byteLength(fragment)));
    expect(submitted.slice(3)).toEqual([
      shaderSourceDigestInput([Buffer.alloc(32), Buffer.alloc(32)]).byteLength,
      shaderSourceDigestInput([Buffer.alloc(32), Buffer.alloc(32)]).byteLength,
    ]);
  });

  it('checks the complete source table', async () => {
    const fragments = Array.from({ length: 35 }, (_, i) => `fn shader_${i}() {}\n`);
    const digests = fragments.map((source) => sourceDigest([source]));
    const value = {
      schemaVersion: '5.0.0',
      receipts: [],
      entryPoints: [],
      fragments,
      sources: Object.fromEntries(digests.map((hash, i) => [hash, [i]])),
      entries: digests.map((sourceDigest, i) => ({
        hash: String(i),
        bindings: '[]',
        sourceDigest,
      })),
      materialShaders: [],
    };
    expect(await readShaderManifestPublication(value)).toEqual({
      entries: fragments.map((source, i) => ({ hash: String(i), bindings: '[]', wgsl: source })),
      materialShaders: [],
    });
    for (const index of [0, 16, 34]) {
      const corrupt = [...fragments];
      corrupt[index] += '// modified';
      await expect(readShaderManifestPublication({ ...value, fragments: corrupt })).rejects.toThrow(
        `Shader source digest mismatch: ${digests[index]}`,
      );
    }
  });

  it('digests complete owned bytes in order with at most 64 sources in flight and a pre-await snapshot', async () => {
    const fragments = Array.from(
      { length: 129 },
      (_, i) => `// shader ${i}: \uD83D\uDE00\nfn shader_${i}() {}\n`,
    );
    const complete = [...fragments];
    const digests = complete.map((source) => sourceDigest([source]));
    const value = {
      schemaVersion: '5.0.0',
      receipts: [],
      entryPoints: [],
      fragments,
      sources: Object.fromEntries(digests.map((hash, i) => [hash, [i]])),
      entries: digests.map((sourceDigest) => ({ sourceDigest })),
      materialShaders: [],
    };
    const submitted: Uint8Array[] = [];
    const ownedBuffers = new Set<ArrayBufferLike>();
    let inFlight = 0;
    let peak = 0;
    let bytesInFlight = 0;
    let peakBytes = 0;
    const subtle: Pick<SubtleCrypto, 'digest'> = {
      digest(algorithm, data) {
        expect(this).toBe(subtle);
        expect(algorithm).toBe('SHA-256');
        expect(data).toBeInstanceOf(Uint8Array);
        const bytes = data as Uint8Array<ArrayBuffer>;
        expect(bytes.byteOffset).toBe(0);
        expect(bytes.byteLength).toBe(bytes.buffer.byteLength);
        ownedBuffers.add(bytes.buffer);
        submitted.push(bytes.slice());
        peak = Math.max(peak, ++inFlight);
        bytesInFlight += bytes.byteLength;
        peakBytes = Math.max(peakBytes, bytesInFlight);
        return nativeSubtle.digest(algorithm, data).finally(() => {
          inFlight--;
          bytesInFlight -= bytes.byteLength;
        });
      },
    };
    vi.stubGlobal('crypto', { subtle });
    const pending = readShaderManifestPublication(value);
    expect(submitted).toHaveLength(64);
    value.fragments[0] = '// modified while awaiting\n';
    value.fragments[128] = '// modified last source while awaiting\n';
    expect(await pending).toEqual({
      entries: complete.map((wgsl) => ({ wgsl })),
      materialShaders: [],
    });
    expect(submitted).toHaveLength(258);
    expect(ownedBuffers.size).toBe(258);
    expect(submitted.slice(0, 129).map((bytes) => Buffer.from(bytes))).toEqual(
      complete.map((source) => Buffer.from(source, 'utf8')),
    );
    expect(peak).toBe(64);
    expect(inFlight).toBe(0);
    expect(bytesInFlight).toBe(0);
    expect(peakBytes).toBeLessThanOrEqual(
      64 *
        Math.max(
          ...complete.map((source) => Buffer.byteLength(source, 'utf8')),
          shaderSourceDigestInput([
            createHash('sha256')
              .update(complete[0] as string)
              .digest(),
          ]).length,
        ),
    );
    await expect(readShaderManifestPublication(value)).rejects.toThrow('digest mismatch');
  });

  it('rejects corruption in the first, middle and final 64-source batch before publication', async () => {
    const fragments = Array.from({ length: 129 }, (_, i) => `fn shader_${i}() {}\n`);
    const digests = fragments.map((source) => sourceDigest([source]));
    const value = {
      schemaVersion: '5.0.0',
      receipts: [],
      entryPoints: [],
      fragments,
      sources: Object.fromEntries(digests.map((hash, i) => [hash, [i]])),
      entries: digests.map((sourceDigest) => ({ sourceDigest })),
      materialShaders: [],
    };
    for (const index of [0, 64, 128]) {
      const corrupt = [...fragments];
      corrupt[index] += '// corrupt tail';
      await expect(readShaderManifestPublication({ ...value, fragments: corrupt })).rejects.toThrow(
        `Shader source digest mismatch: ${digests[index]}`,
      );
    }
  });
});
