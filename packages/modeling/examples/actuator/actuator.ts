import { type BakeSettings, type Model, model, type Point2, type PosePath, type RecipePart, type Rig, recipes, rig, sel } from '@forgeax/engine-modeling';
import type { SessionFactory } from '../case/record.ts';

/**
 * Case C-112 (a C-100 part, code name mech-gt): the thigh actuator of the mech form, the
 * S5 hydraulic cylinder with a rubber bellows dust boot over its exposed rod, taken
 * through the S6 game-ready route. A high-poly detail source (fine revolutions, port
 * bosses, panel line grooves, gland bolts) and a shell: the plain actuator without hidden
 * internals, simplified to a triangle budget and auto-UVed; one bake pass maps the
 * detail onto the shell as normal and AO maps. The shell is rigged: barrel and rod are
 * rigid parts, the boot deforms with automatic weights between its clamped collars, so
 * extending the rod stretches the folds.
 * Axes: the recipe's +Y is the cylinder axis, the base eye pin at the bottom.
 */
export interface ActuatorParameters {
  /** Rod travel in meters. */
  readonly stroke: number;
  /** Rest extension as a fraction of the stroke (the rig's zero). */
  readonly rest: number;
  /** Bellows folds. */
  readonly folds: number;
  /** Triangle budget of the game-ready shell. */
  readonly budget: number;
  /** Texels per side of the baked maps. */
  readonly resolution: number;
}

export const ACTUATOR_DEFAULTS: ActuatorParameters = { stroke: 0.12, rest: 0.25, folds: 8, budget: 1500, resolution: 512 };

/** mech-gt S5 actuator section (`s5-joints.ts` ACTUATOR). */
const BORE = 0.04;
const ROD = 0.022;
const SEGMENTS = 32;
/** Height of the boot's clamp collars at both ends. */
const COLLAR = 0.003;
/** Revolutions of the high-poly sources (detail and the shell before simplification). */
const DETAIL_SEGMENTS = 64;
/** Revolutions of the shell's boot: it deforms, so it keeps its authored fold profile unsimplified. */
const BOOT_SEGMENTS = 24;
/** Barrel outer radius of the recipe (bore / 2 + 12 % wall). */
const BARREL = BORE / 2 + 0.12 * BORE;

function unwrap(part: ReturnType<typeof recipes.hydraulicCylinder>): RecipePart {
  if (!part.ok) throw part.error;
  return part.value;
}

/** Where the boot clamps (just above the gland, just below the rod end, at rest), the eye pins and the barrel features. */
export interface ActuatorFrame {
  readonly bottom: number;
  readonly top: number;
  readonly baseEye: readonly [number, number, number];
  readonly rodEye: readonly [number, number, number];
  /** Barrel length: the gland face height. */
  readonly length: number;
  /** Heights of the port bosses near both barrel ends and of the two grooves between them. */
  readonly ports: readonly [number, number];
  readonly grooves: readonly [number, number];
}

export function actuatorFrame(p: ActuatorParameters = ACTUATOR_DEFAULTS): ActuatorFrame {
  const c = unwrap(recipes.hydraulicCylinder({ bore: BORE, rod: ROD, stroke: p.stroke, extension: p.rest, segments: SEGMENTS, name: 'ram' }));
  const length = c.dimensions.barrelLength as number;
  const rodTop = (c.anchors.rodEye?.[1] as number) - (c.dimensions.eyeRadius as number) - 0.002 * BORE;
  return {
    bottom: length + 0.001,
    top: rodTop - 0.004,
    baseEye: c.anchors.baseEye as ActuatorFrame['baseEye'],
    rodEye: c.anchors.rodEye as ActuatorFrame['rodEye'],
    length,
    ports: [0.18 * length, 0.72 * length],
    grooves: [0.3 * length, 0.6 * length],
  };
}

