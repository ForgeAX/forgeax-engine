import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { ChildOf, Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { ShadowParticipation } from '../components/shadow-participation';
import { extractSource } from '../render-system-extract-tail';
import { RENDERABLE_SOURCE_COMPONENTS } from '../scene/render-source';

function cube(
  world: World,
  assets: AssetRegistry,
  kind?: number,
  parent?: EntityHandle,
): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: { materials: [] } },
      ...(kind === undefined ? [] : [{ component: Mobility, data: { kind } }]),
      ...(parent === undefined ? [] : [{ component: ChildOf, data: { parent } }]),
    )
    .unwrap();
}

describe('Mobility renderable snapshot', () => {
  it('marks only Mobility static renderables for the shadow caster classifier', () => {
    const worldAssets = new AssetRegistry();
    const world = new World({ assets: worldAssets });
    cube(world, worldAssets, MobilityKindValue.static);
    cube(world, worldAssets, MobilityKindValue.movable);
    cube(world, worldAssets);
    const frame = extractSource(world, worldAssets);
    expect(frame.renderables.map((renderable) => renderable.mobility)).toEqual([
      'static',
      undefined,
      undefined,
    ]);
  });

  it('inherits the nearest ancestor Mobility and follows a root change', () => {
    const worldAssets = new AssetRegistry();
    const world = new World({ assets: worldAssets });
    const root = world
      .spawn(
        { component: Transform, data: {} },
        { component: Mobility, data: { kind: MobilityKindValue.static } },
      )
      .unwrap();
    const group = world
      .spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: root } })
      .unwrap();
    cube(world, worldAssets, undefined, group);
    cube(world, worldAssets, MobilityKindValue.movable, group);
    expect(extractSource(world, worldAssets).renderables.map((r) => r.mobility)).toEqual([
      'static',
      undefined,
    ]);
    world.removeComponent(root, Mobility).unwrap();
    world
      .addComponent(root, { component: Mobility, data: { kind: MobilityKindValue.movable } })
      .unwrap();
    expect(extractSource(world, worldAssets).renderables.map((r) => r.mobility)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('reads current mesh and shadow channels after an entity moves between tables', () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const first = cube(world, assets, MobilityKindValue.static);
    const second = cube(world, assets);
    world.set(first, MeshRenderer, { lightingChannels: 3, renderLayers: 4 }).unwrap();
    world.set(second, MeshRenderer, { lightingChannels: 8, renderLayers: 16 }).unwrap();
    const read = (entity: EntityHandle) =>
      extractSource(world, assets).renderables.find((row) => row.entityKey === entity);
    expect(read(first)).toMatchObject({ lightingChannels: 3, renderLayers: 4, mobility: 'static' });
    world
      .addComponent(first, {
        component: ShadowParticipation,
        data: { cast: true, receive: false, channels: 64 },
      })
      .unwrap();
    expect(read(first)).toMatchObject({ lightingChannels: 3, shadowChannels: 64 });
    expect(read(second)).toMatchObject({ lightingChannels: 8, renderLayers: 16 });
    world.removeComponent(first, ShadowParticipation).unwrap();
    expect(read(first)?.shadowChannels).toBeUndefined();
  });

  it('re-projects a renderable when its Mobility changes', () => {
    expect(RENDERABLE_SOURCE_COMPONENTS).toContain(Mobility);
  });
});
