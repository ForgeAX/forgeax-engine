import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Mobility, MobilityKindValue, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { extractFrames } from '../render-system-extract-tail';
import { RENDERABLE_SOURCE_COMPONENTS } from '../scene/render-source';

function cube(world: World, kind?: number): void {
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [] } },
      ...(kind === undefined ? [] : [{ component: Mobility, data: { kind } }]),
    )
    .unwrap();
}

describe('Mobility renderable snapshot', () => {
  it('marks only Mobility static renderables for the shadow caster classifier', () => {
    const world = new World();
    cube(world, MobilityKindValue.static);
    cube(world, MobilityKindValue.movable);
    cube(world);
    const frame = extractFrames([world], 0, new AssetRegistry({} as never));
    expect(frame.renderables.map((renderable) => renderable.mobility)).toEqual([
      'static',
      undefined,
      undefined,
    ]);
  });

  it('re-projects a renderable when its Mobility changes', () => {
    expect(RENDERABLE_SOURCE_COMPONENTS).toContain(Mobility);
  });
});