/** Bellows profile: clamp collars at both ends, `folds` crests between them. */
function bellows(bottom: number, top: number, folds: number): Point2[] {
  const inner = ROD / 2 + 0.0015;
  const outer = ROD / 2 + 0.008;
  const collar = COLLAR;
  const points: Point2[] = [[inner, bottom], [inner, bottom + collar]];
  const pitch = (top - bottom - 2 * collar) / folds;
  for (let i = 0; i < folds; i++) {
    const y = bottom + collar + i * pitch;
    points.push([outer, y + pitch / 2], [inner + 0.001, y + pitch]);
  }
  points[points.length - 1] = [inner, top - collar];
  points.push([inner, top]);
  return points;
}

/**
 * Joints: the barrel (root, base eye pin), the gland clamp (fixed), the rod (prismatic
 * along +Y from the rod clamp, zero at rest) and the rod end (fixed). The boot binds over
 * the gland and rod joints; its bones are the gland point and the rod clamp-to-eye segment.
 * Its collars are clamped: rigid on the gland and the rod, so the fold vertices they share
 * are pinned to those joints and the collars never slide into the barrel or the rod end.
 */
export function actuatorRig(m: Model, p: ActuatorParameters = ACTUATOR_DEFAULTS): Rig {
  const span = actuatorFrame(p);
  const r = rig(m, {
    joints: [
      { name: 'barrel', parent: null, position: [...span.baseEye] },
      { name: 'gland', parent: 'barrel', position: [0, span.bottom, 0] },
      { name: 'rod', parent: 'barrel', position: [0, span.top, 0], kind: 'prismatic', axis: 'y', limits: [-p.rest * p.stroke, (1 - p.rest) * p.stroke] },
      { name: 'rod-end', parent: 'rod', position: [...span.rodEye] },
    ],
  });
  r.bindRigid(sel.all(), 'barrel', { part: 'barrel' });
  r.bindRigid(sel.createdBy('ram-rod').or(sel.createdBy('ram-rod-eye')), 'rod', { part: 'rod' });
  r.bindAuto(sel.createdBy('boot'), ['gland', 'rod'], { part: 'boot' });
  r.bindRigid(sel.createdBy('boot').and(sel.inBox([-1, span.bottom - 1e-4, -1], [1, span.bottom + COLLAR + 1e-4, 1], { by: 'all' })), 'gland', { part: 'clamp-low' });
  r.bindRigid(sel.createdBy('boot').and(sel.inBox([-1, span.top - COLLAR - 1e-4, -1], [1, span.top + 1e-4, 1], { by: 'all' })), 'rod', { part: 'clamp-high' });
  return r;
}

/** Full extension, then full retraction. */
export function actuatorPath(p: ActuatorParameters = ACTUATOR_DEFAULTS): PosePath {
  return {
    keys: [
      { u: 0, pose: {} },
      { u: 0.5, pose: { rod: (1 - p.rest) * p.stroke } },
      { u: 1, pose: { rod: -p.rest * p.stroke } },
    ],
    interpolation: 'smooth',
  };
}

/** Export normals of the shell, for the bake's tangent frame and for rendering alike. */
export const SHELL_NORMALS = { mode: 'autoSmooth', angle: 40 } as const;

/**
 * Tangent-space normal and ambient occlusion from the detail onto the shell, one mip level.
 * The projection distance covers the 5 mm port bosses: the default (1.5 % of the diagonal,
 * 4.4 mm) starts rays inside them, and they vanish from the maps.
 */
export function actuatorBake(p: ActuatorParameters = ACTUATOR_DEFAULTS): BakeSettings {
  return { maps: ['normal', 'ao'], resolution: p.resolution, cage: { offset: 0.007, maxRay: 0.014 }, normals: SHELL_NORMALS, detailNormals: SHELL_NORMALS, samples: 4, mips: false, ao: { rays: 32, distance: 0.02 } };
}

