import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { type Model, model, sel } from '@forgeax/engine-modeling';
import { BOARD, LANDMARK, part, REF } from './reference.ts';

/** Gauge plates: one thin plate per body landmark, spanning the figure in X and Z. */
const PLATE = { width: 0.66, depth: 0.5, thickness: 0.003 } as const;
const BODY_LANDMARKS = [
  'sole-top',
  'sock-top',
  'hem',
  'hem-band-top',
  'apron-bottom',
  'wrist',
  'waist',
  'shoulder',
  'chin',
  'eye-line',
  'crown',
  'headdress-top',
  'ahoge-tip',
] as const;

/**
 * Case C-200 stage G1 (calibration): the measured reference as a gauge. The board
 * carries the three silhouettes and the landmark dimensions; the mesh is a ground
 * plate, one landmark plate per height and a head-unit ruler (crown to chin) beside
 * the figure, so ortho renders show the calibration against the silhouettes.
 */
export function buildCalibration(): Model {
  const m = model();
  m.drawing(BOARD);
  m.box({ size: [PLATE.width, PLATE.thickness, PLATE.depth], center: [0, -PLATE.thickness / 2, 0], tag: 'ground', material: 'ground' });
  m.checkpoint('ground');
  for (const name of BODY_LANDMARKS) {
    const v = LANDMARK[name] as number;
    m.box({ size: [PLATE.width, PLATE.thickness, PLATE.depth], center: [0, v, 0], tag: `landmark-${name}`, material: 'gauge' });
  }
  m.checkpoint('landmarks');
  const head = REF.proportions.headHeight;
  const units = Math.ceil((LANDMARK.crown as number) / head);
  for (let i = 0; i < units; i++) {
    const top = Math.min((LANDMARK.crown as number) - i * head, LANDMARK.crown as number);
    const bottom = Math.max(top - head, 0);
    m.box({
      size: [0.02, top - bottom - 0.004, 0.02],
      center: [-0.4, (top + bottom) / 2, 0],
      tag: 'head-unit',
      material: i % 2 === 0 ? 'unit-a' : 'unit-b',
    });
  }
  m.checkpoint('head-units');
  // Tail reach marker on the ground behind the figure (side view depth).
  const reach = part('right', 'tail').bounds[2];
  m.box({ size: [0.02, 0.006, reach], center: [0.3, 0.0045, -reach / 2], tag: 'tail-reach', material: 'gauge' });
  m.markSharp(sel.edges.dihedral('>', 40));
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000c2001'),
  build: () => buildCalibration().finish({ key: 'maid-whale-g1', normals: { mode: 'weighted' } }),
});
