import { box, cylinder } from '../../src/brep/build.ts';
import type { Shape } from '../../src/brep/types.ts';

/** A 2.6 x 1 x 1 box centred at the origin (top face z = 0.5) and a radius-1, height-4 cylinder along z. */
export function cylinderOnTop(): { top: Shape; side: Shape } {
  const b = box({ size: [2.6, 1, 1] });
  const c = cylinder({ radius: 1, height: 4 });
  if (!b.ok || !c.ok) throw new Error('build failed');
  return { top: b.value, side: c.value };
}
