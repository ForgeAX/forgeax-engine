import { describe, expect, it, vi } from 'vitest';
import { defineComponent, World } from '../index';

const Holder = defineComponent('WorldUniqueRefReader', { value: 'unique<OwnedPayload>' });

describe('World managed payload reads', () => {
  it('publishes one immutable resolution while retaining the live payload identity', () => {
    const world = new World();
    const payload = { value: 7 };
    const handle = world.allocUniqueRef('OwnedPayload', payload);
    const first = world.resolveUniqueRef<typeof payload>(handle);
    expect(world.resolveUniqueRef(handle)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(payload)).toBe(false);
    payload.value = 8;
    expect(first.unwrap()).toBe(payload);
    expect(first.unwrap().value).toBe(8);
    expect(Reflect.set(first, 'value', { value: 9 })).toBe(false);
    expect(world.resolveUniqueRef(handle).unwrap()).toBe(payload);
  });

  it('keeps one payload identity and rejects generations released by component replacement', () => {
    const world = new World();
    const payload = { value: 7 };
    const released = vi.fn();
    const first = world.allocUniqueRef('OwnedPayload', payload, released);
    const entity = world.spawn({ component: Holder, data: { value: first } }).unwrap();
    expect(world.resolveUniqueRef<typeof payload>(first).unwrap()).toBe(payload);
    const replacement = { value: 8 };
    const second = world.allocUniqueRef('OwnedPayload', replacement);
    world.set(entity, Holder, { value: second }).unwrap();
    expect(released).toHaveBeenCalledExactlyOnceWith(payload);
    expect(world.resolveUniqueRef(first)).toMatchObject({
      ok: false,
      error: { code: 'unique-ref-stale' },
    });
    expect(world.resolveUniqueRef<typeof replacement>(second).unwrap()).toBe(replacement);
    world.despawn(entity).unwrap();
    expect(world.resolveUniqueRef(second)).toMatchObject({
      ok: false,
      error: { code: 'unique-ref-stale' },
    });
  });
});
