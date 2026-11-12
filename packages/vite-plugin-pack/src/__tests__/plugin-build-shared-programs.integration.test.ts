import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

const encoder = new TextEncoder();
const programKey = (source: string) =>
  `materials/programs/${createHash('sha256').update(encoder.encode(source)).digest('hex')}.wgsl`;

/** Each imported source compiles to the program text it contains. */
const programImporter: Importer = {
  key: 'program-fixture',
  import: async (context) => {
    const read = await context.readSource();
    if (!read.ok) return { ok: false, error: read.error } as never;
    const source = new TextDecoder().decode(read.value);
    const guid = context.subAssets[0]?.guid ?? '';
    return {
      ok: true,
      value: {
        assets: [
          {
            guid,
            kind: 'fixture-material',
            payload: { kind: 'fixture-material', program: programKey(source) },
            refs: [],
            artifacts: {
              [programKey(source)]: { mediaType: 'text/wgsl', bytes: encoder.encode(source) },
              body: { mediaType: 'application/octet-stream', bytes: encoder.encode(guid) },
            },
          },
        ],
        sourceDependencies: [context.source],
      },
    };
  },
};

type Emitted = { fileName?: string; name?: string; source?: string | Uint8Array };

describe('imported material programs in one production output', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function writeSource(assets: string, name: string, guid: string, program: string) {
    await writeFile(resolve(assets, `${name}.fixture`), program);
    await writeFile(
      resolve(assets, `${name}.fixture.meta.json`),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'program-fixture',
        source: `${name}.fixture`,
        importSettings: {},
        subAssets: [{ guid, sourceIndex: 0, sourceKey: 'material/main', kind: 'fixture-material' }],
      }),
    );
  }

  async function build(root: string, assets: string): Promise<Emitted[]> {
    const plugin = pluginPack({
      roots: [assets],
      importers: [programImporter],
      ddc: { buildCacheRoot: resolve(root, 'build-cache') },
      producerIdentity: 'shared-program-fixture-v1',
    });
    const emitted: Emitted[] = [];
    try {
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return asset.fileName ?? asset.name ?? 'asset';
        },
        getFileName: (referenceId) => referenceId,
      });
    } finally {
      await plugin.closeBundle();
    }
    return emitted;
  }

  function packArtifacts(emitted: readonly Emitted[], guid: string): Record<string, string> {
    const pack = emitted.find((asset) => asset.fileName === `assets/${guid}.pack.json`);
    if (pack === undefined) throw new Error(`missing Pack for ${guid}`);
    const text =
      typeof pack.source === 'string' ? pack.source : new TextDecoder().decode(pack.source);
    const document = JSON.parse(text) as {
      assets: { artifacts: Record<string, { path: string }> }[];
    };
    return Object.fromEntries(
      Object.entries(document.assets[0]?.artifacts ?? {}).map(([key, value]) => [key, value.path]),
    );
  }

  it('writes one file per identical program and a new file when a material changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-shared-programs-'));
    roots.push(root);
    const assets = resolve(root, 'assets');
    await mkdir(assets);
    const guids = [
      '00000000-0000-4000-8000-0000000000a1',
      '00000000-0000-4000-8000-0000000000a2',
      '00000000-0000-4000-8000-0000000000a3',
    ];
    const lit = '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }';
    for (const [index, guid] of guids.entries()) await writeSource(assets, `m${index}`, guid, lit);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const first = await build(root, assets);
      const shared = `shared/${programKey(lit)}`;
      const programFiles = first.filter((asset) => asset.fileName?.endsWith('.wgsl'));
      expect(programFiles.map((asset) => asset.fileName)).toEqual([`assets/${shared}`]);
      expect(programFiles[0]?.source).toEqual(encoder.encode(lit));
      for (const guid of guids) {
        expect(packArtifacts(first, guid)).toEqual({
          [programKey(lit)]: shared,
          body: `${guid}-body.bin`,
        });
      }

      // Reimporting one source with a different program publishes a new
      // address for that Pack; the others still reference the old file, which
      // stays in the output because they are emitted alongside it.
      const changed = '@fragment fn fs() -> @location(0) vec4f { return vec4f(0.5); }';
      await writeSource(assets, 'm1', guids[1] ?? '', changed);
      const second = await build(root, assets);
      expect(
        second
          .filter((asset) => asset.fileName?.endsWith('.wgsl'))
          .map((asset) => asset.fileName)
          .sort(),
      ).toEqual([`assets/${shared}`, `assets/shared/${programKey(changed)}`].sort());
      expect(packArtifacts(second, guids[1] ?? '')[programKey(changed)]).toBe(
        `shared/${programKey(changed)}`,
      );
      expect(packArtifacts(second, guids[0] ?? '')[programKey(lit)]).toBe(shared);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
