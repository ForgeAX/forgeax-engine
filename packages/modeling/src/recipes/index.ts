import { ballBearing } from './bearing';
import { blindRivet, grommet, pushClip, weldNut } from './body-fasteners';
import { cable, catenary } from './cable';
import { cam, camFollowerGuide } from './cam';
import { hydraulicCylinder } from './cylinder';
import {
  escapementReleaseAngle,
  escapementStopAngle,
  escapementWheel,
  steelyardStop,
} from './escapement';
import { hexBolt, hexNut, washer } from './fasteners';
import { gear } from './gear';
import { hinge } from './hinge';
import { clevis, lug, pinJoint } from './pin-joint';
import { bushing, rodEnd } from './plain';
import { rack } from './rack';
import { slideRail } from './rail';
import { pawl, ratchet } from './ratchet';
import { coilSpring } from './spring';
import { chainLink, sprocket } from './sprocket';
import { overCenterLock } from './toggle';
import { tyre, tyreSize, wheelRim } from './wheel';

export { BALL_BEARING_RANGES, type BallBearingOptions } from './bearing';
export {
  BLIND_RIVET_RANGES,
  type BlindRivetOptions,
  GROMMET_RANGES,
  type GrommetOptions,
  PUSH_CLIP_RANGES,
  type PushClipOptions,
  WELD_NUT_RANGES,
  type WeldNutOptions,
  type WeldNutPilot,
} from './body-fasteners';
export {
  CABLE_RANGES,
  type CableFitting,
  type CableOptions,
  type Catenary,
  catenary,
} from './cable';
export { CAI_GRADE_RANGE, CAI_GRADES, type CaiFen, type CaiGrade, caiFen } from './caifen';
export {
  CAM_GUIDE_RANGES,
  CAM_RANGES,
  type CamFollowerGuideOptions,
  type CamOptions,
  cam,
  camFollowerGuide,
} from './cam';
export type { Range, RecipeNaming, RecipePart } from './common';
export { HYDRAULIC_CYLINDER_RANGES, type HydraulicCylinderOptions } from './cylinder';
export { DOUGONG_RANGES, type DougongOptions, type DougongPuzuo, dougong } from './dougong';
export {
  ESCAPEMENT_RANGES,
  type EscapementWheelOptions,
  escapementReleaseAngle,
  escapementStopAngle,
  escapementWheel,
  type SteelyardStopOptions,
  steelyardStop,
} from './escapement';
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
  JUZHE_ROOF_RANGES,
  type JuzheKind,
  type JuzhePurlin,
  type JuzheRoofOptions,
  juzhePurlins,
  juzheRoof,
} from './juzhe-roof';
export {
  LATTICE_PATTERN_RANGES,
  LATTICE_PATTERNS,
  type LatticePattern,
  type LatticePatternOptions,
  latticePattern,
} from './lattice';
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
export {
  PAWL_RANGES,
  type PawlOptions,
  pawl,
  RATCHET_RANGES,
  type RatchetOptions,
  ratchet,
  ratchetPawlAngle,
} from './ratchet';
export { COIL_SPRING_RANGES, type CoilSpringOptions } from './spring';
export {
  CHAIN_LINK_RANGES,
  type ChainLinkOptions,
  type ChainPlacement,
  chainClosure,
  chainLink,
  chainPlacements,
  SPROCKET_RANGES,
  type SprocketOptions,
  sprocket,
} from './sprocket';
export {
  TILE_ROWS_RANGES,
  type TileRowsOptions,
  tileRows,
} from './tile-rows';
export {
  TIMBER_JOINT_RANGES,
  type TimberJointKind,
  type TimberJointOptions,
  timberJoint,
} from './timber-joint';
export { OVER_CENTER_LOCK_RANGES, type OverCenterLockOptions } from './toggle';
export {
  TYRE_RANGES,
  TYRE_SIZE_RANGES,
  type TyreDimensions,
  type TyreOptions,
  type TyreSize,
  tyreSize,
  WHEEL_RIM_RANGES,
  type WheelRimOptions,
} from './wheel';

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
  ratchet,
  pawl,
  sprocket,
  chainLink,
  cam,
  camFollowerGuide,
  escapementWheel,
  steelyardStop,
  escapementReleaseAngle,
  escapementStopAngle,
  pinJoint,
  lug,
  clevis,
  bushing,
  rodEnd,
  overCenterLock,
  pushClip,
  weldNut,
  blindRivet,
  grommet,
  tyreSize,
  tyre,
  wheelRim,
  catenary,
  cable,
} as const;
