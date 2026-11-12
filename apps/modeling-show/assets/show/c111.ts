import { buildPanels } from '../../../../packages/modeling/examples/body-panels/panels.ts';
import { buildLimb } from '../../../../packages/modeling/examples/transforming-limb/limb.ts';
import type { ShowSegment } from './director.ts';
import type { ShowSubjectSource } from './subjects.ts';

const PANEL_SLOTS = ['paint', 'carbon', 'badge', 'number-l', 'number-r', 'underside'] as const;

/** Case C-111: the Show of the C-107 transforming limb and the C-106 body panels. */
export const C111_SUBJECTS: readonly ShowSubjectSource[] = [
  {
    name: 'limb',
    packs: [{ packageId: '01900000-0000-7000-8000-0000000c0107', scenes: ['scene/limb'] }],
    xray: ['fender', 'chassis'],
    history: [{ label: 'C-107 limb', build: () => buildLimb() }],
  },
  {
    name: 'panels',
    packs: [
      {
        packageId: '01900000-0000-7000-8000-0000000c0106',
        meshes: ['mesh/body-panels'],
        materials: Object.fromEntries(PANEL_SLOTS.map((slot) => [slot, `material/${slot}`])),
      },
    ],
    history: [{ label: 'C-106 panels', build: () => buildPanels() }],
  },
];

export const C111_SEGMENTS: readonly ShowSegment[] = [
  { subject: 0, kind: 'turntable', seconds: 8 },
  { subject: 0, kind: 'transform', seconds: 10 },
  { subject: 0, kind: 'explode', seconds: 7 },
  { subject: 0, kind: 'section', seconds: 8 },
  { subject: 0, kind: 'xray', seconds: 9 },
  { subject: 0, kind: 'history', seconds: 14 },
  { subject: 1, kind: 'turntable', seconds: 8 },
  { subject: 1, kind: 'section', seconds: 6 },
  { subject: 1, kind: 'history', seconds: 6 },
];
