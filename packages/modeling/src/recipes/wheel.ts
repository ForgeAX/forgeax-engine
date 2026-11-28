import { err, ok, type Result } from '@forgeax/engine-types';
import { cos, sin } from '../dmath';
import { type ModelingError, modelingError } from '../errors';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import type { Point2 } from '../primitives';
import { sel } from '../selectors';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

/** ISO metric tyre measurements, converted to meters. */
export interface TyreSize {
  readonly sectionWidth: number;
  readonly aspectRatio: number;
  readonly construction: 'R' | 'D' | 'B';
  readonly rimDiameter: number;
  readonly sidewall: number;
  readonly overallDiameter: number;
  readonly circumference: number;
  readonly loadIndex?: number;
  readonly speedSymbol?: string;
}

/** Accepted base magnitudes for an ISO metric tyre designation. */
export const TYRE_SIZE_RANGES = {
  sectionWidth: [0.05, 0.6],
  aspectRatio: [0.1, 1],
  rimDiameter: [0.2, 0.8],
  loadIndex: [1, 999],
} as const satisfies Record<string, Range>;

/** Parse an ISO metric tyre code such as `225/45R17` into meters. */
export function tyreSize(code: string): Result<TyreSize, ModelingError> {
  const invalid = () =>
    err(
      modelingError(
        'model-invalid-argument',
        'an ISO metric tyre designation with a positive width, aspect ratio and rim diameter',
        { code },
        'use forms such as 225/45R17, P215/65R15 or 205/55ZR16 91W',
      ),
    );
  if (typeof code !== 'string') return invalid();
  const normalized = code.trim().toUpperCase();
  const match =
    /^(?:P|LT)?(\d{3})\s*\/\s*(\d{2,3})\s*Z?\s*([RDB])\s*(\d{2})(?:\s*(\d{2,3}))?(?:\s*([A-Z]))?$/.exec(
      normalized,
    );
  if (match === null) return invalid();
  const sectionWidth = Number(match[1]) / 1000;
  const aspectRatio = Number(match[2]) / 100;
  const construction = match[3] as TyreSize['construction'];
  const rimDiameter = Number(match[4]) * 0.0254;
  const loadIndex = match[5] === undefined ? undefined : Number(match[5]);
  const speedSymbol = match[6];
  if (
    !inRange('sectionWidth', sectionWidth, TYRE_SIZE_RANGES.sectionWidth).ok ||
    !inRange('aspectRatio', aspectRatio, TYRE_SIZE_RANGES.aspectRatio).ok ||
    !inRange('rimDiameter', rimDiameter, TYRE_SIZE_RANGES.rimDiameter).ok ||
    (loadIndex !== undefined && !inRange('loadIndex', loadIndex, TYRE_SIZE_RANGES.loadIndex).ok)
  ) {
    return invalid();
  }
  const sidewall = sectionWidth * aspectRatio;
  const overallDiameter = rimDiameter + 2 * sidewall;
  return ok({
    sectionWidth,
    aspectRatio,
    construction,
    rimDiameter,
    sidewall,
    overallDiameter,
    circumference: Math.PI * overallDiameter,
    ...(loadIndex === undefined ? {} : { loadIndex }),
    ...(speedSymbol === undefined ? {} : { speedSymbol }),
  });
}

/** A tyre given by its measurements (meters; aspect ratio as a fraction) instead of a code. */
export type TyreDimensions = Pick<TyreSize, 'sectionWidth' | 'aspectRatio' | 'rimDiameter'>;

/** Meridional revolved tyre, with its axle on +Y and its contact at -Z. */
export interface TyreOptions extends RecipeNaming {
  readonly size: string | TyreDimensions;
  readonly treadWidth?: number;
  readonly grooves?: number;
  readonly grooveDepth?: number;
  readonly grooveWidth?: number;
  readonly shoulderRadius?: number;
  /** Bead-to-bead width; the default is 0.85 x section width rounded to a half inch. */
  readonly rimWidth?: number;
  /** Facets around +Y (default 64). */
  readonly segments?: number;
}