/** High-poly source of the bake: finer revolutions plus the features the shell only shows in its maps. */
export function buildActuatorDetail(p: ActuatorParameters = ACTUATOR_DEFAULTS, session: SessionFactory = () => model()): Model {
  const cylinder = unwrap(recipes.hydraulicCylinder({ bore: BORE, rod: ROD, stroke: p.stroke, extension: p.rest, segments: DETAIL_SEGMENTS, name: 'ram' }));
  const f = actuatorFrame(p);
  const d = session('detail');
  d.append(cylinder.model, { tag: 'cylinder' });
  d.revolve({ points: bellows(f.bottom, f.top, p.folds), segments: DETAIL_SEGMENTS, label: 'boot', material: 'rubber' });
  d.panelLine({ faces: sel.createdBy('ram-barrel'), point: [0, f.grooves[0], 0], normal: [0, 1, 0] }, { width: 0.003, depth: 0.0008, profile: 'v', label: 'groove-low', material: 'groove' });
  d.panelLine({ faces: sel.createdBy('ram-barrel'), point: [0, f.grooves[1], 0], normal: [0, 1, 0] }, { width: 0.003, depth: 0.0008, profile: 'v', label: 'groove-high', material: 'groove' });
  d.cylinder({ radiusTop: 0.0045, radiusBottom: 0.0055, height: 0.006, radialSegments: 24, center: [0, BARREL + 0.002, -f.ports[0]], tag: 'port' });
  d.cylinder({ radiusTop: 0.0045, radiusBottom: 0.0055, height: 0.006, radialSegments: 24, center: [0, BARREL + 0.002, -f.ports[1]], tag: 'port' });
  d.rotate(sel.tag('port'), 'x', 90);
  d.assign(sel.tag('port'), 'steel');
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * (i + 0.5)) / 6;
    d.cylinder({ radiusTop: 0.0016, radiusBottom: 0.0018, height: 0.0014, radialSegments: 12, center: [0.0185 * Math.cos(a), f.length + 0.0007, 0.0185 * Math.sin(a)], tag: 'bolt' });
  }
  d.assign(sel.tag('bolt'), 'steel');
  d.uv.project({ mode: 'cylinder', axis: 'y', scale: 0.1 });
  return d;
}

/**
 * Game-ready shell: the plain actuator without the rod and piston (they run inside the
 * barrel and the boot at every extension) and a boot revolved at game resolution; the rigid
 * parts are simplified to the rest of the triangle budget with hard edges and part borders
 * kept, and the whole shell is auto-UVed. Simplifying the rod and the gland bore separately
 * would close their 0.3 mm clearance, so the hidden rod goes first. `simplifyBoot` is the
 * first design: the boot revolved finely and simplified with the rest; its lowest fold then
 * crosses itself at full retraction.
 */
export function buildActuatorShell(p: ActuatorParameters = ACTUATOR_DEFAULTS, session: SessionFactory = () => model(), simplifyBoot = false): Model {
  const cylinder = unwrap(recipes.hydraulicCylinder({ bore: BORE, rod: ROD, stroke: p.stroke, extension: p.rest, segments: DETAIL_SEGMENTS, name: 'ram' }));
  const f = actuatorFrame(p);
  const s = session('shell');
  s.append(cylinder.model, { tag: 'cylinder' });
  s.delete(sel.createdBy('ram-rod'));
  const profile = bellows(f.bottom, f.top, p.folds);
  s.revolve({ points: profile, segments: simplifyBoot ? DETAIL_SEGMENTS : BOOT_SEGMENTS, label: 'boot', material: 'rubber' });
  // One seam down the boot's meridian cuts its rings: uv.auto must not chart a closed band.
  s.markSeam(sel.createdBy('boot').and(sel.inBox([0.005, -1, -1e-6], [1, 1, 1e-6], { by: 'any' })).toEdges('contained').minus(sel.edges.perpendicular('y')));
  s.markSharp(sel.edges.dihedral('>', 50));
  s.simplify(simplifyBoot ? sel.all() : sel.all().minus(sel.createdBy('boot')), { targetFaces: simplifyBoot ? p.budget : p.budget - 2 * BOOT_SEGMENTS * (profile.length - 1), preserve: { labels: true, materials: true, sharp: true } });
  s.markSharp(sel.edges.dihedral('>', 40));
  s.uv.auto({ resolution: p.resolution, padding: Math.max(2, p.resolution / 128) });
  return s;
}
