import { expect, it } from 'vitest';
import { PublicationTransformRows } from '../publication/transform-rows';

it('validates unsigned identities and preserves physical addresses across changed packets and retries', () => {
  const index = new PublicationTransformRows();
  const wide = Array.from({ length: 4096 }, (_, i) => Math.imul(i, 0x9e3779b1) >>> 0);
  for (const ids of [[], [1], [3, 5, 0xffffffff], [4, 2, 3], [0xffffffff, 0, 15], wide]) {
    const wire = Uint32Array.from(ids);
    for (const needsLookup of [false, true]) {
      expect(index.validate(wire, needsLookup)).toBe(true);
      if (needsLookup) {
        for (let row = 0; row < ids.length; row++)
          expect(index.find(wire, ids[row] as number)).toBe(row);
        expect(index.find(wire, 0x7ffffffa)).toBeUndefined();
      }
      expect([...wire]).toEqual(ids);
      if (ids.length > 0)
        expect(index.validate(Uint32Array.from([...ids, ids[0] as number]), needsLookup)).toBe(
          false,
        );
    }
  }
  index.dispose();
});
