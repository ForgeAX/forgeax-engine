import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMaterialLoader,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import { fbxImporter } from '@forgeax/engine-fbx';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import {
  type MaterialAsset,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { runImport } from '../../../import/src/import-runner';
import { ImporterRegistry } from '../../../import/src/importer-registry';
import { produceSourcePackage } from '../../../import/src/source-package';

const guid = '11111111-1111-4111-8111-111111111111';
const textureGuid = '22222222-2222-4222-8222-222222222222';
const samplerGuid = '33333333-3333-4333-8333-333333333333';
const childGuid = '44444444-4444-4444-8444-444444444444';

it.each([
  'cube',
  'humanoid',
])('publishes complete cooked materials from the real %s FBX', async (name) => {
  const source = fileURLToPath(
    new URL(`../../../../forgeax-engine-assets/vendor/fbx-test/${name}.fbx`, import.meta.url),
  );
  const meta = { ...JSON.parse(await readFile(`${source}.meta.json`, 'utf8')), source };
  const registry = new ImporterRegistry();
  registry.register(fbxImporter);
  const cookers = new NativeCookerRegistry();
  cookers.register(createMaterialPackCooker());
  const result = await runImport(
    meta,
    registry,
    { readSource: async (path) => ({ ok: true, value: new Uint8Array(await readFile(path)) }) },
    cookers,
  );
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok || 'skipped' in result.value) throw new Error('FBX publication required');
  const materials = result.value.product.assets.filter((asset) => asset.kind === 'material');
  expect(materials.length).toBeGreaterThan(0);
  for (const material of materials) {
    const record = validateCookedMaterialRecord(
      (material.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
      loadReference: async () => true,
    }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
    expect(ready.status).toBe('Ready');
    expect(record.resolved.values.baseColor).toBeDefined();
    const geometry = name === 'humanoid' ? 'skinned' : 'mesh';
    if (ready.status !== 'Ready') throw new Error('FBX material not Ready');
    const projection = projectMaterialRecord(ready.record);
    for (const address of ['direct', 'scene-index'] as const) {
      const selected = selectMaterialPassProgram(
        projection,
        'Forward',
        {
          backend: 'webgpu',
          capability: 'storage-buffer',
          pipeline: 'forward',
          geometry,
          pass: 'forward',
          profile: 'forgeax-material-wgsl-v1',
          toolchain: 'naga-oil',
          instrumentation: 'none',
        },
        address,
      );
      expect(
        selected.abi?.vertexInputs.some((attribute) => attribute.semantic === 'skinIndex'),
      ).toBe(geometry === 'skinned');
    }
  }
});

it('keeps the shared import entry loadable under browser export conditions', async () => {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL('../../../import/src/browser.ts', import.meta.url)),
        formats: ['es'],
        fileName: 'import-browser',
      },
    },
  });
});

