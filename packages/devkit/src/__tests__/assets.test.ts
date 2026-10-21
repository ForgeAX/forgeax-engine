import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { describe, expect, it } from 'vitest';
import {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
} from '../assets.js';
import { writeDistManifest } from '../dist.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-assets-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {} })}\n`,
    ),
    writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  await mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'assets', 'hero.png'), new Uint8Array([1, 2, 3]));
  return root;
}

async function scriptablePackFixture(count: number): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-pack-list-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({ id: 'pack-game', name: 'Pack Game', schemaVersion: '3.0.0', roots: {} })}\n`,
    ),
    writeFile(resolve(root, 'package.json'), '{"name":"pack-game"}\n'),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  await mkdir(resolve(root, 'assets'));
  await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const suffix = String(index + 0x90).padStart(12, '0');
      return writeFile(
        resolve(root, 'assets', `source-${index}.pack.ts`),
        [
          "import { definePack, definePackageId } from '@forgeax/engine-pack/source';",
          "import { ok } from '@forgeax/engine-types';",
          '',
          `const packageId = definePackageId('01900000-0000-7000-8000-${suffix}');`,
          '',
          'export default definePack({',
          "  schemaVersion: '2.0.0',",
          '  packageId,',
          '  build: () => ok({}),',
          '});',
          '',
        ].join('\n'),
      );
    }),
  );
  return root;
}

describe('asset commands', () => {
  it('checks only the requested parameter source even when the project has broken assets and output', async () => {
    const root = await fixture();
    try {
      await writeFile(
        resolve(root, 'assets', 'scene.pack.ts'),
        `
        throw new Error('must not import the scene for parameter inspection');
        export default definePack({
          schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000099'),
          parameters: [{ name: 'sunIntensity', type: 'f32', default: 3.2,
            apply: { asset: 'scene/main', path: ['entities', 'sun', 'components', 'DirectionalLight', 'intensity'] } }],
          build() { throw new Error('must not generate'); },
        });
      `,
      );
      await writeFile(
        resolve(root, 'assets', 'broken.pack.ts'),
        'throw new Error("unrelated source");',
      );
      await mkdir(resolve(root, 'dist'));
      await writeFile(resolve(root, 'dist', 'asset-index.json'), 'invalid old output');
      expect(
        await assetInspectCommand({ root, subject: 'assets/scene.pack.ts', parametersOnly: true }),
      ).toMatchObject({
        ok: true,
        value: {
          status: 'identity',
          parameters: [{ name: 'sunIntensity', mode: 'runtime', type: 'f32', default: 3.2 }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('adds an image once and reuses its GUID', async () => {
    const root = await fixture();
    const first = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(first.ok).toBe(true);
    const before = await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8');
    const second = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(second.ok).toBe(true);
    expect(await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8')).toBe(before);
    const listed = await assetListCommand({ root });
    expect(listed).toEqual({
      ok: true,
      value: {
        items: [expect.objectContaining({ kind: 'texture', name: 'texture' })],
        page: { cursor: 0, limit: 100, total: 1 },
      },
    });
    const page = await assetListCommand({ root, type: 'texture', limit: 1 });
    expect(page).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ kind: 'texture' })], page: { total: 1 } },
    });
    const verified = await assetVerifyCommand({ root });
    expect(verified).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 'asset-verification-v1',
        scope: { sourceCount: 1, assetLimit: 256, truncated: false },
        summary: { assetCount: 1, emittedAssetCount: 1, unproducedAssetCount: 1 },
      },
    });
  });

  it('does not write a sidecar during dry-run', async () => {
    const root = await fixture();
    const result = await assetAddCommand({ root, path: 'assets/hero.png', dryRun: true });
    expect(result.ok).toBe(true);
    await expect(readFile(resolve(root, 'assets', 'hero.png.meta.json'))).rejects.toThrow();
  });

  it('imports an FBX source through the built-in producer', async () => {
    const root = await fixture();
    try {
      const source = resolve(root, 'assets', 'lod-group.fbx');
      await writeFile(
        source,
        await readFile(
          new URL('../../../fbx/src/__tests__/fixtures/lod-group.fbx', import.meta.url),
        ),
      );
      const dryRun = await assetAddCommand({
        root,
        path: 'assets/lod-group.fbx',
        dryRun: true,
      });
      expect(dryRun).toMatchObject({ ok: true });
      await expect(readFile(`${source}.meta.json`)).rejects.toThrow();
      const result = await assetAddCommand({ root, path: 'assets/lod-group.fbx' });
      expect(result).toMatchObject({ ok: true });
      const meta = JSON.parse(await readFile(`${source}.meta.json`, 'utf8')) as {
        readonly importer: string;
        readonly subAssets: readonly { readonly kind: string }[];
      };
      expect(meta.importer).toBe('fbx');
      expect(meta.subAssets.map((entry) => entry.kind)).toEqual([
        'mesh',
        'mesh',
        'material',
        'scene',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('routes v3 Pack queries through the Pack authoring operation envelope', async () => {
    const root = await fixture();
    const packageId = '01900000-0000-7000-8000-000000000080';
    await writeFile(
      resolve(root, 'assets', 'direct.pack.json'),
      `${JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { 'scene/main': { kind: 'scene', payload: {}, refs: [] } },
      })}\n`,
    );

    const listed = await assetListCommand({ root });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        sources: [{ packageId, format: 'direct' }],
        assets: [{ packageId, sourceKey: 'scene/main', status: 'identity' }],
        page: { cursor: 0, limit: 100, total: 1, sourceTotal: 1 },
      },
    });
    const inspected = await assetInspectCommand({ root, subject: packageId });
    expect(inspected).toMatchObject({ ok: true, value: { packageId, format: 'direct' } });
    const verified = await assetVerifyCommand({ root });
    expect(verified).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 'asset-verification-v1',
        scope: {
          sourceCount: 1,
          assetCount: 1,
          assetLimit: 256,
          truncated: false,
          scriptablePackSourceCount: 0,
        },
        assets: [
          {
            guid: expect.any(String),
            type: 'scene',
            source: { role: 'author', format: 'pack.json' },
            sourceKey: 'scene/main',
            output: { status: 'unproduced', availability: 'unknown', freshness: 'unknown' },
            dependencies: [],
            producer: { state: 'not-run' },
          },
        ],
        summary: {
          assetCount: 1,
          emittedAssetCount: 1,
          unproducedAssetCount: 1,
          unknownAssetCount: 0,
        },
      },
    });
  });

  it('continues through source-only Pack pages with one bounded cursor', async () => {
    const root = await scriptablePackFixture(3);

    const first = await assetListCommand({ root, limit: 2 });
    expect(first).toMatchObject({
      ok: true,
      value: {
        assets: [],
        sources: [
          { sourcePath: 'assets/source-0.pack.ts' },
          { sourcePath: 'assets/source-1.pack.ts' },
        ],
        page: { cursor: 0, limit: 2, total: 3, sourceTotal: 3, nextCursor: '2' },
      },
    });

    const second = await assetListCommand({ root, limit: 2, cursor: '2' });
    expect(second).toMatchObject({
      ok: true,
      value: {
        assets: [],
        sources: [{ sourcePath: 'assets/source-2.pack.ts' }],
        page: { cursor: 2, limit: 2, total: 3, sourceTotal: 3 },
      },
    });
    if (second.ok) {
      const page = (second.value as { readonly page: Readonly<Record<string, unknown>> }).page;
      expect(page).not.toHaveProperty('nextCursor');
    }
  });

  it('projects current Pack outputs from the generated index into read commands', async () => {
    const root = await scriptablePackFixture(1);
    const packageId = '01900000-0000-7000-8000-000000000144';
    const parsedPackageId = PackageId.parse(packageId);
    expect(parsedPackageId.ok).toBe(true);
    if (!parsedPackageId.ok) throw new Error('fixture package id is invalid');
    const guid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'mesh/main'));
    await mkdir(resolve(root, 'dist'));
    await mkdir(resolve(root, 'dist', 'assets'));
    await mkdir(resolve(root, 'dist', 'shaders'));
    await Promise.all([
      writeFile(resolve(root, 'dist', 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(root, 'dist', 'shaders', 'manifest.json'), '{}\n'),
      writeFile(resolve(root, 'dist', 'assets', `${packageId}.pack.json`), '{"payload":"mesh"}\n'),
    ]);
    await writeFile(
      resolve(root, 'dist', 'pack-index.json'),
      `${JSON.stringify([
        {
          guid,
          kind: 'mesh',
          sourcePath: 'assets/source-0.pack.ts',
          packageId,
          sourceKey: 'mesh/main',
          subject: 'internal-asset',
          provenance: { provider: 'pack-ts', version: '2.0.0' },
          lifecycle: 'current',
          publication: { current: { packageUrl: `/assets/${packageId}.pack.json` } },
        },
      ])}\n`,
    );
    await writeDistManifest(
      {
        root,
        id: 'pack-game',
        name: 'Pack Game',
        roots: {},
        assetRoots: ['assets'],
        packageJson: {},
      },
      '/',
    );

    const listed = await assetListCommand({ root });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        assets: [{ guid, packageId, sourceKey: 'mesh/main', kind: 'mesh', status: 'ready' }],
        page: { total: 1 },
      },
    });
    const inspected = await assetInspectCommand({ root, subject: guid });
    expect(inspected).toMatchObject({
      ok: true,
      value: { guid, packageId, sourceKey: 'mesh/main', status: 'ready' },
    });
    const verified = await assetVerifyCommand({ root });
    expect(verified).toMatchObject({
      ok: true,
      value: { assets: [expect.objectContaining({ guid, sourceKey: 'mesh/main' })] },
    });
  });

  it('fails verification when a published Pack artifact is missing or altered', async () => {
    const root = await scriptablePackFixture(1);
    const packageId = '01900000-0000-7000-8000-000000000150';
    const parsedPackageId = PackageId.parse(packageId);
    expect(parsedPackageId.ok).toBe(true);
    if (!parsedPackageId.ok) throw new Error('fixture package id is invalid');
    const guid = AssetGuid.format(AssetGuid.derive(parsedPackageId.value, 'mesh/main'));
    const packagePath = resolve(root, 'dist', 'assets', `${packageId}.pack.json`);
    await mkdir(resolve(root, 'dist', 'assets'), { recursive: true });
    await mkdir(resolve(root, 'dist', 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(root, 'dist', 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(root, 'dist', 'shaders', 'manifest.json'), '{}\n'),
      writeFile(packagePath, '{"payload":"mesh"}\n'),
      writeFile(
        resolve(root, 'dist', 'pack-index.json'),
        `${JSON.stringify([
          {
            guid,
            kind: 'mesh',
            sourcePath: 'assets/source-0.pack.ts',
            packageId,
            sourceKey: 'mesh/main',
            subject: 'internal-asset',
            provenance: { provider: 'pack-ts', version: '2.0.0' },
            lifecycle: 'current',
            publication: { current: { packageUrl: `/assets/${packageId}.pack.json` } },
          },
        ])}\n`,
      ),
    ]);
    await writeDistManifest(
      {
        root,
        id: 'pack-game',
        name: 'Pack Game',
        roots: {},
        assetRoots: ['assets'],
        packageJson: {},
      },
      '/',
    );

    expect((await assetVerifyCommand({ root })).ok).toBe(true);

    await rm(packagePath);
    expect(await assetVerifyCommand({ root })).toMatchObject({
      ok: false,
      error: { code: 'dist-artifact-missing', detail: { path: `assets/${packageId}.pack.json` } },
    });

    await writeFile(packagePath, '{"payload":"mesX"}\n');
    expect(await assetVerifyCommand({ root })).toMatchObject({
      ok: false,
      error: { code: 'dist-artifact-mismatch', detail: { path: `assets/${packageId}.pack.json` } },
    });

    await writeFile(packagePath, '{"payload":"mesh"}\n');
    expect((await assetVerifyCommand({ root })).ok).toBe(true);
  });

  it.each([
    false,
    true,
  ])('verifies imported Catalog references outside scan roots: scoped=%s', async (scoped) => {
    const root = await fixture();
    const packageId = '01900000-0000-7000-8000-000000000145';
    const externalGuid = '01900000-0000-7000-8000-000000000146';
    await writeFile(
      resolve(root, 'assets', 'direct.pack.json'),
      `${JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { 'material/main': { kind: 'material', payload: {}, refs: [externalGuid] } },
      })}\n`,
    );
    await mkdir(resolve(root, 'dist'));
    const entries = [
      {
        guid: externalGuid,
        kind: 'texture',
        sourcePath: '../../../forgeax-engine-assets/demo-assets/palace/caihua.png',
        sourceKey: 'texture',
        subject: 'imported-output',
        provenance: { provider: 'image', version: '1.0.0' },
        lifecycle: 'current',
        publication: { current: { packageUrl: `/assets/${externalGuid}.pack.json` } },
      },
    ];
    await writeFile(
      resolve(root, 'dist', 'pack-index.json'),
      `${JSON.stringify(
        scoped
          ? {
              schemaVersion: 'runtime-catalog-snapshot-v1',
              scopeId: 'pack-game',
              generation: 1,
              authority: 'authoritative',
              diagnostics: [],
              entries,
            }
          : entries,
      )}\n`,
    );

    const verified = await assetVerifyCommand({ root });
    expect(verified).toMatchObject({
      ok: true,
      value: { assets: [expect.objectContaining({ sourceKey: 'material/main' })] },
    });
  });

  it('does not treat unpublished or malformed Catalog rows as resolvable dependencies', async () => {
    for (const row of [
      { guid: '01900000-0000-7000-8000-000000000147' },
      {
        guid: '01900000-0000-7000-8000-000000000148',
        kind: 'texture',
        lifecycle: 'failed',
        publication: { current: { packageUrl: '/assets/unpublished.pack.json' } },
      },
    ]) {
      const root = await fixture();
      const packageId = '01900000-0000-7000-8000-000000000149';
      const externalGuid = row.guid;
      await writeFile(
        resolve(root, 'assets', 'direct.pack.json'),
        `${JSON.stringify({
          schemaVersion: '3.0.0',
          packageId,
          assets: { 'material/main': { kind: 'material', payload: {}, refs: [externalGuid] } },
        })}\n`,
      );
      await mkdir(resolve(root, 'dist'));
      await writeFile(resolve(root, 'dist', 'pack-index.json'), `${JSON.stringify([row])}\n`);
      expect(await assetVerifyCommand({ root })).toMatchObject({
        ok: false,
        error: { code: 'pack-output-reference-missing' },
      });
    }
  });
});
