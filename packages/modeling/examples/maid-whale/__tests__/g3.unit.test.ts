import { sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildDressG3, buildHairG3, buildTailG3, G3_PARTS } from '../forms.ts';

/** C-200 G3: refined parts build valid and closed; replaced blockout parts are gone. */
describe('C-200 G3 secondary forms', () => {
  it('fuses the hair into one closed mass', () => {
    const m = buildHairG3();
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().closed).toBe(true);
  }, 60_000);

  it('builds the dress shells and apron plates', () => {
    const m = buildDressG3();
    expect(m.poisoned).toBeUndefined();
    for (const tag of ['skirt', 'skirt-hem', 'bodice', 'waistband', 'apron', 'apron-ruffle', 'apron-bib']) expect(m.count(sel.tag(tag))).toBeGreaterThan(0);
  });

  it('sweeps the tail and places the fluke', () => {
    const m = buildTailG3();
    expect(m.poisoned).toBeUndefined();
    expect(m.count(sel.tag('fluke'))).toBeGreaterThan(0);
  });

  it('replaces the blockout hair, dress and tail parts', () => {
    const names = G3_PARTS.map(([n]) => n);
    expect(names.filter((n) => n === 'hair' || n === 'dress' || n === 'tail')).toHaveLength(3);
    expect(names).not.toContain('tail-root');
  });
});