/** Tyre recipe limits; tread and bead dimensions have dependent limits. */
export const TYRE_RANGES = {
  treadFraction: [0.5, 1],
  grooves: [0, 6],
  grooveDepth: [0.001, 0.02],
  grooveWidth: [0.001, 0.025],
  shoulderRadius: [0, 0.03],
  rimWidthFraction: [0.55, 0.98],
  segments: [32, 128],
} as const satisfies Record<string, Range>;

function tyreDimensions(size: string | TyreDimensions): Result<TyreSize, ModelingError> {
  if (typeof size === 'string') return tyreSize(size);
  if (size === null || typeof size !== 'object') {
    return err(
      modelingError('model-invalid-argument', 'size is a tyre code or metric tyre dimensions', {
        size,
      }),
    );
  }
  const checked = checkAll([
    () => inRange('sectionWidth', size.sectionWidth, TYRE_SIZE_RANGES.sectionWidth),
    () => inRange('aspectRatio', size.aspectRatio, TYRE_SIZE_RANGES.aspectRatio),
    () => inRange('rimDiameter', size.rimDiameter, TYRE_SIZE_RANGES.rimDiameter),
  ]);
  if (!checked.ok) return checked;
  const sidewall = size.sectionWidth * size.aspectRatio;
  const overallDiameter = size.rimDiameter + 2 * sidewall;
  return ok({
    sectionWidth: size.sectionWidth,
    aspectRatio: size.aspectRatio,
    construction: 'R',
    rimDiameter: size.rimDiameter,
    sidewall,
    overallDiameter,
    circumference: Math.PI * overallDiameter,
  });
}

function pushPoint(points: Point2[], point: Point2): void {
  const previous = points[points.length - 1];
  if (previous === undefined || previous[0] !== point[0] || previous[1] !== point[1])
    points.push(point);
}

/**
 * One hollow, closed revolved tyre about +Y (the wheel-rim example convention); its
 * contact point is -Z. The inner carcass band closes the cavity between the two bead
 * seats. Tags divide the tread, sidewall and bead regions.
 */
