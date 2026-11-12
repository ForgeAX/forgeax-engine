import { type FaceSelector, type Model, model, type Point2, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-012: the thin-walled lower housing of a handheld device. A rounded
 * footprint with a vent band is extruded into a solid, the vent quads are inset
 * into slots, and `shell` hollows the solid to the wall thickness with the top and
 * the slots as rimmed openings. The top rim gets a tongue lip, `bisect` planes cut
 * the inner floor into pads that grow into screw bosses with drilled holes and a
 * stiffening rib. Straight-line code: tools map every journal entry to its line.
 */
export interface HousingParameters {
  /** Wall thickness of the shell (meters). */
  readonly wall: number;
  /** Number of vent slots on the front wall. */
  readonly vents: number;
}

export const HOUSING_DEFAULTS: HousingParameters = { wall: 0.002, vents: 5 };

const LENGTH = 0.14;
const DEPTH = 0.08;
const HEIGHT = 0.032;
const CORNER = 0.012;
const SLOT = 0.006;
/** Half extents of the boss pads' centres on the floor. */
const BOSS_X = 0.052;
const BOSS_Z = 0.026;
const BOSS = 0.0045;
const RIB = 0.0009;

/**
 * Footprint in the extrusion plane, counter-clockwise: rounded corners and a front
 * edge (outline -y, world +z after the rotation) split into slot and gap columns.
 */
export function footprint(vents: number): Point2[] {
  const hx = LENGTH / 2;
  const hy = DEPTH / 2;
  const points: Point2[] = [];
  const arc = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = ((from + i * 22.5) * Math.PI) / 180;
      points.push([cx + CORNER * Math.cos(a), cy + CORNER * Math.sin(a)]);
    }
  };
  arc(-hx + CORNER, -hy + CORNER, 180);
  const span = vents * SLOT * 2 - SLOT;
  for (let i = 0; i < vents; i++) {
    const x0 = -span / 2 + i * 2 * SLOT;
    points.push([x0, -hy], [x0 + SLOT, -hy]);
  }
  arc(hx - CORNER, -hy + CORNER, 270);
  arc(hx - CORNER, hy - CORNER, 0);
  arc(-hx + CORNER, hy - CORNER, 90);
  return points;
}

/** Front-wall quads of the middle row that become vent slots. */
export function ventFaces(vents: number): FaceSelector {
  const span = vents * SLOT * 2 - SLOT;
  let faces: FaceSelector | undefined;
  for (let i = 0; i < vents; i++) {
    const x0 = -span / 2 + i * 2 * SLOT;
    const slot = sel.inBox([x0 - 1e-6, HEIGHT / 3 - 1e-6, DEPTH / 2 - 1e-6], [x0 + SLOT + 1e-6, (2 * HEIGHT) / 3 + 1e-6, DEPTH / 2 + 1e-6]);
    faces = faces === undefined ? slot : faces.or(slot);
  }
  return (faces as FaceSelector).and(sel.facing('+z', 1));
}

function pad(x: number, z: number, y: number): FaceSelector {
  return sel.inBox([x - BOSS - 1e-6, y - 1e-6, z - BOSS - 1e-6], [x + BOSS + 1e-6, y + 1e-6, z + BOSS + 1e-6]);
}

export function buildHousing(
  p: HousingParameters = HOUSING_DEFAULTS,
  session: SessionFactory = () => model(),
): Model {
  const floor = p.wall;
  const bosses = pad(-BOSS_X, -BOSS_Z, floor).or(pad(BOSS_X, -BOSS_Z, floor)).or(pad(-BOSS_X, BOSS_Z, floor)).or(pad(BOSS_X, BOSS_Z, floor));
  const rib = sel.inBox([-BOSS_X + BOSS, floor - 1e-6, -RIB - 1e-6], [BOSS_X - BOSS, floor + 1e-6, RIB + 1e-6]);
  const interior = sel.createdBy('wall', 'inner').and(sel.facing('+y', 1));
  const top = sel.inBox([-1, HEIGHT - 1e-6, -1], [1, HEIGHT + 1e-6, 1]);

  const m = session('housing');
  // Body: the footprint extruded in three rows, stood up so the height runs along +Y.
  m.extrudePolygon({ points: footprint(p.vents), depth: HEIGHT, steps: 3, label: 'body', tag: 'housing' });
  m.rotate(sel.all(), 'x', -90);
  m.checkpoint('solid');
  // Vents: the middle-row front quads framed by an inset; their inner faces become slots.
  m.inset(ventFaces(p.vents), { thickness: 0.0009, region: 'perFace', label: 'vent' });
  // Shell: hollow to the wall thickness; the top cap and the slot faces become openings.
  m.shell(sel.all(), { thickness: p.wall, open: sel.createdBy('body', 'top').or(sel.createdBy('vent', 'inner')), label: 'wall' });
  m.checkpoint('shelled');
  // Lip: the middle of the top rim rises into a tongue that locates the lid.
  m.inset(sel.createdBy('wall', 'rim').and(top), { thickness: p.wall * 0.3, region: 'merged', label: 'lip' });
  m.extrude(sel.createdBy('lip', 'inner'), { distance: 0.0025, region: 'merged', label: 'lip-up' });
  // Floor pads: bisect planes cut the inner floor into boss pads and a rib strip.
  m.bisect({ point: [-BOSS_X - BOSS, 0, 0], normal: [1, 0, 0] });
  m.bisect({ point: [-BOSS_X + BOSS, 0, 0], normal: [1, 0, 0] });
  m.bisect({ point: [BOSS_X - BOSS, 0, 0], normal: [1, 0, 0] });
  m.bisect({ point: [BOSS_X + BOSS, 0, 0], normal: [1, 0, 0] });
  m.bisect({ point: [0, 0, -BOSS_Z - BOSS], normal: [0, 0, 1] });
  m.bisect({ point: [0, 0, -BOSS_Z + BOSS], normal: [0, 0, 1] });
  m.bisect({ point: [0, 0, BOSS_Z - BOSS], normal: [0, 0, 1] });
  m.bisect({ point: [0, 0, BOSS_Z + BOSS], normal: [0, 0, 1] });
  m.bisect({ point: [0, 0, -RIB], normal: [0, 0, 1] });
  m.bisect({ point: [0, 0, RIB], normal: [0, 0, 1] });
  m.checkpoint('pads');
  // Bosses: the four pads rise into posts, framed and drilled for screws.
  m.extrude(interior.and(bosses), { distance: 0.016, region: 'perFace', label: 'boss' });
  m.inset(sel.createdBy('boss', 'top'), { thickness: 0.0016, region: 'perFace', label: 'boss-ring' });
  m.extrude(sel.createdBy('boss-ring', 'inner'), { distance: -0.012, region: 'perFace', label: 'screw' });
  // Rib: the strip between the bosses stands up as a stiffener across the floor.
  m.extrude(interior.and(rib), { distance: 0.008, region: 'merged', label: 'rib' });
  m.checkpoint('ribbed');
  m.markSharp(sel.edges.dihedral('>', 40));
  m.assign(sel.createdBy('wall', 'inner').or(sel.createdBy('boss')).or(sel.createdBy('boss-ring')).or(sel.createdBy('screw')).or(sel.createdBy('rib')), 'interior');
  m.assign(sel.createdBy('lip-up'), 'lip');
  m.uv.project({ mode: 'box', scale: 0.05 });
  return m;
}
