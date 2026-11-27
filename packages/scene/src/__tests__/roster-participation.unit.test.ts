import { Disabled, defineComponent, World } from '@forgeax/engine-ecs';
import { createStateProjection } from '@forgeax/engine-ecs/projection';
import { describe, expect, it, vi } from 'vitest';
import { ChildOf } from '../components/child-of';
import { Transform } from '../components/transform';
import {
  assertSceneRosterObservation,
  prepareSceneRosterParticipation,
  type SceneRosterObservation,
} from '../instances/roster-participation';

function migrationOwner(world: World) {
  return world as unknown as {
    migrateEntity(slot: number, source: unknown, target: unknown): void;
  };
}

function fixture() {
  const world = new World();
  const members = [
    world.spawn({ component: Disabled, data: {} }, { component: Transform, data: {} }).unwrap(),
    world.spawn({ component: Disabled, data: {} }, { component: Transform, data: {} }).unwrap(),
    world.spawn({ component: Disabled, data: {} }, { component: Transform, data: {} }).unwrap(),
  ] as const;
  const content = vi.fn(() => true);
  const roster = prepareSceneRosterParticipation(world, {
    members,
    authorDisabled: new Set([members[1]]),
    sourceComponents: [Transform, ChildOf],
    isCurrent: content,
  }).unwrap();
  return { world, members, content, roster };
}