export function tyre(options: TyreOptions): Result<RecipePart, ModelingError> {
  const parsed = tyreDimensions(options.size);
  if (!parsed.ok) return parsed;
  const size = parsed.value;
  const name = options.name ?? 'tyre';
  const treadWidth = options.treadWidth ?? 0.8 * size.sectionWidth;
  const grooves = options.grooves ?? 4;
  const grooveDepth = options.grooveDepth ?? 0.007;
  const grooveWidth = options.grooveWidth ?? 0.008;
  const rimWidth = options.rimWidth ?? Math.round((0.85 * size.sectionWidth) / 0.0127) * 0.0127;
  const segments = options.segments ?? 64;
  const halfTread = treadWidth / 2;
  const halfSection = size.sectionWidth / 2;
  const halfBead = rimWidth / 2;
  const maxShoulder = Math.min(
    TYRE_RANGES.shoulderRadius[1],
    0.25 * size.sidewall,
    0.8 * (halfSection - halfTread),
  );
  const shoulderRadius = options.shoulderRadius ?? Math.min(0.012, maxShoulder);
  const checked = checkAll([
    () =>
      inRange('treadWidth', treadWidth, [
        TYRE_RANGES.treadFraction[0] * size.sectionWidth,
        size.sectionWidth,
      ]),
    () => inRange('grooves', grooves, TYRE_RANGES.grooves, true),
    () => inRange('grooveDepth', grooveDepth, TYRE_RANGES.grooveDepth),
    () => inRange('grooveWidth', grooveWidth, TYRE_RANGES.grooveWidth),
    () =>
      inRange('rimWidth', rimWidth, [
        TYRE_RANGES.rimWidthFraction[0] * size.sectionWidth,
        TYRE_RANGES.rimWidthFraction[1] * size.sectionWidth,
      ]),
    () => inRange('shoulderRadius', shoulderRadius, [0, maxShoulder]),
    () => inRange('segments', segments, TYRE_RANGES.segments, true),
  ]);
  if (!checked.ok) return checked;
  const groovePitch = treadWidth / (grooves + 1);
  if (grooves > 0 && grooveWidth >= groovePitch) {
    return err(
      modelingError(
        'model-invalid-argument',
        'circumferential grooves have a positive tread land between them',
        { grooves, grooveWidth, groovePitch, treadWidth },
      ),
    );
  }
  const seatRadius = size.rimDiameter / 2;
  const crown = Math.min(0.0003, treadWidth * 0.001, size.sidewall * 0.003);
  const outerRadius = size.overallDiameter / 2;
  const beadHeight = Math.min(0.006, Math.max(0.003, size.sidewall * 0.07));
  const wall = Math.min(0.012, Math.max(0.004, size.sidewall * 0.08));
  const innerRadius = seatRadius + wall;
  const innerHalfWidth = halfBead - 0.5 * wall;
  const shoulderStartRadius = outerRadius - shoulderRadius;
  const midRadius = seatRadius + 0.48 * size.sidewall;
  const points: Point2[] = [
    [innerRadius, -innerHalfWidth],
    [seatRadius, -halfBead],
    [seatRadius + beadHeight, -halfBead],
    [seatRadius + beadHeight, -halfBead + 0.003],
    [midRadius, -halfSection],
    [shoulderStartRadius, -(halfTread + shoulderRadius)],
  ];

  if (shoulderRadius > 0) {
    for (let i = 1; i <= 4; i++) {
      const angle = -Math.PI / 2 + (Math.PI / 2) * (i / 4);
      pushPoint(points, [
        shoulderStartRadius + shoulderRadius * cos(angle) - crown * (1 - (i * i) / 16),
        -halfTread + shoulderRadius * sin(angle),
      ]);
    }
  } else {
    pushPoint(points, [outerRadius, -halfTread]);
  }

  const treadRadius = (y: number) => outerRadius - crown * ((y / halfTread) * (y / halfTread));
  for (let i = 0; i < grooves; i++) {
    const center = -halfTread + (treadWidth * (i + 1)) / (grooves + 1);
    const start = center - grooveWidth / 2;
    const end = center + grooveWidth / 2;
    pushPoint(points, [treadRadius(start), start]);
    pushPoint(points, [treadRadius(start) - grooveDepth, start]);
    pushPoint(points, [treadRadius(end) - grooveDepth, end]);
    pushPoint(points, [treadRadius(end), end]);
  }
  pushPoint(points, [treadRadius(halfTread), halfTread]);

  if (shoulderRadius > 0) {
    for (let i = 1; i <= 4; i++) {
      const angle = (Math.PI / 2) * (i / 4);
      pushPoint(points, [
        shoulderStartRadius + shoulderRadius * cos(angle) - crown * (1 - (i * i) / 16),
        halfTread + shoulderRadius * sin(angle),
      ]);
    }
  } else {
    pushPoint(points, [outerRadius, halfTread]);
  }
  pushPoint(points, [shoulderStartRadius, halfTread + shoulderRadius]);
  pushPoint(points, [midRadius, halfSection]);
  pushPoint(points, [seatRadius + beadHeight, halfBead - 0.003]);
  pushPoint(points, [seatRadius + beadHeight, halfBead]);
  pushPoint(points, [seatRadius, halfBead]);
  pushPoint(points, [innerRadius, innerHalfWidth]);
  pushPoint(points, [innerRadius, -innerHalfWidth]);

  const m = model();
  m.revolve({ points, segments, label: name, tag: name });
  if (m.poisoned !== undefined) return err(m.poisoned);
  const tread = sel.inBox(
    [-outerRadius, -halfTread - 1e-9, -outerRadius],
    [outerRadius, halfTread + 1e-9, outerRadius],
    { by: 'centroid' },
  );
  const beadRadius = seatRadius + beadHeight + 0.001;
  const bead = sel.inBox([-beadRadius, -1, -beadRadius], [beadRadius, 1, beadRadius], {
    by: 'centroid',
  });
  m.tag(sel.createdBy(name).and(tread), `${name}-tread`);
  m.tag(sel.createdBy(name).and(bead), `${name}-bead`);
  m.tag(sel.createdBy(name).minus(tread).minus(bead), `${name}-sidewall`);
  if (m.poisoned !== undefined) return err(m.poisoned);
  return finishPart(
    m,
    name,
    {
      center: [0, 0, 0],
      contact: [0, 0, -outerRadius],
      beadInner: [0, -halfBead, seatRadius],
      beadOuter: [0, halfBead, seatRadius],
    },
    {
      sectionWidth: size.sectionWidth,
      aspectRatio: size.aspectRatio,
      rimDiameter: size.rimDiameter,
      sidewall: size.sidewall,
      overallDiameter: size.overallDiameter,
      circumference: size.circumference,
      ...(size.loadIndex === undefined ? {} : { loadIndex: size.loadIndex }),
      treadWidth,
      rimWidth,
      grooves,
      grooveDepth,
      grooveWidth,
      shoulderRadius,
      segments,
    },
  );
}

