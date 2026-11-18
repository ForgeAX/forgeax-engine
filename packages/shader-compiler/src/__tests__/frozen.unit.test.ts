import { describe, expect, it } from 'vitest';
import { freezeSnapshot } from '../frozen.js';

function snapshot<T>(value: T) {
  const result = freezeSnapshot(value);
  if (!result) throw new Error('Expected a supported snapshot');
  return result;
}

describe('compiler-owned snapshots', () => {
  it('shares certified immutable descendants while copying new ownership', () => {
    const source = { bindings: [{ name: 'buffer' }], wgsl: 'shared WGSL' };
    const first = snapshot(source);
    const second = snapshot({ ...first.value, deps: ['module'] });
    expect(first.value.bindings).not.toBe(source.bindings);
    expect(second.value.bindings).toBe(first.value.bindings);
    expect(Object.isFrozen(second.value.bindings[0])).toBe(true);
    Object.assign(source.bindings[0] ?? {}, { name: 'changed' });
    expect(second.value.bindings[0]?.name).toBe('buffer');
    expect(second.bytes).toBe(
      snapshot({ ...source, bindings: [{ name: 'buffer' }], deps: ['module'] }).bytes,
    );
  });

  it('does not trust a caller-frozen container or invoke accessors', () => {
    const mutable = { name: 'buffer' };
    const caller = Object.freeze({ mutable });
    const detached = snapshot(caller);
    mutable.name = 'changed';
    expect(detached.value.mutable.name).toBe('buffer');
    expect(detached.value).not.toBe(caller);
    let reads = 0;
    expect(
      freezeSnapshot({
        get value() {
          reads++;
          return 1;
        },
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
    const cycle: { value?: unknown } = {};
    cycle.value = cycle;
    expect(freezeSnapshot(cycle)).toBeUndefined();
  });
});
