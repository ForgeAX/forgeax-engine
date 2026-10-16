import { World } from '@forgeax/engine-ecs';
import {
  ChildOf,
  GlobalTransform,
  registerPropagateTransforms,
  Transform,
} from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { Fog } from '../components/fog';
import { Visibility, VisibilityStateValue } from '../components/visibility';
import { prepareExtractContext } from '../render-system-extract';
import { extractFrame, extractFrames } from '../render-system-extract-tail';

function transform(pos: [number, number, number]) {
  return {
    pos,
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function makeWorld() {
  const world = new World();
  registerPropagateTransforms(world);
  const parent = world
    .spawn(
      { component: Transform, data: transform([1, 0, 0]) },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: transform([2, 0, 0]) },
      { component: ChildOf, data: { parent } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  return { world, parent, child };
}

describe('visibility extract orchestration', () => {
  it('selects Fog once at the resource-owner frame boundary', () => {
    const cameraWorld = new World();
    const resourceWorld = new World();
    resourceWorld
      .spawn({
        component: Fog,
        data: { color: [0.1, 0.2, 0.3], density: 0.02, heightFalloff: 0.4, maxOpacity: 0.8 },
      })
      .unwrap();

    const cameraQuery = vi.spyOn(cameraWorld, 'query');
    const resourceQuery = vi.spyOn(resourceWorld, 'query');
    extractFrames([cameraWorld, resourceWorld], { cameraOwner: 0, resourceOwner: 1 });

    const readsFog = (calls: readonly unknown[][]) =>
      calls.filter(([spec]) => {
        if (typeof spec !== 'object' || spec === null || !('read' in spec)) return false;
        const read = (spec as { readonly read?: readonly unknown[] }).read;
        return read?.includes(Fog) ?? false;
      });

    expect(readsFog(cameraQuery.mock.calls)).toHaveLength(0);
    expect(readsFog(resourceQuery.mock.calls)).toHaveLength(1);
  });

  it('refreshes hierarchy and visibility from the final World state', () => {
    const { world, parent, child } = makeWorld();
    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);
    const snapshot = frame.visibilitySnapshots[0];
    expect(snapshot?.get(parent)?.effective).toBe('visible');
    expect(snapshot?.get(child)?.effective).toBe('visible');
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(3);
  });

  it('keeps renderer extraction read-only over derived GlobalTransform.world', () => {
    const { world, parent, child } = makeWorld();
    world.update(0).unwrap();
    const before = [...world.get(child, GlobalTransform).unwrap().world];
    const beforeInspection = world.inspect();
    const beforeShape = {
      entityCount: beforeInspection.entityCount,
      archetypeCount: beforeInspection.archetypeCount,
      tableCount: beforeInspection.tableCount,
      activeComponents: beforeInspection.activeComponents,
      systemCount: beforeInspection.systemCount,
      resourceKeys: beforeInspection.resourceKeys,
    };

    world.set(parent, Transform, { pos: [9, 0, 0] }).unwrap();
    extractFrames([world], 0);

    expect([...world.get(child, GlobalTransform).unwrap().world]).toEqual(before);
    const afterInspection = world.inspect();
    expect({
      entityCount: afterInspection.entityCount,
      archetypeCount: afterInspection.archetypeCount,
      tableCount: afterInspection.tableCount,
      activeComponents: afterInspection.activeComponents,
      systemCount: afterInspection.systemCount,
      resourceKeys: afterInspection.resourceKeys,
    }).toEqual(beforeShape);
    world.update(0).unwrap();
    expect(world.get(child, GlobalTransform).unwrap().world[12]).toBeCloseTo(11);
  });

  it('keeps direct prepared-kernel output aligned with extractFrames output', () => {
    const { world, child } = makeWorld();
    const merged = extractFrames([world], 0);
    const prepared = prepareExtractContext(world);
    const direct = extractFrame(world, prepared);

    expect(direct.cameras).toEqual(merged.cameras);
    expect(direct.dispatch).toEqual(merged.dispatch);
    expect(prepared.visibility.get(child)?.effective).toBe('visible');
  });

  it('does not reuse a prior visibility result across repeated extracts', () => {
    const { world, parent } = makeWorld();
    const first = extractFrames([world], 0);
    expect(first.visibilitySnapshots[0]?.get(parent)?.effective).toBe('hidden');

    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const second = extractFrames([world], 0);
    expect(second.visibilitySnapshots[0]?.get(parent)?.effective).toBe('visible');
  });
});