/** Wheel barrel about +Y: positive ET and the street/outboard side point toward +Y. */
export interface WheelRimOptions extends RecipeNaming {
  /** Bead-seat diameter (meters). */
  readonly diameter: number;
  /** Width between the two flange inner faces (meters). */
  readonly width: number;
  /** ET, from the centre plane toward the outboard/street side (meters). */
  readonly offset: number;
  /** Bolt-circle diameter (meters). */
  readonly pcd: number;
  readonly bolts: number;
  readonly boltHole?: number;
  readonly centerBore: number;
  readonly spokes: number;
  readonly spokeWidth?: number;
  readonly hubDiameter?: number;
  /** Radial flange height (default 17.5 mm, common J flange). */
  readonly flangeHeight?: number;
  readonly barrelThickness?: number;
  /** Facets around +Y (default 64). */
  readonly segments?: number;
}

/** Declared rim limits; hole fit and spoke clearance are checked against the hub geometry. */
export const WHEEL_RIM_RANGES = {
  diameter: [0.25, 0.8],
  width: [0.08, 0.45],
  offset: [-0.25, 0.25],
  pcd: [0.04, 0.3],
  bolts: [3, 8],
  boltHole: [0.004, 0.035],
  centerBore: [0.01, 0.08],
  spokes: [3, 12],
  spokeWidth: [0.004, 0.08],
  hubDiameter: [0.05, 0.35],
  flangeHeight: [0.005, 0.04],
  barrelThickness: [0.003, 0.015],
  segments: [32, 128],
} as const satisfies Record<string, Range>;

function circleInXZ(radius: number, n: number, centerX = 0, centerZ = 0, phase = 0): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = phase + (2 * Math.PI * i) / n;
    return [centerX + radius * sin(angle), -(centerZ + radius * cos(angle))] as Point2;
  });
}

function invalidRim(
  expected: string,
  detail: Record<string, unknown>,
): Result<never, ModelingError> {
  return err(modelingError('model-invalid-argument', expected, detail));
}

/**
 * One hollow revolved barrel, drilled hub and straight radial spokes about +Y. The
 * mounting face is at `offset`; positive Y is the outboard/street side, and `backspacing`
 * is measured from the inboard flange inner face to that mounting plane.
 */
