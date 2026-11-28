export {
  type Clearance,
  type ClearanceKind,
  type ClearanceOptions,
  clearanceBetween,
} from './clearance';
export type { FaceCurve } from './contour';
export {
  type Closest,
  type Contact,
  closestOnEdge,
  closestOnFace,
  closestOnShape,
  type Foot,
  type SearchOptions,
  type ShapeDistance,
  type SignedDistance,
  shapeDistance,
  shapeLowerBound,
  signedDistance,
} from './distance';
export { type Plane, type PlaneSection, type SectionOptions, sectionByPlane } from './section';
export { type Camera, type Silhouette, type SilhouetteOptions, silhouette } from './silhouette';
export type { JoinedCurve } from './stitch';
