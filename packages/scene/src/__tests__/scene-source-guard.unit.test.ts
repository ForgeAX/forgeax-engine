import { Disabled, defineComponent, type EntityHandle, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, GlobalTransform, Transform } from '../index';
import { prepareSceneTransformsSteps } from '../instances/preparation';
import { captureSceneSourceGuard } from '../instances/source-guard';

const Extra = defineComponent('GuardExtraSource', { value: 'u32' });
function fixture() {
  const world = new World();
  for (const component of [Transform, Disabled, ChildOf, Extra])
    world.components.register(component).unwrap();
  const member = world
    .spawn({ component: Transform, data: { pos: [8, 0, 0] } }, { component: Disabled, data: {} })
    .unwrap();
  const other = world.spawn({ component: Transform, data: {} }).unwrap();
  const guard = captureSceneSourceGuard(world, [member], [Transform, ChildOf, Disabled]).unwrap();
  return { world, member, other, guard };
}

describe('Scene candidate source observation', () => {
  it('accepts unrelated source writes while rejecting a true inactive member write independently of gameplay cursors', () => {
    const { world, member, other, guard } = fixture();
    const gameplay = world.query({ changed: [Transform] }).unwrap();
    for (const _row of gameplay) {
      /* ordinary cursor observes the live set */
    }
    for (let frame = 0; frame < 10; frame++) {
      world.set(other, Transform, { pos: [frame, 0, 0] }).unwrap();
      expect(guard.isCurrent()).toBe(true);
    }
    world.set(member, Transform, { pos: [2, 0, 0] }).unwrap();
    for (const _row of gameplay) {
      /* must not swallow this owner's source facts */
    }
    expect(guard.isCurrent()).toBe(false);
    expect(guard.isCurrent()).toBe(false);
    expect(guard.inspect().scannedRows).toBeGreaterThan(0);
    guard.dispose();
  });

  it('does not treat initial domain-owned derived writes as authored source edits', () => {
    const { world, member, guard } = fixture();
    const steps = prepareSceneTransformsSteps(world, {
      members: [member],
      authorDisabled: new Set(),
      isCurrent: guard.isCurrent,
    });
    let next = steps.next();
    while (!next.done) next = steps.next();
    expect(next.value.unwrap()).toBe(1);
    expect(world.get(member, GlobalTransform).unwrap().world[12]).toBe(8);
    expect(guard.isCurrent()).toBe(true);
    guard.dispose();
    expect(guard.isCurrent()).toBe(false);
  });

  it('invalidates on an undeclared structural edit to an owned member', () => {
    const { world, member, guard } = fixture();
    world.addComponent(member, { component: Extra, data: { value: 1 } }).unwrap();
    expect(guard.isCurrent()).toBe(false);
  });

  it('advances the prepared guard from the migration delta in a large resident World', () => {
    const { world, member, guard } = fixture();
    guard.dispose();
    const residentEntities = 4096;
    for (let index = 0; index < residentEntities; index++)
      world.spawn({ component: Transform, data: {} }).unwrap();
    const prepared = captureSceneSourceGuard(world, [member], [Transform, Disabled]).unwrap();
    try {
      const expectedStructure = world.getStructureEpoch() + 1;
      world.removeComponent(member, Disabled).unwrap();
      expect(prepared.acceptDisabledTransition(expectedStructure)).toBe(true);
      expect(prepared.isCurrent()).toBe(true);
      const observed = prepared.inspect();
      expect(observed.scannedRows).toBe(1);
      expect(observed.checkedIndexEntries).toBeLessThan(residentEntities);
      world.set(member, Transform, { pos: [4, 0, 0] }).unwrap();
      expect(prepared.isCurrent()).toBe(false);
    } finally {
      prepared.dispose();
    }
  });

  it('does not let a new generation erase the deletion of its old owned identity', () => {
    const { world, member, guard } = fixture();
    world.despawn(member).unwrap();
    const replacement = world.spawn({ component: Extra, data: { value: 2 } }).unwrap();
    expect(replacement).not.toBe(member);
    expect(guard.isCurrent()).toBe(false);
    expect(captureSceneSourceGuard(world, [member as EntityHandle], [Transform]).ok).toBe(false);
  });
});
