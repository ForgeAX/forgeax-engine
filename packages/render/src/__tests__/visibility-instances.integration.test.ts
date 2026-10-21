import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function spawnInstance(
  world: World,
  assets: AssetRegistry,
  state: keyof typeof VisibilityStateValue,
) {
  return world
    .spawn(
      { component: Transform, data: {} },
      {
        component: MeshFilter,
        data: { assetHandle: assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap() },
      },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: new Float32Array(IDENTITY) } },
      { component: Visibility, data: { state: VisibilityStateValue[state] } },
    )
    .unwrap();
}

describe('visibility instance producer gate', () => {
  it('gates an explicit Instances owner before producing a renderable', () => {
    const worldAssets = new AssetRegistry();
    const world = new World({ assets: worldAssets });
    const entity = spawnInstance(world, worldAssets, 'hidden');

    const frame = extractFrames([world], 0, worldAssets);

    expect(frame.renderables.some((item) => item.entityKey === entity)).toBe(false);
    expect(frame.dispatch.some((item) => item.entityIndex === 0)).toBe(false);
  });

  it('keeps visible members of a mixed batch independent from hidden members', () => {
    const worldAssets = new AssetRegistry();
    const world = new World({ assets: worldAssets });
    spawnInstance(world, worldAssets, 'hidden');
    const visible = spawnInstance(world, worldAssets, 'visible');

    const frame = extractFrames([world], 0, worldAssets);

    expect(frame.renderables.map((item) => item.entityKey)).toEqual([visible]);
    expect(frame.dispatch.length).toBe(2);
  });
});