it('cooks imported material payloads before publishing the complete source package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-import-material-'));
  try {
    // The importer wire contract uses indices into refs, including UV transforms.
    const material: MaterialAsset = {
      kind: 'material',
      parameters: standardSurfaceParameters(
        standardMaterialParameters(
          new Set(['baseColor', 'metallic', 'roughness', 'alphaCutoff', 'baseColorTexture']),
        ),
      ),
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } },
        {
          name: 'Deferred',
          program: { module: 'forgeax::default-standard-pbr', fragmentEntry: 'fs_gbuffer' },
        },
        {
          name: 'ShadowCaster',
          program: { module: 'forgeax::default-shadow-caster', fragmentEntry: 'fs_shadow' },
        },
      ],
      values: {
        baseColor: [0.7, 0.3, 0.1, 1],
        metallic: 0,
        roughness: 0.5,
        alphaCutoff: 0.5,
        baseColorTexture: {
          texture: 0,
          sampler: 1,
          coordinates: { set: 1, transform: { offset: [0.2, 0.3], scale: [2, 3], rotation: 0.4 } },
        },
      },
    } as unknown as MaterialAsset;
    const registry = new ImporterRegistry();
    registry.register({
      key: 'material-fixture',
      import: async () => ({
        ok: true,
        value: {
          assets: [
            {
              guid: childGuid,
              kind: 'material',
              payload: {
                kind: 'material',
                parent: 0,
                values: { baseColorTexture: { texture: 1, sampler: 2 }, roughness: 0.25 },
              },
              refs: [{ guid }, { guid: textureGuid }, { guid: samplerGuid }],
              artifacts: {},
            },
            {
              guid,
              kind: 'material',
              payload: material,
              refs: [{ guid: textureGuid }, { guid: samplerGuid }],
              artifacts: {},
            },
          ],
          sourceDependencies: [],
        },
      }),
    });
    const meta = {
      importer: 'material-fixture',
      source: join(directory, 'fixture.gltf'),
      subAssets: [
        { guid, kind: 'material', sourceIndex: 0, sourceKey: 'material:0' },
        { guid: childGuid, kind: 'material', sourceIndex: 1, sourceKey: 'material:1' },
      ],
    };
    const fs = { readSource: async () => ({ ok: true as const, value: new Uint8Array([1]) }) };
    const cookers = [createMaterialPackCooker()];
    const native = new NativeCookerRegistry();
    for (const cooker of cookers) native.register(cooker);
    const result = await runImport(meta, registry, fs, native);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok || 'skipped' in result.value) throw new Error('expected imported publication');
    const asset = result.value.product.assets.find((asset) => asset.guid === guid);
    if (asset === undefined) throw new Error('missing material output');
    const payload = asset?.payload as MaterialAsset & { cooked: unknown };
    expect(payload.cooked).toBeDefined();
    const record = validateCookedMaterialRecord(payload.cooked).unwrap();
    expect(record.resolved.values.baseColorTexture).toMatchObject({
      texture: textureGuid,
      sampler: samplerGuid,
      coordinates: { set: 1, transform: { rotation: 0.4 } },
    });
    const ray = record.programs.filter((program) =>
      program.selections.some((selection) => selection.context.pipeline === 'ray'),
    );
    expect(ray).toHaveLength(2);
    expect(ray[0]?.selections[0]).toMatchObject({ pass: 'Forward', entry: 'cs_surface' });
    expect(ray[1]?.selections[0]).toMatchObject({
      pass: 'Forward',
      context: { pass: 'card-capture' },
      entry: 'vs_card',
    });
    expect(
      record.programs.some((program) =>
        program.selections.some((selection) => selection.context.pipeline === 'deferred'),
      ),
    ).toBe(true);
    expect(payload.values?.baseColorTexture).toMatchObject({
      texture: 0,
      sampler: 1,
      coordinates: { set: 1, transform: { rotation: 0.4 } },
    });
    expect(asset?.refs[0]?.guid).toBe(textureGuid);
    expect(
      result.value.product.sourceDependencies.some((path) => path.endsWith('/ray-material.wgsl')),
    ).toBe(true);
    const loaded = await createMaterialLoader({
      loadPublication: async () => ({ guid, record, artifacts: asset.artifacts }),
      loadReference: async () => true,
    }).load({ guid, specializationKey: record.specializationKey ?? '' });
    expect(loaded.status).toBe('Ready');
    const child = result.value.product.assets.find((asset) => asset.guid === childGuid);
    const childRecord = validateCookedMaterialRecord(
      (child?.payload as MaterialAsset & { cooked: unknown }).cooked,
    ).unwrap();
    expect(childRecord.resolved.values.roughness).toBe(0.25);
    expect(childRecord.resolved.values.baseColorTexture).toMatchObject({
      texture: textureGuid,
      sampler: samplerGuid,
    });
    expect(childRecord.refs.parent).toContain(guid);
    expect(child?.payload).toMatchObject({ parent: 0 });
    expect(child?.refs[0]?.guid).toBe(guid);
    // Production's source-package route must carry the same registered cooker.
    const production = await produceSourcePackage({ meta, registry, fs, cookers });
    expect(production.ok).toBe(true);
    if (!production.ok) throw production.error;
    const productionPayload = production.value.product.assets.find((asset) => asset.guid === guid)
      ?.payload as { cooked: unknown };
    expect(validateCookedMaterialRecord(productionPayload.cooked).unwrap().artifactDigest).toBe(
      record.artifactDigest,
    );
    // A cooker error or identity change must not return a publishable source package.
    for (const cooker of [
      {
        key: 'material',
        cook: () => {
          throw new Error('injected material cook rejection');
        },
      },
      {
        key: 'material',
        cook: () => ({
          guid: textureGuid,
          payload: material,
          refs: [],
          artifacts: {},
          inputFingerprint: 'wrong-guid',
        }),
      },
      {
        key: 'material',
        cook: (input: unknown) => ({
          guid: (input as { guid: string }).guid,
          payload: material,
          refs: [],
          artifacts: {},
          inputFingerprint: 'missing-record',
        }),
      },
    ]) {
      const rejected = new NativeCookerRegistry();
      rejected.register(cooker);
      const failed = await runImport(meta, registry, fs, rejected);
      expect(failed).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
