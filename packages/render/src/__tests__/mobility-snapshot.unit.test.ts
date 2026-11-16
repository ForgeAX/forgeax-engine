import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { ChildOf, Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { extractSource } from '../render-system-extract-tail';
import { RENDERABLE_SOURCE_COMPONENTS } from '../scene/render-source';

function cube(world: World, assets: AssetRegistry, kind?: number, parent?: EntityHandle): void {
  world
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

  it('re-projects a renderable when its Mobility changes', () => {
    expect(RENDERABLE_SOURCE_COMPONENTS).toContain(Mobility);
  });
});
