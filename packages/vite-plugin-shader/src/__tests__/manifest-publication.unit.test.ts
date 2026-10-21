import {
  expandShaderManifestPublication,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { mergeShaderManifestPublications, publishShaderManifest } from '../manifest-publication.js';

describe('shared shader source publication', () => {
  it('rejects invalid pooled references on direct entries, materials and every variant', () => {
    const engine = publishShaderManifest(
      [{ hash: 'engine', wgsl: 'fn main() {}', entryPoints: [] }],
      [
        {
          composedWgsl: 'fn main() {}',
          entryPoints: [],
          variants: [{ composedWgsl: 'fn main() {}', entryPoints: [] }],
        },
      ],
    );
    const authored = publishShaderManifest([], []);
    for (const row of [
      engine.entries[0],
      engine.materialShaders[0],
      engine.materialShaders[0]?.variants[0],
    ]) {
      if (row === undefined) throw new Error('missing fixture row');
      for (const invalid of [-1, 1, 0.5, '0', null, undefined]) {
        Reflect.set(row, 'entryPointsIndex', invalid);
        expect(() =>
          mergeShaderManifestPublications(engine, authored, new Set(['engine'])),
        ).toThrow('entryPointsIndex reference is missing');
      }
      Reflect.set(row, 'entryPointsIndex', 0);
    }
  });

  it('pools exact entry-read arrays across the complete variant roster and remaps app tables', async () => {
    const reads = [
      {
        name: 'main',
        stage: 'fragment',
        bindings: [
          {
            group: 1,
            binding: 0,
            fields: Array.from({ length: 100 }, (_, index) => `field_${index}`),
          },
        ],
      },
    ];
    const alternate = [{ name: 'main', stage: 'fragment', bindings: [] }];
    const original = {
      entries: [{ hash: 'engine', wgsl: 'fn main() {}', entryPoints: reads }],
      materialShaders: [
        {
          identifier: 'material',
          composedWgsl: 'fn main() {}',
          entryPoints: reads,
          variants: Array.from({ length: 128 }, (_, index) => ({
            definesKey: `MODE=${index}`,
            composedWgsl: 'fn main() {}',
            entryPoints: index % 2 === 0 ? structuredClone(reads) : alternate,
          })),
        },
      ],
    };
    const publication = publishShaderManifest(original.entries, original.materialShaders);
    expect(publication.entryPoints).toEqual([reads, alternate]);
    expect(JSON.stringify(publication).length).toBeLessThan(JSON.stringify(original).length / 3);
    const decoded = (await readShaderManifestPublication(
      JSON.parse(JSON.stringify(publication)),
    )) as typeof original;
    expect(decoded).toEqual(original);
    expect(decoded.materialShaders[0]?.variants[0]?.entryPoints).toBe(
      decoded.entries[0]?.entryPoints,
    );
    const authoredEntries = [
      { hash: 'authored', wgsl: 'fn authored() {}', entryPoints: alternate },
      { hash: 'empty', wgsl: 'fn empty() {}', entryPoints: [] },
      { hash: 'unknown', wgsl: 'fn unknown() {}' },
    ];
    const authored = publishShaderManifest(authoredEntries, []);
    const merged = mergeShaderManifestPublications(publication, authored, new Set(['engine']));
    expect(merged.entryPoints).toEqual([reads, alternate, []]);
    expect(await readShaderManifestPublication(merged)).toEqual({
      entries: [{ ...original.entries[0], glsl: '' }, ...authoredEntries],
      materialShaders: original.materialShaders,
    });
  });

  it('interns repeated ABI receipts without losing nested facts or variant identity', async () => {
    const receipt = {
      receiptIdentity: 'shared',
      reflection: {
        fields: Array.from({ length: 100 }, (_, index) => ({
          name: `field_${index}`,
          offset: index * 16,
        })),
      },
    };
    const alternate = { ...receipt, receiptIdentity: 'alternate' };
    const original = {
      entries: [],
      materialShaders: [
        {
          identifier: 'material',
          composedWgsl: 'fn main() {}',
          receipt,
          variants: Array.from({ length: 128 }, (_, index) => ({
            definesKey: `MODE=${index}`,
            composedWgsl: 'fn main() {}',
            receipt: index % 2 === 0 ? structuredClone(receipt) : alternate,
          })),
        },
      ],
    };
    const publication = publishShaderManifest(original.entries, original.materialShaders);
    expect(JSON.stringify(publication).length).toBeLessThan(JSON.stringify(original).length / 8);
    expect(await readShaderManifestPublication(JSON.parse(JSON.stringify(publication)))).toEqual(
      original,
    );
  });

  it('merges admitted engine and authored rows without expanding the engine sources', async () => {
    const shared = 'fn shared() {}\n\n';
    const engine = publishShaderManifest(
      [
        { hash: 'kept', bindings: '[]', glsl: '', uvSetCount: 8, wgsl: `${shared}fn engine() {}` },
        { hash: 'removed', bindings: '[]', wgsl: 'fn removed() {}' },
      ],
      [{ identifier: 'engine', composedWgsl: `${shared}fn engine() {}`, variants: [] }],
    );
    const authored = publishShaderManifest(
      [{ hash: 'authored', bindings: '[]', wgsl: `${shared}fn authored() {}` }],
      [],
    );
    const merged = mergeShaderManifestPublications(engine, authored, new Set(['kept']), {
      uvSetCount: 0,
    });
    expect(await readShaderManifestPublication(merged)).toEqual({
      entries: [
        { hash: 'kept', bindings: '[]', glsl: '', uvSetCount: 8, wgsl: `${shared}fn engine() {}` },
        { hash: 'authored', bindings: '[]', wgsl: `${shared}fn authored() {}` },
      ],
      materialShaders: [
        { identifier: 'engine', composedWgsl: `${shared}fn engine() {}`, variants: [] },
      ],
    });
    expect(JSON.stringify(merged)).not.toContain('fn removed()');
    expect(merged.fragments.filter((part) => part === shared)).toHaveLength(1);
    merged.fragments[0] = 'fn tampered() {}';
    await expect(readShaderManifestPublication(merged)).rejects.toThrow('digest mismatch');
  });
  it('pools identical ABI receipts without changing variant contracts or source bytes', async () => {
    const receipt = {
      shaderStage: 'fragment',
      bindings: [{ group: 2, binding: 0 }],
      byteLength: 64,
    };
    const distinct = { ...receipt, byteLength: 80 };
    const original = {
      entries: [],
      materialShaders: [
        {
          identifier: 'material',
          composedWgsl: 'fn base() {}',
          receipt,
          variants: [
            {
              definesKey: 'A=false',
              defines: { A: false },
              composedWgsl: 'fn base() {}',
              receipt: structuredClone(receipt),
            },
            {
              definesKey: 'A=true',
              defines: { A: true },
              composedWgsl: 'fn other() {}',
              receipt: distinct,
            },
          ],
        },
      ],
    };
    const publication = publishShaderManifest(original.entries, original.materialShaders);
    expect(publication.receipts).toEqual([receipt, distinct]);
    const expanded = (await readShaderManifestPublication(publication)) as typeof original;
    expect(expanded).toEqual(original);
    expect(expanded.materialShaders[0]?.variants[0]?.receipt).toBe(
      expanded.materialShaders[0]?.receipt,
    );
    expect(expanded.materialShaders[0]?.variants[1]?.receipt).not.toBe(
      expanded.materialShaders[0]?.receipt,
    );
  });

  it('reuses admitted source blocks while publishing fresh variants and removing old sources', async () => {
    const retained = 'fn common() {}\n\nfn retained() {}\n';
    const removed = 'fn removed() {}\n';
    const fresh = 'fn common() {}\n\nfn fresh() {}\n';
    const previous = publishShaderManifest(
      [
        { hash: 'retained', wgsl: retained },
        { hash: 'removed', wgsl: removed },
      ],
      [],
    );
    const expanded = expandShaderManifestPublication(previous);
    const blocks = new Map(
      [...expanded.sourceFragments.values()].map((fragments) => [fragments.join(''), fragments]),
    );
    const original = {
      entries: [{ hash: 'retained', wgsl: retained, bindings: '[]' }],
      materialShaders: [
        {
          identifier: 'fresh',
          composedWgsl: fresh,
          variants: [{ definesKey: 'A=true', defines: { A: true }, composedWgsl: retained }],
        },
      ],
    };
    const split = String.prototype.split;
    const divided: string[] = [];
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number,
    ) {
      if (separator === '\n\n') divided.push(String(this));
      return Reflect.apply(split, this, [separator, limit]) as string[];
    });
    const publication = (() => {
      try {
        return publishShaderManifest(original.entries, original.materialShaders, blocks);
      } finally {
        spy.mockRestore();
      }
    })();
    expect(divided).toEqual([fresh]);
    expect(await readShaderManifestPublication(publication)).toEqual(original);
    expect(Object.keys(publication.sources)).toHaveLength(2);
    expect(publication.fragments.join('')).not.toContain('fn removed()');
  });

  it('rejects reused fragments that do not reproduce the keyed source', () => {
    const source = 'fn retained() {}';
    expect(() =>
      publishShaderManifest(
        [{ hash: 'test', wgsl: source }],
        [],
        new Map([[source, ['fn corrupted() {}']]]),
      ),
    ).toThrow('do not match admitted bytes');
  });

  it('retains separators, CRLF and the final unterminated source bytes', async () => {
    const wgsl = '\n\n// prefix\r\n\r\nfn main() {}\n\n\n// tail  ';
    const entries = [{ hash: 'test', wgsl }];
    const publication = publishShaderManifest(entries, []);
    expect(await readShaderManifestPublication(publication)).toEqual({
      entries,
      materialShaders: [],
    });
  });

  it('bounds the source table for many variants sharing a long WGSL declaration', () => {
    const common = `fn shared() {\n${Array.from({ length: 1000 }, (_, index) => `  let value_${index} = ${index}u;\n`).join('')}}\n\n`;
    const variants = Array.from({ length: 16 }, (_, index) => ({
      definesKey: `MODE=${index}`,
      composedWgsl: `${common}fn main() { let mode = ${index}u; }\n`,
    }));
    const published = publishShaderManifest(
      [],
      [{ composedWgsl: `${common}fn main() { let mode = 0u; }\n`, variants }],
    );
    // A repeated function must not turn each variant into another per-line index stream.
    expect(JSON.stringify(published).length).toBeLessThan(common.length * 2);
    expect(
      [...expandShaderManifestPublication(published).sourceFragments.values()]
        .map((parts) => parts.join(''))
        .sort(),
    ).toEqual(variants.map((variant) => variant.composedWgsl).sort());
  });

  it('preserves variant identity and exact source bytes across shared blocks', () => {
    const common = Array.from({ length: 30 }, (_, index) => `fn shared_${index}() {}\n\n`).join('');
    const first = `${common}fn main() { let x = 1; }\n`;
    const second = `${common}fn main() { let x = 2; }\n`;
    const original = {
      entries: [{ hash: 'primary', wgsl: first, bindings: '[]' }],
      materialShaders: [
        {
          identifier: 'material',
          composedWgsl: first,
          variants: [
            { definesKey: 'A=false', defines: { A: false }, composedWgsl: second },
            { definesKey: 'A=true', defines: { A: true }, composedWgsl: first },
          ],
        },
      ],
    };
    const published = publishShaderManifest(original.entries, original.materialShaders);
    expect(published.schemaVersion).toBe('5.0.0');
    expect(published.entries[0]).toMatchObject({
      hash: 'primary',
      sourceDigest: published.materialShaders[0]?.sourceDigest,
    });
    expect(published.materialShaders[0]?.variants[1]?.sourceDigest).toBe(
      published.entries[0]?.sourceDigest,
    );
    expect(Object.keys(published.sources)).toHaveLength(2);
    expect(expandShaderManifestPublication(published).manifest).toEqual(original);
    expect(JSON.stringify(published).length).toBeLessThan(JSON.stringify(original).length);
  });
});
