import assert from 'node:assert/strict';
import { createWorldContext, Disabled, defineComponent, World } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';
import {
  Camera,
  createBarrelDistortionMapping,
  Outline,
  setActiveCamera,
} from '@forgeax/engine-render';
import { ChildOf, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { publishBrowserFrameSubmitted, resetBrowserFrameSubmitted } from '../browser-frame-signal';
import { engineWorkspaceTargetToolsPlugin } from '../workspace-target-tools';

const contexts: Context[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose();
});

async function fixture() {
  const world = new World();
  world.spawn().unwrap();
  const context = await createWorldContext(world);
  await context.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'target' });
  contexts.push(context);
  const observation = context.engineWorkspaceTargetTools;
  assert(observation);
  return { world, observation, context };
}

describe('workspace target tools plugin', () => {
  it('outlines the selected render hierarchy and restores camera authoring on clear and disposal', async () => {
    const world = new World();
    const camera = world
      .spawn({ component: Camera, data: {} }, { component: Transform, data: {} })
      .unwrap();
    const authored = world.spawn().unwrap();
    const secondCamera = world
      .spawn(
        { component: Camera, data: {} },
        { component: Transform, data: {} },
        { component: Outline, data: { entities: [authored], visibleColor: [0, 1, 0] } },
      )
      .unwrap();
    const parent = world.spawn({ component: Name, data: { value: 'Group' } }).unwrap();
    const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
    propagateTransforms(world);
    setActiveCamera(world, camera);
    const context = await createWorldContext(world);
    contexts.push(context);
    const fiber = await context.plugin(engineWorkspaceTargetToolsPlugin, {
      targetId: 'target',
      display: { canvas: { width: 100, height: 100 } as HTMLCanvasElement, app: {} as never },
    });
    await fiber.await();
    const tools = context.engineWorkspaceTargetTools;
    assert(tools?.highlight);
    tools.highlight({ entityId: `target:${world.identity}:${parent}` });
    expect(Array.from(world.get(camera, Outline).unwrap().entities)).toEqual([parent, child]);
    expect(world.get(camera, Outline).unwrap().width).toBe(4);
    setActiveCamera(world, secondCamera);
    world.update().unwrap();
    expect(world.get(camera, Outline).ok).toBe(false);
    expect(Array.from(world.get(secondCamera, Outline).unwrap().entities)).toEqual([
      authored,
      parent,
      child,
    ]);
    expect(world.get(secondCamera, Outline).unwrap().width).toBe(2);
    const gameAdded = world.spawn().unwrap();
    world.set(secondCamera, Outline, { entities: [authored, parent, child, gameAdded] }).unwrap();
    tools.highlight({});
    expect(Array.from(world.get(secondCamera, Outline).unwrap().entities)).toEqual([
      authored,
      gameAdded,
    ]);
    expect(Array.from(world.get(secondCamera, Outline).unwrap().visibleColor)).toEqual([0, 1, 0]);
    tools.highlight({ entityId: `target:${world.identity}:${parent}` });
    await fiber.dispose();
    expect(Array.from(world.get(secondCamera, Outline).unwrap().entities)).toEqual([
      authored,
      gameAdded,
    ]);
    expect(world.get(parent, Name).unwrap().value).toBe('Group');
  });
  it('picks submitted frames without ActiveCamera and rejects reset, old World and resized extents', async () => {
    const world = new World();
    const canvas = Object.assign(new EventTarget(), {
      width: 100,
      height: 100,
    }) as HTMLCanvasElement;
    const mapping = {
      ...createBarrelDistortionMapping(100, 100, { strength: 0 }).unwrap(),
      camera: {
        projection: 'perspective' as const,
        far: 100,
        viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    };
    const publish = (worldIdentity = world.identity) =>
      publishBrowserFrameSubmitted(canvas, {
        frameId: 1,
        deviceGeneration: 1,
        worldIdentity,
        barrelDistortion: mapping,
      });
    publish();
    const context = await createWorldContext(world);
    contexts.push(context);
    await context.plugin(engineWorkspaceTargetToolsPlugin, {
      targetId: 'target',
      display: { canvas, app: {} as never },
    });
    const pick = () => context.engineWorkspaceTargetTools?.pick?.({ x: 50, y: 50 });
    expect(pick()).toMatchObject({ frameId: 1, entityId: null });
    canvas.width = 200;
    expect(pick).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ reason: 'extent-mismatch' }) }),
    );
    canvas.width = 100;
    publish('retired-world');
    expect(pick).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ reason: 'world-mismatch' }) }),
    );
    resetBrowserFrameSubmitted(canvas);
    expect(pick).toThrow(
      expect.objectContaining({ detail: expect.objectContaining({ reason: 'missing-frame' }) }),
    );
  });
  it('projects unnamed and dynamic entities, their hierarchy and actual component fields', async () => {
    const { world, observation } = await fixture();
    const Health = defineComponent('InspectionHealth', { value: 'f32' });
    const parent = world.spawn({ component: Name, data: { value: 'Parent' } }).unwrap();
    const child = world
      .spawn({ component: ChildOf, data: { parent } }, { component: Health, data: { value: 7 } })
      .unwrap();
    const tree = await observation.tree({ limit: 100 });
    const node = tree.nodes.find((entry) => entry.entity === child);
    assert(node);
    expect(node.parentId).toBe(`target:${world.identity}:${parent}`);
    expect(node.name).toBeNull();
    expect(node.componentNames).toEqual(expect.arrayContaining(['ChildOf', 'InspectionHealth']));
    expect((await observation.inspect({ entityId: node.entityId })).components).toContainEqual(
      expect.objectContaining({
        name: 'InspectionHealth',
        values: { value: 7 },
      }),
    );
    world.set(child, Health, { value: 12 }).unwrap();
    expect(
      (await observation.inspect({ entityId: node.entityId })).components.find(
        (entry) => entry.name === 'InspectionHealth',
      )?.values,
    ).toEqual({ value: 12 });
    world.despawn(child).unwrap();
    world.spawn({ component: Health, data: { value: 99 } }).unwrap();
    expect(() => observation.inspect({ entityId: node.entityId })).toThrow(/stale/);
    const other = await fixture();
    expect(() =>
      other.observation.inspect({ entityId: `target:${world.identity}:${parent}` }),
    ).toThrow(/World/);
  });

  it('bounds hierarchy pages without losing the continuation', async () => {
    const { world, observation } = await fixture();
    for (let i = 0; i < 4; i++)
      world.spawn({ component: Name, data: { value: String(i) } }).unwrap();
    const first = await observation.tree({ limit: 2 });
    assert(first.nextOffset !== null);
    const second = await observation.tree({
      limit: 2,
      offset: first.nextOffset,
      revision: first.revision,
    });
    assert(second.nextOffset !== null);
    const third = await observation.tree({
      limit: 2,
      offset: second.nextOffset,
      revision: second.revision,
    });
    expect(
      new Set([...first.nodes, ...second.nodes, ...third.nodes].map((node) => node.entityId)).size,
    ).toBe(5);
    expect(third.nextOffset).toBeNull();
  });

  it('includes disabled entities and rejects pagination across structural changes', async () => {
    const { world, observation } = await fixture();
    const disabled = world.spawn({ component: Disabled, data: {} }).unwrap();
    const first = await observation.tree({ limit: 1 });
    assert(first.nextOffset !== null);
    const second = await observation.tree({
      limit: 1,
      offset: first.nextOffset,
      revision: first.revision,
    });
    expect(second.nodes[0]?.entity).toBe(disabled);
    world.despawn(disabled).unwrap();
    expect(() => observation.tree({ limit: 1, offset: 1, revision: first.revision })).toThrow(
      /changed/,
    );
  });

  it('installs and revokes through Cordis without owning the game World', async () => {
    const world = new World();
    const entity = world
      .spawn({ component: Name, data: { value: 'Persistent game entity' } })
      .unwrap();
    const context = await createWorldContext(world);
    contexts.push(context);
    expect(context.engineWorkspaceTargetTools).toBeUndefined();
    for (let i = 0; i < 10; i++) {
      const fiber = await context.plugin(engineWorkspaceTargetToolsPlugin, { targetId: 'target' });
      await fiber.await();
      const tools = context.engineWorkspaceTargetTools;
      assert(tools);
      expect((await tools.tree()).nodes.some((node) => node.entity === entity)).toBe(true);
      await fiber.dispose();
      expect(context.engineWorkspaceTargetTools).toBeUndefined();
      expect(() => tools.tree()).toThrow(/unavailable/);
      expect(world.get(entity, Name).unwrap().value).toBe('Persistent game entity');
    }
    await context.fiber.dispose();
  });
});
