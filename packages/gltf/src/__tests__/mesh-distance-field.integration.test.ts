import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { packMeshBin } from '@forgeax/engine-geometry';
import {
  finalizeImportProducts,
  ImporterRegistry,
  meshAssetOutputProducer,
  projectImportProductForBuild,
  publishImportPublication,
  runImport,
} from '@forgeax/engine-import';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ImportedAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { DdcEntryStore } from '../../../ddc/src/entry-store';
import { meshAssetDataProducer } from '../../../import/src/scriptable-pack-output-producers';
import { gltfImporter } from '../gltf-importer';

const GUID = '11111111-1111-4111-8111-111111111111';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function produce(settings: unknown, shift = 0, doubleSided = false, alphaMode = 'OPAQUE') {
  const positions = new Float32Array([0, 0, shift, 2, 0, shift, 0, 2, shift]);
  const source = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ doubleSided, alphaMode }],
      buffers: [
        {
          byteLength: positions.byteLength,
          uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}`,
        },
      ],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    }),
  );
  const registry = new ImporterRegistry();
  registry.register(gltfImporter);
  const started = performance.now();
  const result = await runImport(
    {
      importer: 'gltf',
      source: 'independent.gltf',
      importSettings: { meshDistanceField: settings },
      subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'mesh:0', kind: 'mesh' }],
    },
    registry,
    { readSource: async () => ({ ok: true, value: source }) },
  );
  if (!result.ok) throw result.error;
  if (!('pack' in result.value)) throw new Error('missing pack');
  const asset = result.value.product.assets[0];
  if (!asset) throw new Error('missing mesh');
  return { asset, ms: performance.now() - started };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-mesh-field-'));
  const requests: string[] = [];
  let selectedKey: string | undefined;
  let corruptField: Uint8Array | undefined;
  let catalog: { guid: string; kind: string; packageUrl: string; sourcePath: string }[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? '/';
    requests.push(path);
    if (path === '/catalog.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(catalog));
      return;
    }
    try {
      if (path === '/mesh.pack.json') response.end(await readFile(join(root, 'runtime', path)));
      else {
        const entry = selectedKey ? await new DdcEntryStore(root).read(selectedKey) : undefined;
        const bytes =
          path === '/distance-field.bin' && corruptField
            ? corruptField
            : entry?.artifacts[path.slice(1)]?.bytes;
        if (!bytes) throw new Error('missing artifact in accepted DDC entry');
        response.end(bytes);
      }
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const registry = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  registry.configurePackIndex(`http://127.0.0.1:${address.port}/catalog.json`);
  return {
    registry,
    requests,
    async publish(asset: ImportedAsset<unknown>, omitField = false) {
      const pack = projectImportProductForBuild({ assets: [asset] });
      const cooked = await finalizeImportProducts(
        { assets: [asset], sourceDependencies: ['independent.gltf'] },
        'fixture',
      );
      const descriptors = cooked[0]?.artifacts;
      if (!descriptors) throw new Error('missing descriptors');
      const body = {
        ...pack,
        assets: pack.assets.map((row) => ({ ...row, artifacts: descriptors })),
      };
      const serialized = JSON.stringify(body);
      const nextCatalog = [
        { guid: GUID, kind: 'mesh', sourcePath: 'independent.gltf', packageUrl: '/mesh.pack.json' },
      ];
      const started = performance.now();
      const result = await publishImportPublication({
        root,
        guid: GUID,
        desiredKey: hash(serialized),
        pack: body,
        previousCatalog: catalog,
        nextCatalog,
        publishedGuids: [GUID],
        transport: {
          path: join(root, 'runtime', 'mesh.pack.json'),
          body: serialized,
          artifacts: Object.entries(asset.artifacts)
            .filter(([name]) => !(omitField && name === 'distance-field.bin'))
            .map(([path, artifact]) => ({ path, ...artifact })),
        },
      });
      if (result.ok) {
        selectedKey = result.key;
        corruptField = undefined;
        catalog = nextCatalog;
        registry.invalidate(GUID);
      }
      return { result, ms: performance.now() - started, descriptors };
    },
    async corrupt(bytes: Uint8Array) {
      corruptField = bytes;
      registry.invalidate(GUID);
    },
    async load() {
      const result = await registry.loadByGuid<MeshAsset>(registry.parseGuid(GUID));
      return result;
    },
    async mesh() {
      const result = await registry.loadByGuid<MeshAsset>(registry.parseGuid(GUID));
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const mesh = registry.lookup(GUID);
      if (mesh?.kind !== 'mesh') throw new Error('expected loaded mesh');
      return mesh;
    },
    async close() {
      registry.invalidateAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const report: Record<string, unknown> = {};
describe('optional mesh distance field publication through actual HTTP Catalog', () => {
  it('loads compact binary and JSON products, re-exports a loaded Mesh, and retains one GUID', async () => {
    const f = await fixture();
    try {
      const source = await produce({ voxelSize: 0.5 });
      const cold = await f.publish(source.asset);
      expect(cold.result.ok).toBe(true);
      const mesh = await f.mesh();
      expect(mesh.distanceField?.policy.kind).toBe('sampled-visibility');
      expect(mesh.distanceField?.sectionSidedness).toEqual([0]);
      const fieldArtifact = source.asset.artifacts['distance-field.bin'];
      if (!fieldArtifact) throw new Error('missing field artifact');
      const artifact = {
        integrity: { algorithm: 'sha256', digest: `sha256:${hash(fieldArtifact.bytes)}` },
        assetCodec: fieldArtifact.assetCodec,
      };
      expect(mesh.distanceField).toMatchObject({ artifact });
      expect(packMeshBin(mesh, GUID).ok).toBe(false);
      const firstValues = mesh.distanceField?.values;
      for (const producer of [meshAssetDataProducer, meshAssetOutputProducer]) {
        const exported = await producer.produce({ guid: GUID, sourceKey: 'mesh:0', asset: mesh });
        if (!exported.ok) throw exported.error;
        expect(exported.value.artifacts['distance-field.bin']?.bytes).toEqual(fieldArtifact.bytes);
        const result = await f.publish({ guid: GUID, kind: 'mesh', ...exported.value });
        expect(result.result.ok).toBe(true);
        const loaded = await f.mesh();
        expect(loaded.distanceField?.values).toEqual(firstValues);
        expect(loaded.distanceField).toMatchObject({ artifact });
        expect(loaded.attributes.position).toEqual(mesh.attributes.position);
      }
      const warm = await f.publish(source.asset);
      expect(warm.result.ok).toBe(true);
      const warmMesh = await f.mesh();
      const before = f.requests.length;
      expect(await f.mesh()).toBe(warmMesh);
      expect(f.requests.length).toBe(before);
      const disabled = await produce(false);
      report.production = {
        coldCookMs: source.ms,
        coldPublishMs: cold.ms,
        warmDdcPublishMs: warm.ms,
        disabledCookMs: disabled.ms,
        fieldArtifactBytes: source.asset.artifacts['distance-field.bin']?.bytes.byteLength,
        baseGeometryBytes: disabled.asset.artifacts.body?.bytes.byteLength,
        geometryWithFieldBytes: source.asset.artifacts.body?.bytes.byteLength,
        warmLoadExtraRequests: f.requests.length - before,
      };
    } finally {
      await f.close();
    }
  });

  it('replaces geometry, sidedness and resolution at the same GUID; failed publication preserves LKG', async () => {
    const f = await fixture();
    try {
      const first = await produce({ voxelSize: 0.5 });
      await f.publish(first.asset);
      const a = await f.mesh();
      const changed = await produce({ voxelSize: 0.25 }, 3, true, 'MASK');
      const published = await f.publish(changed.asset);
      expect(published.result.ok).toBe(true);
      const b = await f.mesh();
      expect(b).not.toBe(a);
      expect(b.distanceField?.meshDigest).not.toBe(a.distanceField?.meshDigest);
      expect(b.distanceField?.spacing).toBe(0.25);
      expect(b.distanceField?.sectionSidedness).toEqual([1]);
      const broken = await f.publish(first.asset, true);
      expect(broken.result.ok).toBe(false);
      expect(await f.mesh()).toBe(b);
      f.registry.invalidate(GUID);
      expect((await f.mesh()).distanceField?.meshDigest).toBe(b.distanceField?.meshDigest);
      const same = await produce({ voxelSize: 0.25 }, 3, true, 'MASK');
      expect(same.asset.artifacts['distance-field.bin']?.bytes).toEqual(
        changed.asset.artifacts['distance-field.bin']?.bytes,
      );
    } finally {
      await f.close();
    }
  });

  it.each([
    'geometry',
    'sidedness',
    'missing',
    'orphan',
    'codec',
    'profile',
    'malformed',
  ] as const)('rejects %s mismatch through the common binary/JSON loader', async (fault) => {
    for (const binary of [true, false]) {
      const f = await fixture();
      try {
        const source = (await produce({ voxelSize: 0.5 })).asset;
        const other = (await produce({ voxelSize: 0.5 }, 5)).asset;
        const payload = { ...(source.payload as Record<string, unknown>) };
        const artifacts = { ...source.artifacts };
        if (fault === 'geometry') {
          Object.assign(payload, other.payload);
          if (other.artifacts.body) artifacts.body = other.artifacts.body;
        }
        if (fault === 'sidedness') payload.distanceField = { sectionSidedness: [1] };
        if (fault === 'orphan') delete payload.distanceField;
        if (fault === 'profile' && artifacts['distance-field.bin'])
          artifacts['distance-field.bin'] = {
            ...artifacts['distance-field.bin'],
            assetCodec: {
              name: 'mesh-distance-field',
              version: '4',
              profile: 'sampled-visibility/4',
            },
          };
        if (fault === 'missing') delete artifacts['distance-field.bin'];
        if (fault === 'codec' && artifacts['distance-field.bin'])
          artifacts['distance-field.bin'] = {
            ...artifacts['distance-field.bin'],
            assetCodec: { name: 'mesh-distance-field', version: '3' },
          };
        if (fault === 'malformed' && artifacts['distance-field.bin'])
          artifacts['distance-field.bin'] = {
            ...artifacts['distance-field.bin'],
            bytes: new Uint8Array([1, 2, 3]),
          };
        if (!binary) delete artifacts.body;
        expect((await f.publish({ ...source, payload, artifacts })).result.ok).toBe(true);
        expect(await f.load()).toMatchObject({ ok: false, error: { code: 'asset-parse-failed' } });
      } finally {
        await f.close();
      }
    }
  });

  it('detects changed HTTP artifact bytes using the ordinary full digest check', async () => {
    const f = await fixture();
    try {
      const source = (await produce({ voxelSize: 0.5 })).asset;
      await f.publish(source);
      const bytes = source.artifacts['distance-field.bin']?.bytes.slice();
      if (!bytes) throw new Error('no field');
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      await f.corrupt(bytes);
      expect(await f.load()).toMatchObject({
        ok: false,
        error: { code: 'asset-artifact-integrity-mismatch' },
      });
    } finally {
      await f.close();
    }
  });

  it('omission generates no field, adds no field request, and replaces previous field data', async () => {
    const f = await fixture();
    try {
      await f.publish((await produce({ voxelSize: 0.5 })).asset);
      await f.mesh();
      for (const settings of [false, undefined]) {
        const asset = (await produce(settings)).asset;
        expect(asset.payload).not.toHaveProperty('distanceField');
        expect(asset.artifacts).not.toHaveProperty('distance-field.bin');
        await f.publish(asset);
        const before = f.requests.length;
        expect((await f.mesh()).distanceField).toBeUndefined();
        expect(f.requests.slice(before)).not.toContain('/distance-field.bin');
      }
    } finally {
      await f.close();
    }
  });

  it('fails invalid Meta settings and BLEND before publication', async () => {
    for (const setting of [true, {}, { voxelSize: 0 }, { voxelSize: 0.5, unknown: true }])
      await expect(produce(setting)).rejects.toMatchObject({ code: 'import-internal-error' });
    await expect(produce({ voxelSize: 0.5 }, 0, false, 'BLEND')).rejects.toMatchObject({
      code: 'import-internal-error',
    });
    if (process.env.FORGEAX_MESH_FIELD_REPORT) {
      await mkdir(join(process.env.FORGEAX_MESH_FIELD_REPORT, '..'), { recursive: true });
      await writeFile(
        process.env.FORGEAX_MESH_FIELD_REPORT,
        JSON.stringify(
          {
            ...report,
            gpuValidated: false,
            fixture: 'independent static triangle, real HTTP and atomic DDC publication',
          },
          null,
          2,
        ),
      );
    }
  });
});

it.runIf(process.env.FORGEAX_MESH_FIELD_SPONZA === '1')(
  'validates Sponza as an optional full source sample through the same HTTP product',
  async () => {
    const sourcePath = resolve('forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf');
    const source = await readFile(sourcePath);
    const registry = new ImporterRegistry();
    registry.register(gltfImporter);
    const f = await fixture();
    try {
      const started = performance.now();
      const imported = await runImport(
        {
          importer: 'gltf',
          source: sourcePath,
          importSettings: { meshDistanceField: { voxelSize: 64 } },
          subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'mesh:0', kind: 'mesh' }],
        },
        registry,
        {
          readSource: async (path) => ({ ok: true, value: new Uint8Array(await readFile(path)) }),
          readSibling: async (_source, path) => ({
            ok: true,
            value: new Uint8Array(await readFile(resolve(dirname(sourcePath), path))),
          }),
        },
      );
      if (!imported.ok) throw new Error(JSON.stringify(imported.error));
      const cookMs = performance.now() - started;
      if (!('product' in imported.value)) throw new Error('no Sponza product');
      const asset = imported.value.product.assets[0];
      if (!asset) throw new Error('missing Sponza mesh');
      const published = await f.publish(asset);
      expect(published.result.ok).toBe(true);
      const loadStart = performance.now();
      const mesh = await f.mesh();
      const loadMs = performance.now() - loadStart;
      expect(mesh.submeshes).toHaveLength(103);
      expect(mesh.distanceField?.sectionSidedness).toHaveLength(103);
      expect(mesh.distanceField?.policy.kind).toBe('sampled-visibility');
      const fieldArtifact = asset.artifacts['distance-field.bin'];
      if (!fieldArtifact) throw new Error('missing Sponza field artifact');
      expect(mesh.distanceField?.artifact).toEqual({
        integrity: { algorithm: 'sha256', digest: `sha256:${hash(fieldArtifact.bytes)}` },
        assetCodec: fieldArtifact.assetCodec,
      });
      const before = f.requests.length;
      expect(await f.mesh()).toBe(mesh);
      expect(f.requests.length).toBe(before);
      const data = {
        sample: 'Khronos Sponza, all 103 source sections',
        sourceSha256: hash(source),
        voxelSizeSourceUnits: 64,
        cookMs,
        publicationMs: published.ms,
        loadMs,
        geometryBytes: asset.artifacts.body?.bytes.byteLength,
        fieldArtifactBytes: asset.artifacts['distance-field.bin']?.bytes.byteLength,
        fieldArtifact: mesh.distanceField?.artifact,
        dimensions: mesh.distanceField?.dimensions,
        triangles: mesh.indices ? mesh.indices.length / 3 : 0,
        policy: mesh.distanceField?.policy,
        gpuValidated: false,
        materialQualification:
          'geometry and source sidedness only; MASK remains approximate and is not alpha coverage',
      };
      await mkdir('artifacts/raytracing/mesh-distance-field', { recursive: true });
      await writeFile(
        'artifacts/raytracing/mesh-distance-field/sponza.json',
        JSON.stringify(data, null, 2),
      );
    } finally {
      await f.close();
    }
  },
  120000,
);
