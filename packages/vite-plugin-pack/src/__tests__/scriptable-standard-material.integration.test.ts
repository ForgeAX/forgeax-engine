import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetRegistry,
  createCatalogSource,
  createMaterialLoader,
  projectMaterialRecord,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createRuntimePackPublication } from '@forgeax/engine-pack/build';
import { validateMaterialTemplatePublication } from '@forgeax/engine-pack/material-cook';
import {
  definePack,
  definePackageId,
  parsePackSourceJson,
  projectDirectPackJson,
} from '@forgeax/engine-pack/source';
import {
  createBuiltinMaterialAsset,
  findVariantByDefines,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { type ImportedAsset, ok } from '@forgeax/engine-types';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  prepareDirectPackTransport,
  produceScriptablePackProducts,
} from '../../../import/src/scriptable-pack-host';
import { directPackFixture } from '../../../pack/src/__tests__/support/direct-pack-fixture.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders';

it('publishes selectable ray-hit and Card programs for compiled direct Standard authoring', async () => {
  const source = createBuiltinMaterialAsset('standard');
  const prepare = async (): Promise<ImportedAsset<unknown> | undefined> => {
    const parsed = parsePackSourceJson(
      directPackFixture('01900000-0000-7000-8000-000000000071', {
        'material/standard': { kind: source.kind, payload: source, refs: [] },
      }),
    ).unwrap();
    if (parsed.format !== 'direct') throw new Error('direct authoring required');
    const result = await prepareDirectPackTransport({
      projected: projectDirectPackJson(parsed),
      sourcePath: fileURLToPath(import.meta.url),
      sourceRevision: 'sha256:standard-authoring',
      cookers: [createMaterialPackCooker([], { profile: 'webgpu-storage-ray' })],
      policy: {
        base: '/',
        packagePath: 'assets/standard.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
      },
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error('direct Standard material publication required');
    return result.value.product.product.assets[0];
  };
  const material = await prepare();
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

it('publishes named direct material source through the same template contract', async () => {
  const material = createBuiltinMaterialAsset('standard');
  const parsed = parsePackSourceJson(
    directPackFixture('01900000-0000-7000-8000-000000000073', {
      'material/standard': { kind: material.kind, payload: material, refs: [] },
    }),
  ).unwrap();
  if (parsed.format !== 'direct') throw new Error('Direct authoring required');
  const projected = projectDirectPackJson(parsed);
  const native = createMaterialPackCooker();
  const cook = vi.fn((input: unknown) => {
    expect(input).toMatchObject({ publication: 'templates' });
    return native.cook(input);
  });
  const publication = (
    await prepareDirectPackTransport({
      projected,
      sourcePath: fileURLToPath(import.meta.url),
      sourceRevision: 'sha256:standard-direct-template',
      cookers: [{ ...native, cook }],
      policy: {
        base: '/',
        packagePath: 'assets/standard.pack.json',
        artifactPath: (guid, key) => `${guid}/${key}`,
      },
    })
  ).unwrap();
  const asset = publication.product.product.assets[0];
  if (asset === undefined) throw new Error('Missing direct material output');
  const payload = asset.payload as { cooked?: unknown; template?: unknown };
  expect(payload.cooked).toBeUndefined();
  const template = validateMaterialTemplatePublication(payload.template).unwrap();
  expect(template.guid).toBe(projected.assets[0]?.guid);
  expect(Object.keys(asset.artifacts)).toEqual([template.sourceArtifact.path]);
  expect(cook).toHaveBeenCalledTimes(1);
});

it('reuses a Standard source template across generations and selects programs after Pack load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-material-generation-ddc-'));
  const sourcePath = join(root, 'material.pack.ts');
  const source = createBuiltinMaterialAsset('standard');
  let builds = 0;
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  const original = first.value.get(sourcePath);
  const reused = second.value.get(sourcePath);
  if (original === undefined || reused === undefined)
    throw new Error('Standard material outputs required');
  const published = reused.product.product.assets[0];
  if (published === undefined) throw new Error('Missing material output');
  const payload = published.payload as { cooked?: unknown; template?: unknown };
  expect(payload.cooked).toBeUndefined();
  const template = validateMaterialTemplatePublication(payload.template).unwrap();
  expect(Object.keys(published.artifacts)).toEqual([template.sourceArtifact.path]);
  expect(reused.product.product.assets).toEqual(original.product.product.assets);
  expect(original.publication.generation).toBe(1);
  expect(reused.publication.generation).toBe(7);
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  const prepare = compiler.prepareMaterial;
  if (prepare === undefined) throw new Error('Material template compiler required');
  const selected = vi.fn();
  const shaderRegistry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: {
      ...compiler,
      prepareMaterial(template) {
        const admitted = prepare(template);
        if (!admitted.ok) return admitted;
        return ok({
          select(request) {
            selected(request);
            return admitted.value.select(request);
          },
        });
      },
    },
  });
  const { packageUrl, pack, artifacts } = reused.finalized;
  const runtime = createRuntimePackPublication({
    pack: { assets: pack.assets },
    scopeId: 'asset-runtime',
    sourcePath,
    sourceRevision: reused.publication.sourceRevision,
    packageUrl,
    inputFingerprint: reused.publication.receipt.inputFingerprint,
    digest: reused.finalized.digest,
    generation: reused.publication.generation,
    outputs: reused.publication.outputs,
    externalEvidence: reused.publication.externalEvidence,
  });
  const assets = new AssetRegistry({
    shaderRegistry,
    catalog: createCatalogSource({
      entries: [
        {
          guid: published.guid,
          kind: 'material',
          packageUrl,
          sourcePath,
          publication: runtime.publication,
        },
      ],
      fetch: async (input) => {
        if (String(input) === packageUrl) return new Response(JSON.stringify(runtime.pack));
        const artifact = artifacts.find(({ path }) => path === String(input).replace(/^\//, ''));
        return artifact
          ? new Response(new Uint8Array(artifact.bytes))
          : new Response('', { status: 404 });
      },
    }),
  });
  try {
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    const handle = (await assets.load(published.guid, 'material')).unwrap();
    const projection = assets.getMaterialProjection(handle).unwrap();
    if (projection === undefined) throw new Error('Material template projection required');
    expect(selected).not.toHaveBeenCalled();
    for (const pass of ['ray-hit', 'card-capture'] as const) {
      const context = {
        backend: 'webgpu',
        capability: 'storage-buffer',
        pipeline: 'ray',
        geometry: 'mesh',
        pass,
        profile: 'forgeax-material-ray-v1',
        toolchain: 'naga-oil',
        instrumentation: 'none',
      } as const;
      const program = selectMaterialPassProgram(projection, 'forward', context);
      expect(
        assets.getMaterialArtifact(program.specializationKey)?.bytes.byteLength,
      ).toBeGreaterThan(0);
      expect(selectMaterialPassProgram(projection, 'forward', context)).toBe(program);
    }
    expect(selected).toHaveBeenCalledTimes(2);
    const context = {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const program = selectMaterialPassProgram(projection, 'forward', context);
    const family = shaderRegistry.materialShaderManifestEntry(program.specializationKey);
    if (family === undefined) throw new Error('Material coverage selections required');
    expect(family.variants).toHaveLength(4);
    const clipping = findVariantByDefines(family, { CLIPPING_PLANES: true, LOD_DITHER: false });
    if (clipping === undefined) throw new Error('Clipping selection required');
    expect(selected).toHaveBeenCalledTimes(3);
    const clippedSource = clipping.composedWgsl;
    expect(clippedSource).not.toBe(family.composedWgsl);
    expect(clipping.composedWgsl).toBe(clippedSource);
    expect(selected).toHaveBeenCalledTimes(4);
    expect(selected).toHaveBeenLastCalledWith({
      pass: 'forward',
      context: { ...context, viewClipping: true },
      vertexColorAvailable: false,
    });
  } finally {
    assets.dispose();
  }
});
