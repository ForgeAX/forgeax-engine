import assert from 'node:assert/strict';
import { AssetRegistry, assetsPlugin } from '@forgeax/engine-assets-runtime';
import {
  type ComponentData,
  createWorldContext,
  defineComponent,
  type EntityHandle,
  World,
} from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { AssetGuid } from '@forgeax/engine-pack/source';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import type { Asset, AssetHandle } from '@forgeax/engine-types';
import { it, onTestFinished } from 'vitest';
import { projectEngineWorkspaceAssets } from '../workspace';
import { engineWorkspaceTargetToolsPlugin } from '../workspace-target-tools';
import { publishWorkspaceAssets } from './workspace-asset-fixture';

const meshGuid = '11111111-1111-4111-8111-111111111111';
const materialGuid = '22222222-2222-4222-8222-222222222222';
const overrideGuid = '33333333-3333-4333-8333-333333333333';
const parsedDefaultMaterial = AssetGuid.parse(materialGuid);
assert(parsedDefaultMaterial.ok);
const defaultMaterial = parsedDefaultMaterial.value;
it('omits references without a Registry and restores native inspection after Fiber removal', async () => {
  const world = new World();
  const entity = world.spawn().unwrap();
  const ctx = await createWorldContext(world);
  onTestFinished(() => ctx.fiber.dispose());
  for (let i = 0; i < 2; i++) {
    const fiber = ctx.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'native' });
    await fiber.await();
    const tools = ctx.engineWorkspaceTargetTools;
    assert(tools);
    const inspection = await tools.inspect({ entityId: `native:${world.identity}:${entity}` });
    assert.equal(inspection.assetReferences, undefined);
    await fiber.dispose();
    assert.equal(ctx.engineWorkspaceTargetTools, undefined);
    assert.throws(() => tools.inspect({ entityId: inspection.entityId }), /unavailable/);
    assert(world.componentsOf(entity).ok);
  }
});

it('tracks optional Registry service removal and restoration without a View plugin', async () => {
  const world = new World();
  const entity = world.spawn().unwrap();
  const ctx = await createWorldContext(world);
  onTestFinished(() => ctx.fiber.dispose());
  await ctx.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'native' }).await();
  const inspect = () => {
    assert(ctx.engineWorkspaceTargetTools);
    return ctx.engineWorkspaceTargetTools.inspect({
      entityId: `native:${world.identity}:${entity}`,
    });
  };
  const assets = new AssetRegistry({});
  for (let cycle = 0; cycle < 2; cycle++) {
    const fiber = ctx.plugin(assetsPlugin(assets));
    await fiber.await();
    assert.deepEqual((await inspect()).assetReferences, { references: [], truncated: false });
    await fiber.dispose();
    assert.equal((await inspect()).assetReferences, undefined);
  }
  assert(world.componentsOf(entity).ok);
});

async function fixture() {
  const assets = new AssetRegistry({});
  publishWorkspaceAssets(assets, []);
  const world = new World({ assets });
  const ctx = await createWorldContext(world, [assetsPlugin(assets)]);
  const tools = ctx.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'scene' });
  await tools.await();
  const leases = [MeshFilter, MeshRenderer].map((component) =>
    world.components.register(component).unwrap(),
  );
  const grants: AssetHandle[] = [];
  const entities: EntityHandle[] = [];
  const allocate = <T extends Asset>(payload: T) => {
    const handle = assets.create(payload).unwrap();
    grants.push(handle);
    return handle;
  };
  const load = async <K extends Asset['kind']>(guid: string, kind: K) => {
    const handle = (await assets.load(guid, kind)).unwrap();
    grants.push(handle);
    return handle;
  };
  const publish = (
    entries: readonly {
      guid: string;
      kind: Asset['kind'];
      payload: Asset;
      refs?: readonly string[];
    }[],
  ) => {
    publishWorkspaceAssets(
      assets,
      entries.map(({ guid, payload, refs }) => ({
        guid,
        asset: payload,
        ...(refs ? { refs } : {}),
      })),
    );
  };
  const spawn = (...entries: ComponentData[]) => {
    const entity = world.spawn(...entries).unwrap();
    entities.push(entity);
    return entity;
  };
  const scope = {
    projectId: 'project',
    targetId: 'scene',
    targetGeneration: 1,
    browserGeneration: 1,
    worldId: world.identity,
  };
  const inspect = (entity: EntityHandle) => {
    assert(ctx.engineWorkspaceTargetTools);
    return ctx.engineWorkspaceTargetTools.inspect({
      entityId: `scene:${world.identity}:${entity}`,
    });
  };
  const query = async (entity: EntityHandle) => {
    const references = (await inspect(entity)).assetReferences;
    assert(references);
    return references;
  };
  onTestFinished(async () => {
    for (const entity of entities) world.despawn(entity).unwrap();
    for (const handle of grants) {
      const released = assets.release(handle);
      if (!released.ok && released.error.code !== 'asset-owner-closed') throw released.error;
    }
    for (const lease of leases.reverse()) lease.dispose();
    await ctx.fiber.dispose();
    assets.dispose();
  });
  return { ctx, world, assets, scope, leases, allocate, load, publish, spawn, inspect, query };
}

