import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { Camera } from '../components/camera';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { extractFrames } from '../render-system-extract-tail';

function spawnCamera(world: World): void {
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
}

function spawnCandidate(world: World, state: keyof typeof VisibilityStateValue) {
  return world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 200] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue[state] } },
    )
    .unwrap();
}

describe('visibility diagnostics', () => {
  it('switches from explicit hidden to frustum culling without changing frustum totals', () => {
    const world = new World();
    registerPropagateTransforms(world);
    spawnCamera(world);
    const entity = spawnCandidate(world, 'hidden');
    world.update(0).unwrap();

    const hidden = extractFrames([world], 0);
    expect(hidden.renderables).toHaveLength(0);
    expect(hidden.visibilityStats).toEqual({ explicitlyHidden: 1 });
    expect(hidden.frustumStats).toEqual({ culled: 0, total: 0 });

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const visible = extractFrames([world], 0);
    expect(visible.renderables).toHaveLength(0);
    expect(visible.visibilityStats).toEqual({ explicitlyHidden: 0 });
    expect(visible.frustumStats).toEqual({ culled: 1, total: 1 });
  });

  it('sums hidden candidate sets per World without counting dispatches or submeshes', () => {
    const first = new World();
    const second = new World();
    spawnCandidate(first, 'hidden');
    spawnCandidate(second, 'hidden');

    const frame = extractFrames([first, second], 0);

    expect(frame.visibilityStats).toEqual({ explicitlyHidden: 2 });
    expect(frame.dispatch).toHaveLength(0);
  });
});
