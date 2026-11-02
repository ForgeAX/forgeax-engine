import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildFaceted } from '../faceting.ts';

/**
 * C-200 hair clump identity (design findings): every one of the nine designed
 * clumps carries its own tag, and no hair face is anonymous. The sheet's check counted a fixed list of
 * six coarse names (so it could never exceed 6 and reported -3) and ignored the cap, which holds the
 * rest of the faces by label.
 */
describe('C-200 hair clump tags', () => {
  const m = buildFaceted();
  const mesh = m.editMesh;
  const count = (t: string) => sel.tag(t).evaluate(mesh).length;
  const clumps = ['hair-bang-l', 'hair-bang-c', 'hair-bang-r', 'hair-side-l', 'hair-side-r', 'hair-back-l', 'hair-back-c', 'hair-back-r', 'hair-ahoge'];

  it('tags each of the nine designed clumps individually', () => {
    expect(clumps.map((t) => [t, count(t) > 0])).toEqual(clumps.map((t) => [t, true]));
  });

  it('leaves no hair face without a clump, cap or spike tag', () => {
    const named = [...clumps, 'hair-cap', 'hair-spike'].map((t) => sel.tag(t)).reduce((a, b) => a.or(b));
    expect(sel.tag('hair').minus(named).evaluate(mesh)).toEqual([]);
  });

  it('shows the cap is the whole remainder once the nine clumps are counted', () => {
    const clumpFaces = clumps.map((t) => sel.tag(t)).reduce((a, b) => a.or(b));
    const rest = sel.tag('hair').minus(clumpFaces).minus(sel.tag('hair-spike')).evaluate(mesh).length;
    expect(rest).toBe(count('hair-cap'));
    expect(rest).toBeGreaterThan(0);
  });
});
