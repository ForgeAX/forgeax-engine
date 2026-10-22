export { skeletonContribution, skinContribution } from './assets/skin-decoder';
export {
  JointCountMismatchError,
  JointEntityDanglingError,
  SkeletonResolveFailedError,
  SkinAssetUnresolvedError,
  type SkinError,
  type SkinErrorCode,
  SkinInstancesCoexistForbiddenError,
  SkinJointPathUnresolvedError,
} from './errors';
export { type FitShadowCapsulesOptions, fitShadowCapsules } from './fit-shadow-capsules';
export { skinningPlugin } from './plugin';
export { resolveSkinJoints } from './resolve-skin-joints';
export { Skin } from './skin';
export { skinVertexPosition } from './skin-vertex-position';
