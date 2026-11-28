import { filletPrism } from '../../src/brep/fillet-prism.ts';
import type { Shape } from '../../src/brep/types.ts';

/** L-bracket with a 0.3 thick web (x 2.0-2.3): the thin-wall case for QF-M6. Profile and radii are the fixture SSOT. */
export function bracketFixture(): Shape {
  const r = filletPrism({
    profile: [
      [0, 0],
      [4, 0],
      [4, 0.6],
      [2.3, 0.6],
      [2.3, 2.0],
      [2.0, 2.0],
      [2.0, 0.6],
      [0.6, 0.6],
      [0.6, 3],
      [0, 3],
    ],
    height: 2,
    radii: [0, 0, 0, 0.25, 0, 0, 0.25, 0.5, 0, 0],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}
