import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { G4_PARTS } from '../details.ts';
import { LANDMARK, part } from '../reference.ts';

/** C-200 G4: every local part of the spec list builds valid at its measured place. */
describe('C-200 G4 local parts', () => {
  it('builds every detail part', () => {
    for (const [name, build] of G4_PARTS) {
      const m = build();
      expect(m.poisoned, name).toBeUndefined();
      expect(m.count(sel.all()), name).toBeGreaterThan(0);
    }
  }, 180_000);

  it('places the headdress between the crown and the measured frill top', () => {
    const m = model();
    m.append((G4_PARTS.find(([n]) => n === 'headdress') as readonly [string, () => ReturnType<typeof model>])[1]());
    const ys = sel
      .all()
      .evaluate(m.editMesh)
      .flatMap((f) => m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v)[1] as number));
    expect(Math.max(...ys)).toBeLessThanOrEqual(part('front', 'headdress').bounds[3] + 0.01);
    expect(Math.max(...ys)).toBeGreaterThan(LANDMARK.crown as number);
  });
});