export function wheelRim(options: WheelRimOptions): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'wheel-rim';
  const { diameter, width, offset, pcd, bolts, centerBore, spokes } = options;
  const boltHole = options.boltHole ?? 0.012;
  const flangeHeight = options.flangeHeight ?? 0.0175;
  const barrelThickness = options.barrelThickness ?? 0.006;
  const segments = options.segments ?? 64;
  const radius = diameter / 2;
  const flangeLip = 0.012;
  const hubThickness = Math.min(0.012, width * 0.15);
  const hubInnerY = offset >= 0 ? offset - hubThickness : offset;
  const hubDiameter =
    options.hubDiameter ?? Math.max(pcd + boltHole + 0.018, 3 * centerBore, 0.14 * diameter);
  const hubRadius = hubDiameter / 2;
  const spokeInner = hubRadius - 0.003;
  const spokeWidth =
    options.spokeWidth ?? Math.min(0.025, 0.55 * 2 * spokeInner * sin(Math.PI / spokes));
  const checks = checkAll([
    () => inRange('diameter', diameter, WHEEL_RIM_RANGES.diameter),
    () => inRange('width', width, WHEEL_RIM_RANGES.width),
    () => inRange('offset', offset, [-0.25, 0.25]),
    () => inRange('pcd', pcd, WHEEL_RIM_RANGES.pcd),
    () => inRange('bolts', bolts, WHEEL_RIM_RANGES.bolts, true),
    () => inRange('boltHole', boltHole, WHEEL_RIM_RANGES.boltHole),
    () => inRange('centerBore', centerBore, WHEEL_RIM_RANGES.centerBore),
    () => inRange('spokes', spokes, WHEEL_RIM_RANGES.spokes, true),
    () => inRange('spokeWidth', spokeWidth, WHEEL_RIM_RANGES.spokeWidth),
    () => inRange('hubDiameter', hubDiameter, WHEEL_RIM_RANGES.hubDiameter),
    () => inRange('flangeHeight', flangeHeight, WHEEL_RIM_RANGES.flangeHeight),
    () => inRange('barrelThickness', barrelThickness, WHEEL_RIM_RANGES.barrelThickness),
    () => inRange('segments', segments, WHEEL_RIM_RANGES.segments, true),
  ]);
  if (!checks.ok) return checks;
  if (width >= diameter * 0.8) {
    return invalidRim('rim width is below 0.8 x its bead-seat diameter', { width, diameter });
  }
  if (Math.abs(offset) > width / 2 - 0.001) {
    return invalidRim('the hub mounting plane stays inside the rim flange faces', {
      offset,
      width,
      min: -width / 2 + 0.001,
      max: width / 2 - 0.001,
    });
  }
  const holeRadius = boltHole / 2;
  const boreRadius = centerBore / 2;
  const boltCircleRadius = pcd / 2;
  const adjacentBoltDistance = 2 * boltCircleRadius * sin(Math.PI / bolts);
  if (boltCircleRadius - holeRadius <= boreRadius + 0.002) {
    return invalidRim('bolt holes clear the center bore by at least 2 mm', {
      pcd,
      boltHole,
      centerBore,
      clearance: boltCircleRadius - holeRadius - boreRadius,
    });
  }
  if (adjacentBoltDistance <= boltHole + 0.002) {
    return invalidRim('adjacent bolt holes have at least 2 mm of material between them', {
      bolts,
      pcd,
      boltHole,
      adjacentBoltDistance,
    });
  }
  const hubWall = hubRadius - boltCircleRadius - holeRadius;
  if (hubWall < 0.004 || hubRadius <= boreRadius + 0.004) {
    return invalidRim('the hub has at least 4 mm of material outside every bore and bolt hole', {
      hubDiameter,
      pcd,
      boltHole,
      centerBore,
      hubWall,
    });
  }
  if (spokeInner <= 0 || spokeWidth >= 2 * spokeInner * sin(Math.PI / spokes)) {
    return invalidRim('spoke width is less than the tangential gap at the hub', {
      spokes,
      spokeWidth,
      gap: 2 * spokeInner * sin(Math.PI / spokes),
      spokeInner,
    });
  }
  if (hubRadius + 0.006 >= radius - barrelThickness) {
    return invalidRim('the hub leaves a radial gap for straight spokes to the barrel', {
      hubDiameter,
      diameter,
      barrelThickness,
      hubRadius,
    });
  }
  const offsetRange: Range = [-width / 2 + 0.001, width / 2 - 0.001];
  const offsetCheck = inRange('offset', offset, offsetRange);
  if (!offsetCheck.ok) return offsetCheck;

  const wellDepth = Math.min(0.026, 0.08 * diameter, 0.15 * width);
  const wellHalfWidth = Math.min(0.006, 0.08 * width);
  const beadSeatDepth = Math.min(0.025, 0.25 * width);
  const innerRadius = radius - wellDepth;
  const halfWidth = width / 2;
  const outerRadius = radius + flangeHeight;
  const barrelProfile: Point2[] = [
    [outerRadius, -halfWidth - flangeLip],
    [outerRadius, -halfWidth],
    [radius, -halfWidth],
    [radius, -halfWidth + beadSeatDepth],
    [innerRadius, -wellHalfWidth],
    [innerRadius, wellHalfWidth],
    [radius, halfWidth - beadSeatDepth],
    [radius, halfWidth],
    [outerRadius, halfWidth],
    [outerRadius, halfWidth + flangeLip],
    [outerRadius - barrelThickness, halfWidth + flangeLip],
    [outerRadius - barrelThickness, halfWidth],
    [radius - barrelThickness, halfWidth],
    [radius - barrelThickness, halfWidth - beadSeatDepth],
    [innerRadius - barrelThickness, wellHalfWidth],
    [innerRadius - barrelThickness, -wellHalfWidth],
    [radius - barrelThickness, -halfWidth + beadSeatDepth],
    [radius - barrelThickness, -halfWidth],
    [outerRadius - barrelThickness, -halfWidth],
    [outerRadius - barrelThickness, -halfWidth - flangeLip],
    [outerRadius, -halfWidth - flangeLip],
  ];
  const hub = model();
  hub.extrudePolygon({
    points: circleInXZ(hubRadius, segments),
    holes: [
      circleInXZ(boreRadius, segments, 0, 0, Math.PI / segments),
      ...Array.from({ length: bolts }, (_, i) => {
        const angle = (2 * Math.PI * i) / bolts;
        return circleInXZ(
          holeRadius,
          Math.min(32, segments),
          boltCircleRadius * sin(angle),
          boltCircleRadius * cos(angle),
          Math.PI / Math.min(32, segments),
        );
      }),
    ],
    depth: hubThickness,
    label: `${name}-hub`,
    tag: `${name}-hub`,
  });
  hub.rotate(sel.createdBy(`${name}-hub`), 'x', -90);
  hub.translate(sel.createdBy(`${name}-hub`), [0, hubInnerY, 0]);
  if (hub.poisoned !== undefined) return err(hub.poisoned);

  const spokeModel = model();
  const spokeOuter = radius + 0.002;
  for (let i = 0; i < spokes; i++) {
    const angle = (2 * Math.PI * i) / spokes;
    const sx = sin(angle);
    const sz = cos(angle);
    const tx = cos(angle);
    const tz = -sin(angle);
    const halfSpoke = spokeWidth / 2;
    const at = (r: number, tangent: number): Point2 => [
      r * sx + tangent * tx,
      -(r * sz + tangent * tz),
    ];
    const label = `${name}-spoke-${i}`;
    spokeModel.extrudePolygon({
      points: [
        at(spokeInner, -halfSpoke),
        at(spokeInner, halfSpoke),
        at(spokeOuter, halfSpoke),
        at(spokeOuter, -halfSpoke),
      ],
      depth: hubThickness,
      label,
      tag: `${name}-spoke`,
    });
    spokeModel.rotate(sel.createdBy(label), 'x', -90);
    spokeModel.translate(sel.createdBy(label), [0, hubInnerY, 0]);
    if (spokeModel.poisoned !== undefined) return err(spokeModel.poisoned);
  }

  const rim = model();
  rim.revolve({
    points: barrelProfile,
    segments,
    label: `${name}-barrel`,
    tag: `${name}-barrel`,
  });
  if (rim.poisoned !== undefined) return err(rim.poisoned);
  hub.union(spokeModel);
  if (hub.poisoned !== undefined) return err(hub.poisoned);
  hub.union(rim);
  if (hub.poisoned !== undefined) return err(hub.poisoned);
  hub.assign(sel.createdBy(`${name}-barrel`), 'aluminum');
  hub.assign(sel.createdBy(`${name}-hub`), 'aluminum');
  hub.assign(sel.createdBy(`${name}-spoke-0`), 'aluminum');
  for (let i = 1; i < spokes; i++) hub.assign(sel.createdBy(`${name}-spoke-${i}`), 'aluminum');
  if (hub.poisoned !== undefined) return err(hub.poisoned);

  const anchors: Record<string, Tuple3> = {
    center: [0, 0, 0],
    mount: [0, offset, 0],
  };
  for (let i = 0; i < bolts; i++) {
    const angle = (2 * Math.PI * i) / bolts;
    anchors[`bolt-${i}`] = [boltCircleRadius * sin(angle), offset, boltCircleRadius * cos(angle)];
  }
  return finishPart(hub, name, anchors, {
    diameter,
    width,
    offset,
    pcd,
    bolts,
    boltHole,
    centerBore,
    spokes,
    spokeWidth,
    hubDiameter,
    flangeHeight,
    barrelThickness,
    segments,
    backspacing: width / 2 + offset,
    flangeOuterDiameter: diameter + 2 * flangeHeight,
    hubThickness,
    hubInnerY,
  });
}
