import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetRegistry, createMaterialLoader } from '@forgeax/engine-assets-runtime';
import { readMaterialContent, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { defineComponent, World } from '@forgeax/engine-ecs';
import * as naga from '@forgeax/engine-naga';
import { type CookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { Materials, MeshRenderer } from '@forgeax/engine-render';
import { sceneAssetContribution } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { type MaterialAsset, resolveMaterialAsset, type SceneAsset } from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { beforeEach, expect, it, vi } from 'vitest';
import { loadMaterialFixture } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { AssetOutputProducerRegistry } from '../../../import/src/scriptable-pack';
import { buildScriptablePack } from '../../../import/src/scriptable-pack-build';
import {
  createDeclaredPackAssetSnapshotSource,
  prepareDirectPackTransport,
  prepareLegacyPackTransport,
} from '../../../import/src/scriptable-pack-host';
import { materialAssetOutputProducer } from '../../../import/src/scriptable-pack-output-producers';
import { materialSampledTextureBudget } from '../../../render/src/material-sampled-texture-budget';
import * as compiler from '../../../shader-compiler/src/compile.js';
import { createMaterialPackCooker } from '../../../shader-compiler/src/index';

// The observing realm's compiler is selected at import time. Restore ordinary
// Worker admission before each case; only the two call-count cases opt back in.
vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
beforeEach(() => vi.unstubAllEnvs());

// These cases admit declared WebGPU publications. Portable backend composition
// remains on the independent cold-cooker contracts below.
const publicationCooker = createMaterialPackCooker([], { profile: 'webgpu-storage' });

function expectWebGpuPublication(record: CookedMaterialRecord) {
  const selections = record.programs.flatMap((program) => program.selections);
  expect(selections.length).toBeGreaterThan(0);
  expect(new Set(selections.map((selection) => selection.context.backend))).toEqual(
    new Set(['webgpu']),
  );
  expect(selections.some((selection) => selection.context.capability === 'uniform-fallback')).toBe(
    false,
  );
}

it.each([
  ['arc-nova-shard.material.pack.json', 1, 0.035],
  ['arc-nova-ember-shard.material.pack.json', 0.68, 0.08],
] as const)(
  'publishes the Boss Lightning clearcoat selection in %s',
  async (file, clearcoat, roughness) => {
    const sourcePath = fileURLToPath(
      new URL(`../../../../apps/hello/boss-lightning/assets/${file}`, import.meta.url),
    );
    const result = await prepareLegacyPackTransport(
      JSON.parse(await readFile(sourcePath, 'utf8')),
      [publicationCooker],
      () => ({
        base: '/',
        packagePath: `assets/${file}`,
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
        sink: () => {},
      }),
      sourcePath,
    );
    const material = result.cooked?.logicalPackage.assets[0];
    expect(material, 'shard material requires a cooked publication').toBeDefined();
    if (material === undefined) throw new Error('published shard material required');
    const cooked = (material.payload as { cooked?: unknown }).cooked;
    expect(cooked, 'explicit clearcoat requires a cooked material publication').toBeDefined();
    const record = validateCookedMaterialRecord(cooked).unwrap();
    expectWebGpuPublication(record);
    expect(record.resolved.staticSwitches?.clearcoat).toBe(true);
    expect(record.resolved.values).toMatchObject({ clearcoat, clearcoatRoughness: roughness });
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
    }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
    expect(ready.status).toBe('Ready');
    if (ready.status !== 'Ready') throw new Error('production material loader required');
    const registry = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('publication must not compile on the GPU');
          },
        },
        manifestUrl: undefined,
      }),
    });
    const { payload } = (await loadMaterialFixture(registry, ready.record)).unwrap();
    expect(registry.getMaterialProjectionForPayload(payload)?.staticSelection).toContain(
      'static-switch:clearcoat=true',
    );
  },
  30_000,
);

