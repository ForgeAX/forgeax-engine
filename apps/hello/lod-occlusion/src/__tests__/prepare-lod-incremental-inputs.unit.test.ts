import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry, materialLoader, meshLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { gltfImporter } from '@forgeax/engine-gltf';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type {
  ArtifactDescriptor,
  Asset,
  AssetRef,
  ImportResult,
  LoadContext,
  MeshAsset,
} from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareLodIncrementalInputs } from '../../scripts/prepare-lod-incremental-inputs.mjs';

type Manifest = Awaited<ReturnType<typeof prepareLodIncrementalInputs>>;
interface AssetRow {
  guid: string;
  kind: string;
  payload: Record<string, unknown>;
  refs: AssetRef[];
  artifacts: Record<string, ArtifactDescriptor>;
}
const app = fileURLToPath(new URL('../../', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const context: LoadContext = {
  fetchBinary: async () => {
    throw new Error('Artifact bytes are supplied explicitly');
  },
  resolveRef: async () => {
    throw new Error('Pure decoding must not eagerly load a ref');
  },
  transcodeCaps: { bc: false, etc2: false, astc: false },
  device: undefined,
};
let temp: string;
let directory: string;
let manifest: Manifest;
const evidence: Record<string, unknown> = {};

async function wire(guid: string): Promise<AssetRow> {
  const row = manifest.assets.find((asset) => asset.guid === guid);
  if (!row) throw new Error(`Missing manifest row: ${guid}`);
  const bytes = await readFile(resolve(directory, row.path));
  expect(hash(bytes)).toBe(row.sha256);
  expect(bytes.byteLength).toBe(row.byteLength);
  return JSON.parse(bytes.toString('utf8')) as AssetRow;
}

async function decode(guid: string): Promise<Asset> {
  const row = await wire(guid);
  const refs = row.refs.map((ref) => ref.guid);
  const artifacts: Record<string, { descriptor: ArtifactDescriptor; bytes: Uint8Array }> = {};
  for (const [key, descriptor] of Object.entries(row.artifacts)) {
    const bytes = await readFile(resolve(directory, descriptor.path));
    expect(hash(bytes)).toBe(descriptor.integrity?.digest);
    expect(bytes.byteLength).toBe(descriptor.byteLength);
    artifacts[key] = { descriptor, bytes };
  }
  const value =
    row.kind === 'mesh'
      ? await meshLoader.loadPack?.(
          { guid, kind: row.kind, payload: row.payload, refs, artifacts },
          context,
        )
      : await materialLoader.load(row.payload, refs, context);
  if (!value || 'ok' in value)
    throw new Error(`Public loader rejected ${guid}: ${JSON.stringify(value)}`);
  return value;
}

async function admit(registry: AssetRegistry, guids: readonly string[]) {
  for (const guid of guids) {
    const row = await wire(guid);
    registry.catalog(guid, await decode(guid), row.refs).unwrap();
  }
}

describe('E03 real build-time incremental inputs', () => {
  beforeAll(async () => {
    temp = await mkdtemp(resolve(tmpdir(), 'forgeax-e03-producer-'));
    directory = resolve(temp, 'inputs');
    manifest = await prepareLodIncrementalInputs({ output: directory });
  });
  afterAll(async () => {
    if (process.env.E03_PRODUCER_EVIDENCE) {
      await writeFile(process.env.E03_PRODUCER_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  it('preserves every real importer GUID, source field and original ref, including low LOD', async () => {
    const meta = JSON.parse(
      await readFile(resolve(app, 'assets/lod-scene.gltf.meta.json'), 'utf8'),
    );
    const imported: ImportResult = await gltfImporter.import({
      source: meta.source,
      subAssets: meta.subAssets,
      importSettings: meta.importSettings,
      sourceOverrides: meta.sourceOverrides,
      readSource: async () => ({
        ok: true,
        value: await readFile(resolve(app, 'assets', meta.source)),
      }),
      readSibling: async () => {
        throw new Error('Embedded fixture requested an external resource');
      },
      decodeImage: async () => {
        throw new Error('The material fixture must not request textures');
      },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw imported.error;
    expect(manifest.assets.map((row) => row.guid)).toEqual(
      imported.value.assets.map((row) => row.guid),
    );
    const plainJsonRejected: string[] = [];
    for (const original of imported.value.assets) {
      expect((await wire(original.guid)).refs).toEqual(original.refs);
      if (original.kind === 'mesh') {
        // Plain JSON loses native typed arrays and GUID bytes. The emitted
        // binary publication must cross the public loader instead.
        const unprepared = JSON.parse(JSON.stringify(original.payload));
        expect(
          await meshLoader.load(
            unprepared,
            original.refs.map((ref) => ref.guid),
            context,
          ),
        ).toBeUndefined();
        plainJsonRejected.push(original.guid);
      }
      for (const [key, body] of Object.entries(original.artifacts)) {
        const row = await wire(original.guid);
        const descriptor = row.artifacts[key];
        expect(descriptor).toBeDefined();
        if (!descriptor) throw new Error(`Missing emitted artifact descriptor: ${key}`);
        expect(await readFile(resolve(directory, descriptor.path))).toEqual(
          Buffer.from(body.bytes),
        );
      }
    }
    expect(
      manifest.assets.find((row) => row.guid === manifest.roles.root)?.refs.map((ref) => ref.guid),
    ).toContain(manifest.roles.lowest);
    expect(manifest.admission.excluded).toEqual([manifest.roles.scene]);
    expect(manifest.shaderClosure.status).toBe('not-prepared');
    expect(manifest.shaderClosure.gpuReadiness).toBe('unverified');
    evidence.provenance = manifest.provenance;
    evidence.assets = manifest.assets;
    evidence.plainJsonCounterexample = {
      rejectedMeshGuids: plainJsonRejected,
      reason: 'Original native producer payload does not survive plain JSON as runtime Mesh data',
    };
  });

  it('round-trips real binary meshes, then admits the same low GUID without changing root identity or refs', async () => {
    const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    await admit(registry, manifest.admission.initial);
    const root = registry.lookup<MeshAsset>(manifest.roles.root);
    expect(root?.kind).toBe('mesh');
    if (!root) throw new Error('Root mesh was not admitted');
    expect(root.vertices).toBeInstanceOf(Float32Array);
    expect(root.lods?.map((lod) => AssetGuid.format(lod.mesh))).toEqual([
      manifest.roles.middle,
      manifest.roles.lowest,
    ]);
    expect(registry.lookup(manifest.roles.lowest)).toBeUndefined();
    const originalRootRefs = (await wire(manifest.roles.root)).refs;
    const world = new World();
    const identity = world.identity;
    const handle = world.sharedRefs.acquire('MeshAsset', root);
    expect(world.sharedRefs.resolve(handle).unwrap()).toBe(root);
    expect(world.sharedRefs.refcount(handle)).toBe(1);
    await admit(registry, manifest.admission.later);
    const lowest = registry.lookup<MeshAsset>(manifest.roles.lowest);
    expect(lowest?.kind).toBe('mesh');
    expect(registry.lookup(manifest.roles.root)).toBe(root);
    expect((await wire(manifest.roles.root)).refs).toEqual(originalRootRefs);
    expect(world.identity).toBe(identity);
    expect(world.sharedRefs.resolve(handle).unwrap()).toBe(root);
    expect(world.sharedRefs.refcount(handle)).toBe(1);
    expect(registry.lookup(manifest.roles.scene)).toBeUndefined();
    evidence.incremental = {
      worldIdentity: identity,
      handle: Number(handle),
      refcount: 1,
      lowestAbsentInitially: true,
      lowestReadyAfterCatalog: true,
      rootIdentityPreserved: true,
      rootRefsUnchanged: true,
      sceneNotAdmitted: true,
      rootVertexBytes: root.vertices.byteLength,
      lowestVertexBytes: lowest?.vertices.byteLength,
      gpuReadiness: 'unverified',
    };
    world.sharedRefs.release(handle).unwrap();
  });

  it('normal all-catalog control admits all three actual decoded meshes', async () => {
    const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    await admit(registry, [...manifest.admission.initial, ...manifest.admission.later]);
    for (const guid of [manifest.roles.root, manifest.roles.middle, manifest.roles.lowest]) {
      expect(registry.lookup<MeshAsset>(guid)?.vertices).toBeInstanceOf(Float32Array);
    }
    evidence.normalCatalog = { allThreeActualMeshesReady: true };
  });

  it('normal root loadByGuid still eagerly loads the actual lowest producer output', async () => {
    const rows = await Promise.all(manifest.assets.map((row) => wire(row.guid)));
    const pack = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: rows.map((row) => ({
        ...row,
        refs: row.refs.map((ref) => ref.guid),
      })),
    };
    const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
    registry.configurePackIndex('https://e03.invalid/pack-index.json');
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/pack-index.json'))
        return new Response(
          JSON.stringify(
            rows.map((row) => ({
              guid: row.guid,
              kind: row.kind,
              sourcePath: 'lod-scene.gltf',
              packageUrl: 'https://e03.invalid/inputs.pack.json',
            })),
          ),
        );
      if (url.endsWith('/inputs.pack.json')) return new Response(JSON.stringify(pack));
      const path = new URL(url).pathname.slice(1);
      return new Response(await readFile(resolve(directory, path)));
    });
    try {
      expect(registry.lookup(manifest.roles.lowest)).toBeUndefined();
      (await registry.loadByGuid(registry.parseGuid(manifest.roles.root))).unwrap();
      expect(registry.lookup(manifest.roles.lowest)?.kind).toBe('mesh');
      expect(registry.loaders.referencePolicy('mesh')).toBe('eager');
      evidence.normalPack = { actualProducerBytes: true, lowestEagerReady: true, calls };
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects truncated actual binary data through the public mesh decoder', async () => {
    const row = await wire(manifest.roles.lowest);
    const descriptor = row.artifacts.body;
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error('Missing lowest mesh body artifact descriptor');
    const bytes = await readFile(resolve(directory, descriptor.path));
    expect(hash(bytes.subarray(0, 16))).not.toBe(descriptor.integrity?.digest);
    const rejected = await meshLoader.loadPack?.(
      {
        guid: row.guid,
        kind: row.kind,
        payload: row.payload,
        refs: row.refs.map((ref) => ref.guid),
        artifacts: { body: { descriptor, bytes: bytes.subarray(0, 16) } },
      },
      context,
    );
    expect(rejected && 'ok' in rejected && rejected.ok === false).toBe(true);
    evidence.truncatedBinaryCounterexample = {
      guid: row.guid,
      originalBytes: bytes.byteLength,
      submittedBytes: 16,
      loaderOutput: rejected,
    };
  });

  it('does not overwrite an existing publication or publish a missing shader closure', async () => {
    const before = await readFile(resolve(directory, 'manifest.json'));
    await expect(prepareLodIncrementalInputs({ output: directory })).rejects.toThrow('EEXIST');
    expect(await readFile(resolve(directory, 'manifest.json'))).toEqual(before);
    const incomplete = resolve(temp, 'missing-shaders.json');
    await writeFile(incomplete, JSON.stringify({ entries: [], materialShaders: [] }));
    const rejected = resolve(temp, 'rejected-inputs');
    await expect(
      prepareLodIncrementalInputs({ output: rejected, shaderManifest: incomplete }),
    ).rejects.toThrow('missing an original material program');
    await expect(readFile(resolve(rejected, 'manifest.json'))).rejects.toThrow('ENOENT');
  });

  const shaderManifest = process.env.E03_SHADER_MANIFEST;
  it.runIf(Boolean(shaderManifest))(
    'verifies real shader publication source hashes without claiming GPU readiness',
    async () => {
      if (!shaderManifest) throw new Error('E03_SHADER_MANIFEST is required for this check');
      const prepared = await prepareLodIncrementalInputs({
        output: resolve(temp, 'shader-inputs'),
        shaderManifest,
      });
      expect(prepared.shaderClosure.status).toBe('cpu-publication-verified');
      expect(prepared.shaderClosure.gpuReadiness).toBe('unverified');
      evidence.shaderClosure = prepared.shaderClosure;
    },
  );
});
