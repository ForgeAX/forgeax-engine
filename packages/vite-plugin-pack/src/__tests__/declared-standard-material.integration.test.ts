import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetRegistry,
  createMaterialLoader,
  resolveAssetHandle,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import * as naga from '@forgeax/engine-naga';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { Materials, MeshRenderer } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  type Handle,
  type MaterialAsset,
  resolveMaterialAsset,
  type SceneAsset,
} from '@forgeax/engine-types';
import { createParticleCodeNativeCookerFromRoots } from '@forgeax/engine-vfx-compiler';
import { afterAll, expect, it, vi } from 'vitest';
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

// This fixture observes Naga calls in its own realm; native pool parity has its own contract.
vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
afterAll(() => vi.unstubAllEnvs());

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
      [createMaterialPackCooker()],
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
    expect(record.resolved.staticSwitches?.clearcoat).toBe(true);
    expect(record.resolved.values).toMatchObject({ clearcoat, clearcoatRoughness: roughness });
    const ready = await createMaterialLoader({
      loadPublication: async () => ({ guid: material.guid, record, artifacts: material.artifacts }),
    }).load({ guid: material.guid, specializationKey: record.specializationKey ?? '' });
    expect(ready.status).toBe('Ready');
    if (ready.status !== 'Ready') throw new Error('production material loader required');
    const registry = new AssetRegistry(
      new ShaderRegistry({
        device: {
          createShaderModule() {
            throw new Error('publication must not compile on the GPU');
          },
        },
        manifestUrl: undefined,
      }),
    );
    const payload = material.payload as unknown as MaterialAsset;
    registry.catalog(material.guid, payload).unwrap();
    registry.recordMaterialReadiness(material.guid, ready);
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
    cookers: [createMaterialPackCooker([dirname(sourcePath)])],
  });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) throw result.error;
  const [material] = result.value.product.assets;
  if (material === undefined) throw new Error('cooked clearcoat material required');
  expect(material.guid).toBe(AssetGuid.format(CLEARCOAT_MATERIAL_GUID));
  const record = validateCookedMaterialRecord(
    (material.payload as { cooked: unknown }).cooked,
  ).unwrap();
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
  const registry = new AssetRegistry(
    new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('material admission must not use GPU compilation');
        },
      },
      manifestUrl: undefined,
    }),
  );
  const payload = material.payload as MaterialAsset;
  registry.catalog(material.guid, payload).unwrap();
  registry.recordMaterialReadiness(material.guid, ready);
  expect(registry.getMaterialProjectionForPayload(payload)?.staticSelection).toContain(
    'static-switch:clearcoat=true',
  );
  const world = new World();
  const handle = world.allocSharedRef('MaterialAsset', payload);
  expect(walkMaterialPassesOverSharedRefs(world, handle, registry).unwrap().values).toMatchObject({
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
    cookers: [
      createMaterialPackCooker(),
      createParticleCodeNativeCookerFromRoots([dirname(sourcePath)]),
    ],
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
  const payload = material.payload as MaterialAsset;
  const registry = new AssetRegistry(
    new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('budget query must not use GPU compilation');
        },
      },
      manifestUrl: undefined,
    }),
  );
  registry.assetCatalog.set(material.guid, {
    guid: material.guid,
    kind: 'material',
    payload,
    refs: material.refs,
  });
  registry.recordMaterialReadiness(material.guid, loaded);
  expect(registry.getMaterialProjectionForPayload(payload)).toBeDefined();
  const world = new World();
  const handle = world.allocSharedRef('MaterialAsset', payload);
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
      cookers: [createMaterialPackCooker([dirname(sourcePath)])],
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
        expect(shadow?.abi?.skinPaletteAddress).toEqual(
          geometry === 'skinned' ? { group: 2, binding: 1, stride: 64 } : undefined,
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
    expect(record(second).programs).toEqual(record(first).programs);
    expect(record(second).resolved.values.baseColor).not.toEqual(
      record(first).resolved.values.baseColor,
    );
    expect(composition).toHaveBeenCalledTimes(compositions);
    expect(validation).toHaveBeenCalledTimes(validations);
  } finally {
    composition.mockRestore();
    validation.mockRestore();
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
  const draft = await createMaterialPackCooker().cook({ guid: 'lab-blue-ball', source });
  const root = draft.payload as MaterialAsset;
  const world = new World();
  const coatedHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    ...root,
    values: { ...root.values, clearcoat: 0.85, clearcoatRoughness: 0.12 },
  });
  const coated = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(coatedHandle).unwrap();
  const resolved = resolveMaterialAsset('coated', { coated });
  expect(resolved.ok, resolved.ok ? '' : JSON.stringify(resolved.error)).toBe(true);
  expect(root.values?.clearcoat).toBe(0);
  expect(root.parameters?.map((parameter) => parameter.name)).toEqual(
    expect.arrayContaining(['clearcoat', 'clearcoatRoughness']),
  );
  if (!resolved.ok) throw resolved.error;
  expect(resolved.value.asset.values).toMatchObject({ clearcoat: 0.85, clearcoatRoughness: 0.12 });
  expect(coated).toHaveProperty('cooked', (draft.payload as { cooked: unknown }).cooked);
  expect(coated.passes).toBe(root.passes);
  const registry = new AssetRegistry(
    new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('material extraction must not compile on the GPU');
        },
      },
      manifestUrl: undefined,
    }),
  );
  expect(
    walkMaterialPassesOverSharedRefs(world, coatedHandle, registry).unwrap().values,
  ).toMatchObject({ clearcoat: 0.85, clearcoatRoughness: 0.12 });
  const unknown = resolveMaterialAsset('unknown', {
    unknown: { ...root, values: { ...root.values, undeclaredCoat: 1 } },
  });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error.code).toBe('material-value-unknown');
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
  const registry = new AssetRegistry(
    new ShaderRegistry({
      device: {
        createShaderModule() {
          throw new Error('scene admission must not acquire a GPU');
        },
      },
      manifestUrl: undefined,
    }),
  );
  const loadedScene = registry.parseAssetPayload('scene', scene.payload, [
    ...scene.refs,
  ]) as SceneAsset;
  const world = new World();
  world.components.register(MeshRenderer).unwrap();
  for (const asset of projected.assets) {
    if (asset.kind === 'material')
      registry
        .catalog(asset.guid, { kind: 'material', ...asset.payload } as MaterialAsset)
        .unwrap();
  }
  const blueball = loadedScene.entities.blueball;
  if (blueball === undefined) throw new Error('authored BlueBall entity required');
  const materialScene: SceneAsset = { ...loadedScene, entities: { blueball } };
  registry
    .catalog(
      scene.guid,
      materialScene,
      scene.refs.map((guid) => ({ guid })),
    )
    .unwrap();
  const bound = registry._resolveSceneGuids(materialScene, world, scene.guid).unwrap();
  const references = bound.entities.blueball?.components.MeshRenderer?.materials as Handle<
    'MaterialAsset',
    'shared'
  >[];
  const reference = references[0];
  if (reference === undefined) throw new Error('actual BlueBall material reference required');
  const referencedGuid = registry.guidOf(
    resolveAssetHandle<MaterialAsset>(world, reference).unwrap(),
  );
  world.sharedRefs.release(reference).unwrap();
  const selected = projected.assets.find((asset) => asset.guid === referencedGuid);
  if (selected?.kind !== 'material') throw new Error('actual BlueBall scene material must resolve');
  const draft = await createMaterialPackCooker().cook({
    guid: selected.guid,
    source: { kind: 'material', ...selected.payload } as MaterialAsset,
  });
  const payload = registry.parseAssetPayload(
    'material',
    draft.payload as Record<string, unknown>,
    [],
  ) as MaterialAsset;
  const record = validateCookedMaterialRecord(
    (draft.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const readiness = await createMaterialLoader({
    loadPublication: async () => ({ guid: selected.guid, record, artifacts: draft.artifacts }),
  }).load({ guid: selected.guid, specializationKey: record.specializationKey ?? '' });
  expect(readiness.status).toBe('Ready');
  if (readiness.status !== 'Ready') throw new Error('published BlueBall root required');
  registry.catalog(selected.guid, payload).unwrap();
  registry.recordMaterialReadiness(selected.guid, readiness);
  expect(payload.staticSwitches?.clearcoat).toBe(true);
  expect(payload).toHaveProperty('cooked', (draft.payload as { cooked: unknown }).cooked);
  const authored = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', payload);
  // Load the contributor gameplay fixture without making it a package build dependency.
  const { cloneWithClearcoat } = await import(
    fileURLToPath(
      new URL(
        '../../../../apps/game-capability-lab/assets/plugins/clearcoat-material.ts',
        import.meta.url,
      ),
    )
  );
  const coated = cloneWithClearcoat(world, authored, registry) as typeof authored | undefined;
  expect(coated, 'the actual Lab gameplay clone must apply').toBeDefined();
  if (coated === undefined) throw new Error('actual clearcoat clone required');
  const admission = walkMaterialPassesOverSharedRefs(world, coated, registry);
  expect(admission.ok, admission.ok ? '' : JSON.stringify(admission.error)).toBe(true);
  if (!admission.ok) throw admission.error;
  expect(admission.value.values).toMatchObject({ clearcoat: 0.85, clearcoatRoughness: 0.12 });
  expect(selected.guid, 'BlueBall must consume its own authored root contract').toBe(intended.guid);
  const coatedPayload = world.sharedRefs.resolve<'MaterialAsset', MaterialAsset>(coated).unwrap();
  expect(registry.getMaterialProjectionForPayload(coatedPayload)).toBe(
    registry.getMaterialProjection(selected.guid),
  );
  const { cloneWithTexture } = await import(
    fileURLToPath(
      new URL(
        '../../../../apps/game-capability-lab/assets/plugins/jpeg-texture-swap.ts',
        import.meta.url,
      ),
    )
  );
  const texture = world.allocSharedRef('TextureAsset', {
    kind: 'texture' as const,
    format: 'rgba8unorm' as const,
    colorSpace: 'linear' as const,
    shape: { viewDimension: '2d' as const, extent: { width: 1, height: 1 } },
    mips: { kind: 'none' as const },
    data: new Uint8Array([64, 128, 192, 255]),
  });
  for (const source of [authored, coated]) {
    const swapped = cloneWithTexture(world, source, registry, texture);
    if (swapped === undefined) throw new Error('actual JPEG swap clone required');
    const swappedPayload = world.sharedRefs
      .resolve<'MaterialAsset', MaterialAsset>(swapped)
      .unwrap();
    if (swappedPayload.parent === undefined) throw new Error('published JPEG parent required');
    expect(AssetGuid.format(swappedPayload.parent)).toBe(selected.guid);
    expect(swappedPayload.passes).toBeUndefined();
    expect(swappedPayload).not.toHaveProperty('staticSwitches');
    expect(swappedPayload).not.toHaveProperty('cooked');
    expect(swappedPayload.values).toEqual(
      source === authored
        ? { baseColorTexture: texture }
        : { clearcoat: 0.85, clearcoatRoughness: 0.12, baseColorTexture: texture },
    );
    expect(registry.getMaterialProjectionForPayload(swappedPayload)).toBe(
      registry.getMaterialProjection(selected.guid),
    );
    world.sharedRefs.release(swapped).unwrap();
  }
  world.sharedRefs.release(texture).unwrap();
  world.sharedRefs.release(coated).unwrap();
  world.sharedRefs.release(authored).unwrap();
});

import { createHash } from 'node:crypto';

it('retains actual Standard composition through clearcoat and skinned material schemas', async () => {
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
  }
}, 30_000);
