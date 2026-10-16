import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS } from '@forgeax/engine-pack/build';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { type ArtifactDescriptor, ok, type ParticleEffectAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { type BuildProductionFile, produceBuildAssets } from '../build-production.js';
import { buildCatalogResult } from '../catalog-inventory.js';
import { ImporterRegistry } from '../importer-registry.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageIdText = '019ffa97-4000-7000-8000-000000000001';
const packageId = (() => {
  const parsed = PackageId.parse(packageIdText);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
const guid = (sourceKey: string) => AssetGuid.format(AssetGuid.derive(packageId, sourceKey));

// Matches the game's throwable source: one GPU particle per original layer,
// with the Molotov terrain mesh supplied by the Player at runtime.
const entry = `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0);
  (*particle).mesh_scale = vec3<f32>(1.0);
  (*particle).lifetime = 1.0;
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}
`;

function packSource(invalidMesh: unknown = undefined): string {
  return `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { ok } from '@forgeax/engine-types';
const packageId = definePackageId('${packageIdText}');
const guid = (key) => AssetGuid.format(AssetGuid.derive(packageId, key));
export default definePack({
  schemaVersion: '2.0.0', packageId,
  async build() {
    const out = {
      'material/fire': { kind: 'material', values: { baseColor: [1, .19, .015, .58] } },
      'material/ember': { kind: 'material', values: { baseColor: [1, .7, .12, .9] } },
      'mesh/burst': createSphereGeometry(1, 12, 8).unwrap(),
    };
    for (const key of ${JSON.stringify(invalidMesh === undefined ? ['fire/burst', 'molotov/fire', 'molotov/ember'] : ['molotov/ember'])}) {
      const [style, layer] = key.split('/');
      const molotov = style === 'molotov';
      const cooked = await cookParticleCodeEffect({
        schemaVersion: 3,
        emitters: [{
          id: layer, capacity: 1, backend: { required: 'gpu' }, space: 'local',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: molotov ? 4 : 1 },
          simulationWhenCulled: 'continue',
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'throwable-static.vfx.wgsl' },
          renderers: [{
            kind: 'mesh', mesh: molotov ? { source: 'player' } : guid('mesh/burst'),
            material: guid('material/' + (molotov ? layer : style)),
            lighting: 'unlit', castShadows: false, receiveShadows: false,
          }],
        }],
      }, { 'throwable-static.vfx.wgsl': { entry: ${JSON.stringify(entry)} } });
      if (!cooked.ok) return cooked;
      ${invalidMesh === undefined ? '' : `cooked.value.asset.program.emitters[0].renderers[0].mesh = ${JSON.stringify(invalidMesh)};`}
      out['effect/' + key] = cooked.value.asset;
    }
    return ok(out);
  },
});
`;
}

describe('Player mesh effects through ordinary Pack build production', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function production(invalidMesh?: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-player-mesh-production-'));
    roots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    await mkdir(join(root, 'node_modules', '@forgeax'), { recursive: true });
    for (const owner of ['pack', 'types', 'geometry', 'vfx-compiler']) {
      await symlink(
        join(repositoryRoot, 'packages', owner),
        join(root, 'node_modules', '@forgeax', `engine-${owner}`),
        'dir',
      );
    }
    await writeFile(join(assets, 'throwable-fx.pack.ts'), packSource(invalidMesh));
    const sourceSnapshot = createScriptablePackSourceSnapshot();
    const sourceIdentityFor = (path: string) => relative(root, path).replaceAll('\\', '/');
    const inventory = await buildCatalogResult(
      [assets],
      '/',
      new Set(),
      {
        scriptablePack: {
          ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
          metadataOnly: true,
          sourceSnapshot,
        },
      },
      () => true,
      sourceIdentityFor,
    );
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.authority).toBe('authoritative');
    const emitted = new Map<string, BuildProductionFile['source']>();
    const result = produceBuildAssets({
      inventory,
      sourceSnapshot,
      cwd: root,
      basePrefix: '/',
      generation: 1,
      cookers: [],
      importerRegistry: new ImporterRegistry(),
      fsForImport: { readSource: async (path) => ok(await readFile(path)), sourceIdentityFor },
      cookedCurrentProjection: {},
      directCurrentProjection: {},
      authoredCookedCurrentProjection: {},
      sink: {
        emitFile(file) {
          const path = file.fileName ?? file.name;
          if (path === undefined) throw new Error('missing emitted file identity');
          emitted.set(path, file.source);
          return path;
        },
        getFileName: (referenceId) => referenceId,
        fileUrl: (path) => `/${path}`,
      },
      fail: (failure) => Object.assign(new Error(failure.code), failure),
    });
    return { result, emitted };
  }

  it('publishes real cooked Molotov Player meshes and static GUID effects with their exact dependency closure', async () => {
    const { result, emitted } = await production();
    const catalog = await result;
    expect(catalog).toHaveLength(6);
    expect(new Set(catalog.map((asset) => asset.packageUrl)).size).toBe(1);
    const packBytes = emitted.get(`assets/${packageIdText}.pack.json`);
    if (packBytes === undefined) throw new Error('production did not emit the Pack');
    const pack = JSON.parse(
      typeof packBytes === 'string' ? packBytes : new TextDecoder().decode(packBytes),
    ) as {
      assets: {
        guid: string;
        refs: string[];
        payload: ParticleEffectAsset;
        artifacts: Record<string, ArtifactDescriptor>;
      }[];
    };
    for (const key of ['fire/burst', 'molotov/fire', 'molotov/ember']) {
      const material = guid(`material/${key === 'molotov/ember' ? 'ember' : 'fire'}`);
      const mesh = key.startsWith('molotov/') ? { source: 'player' } : guid('mesh/burst');
      const effectGuid = guid(`effect/${key}`);
      const refs = (typeof mesh === 'string' ? [material, mesh] : [material]).sort();
      const asset = pack.assets.find((asset) => asset.guid === effectGuid);
      if (asset === undefined) throw new Error(`missing ${key} production asset`);
      expect(asset.refs).toEqual(refs);
      expect(catalog.find((asset) => asset.guid === effectGuid)?.refs).toEqual(refs);
      expect(asset.payload.program.emitters[0]?.renderers[0]).toMatchObject({
        kind: 'mesh',
        mesh,
        material,
        lighting: 'unlit',
      });
      const artifact = asset.artifacts['particle-effect/program.json'];
      if (artifact === undefined) throw new Error('missing published VFX program descriptor');
      const artifactBytes = emitted.get(`assets/${artifact.path}`);
      if (!(artifactBytes instanceof Uint8Array))
        throw new Error(`missing emitted VFX program at ${artifact.path}`);
      const program = JSON.parse(new TextDecoder().decode(artifactBytes));
      expect(program).toEqual({
        format: asset.payload.program.format,
        emitters: asset.payload.program.emitters,
      });
      expect(program.emitters[0].wgsl).toContain('@compute');
      const fingerprint = `sha256:${createHash('sha256').update(artifactBytes).digest('hex')}`;
      expect(asset.payload.programFingerprint).toBe(fingerprint);
      expect(asset.payload.program.fingerprint).toBe(fingerprint);
      expect(artifact).toMatchObject({
        byteLength: artifactBytes.byteLength,
        integrity: { algorithm: 'sha256', digest: fingerprint },
        assetCodec: { name: 'forgeax-vfx-program', version: asset.payload.program.format },
      });
    }
  }, 60_000);

  it.each([
    null,
    42,
    { source: 'other' },
    { source: 'player', extra: true },
  ])('rejects malformed cooked mesh %j before any build publication', async (invalidMesh) => {
    // Corrupt after the real Cook so rejection belongs to Import admission.
    const { result, emitted } = await production(invalidMesh);
    await expect(result).rejects.toMatchObject({
      code: 'import-internal-error',
      expected:
        'ScriptablePack particle-effect output effect/molotov/ember to satisfy its domain producer contract',
      detail: {
        reason: "Particle emitter 'ember' requires a renderer Mesh GUID or Player source",
      },
    });
    expect(emitted.size).toBe(0);
  }, 60_000);
});
