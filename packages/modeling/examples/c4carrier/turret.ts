import { type Model, model, type Point2, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';
import { check, edgeDistances, offsetEdges, section, sector, stadiumSection } from './kit.ts';
import {
  APRON,
  BARREL_SHAPE,
  BARREL_X,
  BRAKE_PORTS,
  BREECH_Z,
  RECOIL_CYLINDER,
  MANTLET,
  PLAN_BASE,
  PLAN_ROOF,
  RING_RADIUS,
  SLEEVE_BORE,
  SLEEVE_FROM,
  SLEEVE_RADIUS,
  TRUNNION,
  WINDOW,
} from './proportions.ts';

export interface TurretParameters {
  /** Round of every hard edge of the house (meters). */
  readonly edgeRound: number;
  /** Armor wall of the house (meters). */
  readonly wall: number;
  /** Segments around the round parts. */
  readonly segments: number;
  /**
   * What happens to the `detail` solids: `weld` unions them into their host (the rig and clearance scans read one
   * closed body per part), `float` keeps added ones as separate floating shells of the high (normal-only in the bake;
   * cuts stay real cuts), `omit` leaves them out (the game low is the form alone). The kernel's boolean `details`
   * option does all three on the faces marked `detail`.
   */
  readonly details: 'weld' | 'float' | 'omit';
}

export const TURRET_DEFAULTS: TurretParameters = { edgeRound: 0.15, wall: 0.5, segments: 32, details: 'weld' };

/**
 * What every named session is for. `form` solids make up the rigid body (booleans merge them into one connected
 * surface); `tool` solids shape a form (cutters, blank profiles); `detail` solids are bolts, vents, hatches,
 * markings and recesses that the low leaves to the bake. SSOT of the source layering: the low drops every join of a
 * `detail` solid, tools and viewers read the same table.
 */
export type SessionRole = 'form' | 'detail' | 'tool';
export const SESSION_ROLES: Readonly<Record<string, SessionRole>> = {
  barbette: 'form', house: 'form', 'roof-plate': 'form', blocks: 'form', hood: 'form', skirt: 'form', bustle: 'form',
  cradle: 'form', pin: 'form', mantlet: 'form', boss: 'form', 'recoil-cylinder': 'form', apron: 'form', barrel: 'form', turret: 'form',
  cavity: 'tool', wedge: 'tool', seat: 'tool', bore: 'tool', slots: 'tool', muzzle: 'tool',
  studs: 'detail', hatches: 'detail', knuckles: 'detail', vision: 'detail', recess: 'detail', lid: 'detail', grip: 'detail',
  legs: 'detail', hinges: 'detail', slit: 'detail', pad: 'detail', ring: 'detail', rivets: 'detail', vents: 'detail',
  'skirt-bolts': 'detail', bvents: 'detail', 'number-plate': 'detail', stem: 'detail', flag: 'detail', foot: 'detail',
  'mantlet-bolts': 'detail', 'mantlet-bolts-low': 'detail', gland: 'detail', cbore: 'detail', ports: 'detail', rods: 'detail', brackets: 'detail',
};

const FLOOR = 0.1;
const [, TY, TZ] = TRUNNION;

/**
 * Heavy twin turret of case C-600, every part a closed solid in the turret frame (Y up, the
 * barrels toward +Z, ring plane y = 0, trunnion axis X through (y, z) = (3, 4.5)). Straight-line
 * code: tools map every journal entry to its line, so every kernel call is written out and
 * every part is a named session.
 */
export function buildTurret(p: TurretParameters = TURRET_DEFAULTS, sessions: SessionFactory = () => model()): Model {
  const roles = new Map<Model, SessionRole>();
  const session: SessionFactory = (name) => {
    const role = SESSION_ROLES[name];
    if (role === undefined) throw new Error(`session '${name}' has no role in SESSION_ROLES`);
    const m = sessions(name);
    roles.set(m, role);
    return m;
  };
  // Detail sessions carry the kernel part role; the join option does weld / float / omit.
  const marked = new Set<Model>();
  const join = (host: Model, op: 'union' | 'difference', other: Model, options: Parameters<Model['union']>[1], what: string): void => {
    for (const m of [host, other]) {
      if (roles.get(m) !== 'detail' || marked.has(m)) continue;
      marked.add(m);
      check(m.markRole(sel.all(), 'detail'), `${what} detail role`);
    }
    check(host[op](other, { ...options, details: p.details }), what);
  };
  const R = RING_RADIUS;
  const total = edgeDistances(PLAN_BASE, PLAN_ROOF);
  const T = [0, 0.05, 0.5, 0.93, 1];
  const ys = [0, 1.4, 4.2, 6.4, 7].map((y) => y + FLOOR);
  const inside = [-0.2, 1.4, 4.2, 6.4, 6.6].map((y) => y + FLOOR);

  // Barbette: the fixed cup, deck ring collar and bolted shelf below the deck, raised roller-path rail, bolt ring and inspection hatches.
  const barbette = session('barbette');
  check(barbette.revolve({ points: [[0, -4.6], [R + 0.9, -4.6], [R + 0.9, -3.0], [R + 0.5, -3.0], [R + 0.5, -2.3], [R + 0.2, -2.0], [R, -1.85], [R, 0], [R - 0.25, 0], [R - 0.25, 0.06], [R - 0.75, 0.06], [R - 0.75, 0], [R - 1, 0], [R - 1, -4.0], [0, -4.0]], segments: 72, label: 'ring', tag: 'barbette' }), 'barbette');
  check(barbette.assign(sel.all(), 'plate'));
  check(barbette.assign(sel.facing('+y', 1).and(sel.inBox([-R, 0.03, -R], [R, 0.1, R])), 'steel'));
  check(barbette.assign(sel.facing('+y', 1).and(sel.inBox([-R - 1, -3.05, -R - 1], [R + 1, -2.95, R + 1])), 'hazard'));
  const studs = session('studs');
  check(studs.cylinder({ radiusTop: 0.16, radiusBottom: 0.16, height: 0.3, radialSegments: 8, center: [0, -2.88, R + 0.7], label: 'stud' }), 'shelf stud');
  check(studs.assign(sel.all(), 'steel'));
  check(studs.array(sel.all(), { radial: { count: 36, axis: 'y', center: [0, 0, 0] }, label: 'studs' }), 'bolt ring');
  join(barbette, 'union', studs, { label: 'bolt-ring', tag: 'barbette' }, 'barbette bolts');
  const hatches = session('hatches');
  check(hatches.box({ size: [1.4, 1.0, 0.24], center: [0, -0.95, R + 0.08], label: 'hatch-plate' }), 'inspection hatch');
  check(hatches.assign(sel.all(), 'armor'));
  const knuckles = session('knuckles');
  check(knuckles.cylinder({ radiusTop: 0.08, radiusBottom: 0.08, height: 0.9, radialSegments: 8, center: [-0.8, -0.95, R + 0.22], label: 'knuckle' }), 'hatch hinge');
  check(knuckles.array(sel.all(), { linear: { count: 2, offset: [1.6, 0, 0] }, label: 'knuckles' }), 'hinge pair');
  check(knuckles.assign(sel.all(), 'steel'));
  join(hatches, 'union', knuckles, { label: 'hinges' }, 'hatch hinges');
  check(hatches.array(sel.all(), { radial: { count: 8, axis: 'y', center: [0, 0, 0] }, label: 'hatch-ring' }), 'hatch ring');
  join(barbette, 'union', hatches, { label: 'inspection-hatches', tag: 'barbette' }, 'barbette hatches');

  // House: a lofted faceted hull minus its inner hull, then the gun window around the trunnion.
  const house = session('house');
  check(house.loft({ profiles: ys.map((y, i) => section(PLAN_BASE, total, T[i] as number, y)), match: 'index', label: 'hull', tag: 'house' }), 'house hull');
  const cavity = session('cavity');
  check(cavity.loft({ profiles: inside.map((y, i) => offsetEdges(section(PLAN_BASE, total, T[i] as number, 0).map(([x, , z]) => [x, z] as Point2), PLAN_BASE.map(() => p.wall)).map(([x, z]) => [x, y, z] as [number, number, number])), match: 'index', label: 'cavity' }), 'cavity');
  join(house, 'difference', cavity, { label: 'cavity' }, 'house cavity');
  const wedge = session('wedge');
  check(wedge.extrudePolygon({ points: sector([TZ, TY], 0, 40, WINDOW.from, WINDOW.to, 24), depth: 2 * WINDOW.halfWidth, label: 'wedge' }), 'window wedge');
  check(wedge.rotate(sel.all(), 'y', -90));
  check(wedge.translate(sel.all(), [WINDOW.halfWidth, 0, 0]));
  join(house, 'difference', wedge, { label: 'window' }, 'window');
  check(house.bevel(sel.createdBy('hull').toEdges('contained').and(sel.edges.dihedral('>', 20)), { width: p.edgeRound, segments: 2, label: 'edge-round' }), 'house bevel');
  check(house.assign(sel.all(), 'armor'));

  // Raised roof plate: inset roof outline extruded over the roof, chamfered once.
  const ROOF_Y = FLOOR + 7;
  const PLATE_TOP = ROOF_Y + 0.35;
  const plate = session('roof-plate');
  check(plate.extrudePolygon({ points: offsetEdges(PLAN_ROOF, PLAN_ROOF.map(() => 0.6)), depth: PLATE_TOP - (ROOF_Y - 0.1), label: 'roof-plate' }), 'roof-plate');
  check(plate.rotate(sel.all(), 'x', 90));
  check(plate.translate(sel.all(), [0, PLATE_TOP, 0]));
  check(plate.bevel(sel.all().toEdges('contained').and(sel.edges.dihedral('>', 30)), { width: 0.12, segments: 1, label: 'plate-chamfer' }), 'roof plate chamfer');
  check(plate.assign(sel.all(), 'plate'));
  join(house, 'union', plate, { label: 'roof-plate', tag: 'house' }, 'roof plate union');
  if (p.details !== 'omit') {
    check(house.panelLine({ faces: sel.tag('house').and(sel.facing('+y', 5)).and(sel.inBox([-9, PLATE_TOP - 0.05, -9], [9, PLATE_TOP + 0.05, 9])), point: [0, 0, 1.2], normal: [0, 0, 1] }, { width: 0.05, depth: 0.04, label: 'roof-seam', material: 'frame' }), 'roof seam');
  }

  // Trunnion bearing blocks bored for the pin.
  const blocks = session('blocks');
  check(blocks.box({ size: [2.7, 2.2, 2.4], center: [5.65, TY, TZ], label: 'bearing' }), 'bearing block');
  check(blocks.array(sel.all(), { linear: { count: 2, offset: [-11.3, 0, 0] }, label: 'bearings' }), 'bearing pair');
  const seat = session('seat');
  check(seat.cylinder({ radiusTop: 0.95, radiusBottom: 0.95, height: 14, radialSegments: p.segments, center: [0, TY, TZ] }), 'pin seat');
  check(seat.rotate(sel.all(), 'z', 90, [0, TY, TZ]));
  join(blocks, 'difference', seat, { label: 'seat' }, 'bearing seats');
  check(blocks.assign(sel.all(), 'armor'));
  join(house, 'union', blocks, { label: 'bearing-blocks', tag: 'house' }, 'house bearings');

  // Vision ports on the side walls.
  const eyes = session('vision');
  check(eyes.box({ size: [5, 0.42, 1.3], center: [7.4, 5.1, -1.5], label: 'vision-port' }), 'vision port');
  check(eyes.array(sel.all(), { linear: { count: 2, offset: [0, 0, -3.4] }, label: 'vision-ports' }), 'vision port row');
  check(eyes.array(sel.all(), { linear: { count: 2, offset: [-14.8, 0, 0] }, label: 'vision-sides' }), 'vision port pair');
  join(house, 'difference', eyes, { label: 'vision', material: 'glass', onPartial: 'accept' }, 'vision ports');

  // Roof hatch on the plate: hazard recess, plate lid with handle and two hinge barrels.
  const recess = session('recess');
  check(recess.box({ size: [2.8, 0.3, 2.8], center: [-2.6, PLATE_TOP, -3], label: 'recess' }), 'hatch recess');
  join(house, 'difference', recess, { label: 'hatch-recess', material: 'hazard' }, 'hatch recess cut');
  const lid = session('lid');
  check(lid.box({ size: [2.64, 0.26, 2.64], center: [-2.6, PLATE_TOP - 0.07, -3], label: 'lid' }), 'hatch lid');
  check(lid.assign(sel.all(), 'plate'));
  const grip = session('grip');
  check(grip.box({ size: [1.0, 0.1, 0.12], center: [-2.6, PLATE_TOP + 0.34, -2.4], label: 'grip' }), 'hatch grip');
  const legs = session('legs');
  check(legs.box({ size: [0.1, 0.22, 0.12], center: [-3.05, PLATE_TOP + 0.2, -2.4], label: 'grip-leg' }), 'grip leg');
  check(legs.array(sel.all(), { linear: { count: 2, offset: [0.9, 0, 0] }, label: 'grip-legs' }), 'grip legs');
  join(grip, 'union', legs, { label: 'grip-legs' }, 'grip assembly');
  check(grip.assign(sel.all(), 'steel'));
  join(lid, 'union', grip, { label: 'handle' }, 'lid handle');
  join(house, 'union', lid, { label: 'hatch', tag: 'house' }, 'hatch lid fit');
  const hinges = session('hinges');
  check(hinges.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.5, radialSegments: 10, center: [-3.4, PLATE_TOP - 0.02, -4.36], label: 'hinge' }), 'hatch hinge');
  check(hinges.rotate(sel.all(), 'z', 90, [-3.4, PLATE_TOP - 0.02, -4.36]));
  check(hinges.array(sel.all(), { linear: { count: 2, offset: [1.6, 0, 0] }, label: 'hinges' }), 'hatch hinge pair');
  check(hinges.assign(sel.all(), 'steel'));
  join(house, 'union', hinges, { label: 'hatch-hinges', tag: 'house' }, 'hatch hinges fit');

  // Two armored sight hoods with a glass slit on the sloped front.
  const hood = session('hood');
  check(hood.extrudePolygon({ points: [[-0.75, 0], [0.75, 0], [0.75, 0.3], [0.3, 0.78], [-0.75, 0.78]], depth: 0.75 - (-0.75), label: 'hood' }), 'hood');
  check(hood.rotate(sel.all(), 'y', -90));
  check(hood.translate(sel.all(), [0.75, 0, 0]));
  const slit = session('slit');
  check(slit.box({ size: [1.0, 0.18, 0.35], center: [0, 0.54, 0.6], label: 'slit' }), 'sight slit');
  join(hood, 'difference', slit, { label: 'sight', material: 'glass' }, 'sight slit cut');
  check(hood.bevel(sel.createdBy('hood').toEdges('contained').and(sel.edges.dihedral('>', 30)), { width: 0.06, segments: 1, label: 'hood-chamfer' }), 'hood chamfer');
  check(hood.translate(sel.all(), [3.2, PLATE_TOP - 0.1, 2.8]));
  check(hood.array(sel.all(), { linear: { count: 2, offset: [-6.4, 0, 0] }, label: 'hoods' }), 'hood pair');
  join(house, 'union', hood, { label: 'sight-hoods', tag: 'house' }, 'sight hoods fit');

  // Lifting eyes: pad and ring on each roof corner.
  const pad = session('pad');
  check(pad.cylinder({ radiusTop: 0.32, radiusBottom: 0.32, height: 0.16, radialSegments: 16, center: [4.2, PLATE_TOP, -4.6], label: 'eye-pad' }), 'eye pad');
  const ring = session('ring');
  check(ring.torus({ radius: 0.2, tube: 0.055, radialSegments: 10, tubularSegments: 16, center: [4.2, PLATE_TOP + 0.25, -4.6], label: 'eye-ring' }), 'eye ring');
  join(pad, 'union', ring, { label: 'eye' }, 'lifting eye');
  check(pad.assign(sel.all(), 'steel'));
  check(pad.array(sel.all(), { linear: { count: 2, offset: [0, 0, 8] }, label: 'eye-pair' }), 'eye pair');
  check(pad.array(sel.all(), { linear: { count: 2, offset: [-8.4, 0, 0] }, label: 'eyes' }), 'eye quad');
  join(house, 'union', pad, { label: 'lifting-eyes', tag: 'house' }, 'lifting eyes fit');

  // Rivet rows along both long edges of the roof plate.
  const rivets = session('rivets');
  check(rivets.cylinder({ radiusTop: 0.09, radiusBottom: 0.09, height: 0.12, radialSegments: 8, center: [4.9, PLATE_TOP + 0.03, -4.8], label: 'rivet' }), 'rivet');
  check(rivets.array(sel.all(), { linear: { count: 9, offset: [0, 0, 0.9] }, label: 'rivet-row' }), 'rivet row');
  check(rivets.array(sel.all(), { linear: { count: 2, offset: [-9.8, 0, 0] }, label: 'rivet-rows' }), 'rivet rows');
  check(rivets.assign(sel.all(), 'trim'));
  join(house, 'union', rivets, { label: 'roof-rivets', tag: 'house' }, 'roof rivets fit');

  // Side armor skirt step on the port wall, vent grilles and rivets, mirrored to starboard.
  const skirt = session('skirt');
  check(skirt.extrudePolygon({ points: [[7.7, 0.3], [8.7, 0.3], [8.7, 1.3], [8.3, 1.75], [7.3, 1.75]], depth: 6.5 - (-7), label: 'skirt' }), 'skirt');
  check(skirt.translate(sel.all(), [0, 0, -7]));
  check(skirt.bevel(sel.createdBy('skirt').toEdges('contained').and(sel.edges.dihedral('>', 30)), { width: 0.08, segments: 1, label: 'skirt-chamfer' }), 'skirt chamfer');
  check(skirt.assign(sel.all(), 'plate'));
  const vents = session('vents');
  check(vents.box({ size: [0.5, 0.2, 0.7], center: [8.55, 0.62, -5.8], label: 'vent' }), 'vent slot');
  check(vents.array(sel.all(), { linear: { count: 2, offset: [0, 0.34, 0] }, label: 'vent-rows' }), 'vent rows');
  check(vents.array(sel.all(), { linear: { count: 8, offset: [0, 0, 1.5] }, label: 'vent-row' }), 'vent columns');
  join(skirt, 'difference', vents, { label: 'vent-grille', material: 'vent' }, 'skirt vents');
  const skirtBolts = session('skirt-bolts');
  check(skirtBolts.cylinder({ radiusTop: 0.08, radiusBottom: 0.08, height: 0.14, radialSegments: 8, center: [8.73, 1.1, -6.5], label: 'skirt-bolt' }), 'skirt bolt');
  check(skirtBolts.rotate(sel.all(), 'z', 90, [8.73, 1.1, -6.5]));
  check(skirtBolts.array(sel.all(), { linear: { count: 14, offset: [0, 0, 1.0] }, label: 'skirt-bolt-row' }), 'skirt bolt row');
  check(skirtBolts.assign(sel.all(), 'trim'));
  join(skirt, 'union', skirtBolts, { label: 'skirt-bolts' }, 'skirt bolts fit');
  check(skirt.mirror({ axis: 'x' }), 'skirt mirror');
  join(house, 'union', skirt, { label: 'skirts', tag: 'house' }, 'skirts fit');

  // Rear bustle overhang with a vent grille.
  const bustle = session('bustle');
  check(bustle.extrudePolygon({ points: [[-6.7, 6.2], [-10.9, 5.6], [-11.2, 2.8], [-10.6, 1.0], [-9.3, 1.0]], depth: 4.4 - (-4.4), label: 'bustle' }), 'bustle');
  check(bustle.rotate(sel.all(), 'y', -90));
  check(bustle.translate(sel.all(), [4.4, 0, 0]));
  check(bustle.bevel(sel.createdBy('bustle').toEdges('contained').and(sel.edges.dihedral('>', 30)), { width: 0.1, segments: 1, label: 'bustle-chamfer' }), 'bustle chamfer');
  check(bustle.assign(sel.all(), 'plate'));
  const bvents = session('bvents');
  check(bvents.box({ size: [0.5, 0.14, 0.5], center: [-3, 3.4, -11.2], label: 'bustle-vent' }), 'bustle vent');
  check(bvents.array(sel.all(), { linear: { count: 4, offset: [0, 0.35, 0] }, label: 'bustle-vent-rows' }), 'bustle vent rows');
  check(bvents.array(sel.all(), { linear: { count: 6, offset: [1.2, 0, 0] }, label: 'bustle-vent-row' }), 'bustle vent columns');
  join(bustle, 'difference', bvents, { label: 'bustle-grille', material: 'vent' }, 'bustle vents');
  join(house, 'union', bustle, { label: 'bustle', tag: 'house' }, 'bustle fit');

  // Turret number: white plate on both side walls, the numeral 1 on the port wall.
  const xo = (y: number): number => 7.9 - (y - 1.5) * 0.3214;
  const board = session('number-plate');
  check(board.extrudePolygon({ points: [[xo(2.3) - 0.12, 2.3], [xo(2.3) + 0.05, 2.3], [xo(3.9) + 0.05, 3.9], [xo(3.9) - 0.12, 3.9]], depth: 1.0 - (-1.6), label: 'number-plate' }), 'number-plate');
  check(board.translate(sel.all(), [0, 0, -1.6]));
  check(board.assign(sel.all(), 'marking'));
  check(board.mirror({ axis: 'x' }), 'number plate mirror');
  join(house, 'union', board, { label: 'number-plates', tag: 'house' }, 'number plates fit');
  const stem = session('stem');
  check(stem.extrudePolygon({ points: [[xo(2.55), 2.55], [xo(2.55) + 0.09, 2.55], [xo(3.65) + 0.09, 3.65], [xo(3.65), 3.65]], depth: -0.15 - (-0.45), label: 'one-stem' }), 'one-stem');
  check(stem.translate(sel.all(), [0, 0, -0.45]));
  const flag = session('flag');
  check(flag.extrudePolygon({ points: [[xo(3.3), 3.3], [xo(3.3) + 0.09, 3.3], [xo(3.65) + 0.09, 3.65], [xo(3.65), 3.65]], depth: 0.2 - (-0.45), label: 'one-flag' }), 'one-flag');
  check(flag.translate(sel.all(), [0, 0, -0.45]));
  const foot = session('foot');
  check(foot.extrudePolygon({ points: [[xo(2.55), 2.55], [xo(2.55) + 0.09, 2.55], [xo(2.72) + 0.09, 2.72], [xo(2.72), 2.72]], depth: 0.15 - (-0.75), label: 'one-foot' }), 'one-foot');
  check(foot.translate(sel.all(), [0, 0, -0.75]));
  join(stem, 'union', flag, { label: 'one-flag' }, 'numeral flag');
  join(stem, 'union', foot, { label: 'one-foot' }, 'numeral foot');
  check(stem.assign(sel.all(), 'frame'));
  join(house, 'union', stem, { label: 'numeral', tag: 'house' }, 'numeral fit');

  // Cradle: one tapered stadium casting for both sleeves, bored for the barrels, with trunnion pins.
  const cradle = session('cradle');
  const z0 = BREECH_Z + SLEEVE_FROM[0];
  const z1 = BREECH_Z + SLEEVE_FROM[1];
  check(cradle.loft({ profiles: [[z0, SLEEVE_RADIUS], [z0 + 2.5, SLEEVE_RADIUS], [z1, 1.35]].map(([z, r]) => stadiumSection(BARREL_X, r as number, TY, z as number, 16)), match: 'index', label: 'casting', tag: 'cradle' }), 'cradle casting');
  const bore = session('bore');
  check(bore.cylinder({ radiusTop: SLEEVE_BORE, radiusBottom: SLEEVE_BORE, height: 12, radialSegments: p.segments, center: [BARREL_X, TY, z0 + 3] }), 'bore');
  check(bore.rotate(sel.all(), 'x', 90, [BARREL_X, TY, z0 + 3]));
  check(bore.array(sel.all(), { linear: { count: 2, offset: [-2 * BARREL_X, 0, 0] }, label: 'bores' }), 'bore pair');
  join(cradle, 'difference', bore, { label: 'bores' }, 'cradle bores');
  check(cradle.bevel(sel.createdBy('casting').toEdges('contained').and(sel.edges.dihedral('>', 25)), { width: 0.08, segments: 2, label: 'cradle-round' }), 'cradle bevel');
  const pin = session('pin');
  const stubX = (4.1 + 6.1) / 2;
  check(pin.cylinder({ radiusTop: 0.8, radiusBottom: 0.8, height: 6.1 - 4.1, radialSegments: p.segments, center: [stubX, TY, TZ], label: 'pin', tag: 'cradle' }), 'pin');
  check(pin.rotate(sel.all(), 'z', 90, [stubX, TY, TZ]));
  check(pin.array(sel.all(), { linear: { count: 2, offset: [-2 * stubX, 0, 0] }, label: 'pins' }), 'pin pair');

  // Mantlet: a closed annular-sector plate around the trunnion axis with a raised boss and bolt rows, slotted for the barrels.
  const mantlet = session('mantlet');
  check(mantlet.extrudePolygon({ points: sector([TZ, TY], MANTLET.radius - MANTLET.thickness, MANTLET.radius, -MANTLET.halfSpan, MANTLET.halfSpan, 20), depth: 2 * MANTLET.halfWidth, label: 'plate', tag: 'mantlet' }), 'mantlet plate');
  check(mantlet.rotate(sel.all(), 'y', -90));
  check(mantlet.translate(sel.all(), [MANTLET.halfWidth, 0, 0]));
  check(mantlet.bevel(sel.createdBy('plate').toEdges('contained').and(sel.edges.dihedral('>', 25)), { width: 0.06, segments: 2, label: 'mantlet-round' }), 'mantlet bevel');
  check(mantlet.assign(sel.all(), 'plate'));
  const boss = session('boss');
  check(boss.extrudePolygon({ points: sector([TZ, TY], MANTLET.radius - 0.1, MANTLET.boss.radius, -MANTLET.boss.halfSpan, MANTLET.boss.halfSpan, 16), depth: 2 * MANTLET.boss.halfWidth, label: 'boss' }), 'mantlet boss');
  check(boss.rotate(sel.all(), 'y', -90));
  check(boss.translate(sel.all(), [MANTLET.boss.halfWidth, 0, 0]));
  check(boss.bevel(sel.createdBy('boss').toEdges('contained').and(sel.edges.dihedral('>', 25)), { width: 0.08, segments: 1, label: 'boss-chamfer' }), 'boss chamfer');
  check(boss.assign(sel.all(), 'armor'));
  join(mantlet, 'union', boss, { label: 'boss', tag: 'mantlet' }, 'mantlet boss fit');
  const lugs = session('mantlet-bolts');
  const BOLT_A = 20;
  check(lugs.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.14, radialSegments: 8, center: [-3.9, TY, TZ + MANTLET.boss.radius + 0.03], label: 'mantlet-bolt' }), 'mantlet bolt');
  check(lugs.rotate(sel.all(), 'x', 90, [-3.9, TY, TZ + MANTLET.boss.radius + 0.03]));
  check(lugs.array(sel.all(), { linear: { count: 2, offset: [3.25, 0, 0] }, label: 'mantlet-bolt-left' }), 'mantlet bolt left');
  check(lugs.array(sel.all(), { linear: { count: 2, offset: [4.55, 0, 0] }, label: 'mantlet-bolt-pairs' }), 'mantlet bolt pairs');
  const lugsLow = session('mantlet-bolts-low');
  check(lugsLow.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 0.14, radialSegments: 8, center: [-3.9, TY, TZ + MANTLET.boss.radius + 0.03], label: 'mantlet-bolt' }), 'mantlet bolt low');
  check(lugsLow.rotate(sel.all(), 'x', 90, [-3.9, TY, TZ + MANTLET.boss.radius + 0.03]));
  check(lugsLow.array(sel.all(), { linear: { count: 2, offset: [3.25, 0, 0] }, label: 'mantlet-bolt-left' }), 'mantlet bolt left low');
  check(lugsLow.array(sel.all(), { linear: { count: 2, offset: [4.55, 0, 0] }, label: 'mantlet-bolt-pairs' }), 'mantlet bolt pairs low');
  check(lugs.rotate(sel.all(), 'x', -BOLT_A, [0, TY, TZ]));
  check(lugsLow.rotate(sel.all(), 'x', BOLT_A, [0, TY, TZ]));
  join(lugs, 'union', lugsLow, { label: 'mantlet-bolts' }, 'mantlet bolt rows');
  check(lugs.assign(sel.all(), 'trim'));
  join(mantlet, 'union', lugs, { label: 'mantlet-bolts', tag: 'mantlet' }, 'mantlet bolts fit');
  const slots = session('slots');
  check(slots.box({ size: [MANTLET.slotWidth, MANTLET.slotHeight, 8], center: [BARREL_X, TY, TZ + 3.3] }), 'slot');
  check(slots.array(sel.all(), { linear: { count: 2, offset: [-2 * BARREL_X, 0, 0] }, label: 'slots' }), 'slot pair');
  join(mantlet, 'difference', slots, { label: 'slots', material: 'frame' }, 'mantlet slots');
  // Recoil cylinders fixed on the mantlet above and below each barrel; the barrel rods slide in their bores.
  const rc = RECOIL_CYLINDER;
  const cyl = session('recoil-cylinder');
  check(cyl.cylinder({ radiusTop: rc.radius, radiusBottom: rc.radius, height: rc.to - rc.from, radialSegments: 16, center: [BARREL_X, TY + rc.offset, (rc.from + rc.to) / 2], label: 'recoil-cylinder' }), 'recoil cylinder');
  check(cyl.rotate(sel.all(), 'x', 90, [BARREL_X, TY + rc.offset, (rc.from + rc.to) / 2]));
  const gland = session('gland');
  check(gland.cylinder({ radiusTop: rc.radius + 0.08, radiusBottom: rc.radius + 0.08, height: 0.3, radialSegments: 16, center: [BARREL_X, TY + rc.offset, rc.to - 0.15], label: 'gland' }), 'recoil gland');
  check(gland.rotate(sel.all(), 'x', 90, [BARREL_X, TY + rc.offset, rc.to - 0.15]));
  join(cyl, 'union', gland, { label: 'gland' }, 'recoil gland fit');
  const cbore = session('cbore');
  check(cbore.cylinder({ radiusTop: rc.bore, radiusBottom: rc.bore, height: rc.to + 0.2 - rc.boreFrom, radialSegments: 16, center: [BARREL_X, TY + rc.offset, (rc.boreFrom + rc.to + 0.2) / 2], label: 'cbore' }), 'recoil bore');
  check(cbore.rotate(sel.all(), 'x', 90, [BARREL_X, TY + rc.offset, (rc.boreFrom + rc.to + 0.2) / 2]));
  join(cyl, 'difference', cbore, { label: 'recoil-bore', material: 'frame' }, 'recoil bore cut');
  check(cyl.assign(sel.createdBy('recoil-cylinder'), 'trim'));
  check(cyl.array(sel.all(), { linear: { count: 2, offset: [0, -2 * rc.offset, 0] }, label: 'recoil-pair' }), 'recoil pair');
  check(cyl.array(sel.all(), { linear: { count: 2, offset: [-2 * BARREL_X, 0, 0] }, label: 'recoil-quad' }), 'recoil quad');
  join(mantlet, 'union', cyl, { label: 'recoil-cylinders', tag: 'mantlet' }, 'recoil cylinders fit');

  // Apron: a rigid arc shield on the cradle frame behind the mantlet, closing the window at every elevation.
  const apron = session('apron');
  check(apron.extrudePolygon({ points: sector([TZ, TY], APRON.radius - APRON.thickness, APRON.radius, APRON.center - APRON.halfSpan, APRON.center + APRON.halfSpan, 24), depth: 2 * APRON.halfWidth, label: 'apron-plate', tag: 'apron' }), 'apron');
  check(apron.rotate(sel.all(), 'y', -90));
  check(apron.translate(sel.all(), [APRON.halfWidth, 0, 0]));
  join(apron, 'difference', slots, { label: 'apron-slots', material: 'frame' }, 'apron slots');
  check(apron.bevel(sel.createdBy('apron-plate').toEdges('contained').and(sel.edges.dihedral('>', 25)), { width: 0.05, segments: 2, label: 'apron-round' }), 'apron bevel');
  check(apron.assign(sel.createdBy('apron-plate'), 'armor'));

  // Barrel: revolved profile (breech ring, collar, jacket clamps, taper, brake body), side-ported brake, muzzle bore, rod brackets.
  const barrel = session('barrel');
  check(barrel.revolve({ points: BARREL_SHAPE, segments: p.segments, label: 'tube', tag: 'barrel' }), 'barrel tube');
  check(barrel.rotate(sel.all(), 'x', 90));
  check(barrel.assign(sel.all(), 'barrel'));
  check(barrel.assign(sel.inBox([-2, -2, 15.25], [2, 2, 15.95]), 'trim'));
  check(barrel.assign(sel.inBox([-2, -2, 17.15], [2, 2, 17.85]), 'trim'));
  const ports = session('ports');
  check(ports.box({ size: [4, BRAKE_PORTS.height, BRAKE_PORTS.width], center: [0, 0, BRAKE_PORTS.from + BRAKE_PORTS.width / 2], label: 'port' }), 'port');
  check(ports.array(sel.all(), { linear: { count: BRAKE_PORTS.count, offset: [0, 0, BRAKE_PORTS.pitch] }, label: 'ports' }), 'port row');
  join(barrel, 'difference', ports, { label: 'ports', material: 'frame' }, 'brake ports');
  const muzzle = session('muzzle');
  check(muzzle.cylinder({ radiusTop: 0.4, radiusBottom: 0.4, height: 1.2, radialSegments: 16, center: [0, 0, 26], label: 'muzzle-bore' }), 'muzzle bore');
  check(muzzle.rotate(sel.all(), 'x', 90, [0, 0, 26]));
  join(barrel, 'difference', muzzle, { label: 'muzzle', material: 'frame' }, 'muzzle bore cut');
  check(barrel.bevel(sel.createdBy('tube').toEdges('contained').and(sel.edges.dihedral('>', 35)), { width: 0.04, segments: 2, label: 'barrel-round', material: 'barrel' }), 'barrel bevel');
  const rods = session('rods');
  check(rods.cylinder({ radiusTop: 0.12, radiusBottom: 0.12, height: 1.6, radialSegments: 12, center: [0, rc.offset, (12.0 + 13.6) / 2], label: 'recoil-rod' }), 'recoil rod');
  check(rods.rotate(sel.all(), 'x', 90, [0, rc.offset, (12.0 + 13.6) / 2]));
  const brackets = session('brackets');
  check(brackets.box({ size: [0.4, 0.8, 0.3], center: [0, rc.offset - 0.25, 13.75], label: 'rod-bracket' }), 'rod bracket');
  join(rods, 'union', brackets, { label: 'rod-brackets' }, 'rod brackets fit');
  check(rods.array(sel.all(), { linear: { count: 2, offset: [0, -2 * rc.offset, 0] }, label: 'rod-pair' }), 'rod pair');
  check(rods.assign(sel.all(), 'steel'));
  join(barrel, 'union', rods, { label: 'rods', tag: 'barrel' }, 'barrel rods fit');

  check(cradle.assign(sel.all(), 'frame'));
  check(pin.assign(sel.all(), 'steel'));

  // Assembly in the turret frame; every part keeps its tag for the rig.
  const turret = session('turret');
  check(turret.append(barbette, { tag: 'barbette' }), 'append barbette');
  check(turret.append(house, { tag: 'house' }), 'append house');
  check(turret.append(cradle, { tag: 'cradle' }), 'append cradle');
  check(turret.append(pin, { tag: 'cradle' }), 'append pin');
  check(turret.append(mantlet, { tag: 'mantlet' }), 'append mantlet');
  check(turret.append(apron, { tag: 'apron' }), 'append apron');
  check(turret.append(barrel, { translate: [BARREL_X, TY, BREECH_Z], tag: 'barrel-port' }), 'append barrel port');
  check(turret.append(barrel, { translate: [-BARREL_X, TY, BREECH_Z], tag: 'barrel-starboard' }), 'append barrel starboard');
  check(turret.uv.project({ mode: 'box', scale: 1 }), 'uv');
  return turret;
}
