import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMaterialLoader,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  definePack,
  definePackageId,
  parsePackSourceJson,
  projectDirectPackJson,
} from '@forgeax/engine-pack/source';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { type ImportedAsset, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { AssetOutputProducerRegistry } from '../../../import/src/scriptable-pack';
import { buildScriptablePack } from '../../../import/src/scriptable-pack-build';
import {
  prepareDirectPackTransport,
  produceScriptablePackProducts,
} from '../../../import/src/scriptable-pack-host';
import { materialAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers';

it.each([
  'scriptable',
  'direct',
] as const)('publishes selectable ray-hit and Card programs for %s Standard material authoring', async (format) => {
  const source = createBuiltinMaterialAsset('standard');
  let material: ImportedAsset<unknown> | undefined;
  if (format === 'scriptable') {
    const outputs = new AssetOutputProducerRegistry();
    outputs.register(materialAssetOutputProducer);
    const result = await buildScriptablePack({
      definition: definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000000070'),
        build: () => ok({ 'material/standard': source }),
      }),
      sourcePath: fileURLToPath(import.meta.url),
      outputs,
      publicationGeneration: 7,
      cookers: [createMaterialPackCooker()],
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error('Standard material publication required');
    material = result.value.product.assets[0];
  } else {
    const parsed = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000071',
      assets: { 'material/standard': { kind: source.kind, payload: source, refs: [] } },
    }).unwrap();
    if (parsed.format !== 'direct') throw new Error('direct authoring required');
    const result = await prepareDirectPackTransport({
      projected: projectDirectPackJson(parsed),
      sourcePath: fileURLToPath(import.meta.url),
      sourceRevision: 'sha256:standard-authoring',
      cookers: [createMaterialPackCooker()],
      policy: {
        base: '/',
        packagePath: 'assets/standard.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error('direct Standard material publication required');
    material = result.value.product.product.assets[0];
  }
  if (material === undefined) throw new Error('Standard material output required');
  const record = validateCookedMaterialRecord(
    (material.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
  }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
  expect(ready.status).toBe('Ready');
  if (ready.status !== 'Ready')
    throw new Error('Standard material must pass the production loader');
  const projection = projectMaterialRecord(ready.record);
  for (const pass of ['ray-hit', 'card-capture'] as const) {
    const selected = selectMaterialPassProgram(projection, 'forward', {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'ray',
      geometry: 'mesh',
      pass,
      profile: 'forgeax-material-ray-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    });
    const program = ready.record.programs.find(
      (entry) => entry.specializationKey === selected.specializationKey,
    );
    expect(program?.artifact.bytes.byteLength).toBeGreaterThan(0);
  }
});

it('reuses one Standard material cook across Pack publication generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-generation-ddc-'));
  const sourcePath = join(root, 'material.pack.ts');
  const source = createBuiltinMaterialAsset('standard');
  let builds = 0;
  try {
    await writeFile(sourcePath, 'stable material source');
    const digest = `sha256:${createHash('sha256')
      .update(await readFile(sourcePath))
      .digest('hex')}`;
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000072'),
      build: () => {
        builds++;
        return ok({ 'material/standard': source });
      },
    });
    const run = (publicationGeneration: number) =>
      produceScriptablePackProducts({
        sources: [
          {
            definition,
            sourcePath,
            displaySourcePath: sourcePath,
            sourceClosure: [{ path: sourcePath, digest }],
            publicationGeneration,
            policy: {
              base: '/',
              packagePath: 'material.pack.json',
              artifactPath: (guid, key) => `${guid}/${key}`,
            },
          },
        ],
        buildCacheRoot: join(root, 'ddc'),
        cookers: [createMaterialPackCooker()],
      });
    const first = await run(1);
    expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
    if (!first.ok) throw first.error;
    const second = await run(7);
    expect(second.ok, second.ok ? '' : JSON.stringify(second.error)).toBe(true);
    if (!second.ok) throw second.error;
    expect(builds).toBe(1);
    const firstAsset = first.value.get(sourcePath)?.product.product.assets[0];
    const secondAsset = second.value.get(sourcePath)?.product.product.assets[0];
    if (firstAsset === undefined || secondAsset === undefined)
      throw new Error('Standard material outputs required');
    const original = validateCookedMaterialRecord(
      (firstAsset.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const reused = validateCookedMaterialRecord(
      (secondAsset.payload as { cooked: unknown }).cooked,
    ).unwrap();
    // A hit rebinds the stored record without validating it again; the record
    // it publishes is exactly the validated form.
    expect((secondAsset.payload as { cooked: unknown }).cooked).toEqual(reused);
    expect(original.publicationGeneration).toBe(1);
    expect(reused.publicationGeneration).toBe(7);
    expect(reused.receipt.identity.cookGeneration).toBe(7);
    expect(reused.receipt.identity.cookIdentity).toBe(original.receipt.identity.cookIdentity);
    expect(reused.artifactDigest).toBe(original.artifactDigest);
    const ready = await createMaterialLoader({
      loadPublication: async () => ({
        guid: secondAsset.guid,
        record: reused,
        artifacts: secondAsset.artifacts,
      }),
    }).load({ guid: secondAsset.guid, specializationKey: reused.specializationKey ?? '' });
    expect(ready.status).toBe('Ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
