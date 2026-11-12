import { type Model, model, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-113: artist editing tools on a garment, structure first. A mannequin torso is
 * revolved and shaped with a symmetric soft move; the bodice is a layer over the torso
 * band; a flared skirt is wrapped onto the hips at its waist band and blends free below;
 * a V-neck panel is knife-projected into the bodice and recessed; a side seam is cut
 * along the skirt surface. The code is straight-line: tools map every journal entry
 * back to the call on its source line.
 */
export const TUNIC = {
  /** Torso profile `[radius, y]`, bottom to top. */
  profile: [
    [0, 0],
    [0.115, 0.01],
    [0.135, 0.09],
    [0.112, 0.2],
    [0.128, 0.3],
    [0.105, 0.375],
    [0.05, 0.415],
    [0.045, 0.48],
    [0, 0.48],
  ] as [number, number][],
  /** Cloth clearance over the body and wall thickness (meters). */
  gap: 0.004,
  wall: 0.002,
  /** V-neck outline in the front view (x, y), knife-projected along -z. */
  neckline: [
    [-0.055, 0.37],
    [0, 0.28],
    [0.055, 0.37],
  ] as [number, number][],
} as const;

export function buildTunic(session: SessionFactory = () => model()): Model {
  const m = session('tunic');
  // Body: a revolved torso, its chest moved forward by a symmetric soft selection.
  m.revolve({ points: TUNIC.profile, segments: 32, tag: 'body' });
  m.translate(sel.tag('body').and(sel.near([0.06, 0.3, 0.11], 6)), [0, 0.006, 0.018], {
    falloff: { radius: 0.07, curve: 'smooth', distance: 'connected' },
    symmetry: 'x',
  });
  // Bodice: a layer over the torso band, a constant gap and a 2 mm wall.
  m.layer(sel.tag('body').and(sel.inBox([-1, 0.17, -1], [1, 0.37, 1], { by: 'centroid' })), {
    offset: TUNIC.gap,
    thickness: TUNIC.wall,
    conform: true,
    label: 'bodice',
    tag: 'dress',
    material: 'cloth',
  });
  // Skirt: a flared open tube, its waist band wrapped onto the hips, free below.
  m.cylinder({
    radiusTop: 0.15,
    radiusBottom: 0.21,
    height: 0.2,
    radialSegments: 32,
    heightSegments: 10,
    openEnded: true,
    center: [0, 0.075, 0],
    tag: 'skirt',
    material: 'cloth',
  });
  m.shrinkwrap(sel.tag('skirt').and(sel.inBox([-1, 0.155, -1], [1, 1, 1], { by: 'any' })), {
    onto: sel.tag('body'),
    offset: TUNIC.gap,
    falloff: { radius: 0.07, distance: 'connected' },
  });
  // V-neck: a closed outline projected onto the visible bodice, then recessed as a panel.
  m.knife({
    points: TUNIC.neckline.map(([x, y]) => [x, y, 1] as [number, number, number]),
    direction: [0, 0, -1],
    closed: true,
    sharp: true,
    faces: sel.tag('dress'),
    label: 'neckline',
    tag: 'trim',
  });
  m.extrude(sel.createdBy('neckline', 'inside'), { distance: -0.0012, region: 'merged' });
  // Side seam along the skirt surface, a UV seam and a hard edge.
  m.knife({
    points: [
      [0.155, 0.16, 0.03],
      [0.17, 0.11, 0.035],
      [0.185, 0.06, 0.04],
      [0.2, 0.0, 0.045],
    ],
    seam: true,
    sharp: true,
    faces: sel.tag('skirt'),
    label: 'seam',
  });
  m.uv.project({ mode: 'cylinder', axis: 'y', scale: 1 });
  return m;
}
