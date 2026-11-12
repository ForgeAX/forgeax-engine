import type { ShowSegment } from './director.ts';
import type { ShowSubjectSource } from './subjects.ts';

/**
 * C-410 (T1 sci-fi mech, high-to-low bake) from forgeax-modeling `examples/scifi-mech`: one mesh per
 * part (`mesh/c410-low.<part>`, a slot per texture set) with the baked set materials, the decimated
 * detail preview `mesh/c410-high` and the plain look. The Pack lists its materials; the Show discovers
 * every mesh it publishes. Pack keys follow `examples/scifi-mech/show.ts` (`SHOW_META`).
 */
const SETS = ['set1', 'set2', 'set3'] as const;

export const SCIFI_MECH: ShowSubjectSource = {
  name: 'scifi-mech',
  source: 'scifi-mech: scifi-mech.pack, C410_JOBS (set bakes at 2048 and the decimated detail)',
  legend: 'C-410 Warden, 3.5 m bipedal mech: low mesh with baked maps (default); Bake row: High mesh, Plain material',
  packs: [
    {
      packageId: '01900000-0000-7000-8000-0000000c0410',
      materials: {
        ...Object.fromEntries(SETS.map((set) => [set, `material/c410-baked-${set}`])),
        plain: 'material/c410-plain',
      },
    },
  ],
  controls: [
    { kind: 'camera' },
    { kind: 'floor' },
    { kind: 'shading' },
    { kind: 'parts' },
    { kind: 'bake', high: 'mesh/c410-high', low: 'mesh/c410-low.', plain: 'material/c410-plain', channels: [] },
  ],
};

export const SCIFI_MECH_SEGMENTS: readonly ShowSegment[] = [{ subject: 0, kind: 'turntable', seconds: 20 }];
