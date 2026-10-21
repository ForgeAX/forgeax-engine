import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  AssetRegistry,
  scenePublicationFenceFromCatalog,
  validateAssetPublication,
} from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, meshAssetContribution } from '@forgeax/engine-geometry';
import { prepareRuntimePackAnchor, RuntimePackProducer } from '@forgeax/engine-import';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import {
  AssetGuid,
  definePackageId,
  PackageId,
  projectScriptablePackSceneComponents,
  resolvePackParameterInheritance,
} from '@forgeax/engine-pack/source';
import { MeshFilter, SceneInstance } from '@forgeax/engine-render';
import {
  sceneAssetContribution,
  scenePlugin,
  Transform,
  worldDespawnScene,
  worldRemoveSceneOverride,
  worldSetSceneOverride,
} from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { AssetError, err } from '@forgeax/engine-types';

const sourceId = '01900000-0000-7000-8000-000000000501';
const rootId = '01900000-0000-7000-8000-000000000504';
const middleId = '01900000-0000-7000-8000-000000000505';
const instanceId = '01900000-0000-7000-8000-000000000502';
const secondInstanceId = '01900000-0000-7000-8000-000000000503';
const language = process.argv[2] ?? 'js';
const file = process.argv[3];
const restoring = process.argv[4] === 'restore';
const programId = `project:scene.${language}#build`;
const source = new RuntimePackProducer({
  scopeId: restoring ? 'fresh-process' : 'live-game',
  imports: {
    geometry: { identity: 'engine-test', url: import.meta.resolve('@forgeax/engine-geometry') },
    pack: { identity: 'engine-test', url: import.meta.resolve('@forgeax/engine-pack/source') },
  },
  validate: (state, fetcher, dependencies) =>
    validateAssetPublication(
      state.rows,
      fetcher,
      { catalog: source.catalog, fetcher: source.fetch },
      { dependencies, decoders: [meshAssetContribution, sceneAssetContribution] },
    ),
});

// This fixture is a game consumer. All entity/handle work uses the existing Scene owner.
async function consumer() {
  let preparationFails = false;
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    postSpawnHook: () =>
      preparationFails
        ? err(
            new AssetError({
              code: 'asset-invalid-value',
              expected: 'injected consumer preparation failure',
              hint: 'retry this consumer after repair',
            }),
          )
        : { ok: true },
  });
  assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
  assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
  const world = new World({ assets });
  const context = await createWorldContext(world, [scenePlugin()]);
  const leases = [MeshFilter, SceneInstance].map((component) =>
    world.components.register(component).unwrap(),
  );
  const bystander = world.spawn({ component: Transform, data: { pos: [99, 0, 0] } }).unwrap();
  assets.setCatalogSource(source.catalog, source.fetch);
  let binding;
  return {
    world,
    assets,
    setPreparationFailure(value) {
      preparationFails = value;
    },
    get binding() {
      return binding;
    },
    async replace(guid) {
      const rows = (await assets.enumerateCatalog()).unwrap();
      const row = rows.find((row) => row.guid === guid);
      assert(row);
      const fence = scenePublicationFenceFromCatalog(rows, guid).unwrap();
      const grant = (await assets.load(guid, 'scene')).unwrap();
      (await assets.reload(grant, { conflict: 'reject' })).unwrap();
      let root;
      try {
        root = assets.instantiateWithPublicationFence(grant, world, undefined, fence).unwrap();
      } finally {
        assets.release(grant).unwrap();
      }
      if (binding) worldDespawnScene(world, binding.root).unwrap();
      binding = { root, guid, fence, packageId: row.packageId, sourceKey: row.sourceKey };
      assert(world.hasComponent(bystander, Transform));
      return binding;
    },
    width() {
      assert(binding);
      const meshEntity = [...world.iterDescendants(binding.root)].find((entity) =>
        world.hasComponent(entity, MeshFilter),
      );
      assert(meshEntity);
      const handle = world.get(meshEntity, MeshFilter).unwrap().assetHandle;
      const positions = assets.read(handle).unwrap().attributes.position;
      const xs = Array.from(positions).filter((_, index) => index % 3 === 0);
      return Math.max(...xs) - Math.min(...xs);
    },
    position() {
      assert(binding);
      const meshEntity = [...world.iterDescendants(binding.root)].find((entity) =>
        world.hasComponent(entity, MeshFilter),
      );
      assert(meshEntity);
      return Array.from(world.get(meshEntity, Transform).unwrap().pos);
    },
    overrideAndRevert() {
      assert(binding);
      const member = [...world.iterDescendants(binding.root)].find((entity) =>
        world.hasComponent(entity, MeshFilter),
      );
      assert(member);
      const original = world.get(member, MeshFilter).unwrap().assetHandle;
      const override = assets.create(createBoxGeometry(5, 2, 3).unwrap()).unwrap();
      worldSetSceneOverride(
        world,
        binding.root,
        member,
        MeshFilter,
        'assetHandle',
        override,
      ).unwrap();
      assets.release(override).unwrap();
      assert.equal(this.width(), 5);
      worldRemoveSceneOverride(world, binding.root, member, MeshFilter, 'assetHandle').unwrap();
      assert.equal(world.get(member, MeshFilter).unwrap().assetHandle, original);
      assert.equal(this.width(), 2);
    },
    async close() {
      if (binding) worldDespawnScene(world, binding.root).unwrap();
      binding = undefined;
      world.despawn(bystander).unwrap();
      assets.dispose(); // Retire the source cache with its owning game scope.
      assert.equal(runtimeAssets(assets).inspect().assets, 0);
      for (const lease of leases.reverse()) lease.dispose();
      await context.fiber.dispose();
    },
  };
}

