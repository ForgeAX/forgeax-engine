import type { ShowSegment } from './director.ts';
import type { ShowSubjectSource } from './subjects.ts';

/**
 * F2 (case C-200, maid-whale): the whole low-poly character of the G6 faceting stage of
 * forgeax-modeling `examples/maid-whale` (`mesh/maid-whale-faceted`, a modeling-mesh-job
 * cook source). The mesh publishes no materials; its slots take the reference sheet colors
 * (linear, `reference.json` palette).
 */
export const MAID_WHALE: ShowSubjectSource = {
  name: 'maid-whale',
  source: 'maid-whale: g6-faceted.pack, G6_JOB (faceting of the G5 assembly)',
  packs: [{ packageId: '01900000-0000-7000-8000-0000000c2016', meshes: ['mesh/maid-whale-faceted'] }],
  palette: {
    skin: { color: [0.9734, 0.7084, 0.5271], roughness: 0.6 },
    hair: { color: [0.0563, 0.1776, 0.448], roughness: 0.45 },
    navy: { color: [0.0284, 0.0482, 0.162], roughness: 0.6 },
    white: { color: [0.9131, 0.855, 0.8308], roughness: 0.7 },
    shoe: { color: [0.0091, 0.016, 0.0452], roughness: 0.35 },
    gem: { color: [0.0319, 0.3095, 0.5029], roughness: 0.15 },
    gold: { color: [0.1144, 0.0704, 0.0319], metallic: 1, roughness: 0.3 },
    ribbon: { color: [0.1912, 0.4508, 0.6724], roughness: 0.5 },
  },
};

export const MAID_WHALE_SEGMENTS: readonly ShowSegment[] = [{ subject: 0, kind: 'turntable', seconds: 16 }];

const G7_PACK = '01900000-0000-7000-8000-0000000c2020';
const G7_PARTS = [
  'mesh/maid-whale-g7.apron',
  'mesh/maid-whale-g7.arm-l',
  'mesh/maid-whale-g7.arm-r',
  'mesh/maid-whale-g7.back-bow',
  'mesh/maid-whale-g7.bodice',
  'mesh/maid-whale-g7.bowtie',
  'mesh/maid-whale-g7.brooch',
  'mesh/maid-whale-g7.fin-l',
  'mesh/maid-whale-g7.fin-r',
  'mesh/maid-whale-g7.hair',
  'mesh/maid-whale-g7.head',
  'mesh/maid-whale-g7.headdress',
  'mesh/maid-whale-g7.leg-l',
  'mesh/maid-whale-g7.leg-r',
  'mesh/maid-whale-g7.rest',
  'mesh/maid-whale-g7.ribbon-l',
  'mesh/maid-whale-g7.ribbon-r',
  'mesh/maid-whale-g7.shoe-l',
  'mesh/maid-whale-g7.shoe-r',
  'mesh/maid-whale-g7.skirt',
  'mesh/maid-whale-g7.tail',
  'mesh/maid-whale-g7.torso'
];
const G7_SLOTS = ['apron-front', 'face', 'gem', 'gold', 'hair', 'hair-0', 'hair-1', 'hair-2', 'hair-3', 'hair-4', 'hair-5', 'navy', 'ribbon', 'shoe', 'skin', 'tail', 'tail-underside', 'white'];

/**
 * F2 G7 face figure: the cooked assets job of forgeax-modeling `examples/maid-whale/g7-face.pack`.
 * The figure shows as its per-part meshes (they cover the whole mesh once; the whole mesh is not
 * listed so nothing overlaps) with the job's own `material/<slot>` materials (palette, hair ombre,
 * tail, the face decal on uv1 and the apron emblem).
 */
export const MAID_WHALE_G7: ShowSubjectSource = {
  name: 'maid-whale-g7',
  source: 'maid-whale-g7: g7-face.pack, G7_JOB (assets job maid-whale.g7-face)',
  packs: [
    {
      packageId: G7_PACK,
      meshes: G7_PARTS,
      materials: Object.fromEntries(G7_SLOTS.map((slot) => [slot, `material/${slot}`])),
    },
  ],
};

export const MAID_WHALE_G7_SEGMENTS: readonly ShowSegment[] = [{ subject: 0, kind: 'turntable', seconds: 16 }];
