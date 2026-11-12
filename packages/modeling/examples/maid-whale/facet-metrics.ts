import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { G3_GARMENT_TAGS } from './garments.ts';

/** C-200 G6 regions: the parts the sheet facets differently. */

const anyTag = (tags: readonly string[]): FaceSelector => tags.reduce((s, t) => s.or(sel.tag(t)), sel.tag('__none__'));
const SKIRT = ['skirt', 'skirt-hem'];

/** The regions the sheet facets differently: the back hair coarsest, the skirt coarser than the bodice. */
export function facetRegions(m: Model): Readonly<Record<'back-hair' | 'hair' | 'skin' | 'skirt' | 'dress' | 'tail', FaceSelector>> {
  // The back mass's ends: G4 tips, or the remodel's lobes (facet-plan.json back-hair units).
  const tips = m.inspect().labels.map((l) => l.label).filter((l) => /^hair-(tip|back-lobe|back-inner)-\d+$/.test(l));
  const backHair = ['hair-back-outer', 'hair-back-inner', ...tips].reduce((s, l) => s.or(sel.createdBy(l)), sel.tag('__none__'));
  return {
    'back-hair': backHair,
    hair: sel.tag('hair').minus(backHair),
    skin: anyTag(['head', 'arm-l', 'arm-r', 'hand-l', 'hand-r', 'leg-l', 'leg-r']),
    // The G6 pleat units (built as facets) belong to the skirt.
    skirt: anyTag([...SKIRT, 'skirt-pleat']).minus(sel.tag('tail')),
    dress: anyTag(G3_GARMENT_TAGS.filter((t) => !SKIRT.includes(t))).minus(sel.tag('tail')),
    tail: sel.tag('tail'),
  };
}
