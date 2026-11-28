import { expect, it } from 'vitest';
import { booleanSolids } from '../boolean.ts';
import { cylinder } from '../build.ts';
import { IDENTITY_PLACEMENT, transformShape } from '../transform.ts';
import { validate } from '../validate.ts';

// A bolt-circle bore whose seam sits at phase 0 (untransformed cylinder). Before the ray fix, radii 6 and 8
// failed with brep-edge-use because the fixed ray crossed a tessellation edge through the bore centre.
it.each([6, 8])('bores a flange at bolt radius 28 with an unrotated r%i tool', (r) => {
  const flange = cylinder({ radius: 40, height: 8, label: 'flange' });
  const tool = cylinder({ radius: r, height: 20 });
  if (!flange.ok || !tool.ok) throw new Error('build');
  const placed = transformShape(tool.value, { ...IDENTITY_PLACEMENT, t: [28, 0, 0] });
  if (!placed.ok) throw new Error('place');
  const res = booleanSolids(flange.value, placed.value, 'difference');
  expect(res.ok).toBe(true);
  if (res.ok) expect(validate(res.value).ok).toBe(true);
});