it('publishes the Bevy clearcoat material before admitting its physical layer', async () => {
  const sourcePath = fileURLToPath(
    new URL('../../../../apps/bevy/clearcoat/assets/materials.pack.ts', import.meta.url),
  );
  const { default: definition } = await import(sourcePath);
  const { CLEARCOAT_MATERIAL_GUID } = await import(
    fileURLToPath(
      new URL('../../../../apps/bevy/clearcoat/src/material-identity.ts', import.meta.url),
    )
  );
  const outputs = new AssetOutputProducerRegistry();
  outputs.register(materialAssetOutputProducer);
  const result = await buildScriptablePack({
    definition,
    sourcePath,
    outputs,
    publicationGeneration: 7,
    cookers: [publicationCooker],
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw result.error;
  const [material] = result.value.product.assets;
  if (material === undefined) throw new Error('cooked clearcoat material required');
  expect(material.guid).toBe(AssetGuid.format(CLEARCOAT_MATERIAL_GUID));
  const record = validateCookedMaterialRecord(
    (material.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expectWebGpuPublication(record);
  expect(record.resolved.staticSwitches).toEqual({
    clearcoat: true,
    sheen: false,
    anisotropy: false,
    iridescence: false,
    diffuseTransmission: false,
  });
  expect(record.resolved.passes.map((pass) => pass.renderState?.tags)).toEqual([
    { LightMode: 'Forward' },
    { LightMode: 'ShadowCaster' },
  ]);
  expect(
    new Set(
      record.programs.flatMap((program) => program.selections.map((selection) => selection.pass)),
    ),
  ).toEqual(new Set(['forward', 'shadow-caster']));
  expect((material.payload as MaterialAsset).colorSpace).toBe('linear');
  expect(record.resolved.values).toMatchObject({
    baseColor: [0.62, 0.045, 0.018, 1],
    metallic: 0.15,
    roughness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
  }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
  expect(ready.status).toBe('Ready');
  if (ready.status !== 'Ready') throw new Error('production material loader required');
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('material admission must not use GPU compilation');
        },
      },
      manifestUrl: undefined,
    }),
  });
  const { payload, handle } = (await loadMaterialFixture(registry, ready.record)).unwrap();
  expect(registry.getMaterialProjectionForPayload(payload)?.staticSelection).toContain(
    'static-switch:clearcoat=true',
  );
  const world = new World({ assets: registry });
  expect(readMaterialContent(runtimeAssets(world.assets), handle).unwrap().values).toMatchObject({
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
}, 30_000);

it('publishes the declared Brotato Standard shorthand and its dependent particle source', async () => {
  const sourcePath = fileURLToPath(
    new URL(
      '../../../../apps/showcase/brotato-3d/assets/brotato-impact-vfx.pack.json',
      import.meta.url,
    ),
  );
  const parsed = parsePackSourceJson(JSON.parse(await readFile(sourcePath, 'utf8'))).unwrap();
  if (parsed.format !== 'direct') throw new Error('direct authoring required');
  const result = await prepareDirectPackTransport({
    projected: projectDirectPackJson(parsed),
    sourcePath,
    sourceRevision: 'declared-standard-regression',
    cookers: [publicationCooker, createParticleCodeNativeCookerFromRoots([dirname(sourcePath)])],
    policy: {
      base: '/',
      packagePath: 'assets/declared.pack.json',
      artifactPath: (guid, key) => `${guid}/${key}.bin`,
      sink: () => {},
    },
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw new Error('declared content must be producer-ready');
  const assets = result.value.product.product.assets;
  const material = assets.find((asset) => asset.kind === 'material');
  const effect = assets.find((asset) => asset.kind === 'particle-effect');
  if (material === undefined || effect === undefined)
    throw new Error('the complete declared package is required');
  expect(effect.refs.map((reference) => reference.guid)).toContain(material.guid);
  const record = validateCookedMaterialRecord(
    (material.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expectWebGpuPublication(record);
  expect(record.resolved.values).toMatchObject({
    emissive: [0.05, 0.55, 1],
    emissiveIntensity: 8,
    roughness: 0.25,
    clearcoat: 0.15,
  });
  expect(record.resolved.parameters.map((parameter) => parameter.name)).toContain(
    'clearcoatRoughness',
  );
  const loaded = await createMaterialLoader({
    loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
  }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
  expect(loaded.status).toBe('Ready');
  if (loaded.status !== 'Ready') throw new Error('production material loader required');
  const registry = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('budget query must not use GPU compilation');
        },
      },
      manifestUrl: undefined,
    }),
  });
  const { payload: accepted, handle } = (
    await loadMaterialFixture(registry, loaded.record)
  ).unwrap();
  expect(registry.getMaterialProjectionForPayload(accepted)).toBeDefined();
  const world = new World({ assets: registry });
  expect(materialSampledTextureBudget(world, registry, handle)).toEqual({
    limit: 16,
    required: 16,
    transmission: 'none',
    conflicts: [],
  });

  expect(result.value.finalized.pack.assets.map((asset) => asset.guid).sort()).toEqual(
    assets.map((asset) => asset.guid).sort(),
  );
}, 30_000);

