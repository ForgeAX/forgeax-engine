import { describe, expect, it } from 'vitest';
import { cylinder } from '../build.ts';
import { faceTrim, inFaceUv } from '../trim-face.ts';

describe('planar cap winding for a circle-bounded disc', () => {
  const made = cylinder({ radius: 0.3, height: 3, label: 'cyl' });
  if (!made.ok) throw new Error('cylinder build failed');
  const shape = made.value;

  it('classifies the centre of the clockwise bottom cap and the top cap alike', () => {
    for (const f of [0, 2]) {
      const trim = faceTrim(shape, f);
      expect(inFaceUv(trim, [0, 0])).toBe(true);
      expect(inFaceUv(trim, [0.1, 0])).toBe(true);
      expect(inFaceUv(trim, [0.5, 0])).toBe(false);
    }
  });
});
