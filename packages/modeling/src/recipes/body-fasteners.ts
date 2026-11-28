import { err, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  circle,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
  revolveCircle,
} from './common';
import { clearanceRadius, METRIC_SIZES, type MetricSize, metric } from './fasteners';

/** Fir-tree push clip sizes and supported tessellation counts (meters unless noted). */
export const PUSH_CLIP_RANGES = {
  headDiameter: [0.006, 0.05],
  headThickness: [0.0005, 0.008],
  stemDiameter: [0.002, 0.015],
  stemLength: [0.006, 0.2],
  barbs: [2, 8],
  barbDiameter: [0.002, 0.04],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

/** Options for a one-piece fir-tree trim clip (meters). */
export interface PushClipOptions extends RecipeNaming {
  readonly headDiameter: number;
  readonly headThickness: number;
  /** Panel-hole diameter; the clip's core stem is smaller. */
  readonly stemDiameter: number;
  /** Length from the under-head seat to the tip. */
  readonly stemLength: number;
  readonly barbs: number;
  /** Largest outside diameter of each retaining barb. */
  readonly barbDiameter: number;
  readonly segments?: number;
}

/**
 * One revolved push-in trim clip about +Y: a flat head, clearance core, tapered fir-tree
 * barbs and lead-in. Anchors `seat`, `tip`, `axis`; dimensions `holeDiameter`, `gripMin`,
 * `gripMax` and overall `length`.
 */
export function pushClip(options: PushClipOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'push-clip';
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () => inRange('headDiameter', options.headDiameter, PUSH_CLIP_RANGES.headDiameter),
    () => inRange('headThickness', options.headThickness, PUSH_CLIP_RANGES.headThickness),
    () => inRange('stemDiameter', options.stemDiameter, PUSH_CLIP_RANGES.stemDiameter),
    () => inRange('stemLength', options.stemLength, PUSH_CLIP_RANGES.stemLength),
    () => inRange('barbs', options.barbs, PUSH_CLIP_RANGES.barbs, true),
    () => inRange('barbDiameter', options.barbDiameter, PUSH_CLIP_RANGES.barbDiameter),
    () => inRange('segments', segments, PUSH_CLIP_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  const { headDiameter, headThickness, stemDiameter, stemLength, barbs, barbDiameter } = options;
  const relations = checkAll([
    () => inRange('headDiameter', headDiameter, [1.4 * stemDiameter, 8 * stemDiameter]),
    () => inRange('stemLength', stemLength, [3 * stemDiameter, 20 * stemDiameter]),
    () => inRange('headThickness', headThickness, [0.04 * headDiameter, 0.5 * headDiameter]),
    () =>
      inRange('barbDiameter', barbDiameter, [
        1.05 * stemDiameter,
        Math.min(2.2 * stemDiameter, headDiameter),
      ]),
  ]);
  if (!relations.ok) return relations;

  const coreRadius = 0.36 * stemDiameter;
  const barbRadius = barbDiameter / 2;
  const firstShoulder = -0.72 * stemLength;
  const shoulderStep = (0.54 * stemLength) / (barbs - 1);
  const tipLength = Math.min(0.12 * stemDiameter, 0.06 * stemLength);
  const points: Point2[] = [
    [0, -stemLength],
    [0.16 * stemDiameter, -stemLength],
    [coreRadius, -stemLength + tipLength],
    [coreRadius, firstShoulder - 0.35 * shoulderStep],
  ];
  for (let i = 0; i < barbs; i++) {
    const shoulder = firstShoulder + i * shoulderStep;
    const peak = shoulder - 0.1 * shoulderStep;
    points.push([barbRadius, peak], [coreRadius, shoulder]);
    if (i + 1 < barbs) {
      const nextBase = firstShoulder + (i + 1) * shoulderStep - 0.35 * shoulderStep;
      points.push([coreRadius, nextBase]);
    }
  }
  points.push(
    [coreRadius, 0],
    [headDiameter / 2, 0],
    [headDiameter / 2, headThickness],
    [0, headThickness],
  );
  const m = model();
  m.revolve({ points, segments, label: name });
  m.assign(sel.all(), 'nylon');
  return finishPart(
    m,
    name,
    { seat: [0, 0, 0], tip: [0, -stemLength, 0], axis: [0, -1, 0] },
    {
      holeDiameter: stemDiameter,
      gripMin: -firstShoulder - (barbs - 1) * shoulderStep,
      gripMax: -firstShoulder,
      length: stemLength + headThickness,
    },
  );
}

/** Projection weld-nut size and feature ranges (meters unless noted). */
export const WELD_NUT_RANGES = {
  size: [0.003, 0.024],
  acrossFlats: [0.0055, 0.036],
  height: [0.001, 0.04],
  pilotDiameter: [0.003, 0.035],
  pilotHeight: [0.0003, 0.012],
  projectionHeightRatio: [0.04, 0.08],
  projectionRadiusRatio: [0.06, 0.09],
  projections: [3, 6],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

/** Optional locating collar dimensions for a projection weld nut (meters). */
export interface WeldNutPilot {
  readonly diameter: number;
  readonly height: number;
}

/** Options for a hexagonal or square metric projection weld nut. */
export interface WeldNutOptions extends RecipeNaming {
  readonly size: MetricSize;
  readonly shape: 'hex' | 'square';
  readonly height?: number;
  readonly pilot?: WeldNutPilot;
  readonly projections?: number;
  readonly segments?: number;
}

function metricSize(size: MetricSize): ReturnType<typeof metric> | undefined {
  return Object.hasOwn(METRIC_SIZES, size) ? metric(size) : undefined;
}

/**
 * Projection weld nut about +Y: hex or square prism, nominal through bore, optional
 * locating pilot and weld projections. Anchors `seat`, `top` and `projection1...n`;
 * dimensions `acrossFlats`, `height`, `boreDiameter`, `pilotDiameter` and
 * `projectionHeight`.
 */
export function weldNut(options: WeldNutOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'weld-nut';
  const size = metricSize(options.size);
  const segments = options.segments ?? 24;
  if (options.shape !== 'hex' && options.shape !== 'square') {
    return err(
      modelingError('model-invalid-argument', "shape is 'hex' or 'square'", {
        shape: options.shape,
        allowed: ['hex', 'square'],
      }),
    );
  }
  const height = options.height ?? size?.m ?? Number.NaN;
  const acrossFlats = size?.s ?? Number.NaN;
  const vertexCount = options.shape === 'square' ? 4 : 6;
  const projections = options.projections ?? (options.shape === 'square' ? 4 : 3);
  const projectionHeight = 0.06 * acrossFlats;
  const pilot = options.pilot;
  const checked = checkAll([
    () => inRange('size', size?.d ?? Number.NaN, WELD_NUT_RANGES.size),
    () => inRange('acrossFlats', acrossFlats, WELD_NUT_RANGES.acrossFlats),
    () => inRange('height', height, WELD_NUT_RANGES.height),
    () => inRange('projections', projections, WELD_NUT_RANGES.projections, true),
    () => inRange('segments', segments, WELD_NUT_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  if (size === undefined) {
    return err(
      modelingError('model-invalid-argument', 'size is a supported metric size', {
        size: options.size,
        allowed: Object.keys(METRIC_SIZES),
      }),
    );
  }
  const boreRadius = clearanceRadius(size.d / 2, segments, 0.01);
  const projectionHeightCheck = inRange('projectionHeight', projectionHeight, [
    WELD_NUT_RANGES.projectionHeightRatio[0] * acrossFlats,
    WELD_NUT_RANGES.projectionHeightRatio[1] * acrossFlats,
  ]);
  if (!projectionHeightCheck.ok) return projectionHeightCheck;
  const projectionRadius = 0.07 * acrossFlats;
  const projectionRadiusCheck = inRange('projectionRadius', projectionRadius, [
    WELD_NUT_RANGES.projectionRadiusRatio[0] * acrossFlats,
    WELD_NUT_RANGES.projectionRadiusRatio[1] * acrossFlats,
  ]);
  if (!projectionRadiusCheck.ok) return projectionRadiusCheck;
  const projectionCount = inRange('projections', projections, [3, vertexCount], true);
  if (!projectionCount.ok) return projectionCount;
  const heightCheck = inRange('height', height, [0.4 * acrossFlats, 0.8 * acrossFlats]);
  if (!heightCheck.ok) return heightCheck;
  if (pilot !== undefined) {
    const pilotLower = boreRadius * 2 * 1.01;
    const pilotUpper = Math.min(acrossFlats * 0.95, WELD_NUT_RANGES.pilotDiameter[1]);
    const pilotHeightUpper = height - projectionHeight * 1.01;
    const pilotError = checkAll([
      () => inRange('pilotDiameter', pilot.diameter, WELD_NUT_RANGES.pilotDiameter),
      () => inRange('pilotHeight', pilot.height, WELD_NUT_RANGES.pilotHeight),
      () => inRange('pilotDiameter', pilot.diameter, [pilotLower, pilotUpper]),
      () => inRange('pilotHeight', pilot.height, [0.03 * acrossFlats, pilotHeightUpper]),
    ]);
    if (!pilotError.ok) return pilotError;
  }
  const sides = options.shape === 'hex' ? 6 : 4;
  const outerRadius =
    options.shape === 'hex' ? acrossFlats / Math.sqrt(3) : acrossFlats / Math.sqrt(2);
  const outline = circle(
    outerRadius,
    sides,
    [0, 0],
    options.shape === 'hex' ? Math.PI / 6 : Math.PI / 4,
  );
  const m = model();
  const bodyLabel = `${name}-body`;
  m.extrudePolygon({
    points: outline,
    holes: [revolveCircle(boreRadius, segments)],
    depth: height,
    label: bodyLabel,
  });
  m.rotate(sel.createdBy(bodyLabel), 'x', -90);

  const features = model();
  if (pilot !== undefined) {
    const label = `${name}-pilot`;
    const overlap = acrossFlats * 1e-5;
    features.revolve({
      points: [
        [boreRadius, -pilot.height],
        [pilot.diameter / 2, -pilot.height],
        [pilot.diameter / 2, overlap],
        [boreRadius, overlap],
        [boreRadius, -pilot.height],
      ],
      segments,
      label,
    });
  }

  const projectionClearance = acrossFlats * 1e-5;
  for (let i = 0; i < projections; i++) {
    const vertex = outline[Math.floor((i * sides) / projections)] as Point2;
    const x = 0.78 * vertex[0];
    const z = -0.78 * vertex[1];
    const label = `${name}-projection-${i + 1}`;
    const before = features.editMesh.faceCount;
    features.revolve({
      points: [
        [0, -projectionHeight],
        [0.12 * projectionRadius, -projectionHeight],
        [projectionRadius, projectionClearance],
        [0, projectionClearance],
      ],
      segments,
      label,
    });
    const after = features.editMesh.faceCount;
    if (after === before)
      return err(modelingError('model-internal', 'a weld projection profile was added'));
    features.translate(sel.createdBy(label), [x, 0, z]);
  }
  if (features.poisoned !== undefined) return err(features.poisoned);
  m.union(features, { label: `${name}-weld-features` });
  if (m.poisoned !== undefined) return err(m.poisoned);
  m.assign(sel.all(), 'steel');
  const anchors: Record<string, [number, number, number]> = {
    seat: [0, 0, 0],
    top: [0, height, 0],
  };
  for (let i = 0; i < projections; i++) {
    const vertex = outline[Math.floor((i * sides) / projections)] as Point2;
    anchors[`projection${i + 1}`] = [0.78 * vertex[0], -projectionHeight, -0.78 * vertex[1]];
  }
  const properties = {
    acrossFlats,
    height,
    boreDiameter: size.d,
    pilotDiameter: pilot?.diameter ?? 0,
    projectionHeight,
  };
  const part = finishPart(m, name, anchors, properties);
  if (!part.ok) return part;
  return part;
}

/** Blind-rivet dimensions and supported body sizes (meters unless noted). */
export const BLIND_RIVET_RANGES = {
  diameter: [0.0024, 0.0064],
  gripDiameters: [0.5, 20],
  headDiameterRatios: [1.5, 3],
  headHeightRatios: [0.2, 1],
  bulbDiameterRatios: [1.1, 2],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

/** Options for a set blind rivet represented in its installed state (meters). */
export interface BlindRivetOptions extends RecipeNaming {
  readonly diameter: number;
  readonly grip: number;
  readonly headDiameter?: number;
  readonly headHeight?: number;
  readonly bulbDiameter?: number;
  readonly segments?: number;
}

/**
 * Installed blind rivet about +Y: domed head with a broken-mandrel recess, body through
 * the grip and upset blind-side bulb. Anchors `seat` and `blind`; dimensions `holeDiameter`,
 * `grip` and overall `length`.
 */
export function blindRivet(options: BlindRivetOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'blind-rivet';
  const diameter = options.diameter;
  const diameterCheck = inRange('diameter', diameter, BLIND_RIVET_RANGES.diameter);
  if (!diameterCheck.ok) return diameterCheck;
  const headDiameter = options.headDiameter ?? 2 * diameter;
  const headHeight = options.headHeight ?? 0.5 * diameter;
  const bulbDiameter = options.bulbDiameter ?? 1.5 * diameter;
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () =>
      inRange('grip', options.grip, [
        BLIND_RIVET_RANGES.gripDiameters[0] * diameter,
        BLIND_RIVET_RANGES.gripDiameters[1] * diameter,
      ]),
    () =>
      inRange('headDiameter', headDiameter, [
        BLIND_RIVET_RANGES.headDiameterRatios[0] * diameter,
        BLIND_RIVET_RANGES.headDiameterRatios[1] * diameter,
      ]),
    () =>
      inRange('headHeight', headHeight, [
        BLIND_RIVET_RANGES.headHeightRatios[0] * diameter,
        BLIND_RIVET_RANGES.headHeightRatios[1] * diameter,
      ]),
    () =>
      inRange('bulbDiameter', bulbDiameter, [
        BLIND_RIVET_RANGES.bulbDiameterRatios[0] * diameter,
        BLIND_RIVET_RANGES.bulbDiameterRatios[1] * diameter,
      ]),
    () => inRange('segments', segments, BLIND_RIVET_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;

  const bulbHeight = 0.35 * diameter;
  const bulbRadius = bulbDiameter / 2;
  const bodyRadius = diameter / 2;
  const mandrelRadius = 0.14 * diameter;
  const recessDepth = 0.18 * headHeight;
  const domeBaseRadius = headDiameter / 2;
  const crown = headHeight;
  const points: Point2[] = [
    [0, -options.grip - bulbHeight],
    [0.45 * bulbRadius, -options.grip - bulbHeight],
    [bulbRadius, -options.grip - 0.5 * bulbHeight],
    [bodyRadius, -options.grip],
    [bodyRadius, 0],
    [domeBaseRadius, 0],
  ];
  for (let i = 1; i <= 8; i++) {
    const y = (crown * i) / 8;
    const r2 =
      domeBaseRadius * domeBaseRadius * (1 - y / crown) +
      mandrelRadius * mandrelRadius * (y / crown);
    points.push([Math.sqrt(r2), y]);
  }
  points.push([mandrelRadius, crown - recessDepth], [0, crown - recessDepth]);
  const m = model();
  m.revolve({ points, segments, label: name });
  m.assign(sel.all(), 'steel');
  return finishPart(
    m,
    name,
    { seat: [0, 0, 0], blind: [0, -options.grip, 0] },
    {
      holeDiameter: diameter + 0.0001,
      grip: options.grip,
      length: options.grip + bulbHeight + headHeight,
    },
  );
}

/** Rubber grommet hole, panel, flange and tessellation ranges (meters unless noted). */
export const GROMMET_RANGES = {
  holeDiameter: [0.004, 0.06],
  panelThickness: [0.0005, 0.01],
  boreHoleRatios: [0, 1],
  flangeDiameterRatios: [1.3, 3.5],
  flangeThicknessPanelRatios: [0.2, 3],
  segments: [12, 48],
} as const satisfies Record<string, Range>;

/** Options for a rubber panel grommet or zero-bore blanking plug (meters). */
export interface GrommetOptions extends RecipeNaming {
  readonly holeDiameter: number;
  readonly panelThickness: number;
  /** Cable passage diameter; zero makes a blanking plug. */
  readonly bore: number;
  readonly flangeDiameter?: number;
  readonly flangeThickness?: number;
  readonly segments?: number;
}

/**
 * One revolved rubber grommet about +Y with a panel-thickness groove and tapered entry
 * flange. Anchors `panel`, `entry`, `exit`; dimensions `grooveWidth`, `rootDiameter`,
 * `outerDiameter` and `bore`.
 */
export function grommet(options: GrommetOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'grommet';
  const flangeDiameter = options.flangeDiameter ?? 1.8 * options.holeDiameter;
  const flangeThickness = options.flangeThickness ?? 0.5 * options.panelThickness;
  const segments = options.segments ?? 24;
  const checked = checkAll([
    () => inRange('holeDiameter', options.holeDiameter, GROMMET_RANGES.holeDiameter),
    () => inRange('panelThickness', options.panelThickness, GROMMET_RANGES.panelThickness),
    () =>
      inRange('bore', options.bore, [0, GROMMET_RANGES.boreHoleRatios[1] * options.holeDiameter]),
    () =>
      inRange('flangeDiameter', flangeDiameter, [
        GROMMET_RANGES.flangeDiameterRatios[0] * options.holeDiameter,
        GROMMET_RANGES.flangeDiameterRatios[1] * options.holeDiameter,
      ]),
    () =>
      inRange('flangeThickness', flangeThickness, [
        GROMMET_RANGES.flangeThicknessPanelRatios[0] * options.panelThickness,
        GROMMET_RANGES.flangeThicknessPanelRatios[1] * options.panelThickness,
      ]),
    () => inRange('segments', segments, GROMMET_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  const relations = checkAll([
    () => inRange('bore', options.bore, [0, options.holeDiameter * (1 - 1e-9)]),
    () =>
      inRange('flangeDiameter', flangeDiameter, [
        1.01 * options.holeDiameter,
        GROMMET_RANGES.flangeDiameterRatios[1] * options.holeDiameter,
      ]),
  ]);
  if (!relations.ok) return relations;

  const rootRadius = options.holeDiameter / 2;
  const boreRadius = options.bore / 2;
  const flangeRadius = flangeDiameter / 2;
  const halfPanel = options.panelThickness / 2;
  const lower = -halfPanel - flangeThickness;
  const upper = halfPanel + flangeThickness;
  const points: Point2[] =
    options.bore === 0
      ? [
          [0, lower],
          [flangeRadius, lower],
          [flangeRadius, -halfPanel],
          [rootRadius, -halfPanel],
          [rootRadius, halfPanel],
          [flangeRadius, halfPanel],
          [flangeRadius, upper],
          [0, upper],
        ]
      : [
          [boreRadius, lower],
          [rootRadius, lower],
          [flangeRadius, -halfPanel],
          [rootRadius, -halfPanel],
          [rootRadius, halfPanel],
          [flangeRadius, halfPanel],
          [flangeRadius, upper],
          [boreRadius, upper],
          [boreRadius, lower],
        ];
  const m = model();
  m.revolve({ points, segments, label: name });
  m.assign(sel.all(), 'rubber');
  return finishPart(
    m,
    name,
    { panel: [0, 0, 0], entry: [0, lower, 0], exit: [0, upper, 0] },
    {
      grooveWidth: options.panelThickness,
      rootDiameter: options.holeDiameter,
      outerDiameter: flangeDiameter,
      bore: options.bore,
    },
  );
}
