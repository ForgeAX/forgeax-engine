import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildBlockout, DRESS_SECTIONS, G2_PARTS } from '../blockout.ts';
import { LANDMARK, part } from '../reference.ts';

/** C-200 G2: every part's primary form exists, tagged, at its measured place. */
describe('C-200 G2 blockout', () => {
  const m = buildBlockout();

  it('builds every part as a tagged, appended session', () => {
    expect(m.poisoned).toBeUndefined();
    for (const [name] of G2_PARTS) expect(m.count(sel.tag(name))).toBeGreaterThan(0);
  });

  it('keeps the measured landmarks and extents', () => {
    const bounds = (tag: string) => {
      const points = sel
        .tag(tag)
        .evaluate(m.editMesh)
        .flatMap((f) => m.editMesh.faceVertices(f).map((v) => m.editMesh.position(v)));
      const axis = (k: number) => [Math.min(...points.map((p) => p[k] as number)), Math.max(...points.map((p) => p[k] as number))];
      return { x: axis(0), y: axis(1), z: axis(2) };
    };
    expect(Math.abs((bounds('hair').y[1] as number) - (LANDMARK.crown as number))).toBeLessThan(0.01);
    expect(Math.abs((bounds('head').y[0] as number) - (LANDMARK.chin as number))).toBeLessThan(0.01);
    const shoe = bounds('shoe-l');
    expect(Math.abs((shoe.x[1] as number) - (shoe.x[0] as number) - part('front', 'shoe-l').size[0])).toBeLessThan(0.005);
    expect(DRESS_SECTIONS.map((s) => s[0])).toEqual([...DRESS_SECTIONS.map((s) => s[0])].sort((a, b) => a - b));
  });
});
