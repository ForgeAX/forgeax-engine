import {
  ImporterRegistry,
  publishImportPublication,
  type RunImportMeta,
  runImport,
} from '@forgeax/engine-import';
import { finalizePackageTransportSource } from '@forgeax/engine-pack/build';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parseShadowCapsuleSet } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { fbxImporter, sourceKeyForFbxOutput } from '../fbx-importer.js';
import { initFbxWasm, parseFbxToObject } from '../index.js';
import { parseFbxLodGroup } from '../lod/parse-lod-group.js';

const source = new URL('./fixtures/lod-group.fbx', import.meta.url);
const invalidSource = new URL('./fixtures/lod-group-invalid-mode.fbx', import.meta.url);
const binarySource = new URL(
  '../../../../forgeax-engine-assets/vendor/fbx-test/humanoid.fbx',
  import.meta.url,
);

interface RawLodDocument {
  readonly meshes?: readonly { readonly name?: string }[];
  readonly lodGroups?: readonly {
    readonly children?: readonly {
      readonly meshIndex?: unknown;
      readonly distance?: unknown;
      readonly display?: unknown;
    }[];
    readonly threshold?: unknown;
    readonly mode?: unknown;
    readonly relative?: unknown;
  }[];
}

interface RawBinaryDocument {
  readonly meshes?: readonly { readonly name?: string }[];
  readonly materials?: readonly { readonly name?: string }[];
  readonly clips?: readonly { readonly name?: string }[];
  readonly skeletons?: readonly unknown[];
  readonly skins?: readonly unknown[];
  readonly lodGroups?: readonly unknown[];
}

async function readFixture(): Promise<Uint8Array> {
  const nodeFs = (await import('node:' + 'fs/promises')) as unknown as {
    readonly readFile: (path: URL) => Promise<Uint8Array>;
  };
  return new Uint8Array(await nodeFs.readFile(source));
}

async function readUrl(url: URL): Promise<Uint8Array> {
  const nodeFs = (await import('node:' + 'fs/promises')) as unknown as {
    readonly readFile: (path: URL) => Promise<Uint8Array>;
  };
  return new Uint8Array(await nodeFs.readFile(url));
}