it('reads actual held mesh and default material identities without changing entities', async () => {
  const f = await fixture();
  f.publish([
    { guid: materialGuid, kind: 'material', payload: Materials.unlit([1, 0, 0, 1]) },
    {
      guid: meshGuid,
      kind: 'mesh',
      refs: [materialGuid],
      payload: {
        ...createBoxGeometry(1, 1, 1).unwrap(),
        materialSlots: [
          { slotName: 'Surface', defaultMaterial: defaultMaterial },
          { slotName: 'Engine default' },
        ],
      },
    },
  ]);
  const handle = await f.load(meshGuid, 'mesh');
  const material = await f.load(materialGuid, 'material');
  const entity = f.spawn(
    { component: MeshFilter, data: { assetHandle: handle } },
    { component: MeshRenderer, data: { materials: [] } },
  );
  const epoch = f.world.getStructureEpoch();
  const observer = f.assets.observe().unwrap();
  onTestFinished(() => observer.dispose());
  observer.read().unwrap().accept();
  const before = await f.inspect(entity);
  const result = await f.query(entity);
  assert.equal(
    result.references.find((ref) => ref.key === 'MeshFilter.assetHandle')?.guid,
    meshGuid,
  );
  assert.equal(result.references.find((ref) => ref.slotName === 'Surface')?.guid, materialGuid);
  assert.equal(
    result.references.find((ref) => ref.slotName === 'Engine default')?.origin,
    'engine-default',
  );
  assert.equal(f.world.getStructureEpoch(), epoch);
  assert.deepEqual(observer.read().unwrap().changes, []);
  assert.deepEqual((await f.inspect(entity)).components, before.components);
  assert.equal(f.assets.guidOf(material), materialGuid);
});

it('preserves old held publication identity and prefers a nonzero instance material', async () => {
  const f = await fixture();
  f.publish([
    { guid: materialGuid, kind: 'material', payload: Materials.unlit([1, 0, 0, 1]) },
    { guid: overrideGuid, kind: 'material', payload: Materials.unlit([0, 1, 0, 1]) },
    {
      guid: meshGuid,
      kind: 'mesh',
      refs: [materialGuid],
      payload: {
        ...createBoxGeometry(1, 1, 1).unwrap(),
        materialSlots: [{ slotName: 'Surface', defaultMaterial: defaultMaterial }],
      },
    },
  ]);
  const handle = await f.load(meshGuid, 'mesh');
  const materialHandle = await f.load(overrideGuid, 'material');
  const entity = f.spawn(
    { component: MeshFilter, data: { assetHandle: handle } },
    { component: MeshRenderer, data: { materials: [materialHandle] } },
  );
  f.publish([{ guid: meshGuid, kind: 'mesh', payload: createBoxGeometry(4, 4, 4).unwrap() }]);
  const result = await f.query(entity);
  assert.equal(
    result.references.find((ref) => ref.key === 'MeshFilter.assetHandle')?.guid,
    meshGuid,
  );
  const material = result.references.find((ref) => ref.key === 'MeshRenderer.materials[0]');
  assert(material);
  assert.equal(material.guid, overrideGuid);
  assert.equal(material.origin, 'component');
  assert.equal(material.slotName, 'Surface');
});