it('reads only the requested Brotato particle producer before full package publication', async () => {
  const sourcePath = fileURLToPath(
    new URL(
      '../../../../apps/showcase/brotato-3d/assets/brotato-impact-vfx.pack.json',
      import.meta.url,
    ),
  );
  const sourceText = await readFile(sourcePath, 'utf8');
  const parsed = parsePackSourceJson(JSON.parse(sourceText)).unwrap();
  if (parsed.format !== 'direct') throw new Error('direct authoring required');
  const projected = projectDirectPackJson(parsed);
  const effect = projected.assets.find((asset) => asset.kind === 'particle-effect');
  const material = projected.assets.find((asset) => asset.kind === 'material');
  if (effect === undefined || material === undefined)
    throw new Error('complete Brotato source required');
  const parseGuid = (value: string) => {
    const result = AssetGuid.parse(value);
    if (!result.ok) throw result.error;
    return result.value;
  };
  const particle = createParticleCodeNativeCookerFromRoots([dirname(sourcePath)]);
  const particleCook = vi.fn(particle.cook.bind(particle));
  const materialCook = vi.fn(() => {
    throw new Error('unrequested material producer must remain lazy');
  });
  const source = createDeclaredPackAssetSnapshotSource(
    new Map([
      [
        sourcePath,
        {
          format: 'pack.json' as const,
          sourcePath,
          sourceText,
          sourceRevision: 'brotato-content-read-regression',
          value: parsed,
        },
      ],
    ]),
    [
      { ...createMaterialPackCooker(), cook: materialCook },
      { ...particle, cook: particleCook },
    ],
    projected.assets.map((asset) => parseGuid(asset.guid)),
  );
  const [first, second] = await Promise.all([
    source.readByGuid(parseGuid(effect.guid)),
    source.readByGuid(parseGuid(effect.guid)),
  ]);
  expect(first.ok, first.ok ? '' : JSON.stringify(first.error)).toBe(true);
  expect(second.ok).toBe(true);
  expect(materialCook).not.toHaveBeenCalled();
  expect(particleCook).toHaveBeenCalledTimes(1);
  const snapshot = first.unwrap();
  expect(snapshot.asset).toMatchObject({ kind: 'particle-effect', schemaVersion: 3 });
  expect(snapshot.asset).not.toBe(second.unwrap().asset);
  expect(particleCook.mock.results[0]?.value).toBeDefined();
  const draft = await particleCook.mock.results[0]?.value;
  expect(draft?.refs).toContain(material.guid);
  expect(Object.keys(draft?.artifacts ?? {})).toContain('particle-effect/program.json');
  const failedMaterial = await source.readByGuid(parseGuid(material.guid));
  expect(failedMaterial.ok).toBe(false);
  if (failedMaterial.ok) throw new Error('the requested producer failure must remain observable');
  expect(failedMaterial.error.code).toBe('native-cook-failed');
  expect(materialCook).toHaveBeenCalledTimes(1);
  const again = await source.readByGuid(parseGuid(effect.guid));
  expect(again.ok).toBe(true);
  expect(particleCook).toHaveBeenCalledTimes(1);
}, 15_000);

