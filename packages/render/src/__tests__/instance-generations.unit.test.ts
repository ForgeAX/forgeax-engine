import { describe, expect, it } from 'vitest';
import {
  captureInstanceGenerations,
  matchInstanceOrdinals,
  previousInstanceOrdinal,
  SAME_INSTANCE_ORDINALS,
  survivingInstanceOrdinals,
} from '../instance-generations';

describe('instance generation pairing', () => {
  it('reuses the submitted column index across independent moving lists', () => {
    const ids = [101, 0xfffffff0, 14, 500_000];
    const previous = captureInstanceGenerations(Uint32Array.from(ids));
    let observed: ReturnType<typeof matchInstanceOrdinals>;
    for (let turn = 1; turn <= 32; turn++) {
      const order = ids.map((_, index) => (index + (turn % 2 === 0 ? 2 : 1)) % ids.length);
      const current = captureInstanceGenerations(
        Uint32Array.from(order, (index) => ids[index] as number),
      );
      const admitted = survivingInstanceOrdinals(current, previous);
      expect(admitted).toBeDefined();
      expect(admitted).not.toBe(SAME_INSTANCE_ORDINALS);
      observed ??= admitted;
      expect(admitted).toBe(observed);
      expect(
        [...current].map((id, ordinal) => previousInstanceOrdinal(admitted, id, ordinal)),
      ).toEqual(order);
    }
  });

  it('pairs survivor subsets while rejecting reused, zero and duplicate generations', () => {
    const past = Uint32Array.of(50, 52, 55);
    expect(survivingInstanceOrdinals(Uint32Array.of(50, 52), past)).toBe(SAME_INSTANCE_ORDINALS);
    expect(survivingInstanceOrdinals(Uint32Array.of(50, 53), past)).toBeUndefined();
    expect(matchInstanceOrdinals(Uint32Array.of(50, 50), past)).toBeUndefined();
    expect(matchInstanceOrdinals(Uint32Array.of(0, 52), past)).toBeUndefined();
    const validation = past.slice();
    expect(matchInstanceOrdinals(validation, validation)).toBe(SAME_INSTANCE_ORDINALS);
    validation[0] = validation[1] as number;
    expect(matchInstanceOrdinals(validation, validation)).toBeUndefined();
  });
});