it('reports unbound and runtime handles and rejects stale bindings', async () => {
  const f = await fixture();
  const handle = f.allocate(createBoxGeometry(1, 1, 1).unwrap());
  for (const [value, status] of [
    [0, 'unbound'],
    [handle, 'unregistered'],
  ] as const) {
    const entity = f.spawn({ component: MeshFilter, data: { assetHandle: value } });
    assert.equal(
      (await f.query(entity)).references.find((ref) => ref.component === 'MeshFilter')?.status,
      status,
    );
  }
  const expired = f.assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  f.assets.release(expired).unwrap();
  assert.throws(() => f.spawn({ component: MeshFilter, data: { assetHandle: expired } }));
  const wrongKind = f.allocate(Materials.unlit([1, 0, 0, 1]));
  assert.throws(() => f.spawn({ component: MeshFilter, data: { assetHandle: wrongKind } }));
  const stale = f.spawn({ component: MeshFilter, data: { assetHandle: handle } });
  f.assets.dispose();
  assert.equal((await f.query(stale)).references[0]?.status, 'stale');
  const targetTools = f.ctx.engineWorkspaceTargetTools;
  assert(targetTools);
  assert.throws(() => targetTools.inspect({ entityId: 'scene:wrong:1' }), /World/);
});

it('recognizes custom asset arrays and excludes ordinary strings and entity arrays', async () => {
  const f = await fixture();
  const component = defineComponent('ViewReferenceTest', {
    clips: 'array<asset<mesh>>',
    text: 'string',
    joints: 'array<entity>',
    state: 'shared<DiagnosticState>',
  });
  const lease = f.world.components.register(component).unwrap();
  f.leases.push(lease);
  f.publish([{ guid: meshGuid, kind: 'mesh', payload: createBoxGeometry(1, 1, 1).unwrap() }]);
  const handle = await f.load(meshGuid, 'mesh');
  const state = f.world.allocSharedRef('DiagnosticState', { count: 1 });
  onTestFinished(() => {
    f.world.sharedRefs.release(state).unwrap();
  });
  const entity = f.spawn({
    component,
    data: { clips: Array(132).fill(handle), text: meshGuid, joints: [], state },
  });
  const result = await f.query(entity);
  assert.equal(result.references.length, 128);
  assert.equal(result.truncated, true);
  assert(result.references.every((ref) => ref.field === 'clips' && ref.guid === meshGuid));
});

it('bounds fixed and dynamic asset reference arrays to 256 entity facts', async () => {
  const f = await fixture();
  const component = defineComponent('BoundedNativeReferences', {
    fixed: 'array<asset<mesh>, 128>',
    first: 'array<asset<mesh>>',
    second: 'array<asset<mesh>>',
  });
  f.leases.push(f.world.components.register(component).unwrap());
  const handle = f.allocate(createBoxGeometry(1, 1, 1).unwrap());
  const entity = f.spawn({
    component,
    data: {
      fixed: Array(128).fill(handle),
      first: Array(128).fill(handle),
      second: [handle],
    },
  });
  const result = await f.query(entity);
  assert.equal(result.references.length, 256);
  assert.equal(result.truncated, true);
});

it('aligns reference kinds with the ordinary workspace Catalog projection', async () => {
  const f = await fixture();
  const component = defineComponent('NativeEffectReference', {
    effect: 'asset<particle-effect>',
  });
  f.leases.push(f.world.components.register(component).unwrap());
  const entity = f.spawn({ component, data: { effect: 0 } });
  const [asset] = projectEngineWorkspaceAssets([
    {
      guid: meshGuid,
      kind: 'particle-effect',
      sourcePath: 'effect.pack',
      packageUrl: 'https://workspace.invalid/fixture.pack.json',
    },
  ]);
  const result = await f.query(entity);
  assert(asset);
  assert.equal(result.references[0]?.kind, asset.kind);
  assert.equal(result.references[0]?.kind, 'vfx');
});