function binaryGuid(index: number): string {
  return `00000000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
}

function binaryOutputSourceKey(kind: string, name: string | undefined, fallback: string): string {
  return name === undefined
    ? (sourceKeyForFbxOutput({ kind }) ?? fallback)
    : (sourceKeyForFbxOutput({ kind, name }) ?? fallback);
}

function binaryMeta(raw: RawBinaryDocument): RunImportMeta {
  let index = 0;
  const subAssets: RunImportMeta['subAssets'][number][] = [];
  for (const [sourceIndex, mesh] of (raw.meshes ?? []).entries()) {
    subAssets.push({
      guid: binaryGuid(index++),
      sourceIndex,
      sourceKey: binaryOutputSourceKey('mesh', mesh.name, `fbx:mesh:${sourceIndex}`),
      kind: 'mesh',
    });
  }
  for (const [sourceIndex, material] of (raw.materials ?? []).entries()) {
    subAssets.push({
      guid: binaryGuid(index++),
      sourceIndex,
      sourceKey: binaryOutputSourceKey('material', material.name, `fbx:material:${sourceIndex}`),
      kind: 'material',
    });
  }
  if ((raw.skeletons?.length ?? 0) > 0) {
    subAssets.push({
      guid: binaryGuid(index++),
      sourceIndex: 0,
      sourceKey: 'fbx:skeleton',
      kind: 'skeleton',
    });
  }
  if ((raw.skins?.length ?? 0) > 0) {
    subAssets.push({
      guid: binaryGuid(index++),
      sourceIndex: 0,
      sourceKey: 'fbx:skin',
      kind: 'skin',
    });
  }
  for (const [sourceIndex, clip] of (raw.clips ?? []).entries()) {
    subAssets.push({
      guid: binaryGuid(index++),
      sourceIndex,
      sourceKey: binaryOutputSourceKey(
        'animation-clip',
        clip.name,
        `fbx:animation-clip:${sourceIndex}`,
      ),
      kind: 'animation-clip',
    });
  }
  subAssets.push({
    guid: binaryGuid(index),
    sourceIndex: 0,
    sourceKey: 'fbx:scene',
    kind: 'scene',
  });
  return { importer: 'fbx', source: 'humanoid.fbx', subAssets };
}

async function createPublicationRoot(): Promise<{
  readonly root: string;
  readonly remove: () => Promise<void>;
}> {
  const nodeFs = (await import('node:' + 'fs/promises')) as unknown as {
    readonly mkdtemp: (prefix: string) => Promise<string>;
    readonly rm: (
      path: string,
      options: { readonly recursive: boolean; readonly force: boolean },
    ) => Promise<void>;
  };
  const nodeOs = (await import('node:' + 'os')) as unknown as {
    readonly tmpdir: () => string;
  };
  const nodePath = (await import('node:' + 'path')) as unknown as {
    readonly join: (...parts: string[]) => string;
  };
  const root = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'forgeax-real-fbx-lod-'));
  return {
    root,
    remove: () => nodeFs.rm(root, { recursive: true, force: true }),
  };
}

function meta(raw: RawLodDocument): RunImportMeta {
  const subAssets = (raw.meshes ?? []).map((mesh, sourceIndex) => ({
    guid: `00000000-0000-7000-8000-${String(sourceIndex + 1).padStart(12, '0')}`,
    sourceIndex,
    sourceKey:
      sourceKeyForFbxOutput({
        kind: 'mesh',
        ...(mesh.name === undefined ? {} : { name: mesh.name }),
      }) ?? `fbx:mesh:${sourceIndex}`,
    kind: 'mesh' as const,
  }));
  return {
    importer: 'fbx',
    source: 'lod-group.fbx',
    subAssets: [
      ...subAssets,
      {
        guid: '00000000-0000-7000-8000-000000000003',
        sourceIndex: 0,
        sourceKey: 'fbx:scene',
        kind: 'scene',
      },
    ],
  };
}

describe('real FBX LodGroup importer closure', () => {
  beforeAll(async () => {
    await initFbxWasm();
  });

  it('exports native child order and produces mesh LOD metadata through Pack', async () => {
    const bytes = await readFixture();
    const raw = parseFbxToObject(bytes) as RawLodDocument;
    expect(raw.lodGroups).toHaveLength(1);
    expect(raw.lodGroups?.[0]).toMatchObject({
      threshold: 50,
      mode: 'distance',
      relative: false,
      children: [
        { meshIndex: 0, distance: 0, display: 'use-lod' },
        { meshIndex: 1, distance: 50, display: 'use-lod' },
      ],
    });

    const registry = new ImporterRegistry();
    registry.register(fbxImporter);
    const result = await runImport(meta(raw), registry, {
      readSource: async () => ({ ok: true as const, value: bytes }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    const meshes = result.value.pack.assets.filter((asset) => asset.kind === 'mesh');
    expect(meshes).toHaveLength(2);
    const root = meshes.find((asset) => asset.guid.endsWith('000000000001'));
    const rootLod = (
      root?.payload as {
        readonly lods?: readonly { readonly mesh: Uint8Array; readonly screenCoverage: number }[];
      }
    ).lods?.[0];
    expect(rootLod?.screenCoverage).toBe(0.5);
    expect(rootLod === undefined ? undefined : AssetGuid.format(rootLod.mesh as never)).toBe(
      '00000000-0000-7000-8000-000000000002',
    );
    const byGuid = new Map(result.value.pack.assets.map((asset) => [asset.guid, asset]));
    for (const asset of result.value.pack.assets) {
      for (const ref of asset.refs) expect(byGuid.has(ref)).toBe(true);
    }

    const publicationRoot = await createPublicationRoot();
    try {
      const rootGuid = root?.guid ?? '';
      const catalog = result.value.pack.assets.map((asset) => ({
        guid: asset.guid,
        packageUrl: `${asset.guid}.pack.json`,
        kind: asset.kind,
        sourcePath: 'lod-group.fbx',
      }));
      const finalized = await finalizePackageTransportSource(
        { assets: result.value.pack.assets },
        {
          base: '/',
          packagePath: `${rootGuid}.pack.json`,
          artifactPath: (assetGuid, key) => `${assetGuid}-${key}.bin`,
        },
      );
      const publication = await publishImportPublication({
        root: publicationRoot.root,
        guid: rootGuid,
        desiredKey: 'b'.repeat(64),
        pack: finalized.pack,
        previousCatalog: [],
        nextCatalog: catalog,
        publishedGuids: result.value.pack.assets.map((asset) => asset.guid),
        transport: {
          path: `${publicationRoot.root}/${rootGuid}.pack.json`,
          body: JSON.stringify(finalized.pack),
          artifacts: finalized.artifacts.map(({ path, mediaType, bytes }) => ({
            path,
            mediaType,
            bytes,
          })),
        },
      });
      expect(publication).toMatchObject({ ok: true, head: { state: 'current' } });
      if (publication.ok) {
        expect(publication.catalog).toHaveLength(catalog.length);
        expect(publication.catalog.some((entry) => entry.guid === root?.guid)).toBe(true);
      }
    } finally {
      await publicationRoot.remove();
    }
  }, 30_000);

  it('rejects a native forced-display level after parsing the real fixture', async () => {
    const bytes = await readUrl(invalidSource);
    const raw = parseFbxToObject(bytes) as RawLodDocument;
    expect(raw.lodGroups).toHaveLength(1);
    expect(raw.lodGroups?.[0]?.children?.[0]?.display).toBe('show');
    expect(parseFbxLodGroup(raw.lodGroups?.[0] ?? {})).toMatchObject({
      ok: false,
      error: { code: 'fbx-lod-display-mode-unsupported' },
    });
  }, 30_000);

  it('runs real binary bytes through ufbx, importer, runner, and Pack output', async () => {
    const bytes = await readUrl(binarySource);
    const raw = parseFbxToObject(bytes) as RawBinaryDocument;
    expect(raw.lodGroups ?? []).toHaveLength(0);

    const registry = new ImporterRegistry();
    registry.register(fbxImporter);
    const result = await runImport(binaryMeta(raw), registry, {
      readSource: async () => ({ ok: true as const, value: bytes }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok || 'skipped' in result.value) return;
    expect(result.value.pack.assets.some((asset) => asset.kind === 'mesh')).toBe(true);
    expect(result.value.pack.assets.some((asset) => asset.kind === 'scene')).toBe(true);
    const skeleton = result.value.pack.assets.find((asset) => asset.kind === 'skeleton');
    const bounds = (skeleton?.payload as { readonly bounds?: Float32Array })?.bounds;
    expect(bounds).toBeDefined();
    expect(Array.from(bounds ?? []).every(Number.isFinite)).toBe(true);
    expect(bounds?.length).toBe(6);
    const skeletonPayload = skeleton?.payload as {
      readonly jointCount: number;
      readonly shadowCapsules?: unknown;
    };
    const capsules = parseShadowCapsuleSet(
      skeletonPayload.shadowCapsules,
      skeletonPayload.jointCount,
    );
    expect(capsules?.joints.length).toBeGreaterThan(8);
    const byGuid = new Map(result.value.pack.assets.map((asset) => [asset.guid, asset]));
    for (const asset of result.value.pack.assets) {
      for (const ref of asset.refs) expect(byGuid.has(ref)).toBe(true);
    }
  }, 30_000);
});