it('publishes the declared Unlit shorthand beside an explicit custom animation schema', async () => {
  for (const file of ['base-material.pack.json', 'animated-target-material.pack.json']) {
    const sourcePath = fileURLToPath(
      new URL(`../../../../apps/game-capability-lab/assets/${file}`, import.meta.url),
    );
    const parsed = parsePackSourceJson(JSON.parse(await readFile(sourcePath, 'utf8'))).unwrap();
    if (parsed.format !== 'direct') throw new Error('direct authoring required');
    const result = await prepareDirectPackTransport({
      projected: projectDirectPackJson(parsed),
      sourcePath,
      sourceRevision: 'declared-unlit-regression',
      cookers: [publicationCooker],
      policy: {
        base: '/',
        packagePath: `assets/${file}`,
        artifactPath: (guid, key) => `${guid}/${key}.bin`,
        sink: () => {},
      },
    });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error('declared content must be producer-ready');
    const material = result.value.product.product.assets.find((asset) => asset.kind === 'material');
    if (material === undefined) throw new Error('the declared material is required');
    const record = validateCookedMaterialRecord(
      (material.payload as { cooked: unknown }).cooked,
    ).unwrap();
    expectWebGpuPublication(record);
    const loaded = await createMaterialLoader({
      loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
    }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
    expect(loaded.status).toBe('Ready');
    if (file === 'base-material.pack.json') {
      expect(record.resolved.values.baseColor).toEqual([0.6, 0.6, 0.6, 1]);
      expect(record.resolved.parameters.map((parameter) => parameter.name)).toContain(
        'alphaCutoff',
      );
      expect(
        new Set(record.programs.flatMap((program) => program.selections.map((s) => s.pass))),
      ).toEqual(new Set(['Forward', 'ShadowCaster']));
      for (const geometry of ['mesh', 'skinned']) {
        const shadow = record.programs
          .flatMap((program) => program.selections)
          .find(
            (selection) =>
              selection.pass === 'ShadowCaster' &&
              selection.context.capability === 'storage-buffer' &&
              selection.context.geometry === geometry,
          );
        expect(shadow?.address).toBe('direct');
        expect(shadow?.abi?.sceneIndexEntry).toBeUndefined();
        expect(shadow?.abi?.vertexInputs.some((input) => input.semantic === 'skinIndex')).toBe(
          geometry === 'skinned',
        );
        expect(shadow?.abi?.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
          geometry === 'skinned',
        );
      }
    } else {
      expect(record.resolved.parameters.map((parameter) => parameter.name)).toEqual([
        'baseColor',
        'time',
      ]);
      expect(record.resolved.passes?.[0]?.program.module).toBe('game_default::animated_target');
    }
  }
}, 30_000);

it('retains complete ordinary Standard programs across authored color changes', async () => {
  // Only call-count observations require compilation in this test's realm.
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  const composition = vi.spyOn(naga, 'composeShader');
  const validation = vi.spyOn(compiler, 'compileShaderProgram');
  try {
    const cooker = createMaterialPackCooker();
    const source = Materials.standard({
      baseColor: [1, 0, 0, 1],
      roughness: 0.5,
      metallic: 0,
      specular: 0,
    });
    const first = await cooker.cook({ guid: 'ordinary-red', source });
    const compositions = composition.mock.calls.length;
    const validations = validation.mock.calls.length;
    expect(compositions).toBeGreaterThan(0);
    expect(validations).toBeGreaterThan(0);
    const second = await cooker.cook({
      guid: 'ordinary-green',
      source: Materials.standard({
        baseColor: [0, 1, 0, 1],
        roughness: 0.5,
        metallic: 0,
        specular: 0,
      }),
    });
    const record = (draft: typeof first) =>
      validateCookedMaterialRecord((draft.payload as { cooked: unknown }).cooked).unwrap();
    const selections = record(first).programs.flatMap((program) => program.selections);
    expect(new Set(selections.map((selection) => selection.context.backend))).toEqual(
      new Set(['webgpu', 'webgl2']),
    );
    expect(
      selections.some((selection) => selection.context.capability === 'uniform-fallback'),
    ).toBe(true);
    expect(record(second).programs).toEqual(record(first).programs);
    expect(record(second).resolved.values.baseColor).not.toEqual(
      record(first).resolved.values.baseColor,
    );
    expect(composition).toHaveBeenCalledTimes(compositions);
    expect(validation).toHaveBeenCalledTimes(validations);
  } finally {
    composition.mockRestore();
    validation.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('admits the authored Lab clearcoat toggle after ordinary material cooking', async () => {
  const document = JSON.parse(
    await readFile(
      new URL('../../../../apps/game-capability-lab/assets/scene.pack.json', import.meta.url),
      'utf8',
    ),
  );
  const authored = document.assets['material/blue-ball'];
  const source = { kind: authored.kind, ...authored.payload } as MaterialAsset;
  const guid = '5a90b107-fb75-4a62-9b08-520a8d153019';
  const draft = await publicationCooker.cook({ guid, source });
  const record = validateCookedMaterialRecord(
    (draft.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expectWebGpuPublication(record);
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid, record, artifacts: draft.artifacts }),
  }).load({ guid, specializationKey: record.specializationKey ?? '' });
  if (ready.status !== 'Ready') throw new Error('production material loader required');
  const registry = new AssetRegistry();
  try {
    const {
      handle,
      payload: root,
      projection,
    } = (await loadMaterialFixture(registry, ready.record)).unwrap();
    const coated = registry.copy(handle).unwrap();
    registry.update(coated, { values: { clearcoat: 0.85, clearcoatRoughness: 0.12 } }).unwrap();
    const value = registry.read(coated).unwrap();
    expect(root.values?.clearcoat).toBe(0);
    expect(root.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['clearcoat', 'clearcoatRoughness']),
    );
    expect(value.values).toMatchObject({ clearcoat: 0.85, clearcoatRoughness: 0.12 });
    expect(
      registry.getMaterialProjectionForPayload(
        runtimeAssets(registry).borrow<MaterialAsset>(coated).unwrap(),
      ),
    ).toBe(projection);
    const unknown = resolveMaterialAsset('unknown', {
      unknown: { ...root, values: { ...root.values, undeclaredCoat: 1 } },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('material-value-unknown');
  } finally {
    registry.dispose();
  }
});

it('admits clearcoat on the material actually referenced by the authored BlueBall scene', async () => {
  const sourcePath = fileURLToPath(
    new URL('../../../../apps/game-capability-lab/assets/scene.pack.json', import.meta.url),
  );
  const parsed = parsePackSourceJson(JSON.parse(await readFile(sourcePath, 'utf8'))).unwrap();
  if (parsed.format !== 'direct') throw new Error('direct Lab authoring required');
  const projected = projectDirectPackJson(parsed);
  const scene = projected.assets.find((asset) => asset.sourceKey === 'scene/main');
  const intended = projected.assets.find((asset) => asset.sourceKey === 'material/blue-ball');
  if (scene === undefined || intended === undefined)
    throw new Error('Lab scene and BlueBall material required');
  const blueball = (scene.payload as { entities: SceneAsset['entities'] }).entities.blueball;
  const materialIndex = blueball?.components.MeshRenderer?.materials;
  if (!Array.isArray(materialIndex) || typeof materialIndex[0] !== 'number')
    throw new Error('authored material wire reference required');
  const guid = scene.refs[materialIndex[0]];
  const selected = projected.assets.find((asset) => asset.guid === guid);
  if (selected?.kind !== 'material') throw new Error('actual BlueBall scene material must resolve');
  expect(selected.guid).toBe(intended.guid);
  const draft = await publicationCooker.cook({
    guid: selected.guid,
    source: { kind: 'material', ...selected.payload } as MaterialAsset,
  });
  const record = validateCookedMaterialRecord(
    (draft.payload as { cooked: unknown }).cooked,
  ).unwrap();
  expectWebGpuPublication(record);
  const ready = await createMaterialLoader({
    loadPublication: async () => ({ guid: selected.guid, record, artifacts: draft.artifacts }),
  }).load({ guid: selected.guid, specializationKey: record.specializationKey ?? '' });
  if (ready.status !== 'Ready') throw new Error('published BlueBall root required');
  const registry = new AssetRegistry();
  const world = new World({ assets: registry });
  world.components.register(MeshRenderer).unwrap();
  world.components
    .register(
      defineComponent('SceneInstance', {
        source: { type: 'asset<scene>' },
        mapping: { type: 'array<entity>' },
        state: { type: 'unique<SceneInstanceState>' },
      }),
    )
    .unwrap();
  try {
    const {
      handle: authored,
      payload,
      projection,
    } = (await loadMaterialFixture(registry, ready.record)).unwrap();
    registry.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    publishRuntimeAssets(registry, [
      { guid: selected.guid, asset: payload },
      {
        guid: scene.guid,
        asset: {
          kind: 'scene',
          entities: { blueball: { components: { MeshRenderer: { materials: [0] } } } },
        } as SceneAsset,
        refs: [selected.guid],
      },
    ]);
    const sceneHandle = (await registry.load(scene.guid, 'scene')).unwrap();
    const entities = registry.instantiateFlat(sceneHandle, world).unwrap();
    const entity = entities[0];
    if (entity === undefined) throw new Error('BlueBall scene entity required');
    expect(Array.from(world.get(entity, MeshRenderer).unwrap().materials)).toEqual([authored]);
    const { cloneWithClearcoat } = await import(
      fileURLToPath(
        new URL(
          '../../../../apps/game-capability-lab/assets/plugins/clearcoat-material.ts',
          import.meta.url,
        ),
      )
    );
    const coated = cloneWithClearcoat(authored, registry);
    if (coated === undefined) throw new Error('actual Lab clearcoat clone required');
    expect(registry.read(coated).unwrap().values).toMatchObject({
      clearcoat: 0.85,
      clearcoatRoughness: 0.12,
    });
    expect(
      registry.getMaterialProjectionForPayload(
        runtimeAssets(registry).borrow<MaterialAsset>(coated).unwrap(),
      ),
    ).toBe(projection);
    const { cloneWithTexture } = await import(
      fileURLToPath(
        new URL(
          '../../../../apps/game-capability-lab/assets/plugins/jpeg-texture-swap.ts',
          import.meta.url,
        ),
      )
    );
    const texture = registry
      .create({
        kind: 'texture',
        format: 'rgba8unorm',
        colorSpace: 'linear',
        shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
        mips: { kind: 'none' },
        data: new Uint8Array([64, 128, 192, 255]),
      })
      .unwrap();
    for (const source of [authored, coated]) {
      const swapped = cloneWithTexture(source, registry, texture);
      if (swapped === undefined) throw new Error('actual JPEG swap clone required');
      expect(registry.read(swapped).unwrap().values).toMatchObject({
        ...registry.read(source).unwrap().values,
        baseColorTexture: texture,
      });
      expect(
        registry.getMaterialProjectionForPayload(
          runtimeAssets(registry).borrow<MaterialAsset>(swapped).unwrap(),
        ),
      ).toBe(projection);
      registry.release(swapped).unwrap();
    }
    expect(registry.read(authored).unwrap().values?.baseColorTexture).not.toBe(texture);
    registry.release(texture).unwrap();
    registry.release(coated).unwrap();
  } finally {
    registry.dispose();
  }
});

import { createHash } from 'node:crypto';

it('retains actual Standard composition through clearcoat and skinned material schemas', async () => {
  vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1');
  const composition = vi.spyOn(naga, 'composeShader');
  try {
    const cooker = createMaterialPackCooker();
    const standard = Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 });
    const first = await cooker.cook({ guid: 'mixed-standard-first', source: standard });
    await cooker.cook({
      guid: 'mixed-painted',
      source: Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [0.28, 0.035, 0.075, 1],
        metallic: 0.12,
        roughness: 0.18,
        clearcoat: 0.82,
        clearcoatRoughness: 0.08,
      }),
    });
    const body = Materials.standard({
      baseColor: [0.72, 0.78, 0.73, 1],
      metallic: 0.22,
      roughness: 0.36,
    });
    if (body.passes === undefined) throw new Error('Standard passes required');
    const [bodyFirst, ...bodyRest] = body.passes;
    const skin = (pass: NonNullable<MaterialAsset['passes']>[number]) =>
      pass.name === 'shadow-caster'
        ? pass
        : { ...pass, program: { ...pass.program, module: 'forgeax::pbr-skin' } };
    await cooker.cook({
      guid: 'mixed-skinned',
      source: { ...body, passes: [skin(bodyFirst), ...bodyRest.map(skin)] },
    });
    const compositions = composition.mock.calls.length;
    const repeated = await cooker.cook({ guid: 'mixed-standard-return', source: standard });
    expect(composition).toHaveBeenCalledTimes(compositions);
    const hashes = (draft: typeof first) =>
      Object.entries(draft.artifacts).map(([key, artifact]) => [
        key,
        createHash('sha256').update(artifact.bytes).digest('hex'),
      ]);
    expect(hashes(repeated)).toEqual(hashes(first));
  } finally {
    composition.mockRestore();
    vi.unstubAllEnvs();
  }
}, 30_000);
