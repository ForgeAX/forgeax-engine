import { describe, expect, it } from 'vitest';
import { defineComponent } from '../component';
import { World } from '../world';

const VisibilityLike = defineComponent('M1VisibilityLikeAtomic', {
  state: { type: 'enum', default: 0, labels: { inherited: 0, hidden: 1, visible: 2 } },
});

const Position = defineComponent('M1VisibilityAtomicPosition', {
  value: 'f32',
});

function expectInvalidValue(result: { ok: boolean; error?: unknown }, entity?: number): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const error = result.error as {
    code: string;
    expected: string;
    hint: string;
    detail: {
      entity: number | undefined;
      component: string;
      field: string;
      received: unknown;
      allowedValues: Readonly<Record<string, number>>;
    };
  };
  expect(error.code).toBe('component-field-invalid-value');
  expect(error.expected).toContain('inherited');
  expect(error.hint).toContain('VisibilityLike');
  expect(error.detail).toEqual({
    entity,
    component: 'M1VisibilityLikeAtomic',
    field: 'state',
    received: 9,
    allowedValues: { inherited: 0, hidden: 1, visible: 2 },
  });
}

describe('M1 Visibility enum writes are atomic', () => {
  it('rejects an invalid enum during spawn before creating the row', () => {
    const world = new World();

    const result = world.spawn({ component: VisibilityLike, data: { state: 9 } });

    expectInvalidValue(result);
    expect(world.spawn({ component: Position, data: { value: 1 } }).unwrap()).toBe(0);
  });

  it('rejects an invalid enum during addComponent before archetype migration', () => {
    const world = new World();
    const entity = world.spawn({ component: Position, data: { value: 1 } }).unwrap();

    const result = world.addComponent(entity, {
      component: VisibilityLike,
      data: { state: 9 },
    });

    expectInvalidValue(result, entity);
    expect(world.get(entity, VisibilityLike).ok).toBe(false);
    expect(world.get(entity, Position).unwrap().value).toBe(1);
  });

  it('rejects an invalid enum during set and preserves the previous value', () => {
    const world = new World();
    const entity = world.spawn({ component: VisibilityLike, data: { state: 1 } }).unwrap();

    const result = world.set(entity, VisibilityLike, { state: 9 });

    expectInvalidValue(result, entity);
    expect(world.get(entity, VisibilityLike).unwrap().state).toBe(1);
  });

  it('accepts every declared enum value through all three write entries', () => {
    const world = new World();
    const entity = world.spawn({ component: VisibilityLike, data: { state: 0 } }).unwrap();

    expect(world.set(entity, VisibilityLike, { state: 1 }).ok).toBe(true);
    expect(world.addComponent(entity, { component: Position, data: { value: 2 } }).ok).toBe(true);
    expect(world.get(entity, VisibilityLike).unwrap().state).toBe(1);
  });
});
