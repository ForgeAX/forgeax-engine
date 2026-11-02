import { C111_SEGMENTS, C111_SUBJECTS } from './c111.ts';
import type { ShowSegment } from './director.ts';
import { GALLERY_SEGMENTS, GALLERY_SUBJECTS } from './gallery.ts';
import { HOOD_LINKAGE, HOOD_LINKAGE_SEGMENTS } from './hood-linkage.ts';
import { MAID_WHALE, MAID_WHALE_G7, MAID_WHALE_G7_SEGMENTS, MAID_WHALE_SEGMENTS } from './maid-whale.ts';
import { Materials } from '@forgeax/engine/render';
import { MECH_GT_CAR, MECH_GT_CLEAN_PAINT, MECH_GT_SEGMENTS, MECH_GT_SUBJECTS } from './mech-gt.ts';
import { SCIFI_MECH, SCIFI_MECH_SEGMENTS } from './scifi-mech.ts';
import type { ShowSubjectSource } from './subjects.ts';

/**
 * Show programs by name; a plugin config selects one. F1 mech-gt S8 is `mech-gt`;
 * `mech-gt-car` is the finished car alone (its interactive page loads no rig); F2 is `maid-whale` (`maid-whale-g7`: the G7 face figure with its cooked materials); kernel
 * cases follow their case ids, and `gallery` shows single-Pack cases.
 */
export interface ShowProgram {
  readonly subjects: readonly ShowSubjectSource[];
  readonly segments: readonly ShowSegment[];
  /** Standard material looks the Show Pack cooks (`material/look-<name>`), for subject `clean` slots. */
  readonly looks?: Readonly<Record<string, ReturnType<typeof Materials.standard>>>;
}

export const SHOW_PROGRAMS: Readonly<Record<string, ShowProgram>> = {
  'c-111': { subjects: C111_SUBJECTS, segments: C111_SEGMENTS },
  'c-116': { subjects: [HOOD_LINKAGE], segments: HOOD_LINKAGE_SEGMENTS },
  'mech-gt': { subjects: MECH_GT_SUBJECTS, segments: MECH_GT_SEGMENTS },
  'maid-whale': { subjects: [MAID_WHALE], segments: MAID_WHALE_SEGMENTS },
  'scifi-mech': { subjects: [SCIFI_MECH], segments: SCIFI_MECH_SEGMENTS },
  'maid-whale-g7': { subjects: [MAID_WHALE_G7], segments: MAID_WHALE_G7_SEGMENTS },
  gallery: { subjects: GALLERY_SUBJECTS, segments: GALLERY_SEGMENTS },
  'mech-gt-car': {
    subjects: [MECH_GT_CAR],
    segments: [{ subject: 0, kind: 'turntable', seconds: 20 }],
    looks: { 'clean-paint': MECH_GT_CLEAN_PAINT },
  },
};
