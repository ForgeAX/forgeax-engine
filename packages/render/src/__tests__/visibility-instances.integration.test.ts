import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Instances } from '../components/instances';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function spawnInstance(world: World, state: keyof typeof VisibilityStateValue) {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: new Float32Array(IDENTITY) } },
      { component: Visibility, data: { state: VisibilityStateValue[state] } },
    )
    .unwrap();
}

describe('visibility instance producer gate', () => {
  it('gates an explicit Instances owner before producing a renderable', () => {
    const world = new World();
    const entity = spawnInstance(world, 'hidden');

    const frame = extractFrames([world], 0);

    expect(frame.renderables.some((item) => item.entityKey === entity)).toBe(false);
    expect(frame.dispatch.some((item) => item.entityIndex === 0)).toBe(false);
  });

  it('keeps visible members of a mixed batch independent from hidden members', () => {
    const world = new World();
    spawnInstance(world, 'hidden');
    const visible = spawnInstance(world, 'visible');

    const frame = extractFrames([world], 0);

    expect(frame.renderables.map((item) => item.entityKey)).toEqual([visible]);
    expect(frame.dispatch.length).toBe(2);
  });
});
