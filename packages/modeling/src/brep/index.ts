export { type BlendSide, type Section, sectionOf } from './blend';
export { type BooleanOp, booleanSolids } from './boolean';
export * from './build';
export { chamferBetween, chamferEdgeGeometry } from './chamfer';
export * from './collider-fit';
export * from './continuity';
export { curvePoint, curveTangent, pcurveFor, pcurvePoint, pcurveTangent } from './curves';
export * from './diagnostics';
export { type DraftedPrismOptions, draftedPrism } from './draft';
export * from './edit';
export { type PipeElbowOptions, pipeElbow } from './elbow';
export * from './feature-constraints';
export { type EdgeBlend, filletBetween, filletEdgeGeometry } from './fillet';
export { type FilletBoxOptions, filletBox } from './fillet-box';
export { type FilletCylinderOptions, filletCylinder } from './fillet-cylinder';
export { type FilletPrismOptions, filletPrism } from './fillet-prism';
export * from './heal';
export { type HousingOptions, housing } from './housing';
export {
  type BranchPCurve,
  branchPCurvePoint,
  type IntersectionBranch,
  type IntersectionPartial,
  type IntersectionPartialCode,
  type IntersectionReceipt,
  type IntersectionWindow,
  type IntersectOptions,
  intersectSurfaces,
  type SurfaceIntersection,
} from './intersect';
export * from './loft';
export * from './measure';
export { measureTrimmedFace, type TrimmedFaceMeasure } from './measure-trimmed';
export { offsetSurface } from './offset';
export * from './pattern';
export {
  type QuadOptions,
  type QuadReport,
  type QuadResult,
  type QuadSource,
  quadrangulate,
} from './quad';
export { type IsoFace, type IsoHost, type IsoStep, isoQuadricFace } from './quad-iso-quadric';
export * from './query';
export * from './revolve-profile';
export { type FaceQuery, faceReference, selectFace, selectFaces } from './select';
export * from './serialize';
export { type RevolveShellOptions, revolveShell } from './shell';
export * from './ssi';
export {
  frameDefect,
  makeFrame,
  type SurfaceDomain,
  type SurfaceInverse,
  surfaceDerivatives,
  surfaceDomain,
  surfaceInverse,
  surfaceNormal,
  surfacePoint,
  wrapPeriod,
} from './surfaces';
export * from './sweep';
export {
  type SampledMesh,
  type TessellateOptions,
  tessellate,
  tessellateSampled,
} from './tessellate';
export { axisRotation, IDENTITY_PLACEMENT, type Placement, transformShape } from './transform';
export { classifyOnFace, type FaceTrim, faceTrim, inFaceUv, type TrimClass } from './trim-face';
export {
  type BranchSpan,
  type BranchSpans,
  cutBranch,
  type SpanCut,
  type SpanCutKind,
} from './trim-span';
export { type TubOptions, tub } from './tub';
export * from './types';
export { type BrepIssue, type ShellTopology, type ValidationReport, validate } from './validate';
