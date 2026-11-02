import type { ShowSegment } from './director.ts';
import { Materials } from '@forgeax/engine/render';
import type { ShowSubjectSource } from './subjects.ts';

/** The mech-gt red (the finished `material/paint` base color) as clean clear-coated gloss. */
export const MECH_GT_CLEAN_PAINT = Materials.standard({
  baseColor: [0.32, 0.012, 0.016, 1],
  metallic: 0.5,
  roughness: 0.3,
  clearcoat: 1,
  clearcoatRoughness: 0.03,
} as never);

/**
 * F1 (case C-100, code name mech-gt) showcase: the finished car, then the transforming
 * assembly: car -> robot -> car, the robot form on the turntable, explode and section. Packs are the merged mech-gt stage Packs of
 * forgeax-modeling `examples/mech-gt`; the Show project lists them as sibling Packs.
 */
const PACKAGES = {
  s7: '01900000-0000-7000-8000-0000000c1070',
  robot: '01900000-0000-7000-8000-0000000c10b0',
  front: '01900000-0000-7000-8000-0000000c1060',
  cabin: '01900000-0000-7000-8000-0000000c1061',
  rear: '01900000-0000-7000-8000-0000000c1062',
  wheels: '01900000-0000-7000-8000-0000000c1063',
  nose: '01900000-0000-7000-8000-0000000c1064',
  internals: '01900000-0000-7000-8000-0000000c1065',
  detailCockpit: '01900000-0000-7000-8000-0000000c1076',
  detailFront: '01900000-0000-7000-8000-0000000c1071',
  detailSide: '01900000-0000-7000-8000-0000000c1072',
  detailRear: '01900000-0000-7000-8000-0000000c1073',
  detailWheels: '01900000-0000-7000-8000-0000000c1074',
  detailUnderbody: '01900000-0000-7000-8000-0000000c1075',
} as const;

const slots = (...names: readonly string[]) => Object.fromEntries(names.map((name) => [name, `material/${name}`]));

/**
 * Material slots each mech-gt Pack publishes (one Standard material per slot its mesh uses);
 * `mech-gt.unit.test.ts` rebuilds the Packs and fails when a list drifts.
 */
const SLOTS = {
  front: slots('paint', 'underside'),
  nose: slots('paint', 'underside', 'glass', 'carbon'),
  cabin: slots('paint', 'underside', 'glass', 'intake'),
  rear: slots('paint', 'underside', 'louvre', 'carbon'),
  wheels: slots('tire'),
  internals: slots('hub', 'carbon', 'disc', 'alu', 'steel', 'spring', 'chrome', 'harness', 'motor', 'engine', 'battery', 'hydraulic'),
  robot: slots('gt-paint', 'gt-paint-accent', 'gt-frame', 'gt-metal', 'gt-metal-steel', 'gt-glow', 'gt-primer', 'gt-glass', 'gt-decal-number-l', 'gt-decal-number-r'),
  detailCockpit: slots('gt-paint-accent', 'gt-paint-accent-quilt', 'gt-frame', 'gt-metal', 'gt-metal-steel', 'gt-glow', 'gt-primer'),
  detailFront: slots('gt-frame', 'gt-metal-steel', 'gt-glow-white', 'gt-primer', 'gt-glass'),
  detailSide: slots('gt-decal-hyd-small', 'gt-paint', 'gt-frame', 'gt-metal-steel', 'gt-glow-amber'),
  detailRear: slots('gt-decal-number', 'gt-frame', 'gt-metal', 'gt-metal-steel', 'gt-glow-red', 'gt-primer', 'gt-glass'),
  detailWheels: slots('gt-paint-accent', 'gt-frame', 'gt-metal', 'gt-metal-steel', 'gt-primer'),
  detailUnderbody: slots('gt-decal-no-step', 'gt-paint', 'gt-frame', 'gt-metal-steel'),
} as const;

const group = (name: keyof typeof SLOTS & keyof typeof PACKAGES, mesh: string) => ({
  packageId: PACKAGES[name],
  meshes: [mesh],
  materials: SLOTS[name],
});

/** The finished car: S6 exterior groups and the S6c detail groups in the car frame. */
export const MECH_GT_CAR: ShowSubjectSource = {
  name: 'car',
  source: 'car: S6 groups (S6 exterior + S6c details, finished panels)',
  // The finished paint carries baked wear and decals; the clean look shows the panels' highlights.
  clean: { paint: 'clean-paint', 'gt-paint': 'clean-paint' },
  legend:
    'New Class-A panels: front fenders, hood, door and side intake (new flank), C-pillar, rear roof, rear fenders, engine cover, rear fascia, nose and roof front. Every exterior panel except the glass is now on the new surfaces.',
  packs: [
    group('front', 'mesh/s6-front'),
    group('nose', 'mesh/s6-nose'),
    group('cabin', 'mesh/s6-cabin'),
    group('rear', 'mesh/s6-rear'),
    group('wheels', 'mesh/s6-wheels'),
    group('detailCockpit', 'mesh/s6c-cockpit'),
    group('detailFront', 'mesh/s6c-front'),
    group('detailSide', 'mesh/s6c-side'),
    group('detailRear', 'mesh/s6c-rear'),
    group('detailWheels', 'mesh/s6c-wheels'),
    group('detailUnderbody', 'mesh/s6c-underbody'),
  ],
};

/**
 * The S7 transforming assembly (`scene/s7`, forward clip car -> robot). Its parts
 * carry the S3 panel, S5 internal and S6b robot slots; the finished Packs' materials
 * paint them with the one mech-gt scheme. Those Packs are material-only here (`meshes: []`): their
 * own meshes (the finished car groups, the S6b robot body) are not animated by the clip, and an
 * unlisted Pack would otherwise be discovered into static meshes beside the scene.
 */
const TRANSFORM: ShowSubjectSource = {
  name: 'transform',
  source: 'transform: S7 closed (S3 panels), forward clip',
  packs: [
    { packageId: PACKAGES.s7, scenes: ['scene/s7'] },
    { packageId: PACKAGES.front, meshes: [], materials: SLOTS.front },
    { packageId: PACKAGES.nose, meshes: [], materials: SLOTS.nose },
    { packageId: PACKAGES.wheels, meshes: [], materials: SLOTS.wheels },
    { packageId: PACKAGES.internals, meshes: [], materials: SLOTS.internals },
    { packageId: PACKAGES.cabin, meshes: [], materials: SLOTS.cabin },
    {
      packageId: PACKAGES.robot,
      meshes: [],
      // Mechanism hardware slots without a finished Pack of their own take the shared scheme.
      materials: {
        ...SLOTS.robot,
        frame: 'material/gt-frame',
        pin: 'material/gt-metal-steel',
        rim: 'material/gt-metal',
        rubber: 'material/gt-primer',
        primer: 'material/gt-primer',
      },
    },
  ],
};

export const MECH_GT_SUBJECTS: readonly ShowSubjectSource[] = [MECH_GT_CAR, TRANSFORM];

export const MECH_GT_SEGMENTS: readonly ShowSegment[] = [
  { subject: 0, kind: 'turntable', seconds: 12 },
  { subject: 1, kind: 'transform', seconds: 24 },
  // The forward clip ends on the robot.
  { subject: 1, kind: 'turntable', seconds: 12, form: 1 },
  { subject: 1, kind: 'explode', seconds: 9 },
  { subject: 1, kind: 'section', seconds: 9 },
];
