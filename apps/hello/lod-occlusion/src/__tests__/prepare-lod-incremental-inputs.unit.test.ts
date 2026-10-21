import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { gltfImporter } from '@forgeax/engine-gltf';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { materialContribution } from '@forgeax/engine-render';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { ok } from '@forgeax/engine-types';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type {
  AssetRuntimeArtifactDescriptor,
  AssetRef,
  ImportResult,
  MeshAsset,
} from '@forgeax/engine-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadLodProducerAssets } from '../../scripts/lod-acceptance-evidence.mjs';
import { prepareLodIncrementalInputs } from '../../scripts/prepare-lod-incremental-inputs.mjs';

type Manifest = Awaited<ReturnType<typeof prepareLodIncrementalInputs>>;
interface AssetRow {
  guid: string;
  kind: string;
  payload: Record<string, unknown>;
  refs: AssetRef[];
  artifacts: Record<string, AssetRuntimeArtifactDescriptor>;
}
const app = fileURLToPath(new URL('../../', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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

function registry() {
  const assets = new AssetRegistry({ shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }) });
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.installDecoder(materialContribution.kind, materialContribution.decoder);
  return assets;
}

async function decodeMesh(row: AssetRow, body?: Uint8Array) {
  return meshAssetContribution.decoder.decode({
    envelope: { ...row, payload: row.payload as unknown as MeshAsset, refs: row.refs.map(ref => ref.guid) },
    artifacts: { read: async descriptor => ok(body ?? new Uint8Array(await readFile(resolve(directory, descriptor.path)))) },
    signal: new AbortController().signal,
  });
}

function nativeMesh(value: NonNullable<MeshAsset['lods']>[number]['mesh']) {
  if (typeof value !== 'number') throw new Error('Source LOD was not adopted as a runtime handle');
  return value;
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
        expect((await decodeMesh({ ...await wire(original.guid), payload: unprepared, artifacts: {} })).ok).toBe(false);
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

  it('reloads a complete expanded closure on the original root handle and preserves held versions', async () => {
    const assets = registry();
    const staged = await loadLodProducerAssets(assets, manifest, async path => new Uint8Array(await readFile(resolve(directory, path))), manifest.roles);
    const root = staged.root;
    const initial = assets.read(root).unwrap();
    expect(initial.vertices).toBeInstanceOf(Float32Array);
    expect(initial.lods).toHaveLength(1);
    expect(assets.source(nativeMesh(initial.lods![0]!.mesh)).unwrap()?.guid).toBe(manifest.roles.middle);
    const held = assets.snapshot(root).unwrap();
    const world = new World({ assets });
    const identity = world.identity;
    await staged.admitLowest();
    const current = assets.snapshot(root).unwrap();
    const complete = assets.read(root).unwrap();
    expect(complete.lods).toHaveLength(2);
    const lowest = nativeMesh(complete.lods![1]!.mesh);
    expect(assets.source(lowest).unwrap()?.guid).toBe(manifest.roles.lowest);
    expect(assets.read(lowest).unwrap().vertices).toBeInstanceOf(Float32Array);
    expect(current.version(root).unwrap()).toBeGreaterThan(held.version(root).unwrap());
    expect(held.read<MeshAsset>(root).unwrap().lods).toHaveLength(1);
    expect(world.identity).toBe(identity);
    expect(assets.validate(root).ok).toBe(true);
    evidence.incremental = { handle: Number(root), rootIdentityPreserved: true, versionAdvanced: true, completeInitialClosure: true, lowestReadyAfterReload: true, gpuReadiness: 'unverified' };
    held.dispose();
    current.dispose();
    assets.release(root).unwrap();
  });

  it('normal source root load eagerly decodes the complete original producer closure', async () => {
    const rows = await Promise.all(manifest.assets.filter(row => row.kind !== 'scene').map(row => wire(row.guid)));
    const packageUrl = 'https://e03.invalid/inputs.pack.json';
    const publication = createRuntimePackPublication({ scopeId: 'asset-runtime', sourcePath: 'lod-scene.gltf', sourceRevision: 'complete', packageUrl, pack: { assets: rows.map(row => ({...row, refs: row.refs.map(ref => ref.guid), artifacts: Object.fromEntries(Object.entries(row.artifacts).map(([key, descriptor]) => [key, {...descriptor, integrity: {...descriptor.integrity, digest: `sha256:${descriptor.integrity!.digest}`}}]))})) } });
    const assets = registry();
    const calls: string[] = [];
    assets.setCatalogSource(createCatalogSource({
      entries: rows.map(row => ({ guid: row.guid, kind: row.kind, packageUrl, sourcePath: 'lod-scene.gltf', publication: publication.publication })),
      fetch: async input => {
        const url = String(input);
        calls.push(url);
        if (url === packageUrl) return new Response(JSON.stringify(publication.pack));
        return new Response(await readFile(resolve(directory, new URL(url).pathname.slice(1))));
      },
    }));
    const root = (await assets.load(manifest.roles.root, 'mesh')).unwrap();
    const value = assets.read(root).unwrap();
    expect(value.lods).toHaveLength(2);
    for (const handle of [root, ...value.lods!.map(lod => nativeMesh(lod.mesh))]) {
      expect(assets.read(handle).unwrap().vertices).toBeInstanceOf(Float32Array);
    }
    expect(assets.source(nativeMesh(value.lods![1]!.mesh)).unwrap()?.guid).toBe(manifest.roles.lowest);
    evidence.normalPack = { actualProducerBytes: true, lowestEagerReady: true, calls };
    assets.release(root).unwrap();
  });

  it('rejects truncated actual binary data through the public mesh decoder', async () => {
    const row = await wire(manifest.roles.lowest);
    const descriptor = row.artifacts.body;
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error('Missing lowest mesh body artifact descriptor');
    const bytes = await readFile(resolve(directory, descriptor.path));
    expect(hash(bytes.subarray(0, 16))).not.toBe(descriptor.integrity?.digest);
    const rejected = await decodeMesh(row, bytes.subarray(0, 16));
    expect(rejected.ok).toBe(false);
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
