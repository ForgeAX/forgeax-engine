import type { ShowSegment } from './director.ts';
import type { ShowSubjectSource } from './subjects.ts';

/**
 * Case C-116 (B14): the hood four-bar of forgeax-modeling `examples/hood-linkage`, whose
 * scene's AnimationPlayer plays the cylinder's full stroke; the Show's u drives it.
 */
export const HOOD_LINKAGE: ShowSubjectSource = {
  name: 'hood-linkage',
  source: 'hood-linkage: hood.pack, hoodRig(buildHood()).finish',
  packs: [{ packageId: '01900000-0000-7000-8000-0000000c0116', scenes: ['scene/hood-linkage'] }],
};

export const HOOD_LINKAGE_SEGMENTS: readonly ShowSegment[] = [
  { subject: 0, kind: 'turntable', seconds: 10 },
  { subject: 0, kind: 'transform', seconds: 12 },
  { subject: 0, kind: 'turntable', seconds: 10, form: 1 },
];