describe('Scene-owned roster participation', () => {
  it('keeps same-World groups independent without consuming the ordinary source cursor', () => {
    const world = new World();
    const resident = world.spawn({ component: Transform, data: {} }).unwrap();
    const members = [
      world.spawn({ component: Transform, data: {} }, { component: Disabled, data: {} }).unwrap(),
      world.spawn({ component: Transform, data: {} }, { component: Disabled, data: {} }).unwrap(),
    ];
    const ordinary = createStateProjection(world, [Transform], [Transform]);
    ordinary.read().accept();
    const groups = members.map((entity) =>
      prepareSceneRosterParticipation(world, {
        members: [entity],
        authorDisabled: new Set(),
        sourceComponents: [Transform],
        isCurrent: () => true,
      }).unwrap(),
    );
    const first = groups[0],
      second = groups[1];
    if (first === undefined || second === undefined) throw new Error('Missing fixture rosters');
    const firstInput = first.capture().unwrap(),
      secondInput = second.capture().unwrap();
    world.set(resident, Transform, { pos: [7, 0, 0] }).unwrap();
    const activeFirst = first.setActive(true, firstInput).unwrap();
    expect(secondInput.isCurrent()).toBe(true);
    const activeSecond = second.setActive(true, secondInput).unwrap();
    expect(activeFirst.isCurrent()).toBe(true);
    first.setActive(false, activeFirst).unwrap();
    expect(activeSecond.isCurrent()).toBe(true);
    const pending = ordinary.read();
    expect(pending.indices).toContain(Number(resident) & 0x00ffffff);
    expect(ordinary.changed(resident, Transform)).toBe(true);
    pending.validate();
    pending.accept();
    first.dispose();
    second.dispose();
  });

  it.each([
    'receiver',
    'getter',
  ] as const)('fixes the external content guard %s for its whole lifetime', (mode) => {
    const world = new World();
    const entity = world.spawn({ component: Disabled, data: {} }).unwrap();
    let reads = 0;
    const input = {
      members: [entity],
      authorDisabled: new Set<typeof entity>(),
      sourceComponents: [],
      generation: 0,
      get isCurrent() {
        reads++;
        return function (this: { generation: number }) {
          return this.generation === 0;
        };
      },
    };
    const roster = prepareSceneRosterParticipation(world, input).unwrap();
    const observed = roster.capture().unwrap();
    if (mode === 'getter') expect(reads).toBe(1);
    else {
      input.generation = 1;
      expect(observed.isCurrent()).toBe(false);
      expect(roster.capture().ok).toBe(false);
    }
    roster.dispose();
  });

  it('keeps an empty roster qualified without requiring a renderable or a source mutation', () => {
    const world = new World();
    const roster = prepareSceneRosterParticipation(world, {
      members: [],
      authorDisabled: new Set(),
      sourceComponents: [Transform],
      isCurrent: () => true,
    }).unwrap();
    const initial = roster.capture().unwrap();
    const active = roster.setActive(true, initial).unwrap();
    expect(active.members).toHaveLength(0);
    expect(active.active).toBe(true);
    expect(initial.isCurrent()).toBe(false);
    expect(roster.setActive(false, active).unwrap().active).toBe(false);
    roster.dispose();
  });

  it('hands off exact successive observations and preserves authored Disabled intent', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    expect(f.roster.capture().unwrap()).toBe(first);
    expect(() => assertSceneRosterObservation(first)).not.toThrow();
    const active = f.roster.setActive(true, first).unwrap();
    expect(first.isCurrent()).toBe(false);
    expect(active.generation).toBe(first.generation + 1);
    expect(active.active).toBe(true);
    expect(active.members).toBe(first.members);
    expect(f.world.hasComponent(f.members[0], Disabled)).toBe(false);
    expect(f.world.hasComponent(f.members[1], Disabled)).toBe(true);
    expect(f.roster.setActive(true, active).unwrap()).toBe(active);
    const inactive = f.roster.setActive(false, active).unwrap();
    expect(active.isCurrent()).toBe(false);
    expect(inactive.active).toBe(false);
    expect(f.members.every((entity) => f.world.hasComponent(entity, Disabled))).toBe(true);
    f.roster.dispose();
    expect(inactive.isCurrent()).toBe(false);
    expect(f.roster.capture().ok).toBe(false);
  });

  it('leaves Disabled membership reads to the owning batch during participation changes', () => {
    const { world, roster, content } = fixture();
    const initial = roster.capture().unwrap();
    const membership = vi.spyOn(world, 'hasComponent');
    try {
      content.mockClear();
      const active = roster.setActive(true, initial).unwrap();
      const inactive = roster.setActive(false, active).unwrap();
      expect(inactive.active).toBe(false);
      expect(membership).not.toHaveBeenCalled();
      expect(content).toHaveBeenCalledTimes(4);
    } finally {
      membership.mockRestore();
      roster.dispose();
    }
  });

  it('rejects copies and foreign observations without destroying the current qualification', () => {
    const f = fixture(),
      other = fixture();
    const initial = f.roster.capture().unwrap();
    expect(() => assertSceneRosterObservation({ ...initial })).toThrow('foreign-observation');
    f.content.mockClear();
    expect(f.roster.setActive(true, { ...initial }).ok).toBe(false);
    expect(f.content).not.toHaveBeenCalled();
    expect(f.roster.setActive(true, other.roster.capture().unwrap()).ok).toBe(false);
    expect(f.roster.capture().unwrap()).toBe(initial);
    f.roster.dispose();
    other.roster.dispose();
  });

  it('refuses an unissued missing observation before running any external guard', () => {
    const f = fixture();
    f.content.mockClear();
    const missing = undefined as unknown as SceneRosterObservation;
    expect(f.roster.setActive(false, missing).ok).toBe(false);
    expect(f.content).not.toHaveBeenCalled();
    expect(f.members.every((entity) => f.world.hasComponent(entity, Disabled))).toBe(true);
    f.roster.dispose();
  });

  it('refuses reentrant source acceptance inside an observation guard', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    let nestedAccepted: boolean | undefined;
    f.content.mockImplementationOnce(() => {
      nestedAccepted = f.roster.setActive(true, first).ok;
      return true;
    });
    expect(first.isCurrent()).toBe(true);
    expect(nestedAccepted).toBe(false);
    expect(f.members.every((entity) => f.world.hasComponent(entity, Disabled))).toBe(true);
    expect(f.roster.capture().unwrap()).toBe(first);
    f.roster.dispose();
  });

  it('keeps disposal terminal when the content guard closes its owner', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    f.content.mockImplementationOnce(() => {
      f.roster.dispose();
      return true;
    });
    expect(f.roster.capture().ok).toBe(false);
    expect(f.roster.inspect().phase).toBe('closed');
    expect(first.isCurrent()).toBe(false);
  });

  it('preserves both closure and a write-fault result when a post-write guard disposes the owner', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    f.content.mockImplementation(() => {
      if (!f.world.hasComponent(f.members[0], Disabled)) f.roster.dispose();
      return true;
    });
    const result = f.roster.setActive(true, first);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('partial-transition');
    expect(f.world.hasComponent(f.members[0], Disabled)).toBe(false);
    expect(f.roster.inspect()).toEqual({ phase: 'closed', participation: 'unconfirmed' });
    expect(first.isCurrent()).toBe(false);
  });

  it.each([
    'source-value',
    'extra-structure',
  ] as const)('rejects a %s edit during the controlled Disabled transition', (kind) => {
    const { world, roster, members } = fixture();
    const first = roster.capture().unwrap();
    const owner = migrationOwner(world);
    const migrate = owner.migrateEntity.bind(world);
    const extra = defineComponent('UnexpectedRosterComponent', {});
    const intercepted = vi
      .spyOn(owner, 'migrateEntity')
      .mockImplementationOnce((slot, source, target) => {
        migrate(slot, source, target);
        const entity = members[0];
        if (kind === 'source-value') world.set(entity, Transform, { pos: [3, 0, 0] }).unwrap();
        else world.addComponent(entity, { component: extra, data: {} }).unwrap();
      });
    try {
      const accepted = roster.setActive(true, first);
      expect(accepted).toMatchObject({
        ok: false,
        error: { detail: { reason: 'partial-transition' } },
      });
      expect(first.isCurrent()).toBe(false);
      expect(roster.inspect().participation).toBe('unconfirmed');
    } finally {
      intercepted.mockRestore();
      roster.dispose();
    }
  });

  it('rejects an entity generation replacement instead of adopting its new source state', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    f.world.despawn(f.members[0]).unwrap();
    const replacement = f.world.spawn({ component: Disabled, data: {} }).unwrap();
    expect(replacement).not.toBe(f.members[0]);
    expect(first.isCurrent()).toBe(false);
    expect(f.roster.setActive(true, first).ok).toBe(false);
    expect(f.world.hasComponent(replacement, Disabled)).toBe(true);
    f.roster.dispose();
  });

  it.each([
    'false',
    'throw',
    'write',
  ] as const)('reports post-write guard %s as a transition fault with unconfirmed participation', (mode) => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    f.content.mockImplementation(() => {
      if (f.world.hasComponent(f.members[0], Disabled)) return true;
      if (mode === 'throw') throw new Error('post-write content guard failed');
      if (mode === 'write') {
        f.world.set(f.members[0], Transform, { pos: [8, 0, 0] }).unwrap();
        return true;
      }
      return false;
    });
    const result = f.roster.setActive(true, first);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('partial-transition');
    expect(f.world.hasComponent(f.members[0], Disabled)).toBe(false);
    expect(f.roster.inspect()).toMatchObject({ phase: 'failed', participation: 'unconfirmed' });
    expect(first.isCurrent()).toBe(false);
    f.roster.dispose();
  });

  it('cannot wash an uncontrolled Disabled transition or component edit-and-restore into a successor', () => {
    for (const mode of ['disabled', 'author-disabled', 'value', 'structure'] as const) {
      const f = fixture();
      const initial = f.roster.capture().unwrap();
      const entity = f.members[0];
      if (mode === 'disabled') f.world.removeComponent(entity, Disabled).unwrap();
      else if (mode === 'author-disabled') f.world.removeComponent(f.members[1], Disabled).unwrap();
      else if (mode === 'value') {
        f.world.set(entity, Transform, { pos: [3, 0, 0] }).unwrap();
        f.world.set(entity, Transform, { pos: [0, 0, 0] }).unwrap();
      } else {
        const extra = defineComponent('RosterExtra', {});
        f.world.addComponent(entity, { component: extra, data: {} }).unwrap();
        f.world.removeComponent(entity, extra).unwrap();
      }
      expect(initial.isCurrent()).toBe(false);
      expect(f.roster.setActive(true, initial).ok).toBe(false);
      expect(f.roster.inspect().phase).toBe('failed');
      f.roster.dispose();
    }
  });

  it('watches ancestor inputs and tolerates unrelated resident edits', () => {
    const world = new World();
    const parent = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world
      .spawn(
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent } },
        { component: Disabled, data: {} },
      )
      .unwrap();
    const resident = world.spawn({ component: Transform, data: {} }).unwrap();
    const roster = prepareSceneRosterParticipation(world, {
      members: [child],
      authorDisabled: new Set(),
      sourceComponents: [Transform, ChildOf],
      isCurrent: () => true,
    }).unwrap();
    const first = roster.capture().unwrap();
    world.set(resident, Transform, { pos: [9, 0, 0] }).unwrap();
    expect(first.isCurrent()).toBe(true);
    world.set(parent, Transform, { pos: [2, 0, 0] }).unwrap();
    expect(first.isCurrent()).toBe(false);
    expect(roster.setActive(true, first).ok).toBe(false);
    roster.dispose();
  });

  it('keeps content refusal sticky and catches writes made by the external preflight guard', () => {
    const f = fixture();
    const initial = f.roster.capture().unwrap();
    f.content.mockReturnValueOnce(false);
    expect(initial.isCurrent()).toBe(false);
    expect(initial.isCurrent()).toBe(false);
    f.roster.dispose();
    const g = fixture();
    const second = g.roster.capture().unwrap();
    g.content.mockImplementationOnce(() => {
      g.world.set(g.members[0], Transform, { pos: [3, 0, 0] }).unwrap();
      return true;
    });
    expect(g.roster.setActive(true, second).ok).toBe(false);
    expect(g.world.hasComponent(g.members[0], Disabled)).toBe(true);
    g.roster.dispose();
  });

  it('retains an explicit fault after partial source writes and never reports successful activation', () => {
    const f = fixture();
    const first = f.roster.capture().unwrap();
    const owner = migrationOwner(f.world);
    const original = owner.migrateEntity.bind(f.world);
    const migrate = vi.spyOn(owner, 'migrateEntity');
    migrate.mockImplementationOnce(original).mockImplementationOnce(() => {
      throw new Error('injected source write failure');
    });
    const result = f.roster.setActive(true, first);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.reason).toBe('partial-transition');
    expect(f.roster.inspect().phase).toBe('failed');
    expect(f.world.execution.health).toBe('poisoned');
    expect(f.world.hasComponent(f.members[0], Disabled)).toBe(false);
    expect(f.world.hasComponent(f.members[2], Disabled)).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(f.roster.capture().ok).toBe(false);
    migrate.mockRestore();
    f.roster.dispose();
  });
});
