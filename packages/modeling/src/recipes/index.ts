import { ballBearing } from './bearing';
import { hydraulicCylinder } from './cylinder';
import { hexBolt, hexNut, washer } from './fasteners';
import { gear } from './gear';
import { hinge } from './hinge';
import { clevis, lug, pinJoint } from './pin-joint';
import { bushing, rodEnd } from './plain';
import { rack } from './rack';
import { slideRail } from './rail';
import { coilSpring } from './spring';
import { overCenterLock } from './toggle';

export { BALL_BEARING_RANGES, type BallBearingOptions } from './bearing';
export type { Range, RecipeNaming, RecipePart } from './common';
export { HYDRAULIC_CYLINDER_RANGES, type HydraulicCylinderOptions } from './cylinder';
export {
  clearanceRadius,
  HEX_BOLT_RANGES,
  type HexBoltOptions,
  type HexNutOptions,
  METRIC_SIZES,
  type MetricSize,
  metric,
  type WasherOptions,
} from './fasteners';
export { FIT_CLASSES, type FitClass, type IsoFit, isoFit } from './fits';
export { GEAR_RANGES, type GearOptions, gearOutline } from './gear';
export { HINGE_RANGES, type HingeOptions } from './hinge';
export {
  type ClevisOptions,
  fitSegments,
  type LugOptions,
  type LugShape,
  PIN_JOINT_RANGES,
  type PinJointOptions,
} from './pin-joint';
export {
  BUSHING_RANGES,
  type BushingOptions,
  ROD_END_RANGES,
  type RodEndOptions,
} from './plain';
export { RACK_RANGES, type RackOptions } from './rack';
export { SLIDE_RAIL_RANGES, type SlideRailOptions } from './rail';
export { COIL_SPRING_RANGES, type CoilSpringOptions } from './spring';
export { OVER_CENTER_LOCK_RANGES, type OverCenterLockOptions } from './toggle';

/**
 * Parametric mechanical parts. Each recipe validates its parameters against its
 * declared ranges, builds an ordinary modeling session and returns it with assembly
 * anchors and derived dimensions, or the first structured failure.
 */
export const recipes = {
  gear,
  hydraulicCylinder,
  ballBearing,
  hexBolt,
  hexNut,
  washer,
  coilSpring,
  hinge,
  slideRail,
  rack,
  pinJoint,
  lug,
  clevis,
  bushing,
  rodEnd,
  overCenterLock,
} as const;