const first = await consumer();
const second = await consumer();
const instance = (packageId, width) => ({
  schemaVersion: '3.0.0',
  packageId,
  parent: sourceId,
  values: width === undefined ? {} : { width },
});
const sceneGuid = (packageId) =>
  AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'scene'));
try {
  assert.equal(source.programEntries().size, 0);
  if (restoring) {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    (await source.restore(saved.content)).unwrap();
    assert.equal(saved.selection.packageId, instanceId);
    assert.equal(saved.selection.sourceKey, 'scene');
  } else {
    const entry = `scene.${language}`;
    const programSource = {
      entry,
      export: 'build',
      imports: { geometry: 'engine-test', pack: 'engine-test' },
      modules: {
        [entry]: `import { createBoxGeometry, meshAssetContribution } from 'geometry';
          import { AssetGuid } from 'pack';
          export function build({ packageId, values }${language === 'ts' ? ': any' : ''}) {
            return { ok: true, value: {
              box: createBoxGeometry(values.width, 2, 3).unwrap(),
              scene: { kind: 'scene', entities: { box: { components: {
                Transform: { pos: values.offset },
                MeshFilter: { assetHandle: AssetGuid.format(AssetGuid.derive(packageId, 'box')) }
              } } } }
            } };
          }`,
      },
    };
    // The JS branch never imports DevKit or a transpiler.
    const program =
      language === 'ts'
        ? (await import('../../../../devkit/dist/plugin-build.mjs'))
            .prepareRuntimePackProgram(programSource)
            .unwrap()
        : { artifact: preparePackProgram(programSource).unwrap() };
    const parameters = [
      { name: 'width', type: 'f32', default: 1, minimum: 1, maximum: 5 },
      { name: 'offset', type: 'vec3', default: [1, 2, 3] },
    ];
    const inherited = (
      await resolvePackParameterInheritance(
        {
          format: 'instance',
          packageId: definePackageId(sourceId),
          parent: definePackageId(middleId),
          values: { offset: [7, 8, 9] },
        },
        (packageId) =>
          PackageId.format(packageId) === middleId
            ? {
                format: 'instance',
                packageId,
                parent: definePackageId(rootId),
                values: { width: 2, offset: [4, 5, 6] },
              }
            : { format: 'source', packageId: definePackageId(rootId), parameters },
      )
    ).unwrap();
    const anchor = prepareRuntimePackAnchor(
      {
        source: {
          schemaVersion: '2.0.0',
          kind: 'scriptable-pack-source',
          source: entry,
          packageId: rootId,
          program: programId,
          runtime: { dependencies: [] },
          parameters,
          sceneComponents: projectScriptablePackSceneComponents([MeshFilter, Transform]),
        },
        programs: { [programId]: program },
      },
      inherited,
    ).unwrap();
    (await source.admit(anchor)).unwrap();
    (await source.generate(instance(instanceId))).unwrap();
  }
  const guid = sceneGuid(instanceId);
  await first.replace(guid);
  await second.replace(guid);
  assert.equal(first.width(), 2);
  assert.equal(second.width(), 2);
  assert.deepEqual(first.position(), [7, 8, 9]);
  assert.deepEqual(second.position(), [7, 8, 9]);
  first.overrideAndRevert();
  const firstCount = runtimeAssets(first.assets).inspect().assets;
  const secondCount = runtimeAssets(second.assets).inspect().assets;
  const initial = second.binding;
  const row = source.rows().find((row) => row.guid === guid);
  const output = row?.publication.outputs.find((output) => output.guid === guid);
  assert(output);
  const saved = {
    selection: { packageId: row.packageId, sourceKey: row.sourceKey },
    content: await source.exportSource(new Map([[guid, output.digest]])),
  };
  const savedSources = [
    ...saved.content.packs,
    ...Object.values(saved.content.closure?.contents ?? {}),
  ];
  assert.equal(savedSources.length, 1);
  assert.equal(savedSources[0].source.packageId, sourceId);
  assert.equal(savedSources[0].source.parameters[0].default, 2);
  assert.deepEqual(savedSources[0].source.parameters[1].default, [7, 8, 9]);
  if (!restoring) await writeFile(file, JSON.stringify(saved));
  (
    await source.generate({
      ...instance(instanceId, 2),
      values: { width: 2, offset: [10, 11, 12] },
    })
  ).unwrap();
  await first.replace(guid);
  assert.deepEqual(first.position(), [10, 11, 12]);
  const beforeInvalidVector = source.rows();
  assert.equal(
    (await source.generate({ ...instance(instanceId, 2), values: { offset: [10, 11] } })).ok,
    false,
  );
  assert.deepEqual(source.rows(), beforeInvalidVector);
  assert.deepEqual(first.position(), [10, 11, 12]);
  (await source.generate(instance(instanceId, 2))).unwrap();
  await first.replace(guid);
  assert.deepEqual(first.position(), [7, 8, 9]);
  (await source.generate(instance(instanceId, 4))).unwrap();
  second.setPreparationFailure(true);
  await first.replace(guid);
  await assert.rejects(second.replace(guid));
  assert.equal(first.width(), 4);
  // Reload already committed shared asset content before scene replacement.
  // Failed scene preparation retains the old entity/layout binding, while
  // those entities consume the explicitly accepted Mesh revision.
  assert.equal(second.width(), 4);
  assert.equal(second.binding, initial);
  assert.notEqual(first.binding.fence.outputDigest, second.binding.fence.outputDigest);
  assert.equal(runtimeAssets(first.assets).inspect().assets, firstCount);
  assert.equal(runtimeAssets(second.assets).inspect().assets, secondCount);
  second.setPreparationFailure(false);
  await second.replace(guid);
  assert.equal(second.width(), 4);
  // A second package keeps its own internal Mesh GUID despite identical parameter values.
  (await source.generate(instance(secondInstanceId, 4))).unwrap();
  await second.replace(sceneGuid(secondInstanceId));
  assert.equal(second.width(), 4);
  assert.notEqual(first.binding.guid, second.binding.guid);
  for (const width of [2, 4, 3, 2]) {
    (await source.generate(instance(instanceId, width))).unwrap();
    await first.replace(guid);
    assert.equal(first.width(), width);
    assert.equal(runtimeAssets(first.assets).inspect().assets, firstCount);
  }
  await second.close();
  assert.equal(first.width(), 2);
  source.withdraw(sourceId);
  assert.equal(first.width(), 2);
  await first.close();
  process.stdout.write(
    `${JSON.stringify({ independentConsumers: true, inheritedAnchor: true, recovered: restoring, assetsAfterClose: 0 })}\n`,
  );
} finally {
  source.dispose();
}
