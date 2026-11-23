// Engine owner capabilities; ordinary game code uses the public Scene entry.
export { compileKeyedSceneAssetSteps } from './instances/keyed';
export {
  prepareSceneTransformsSteps,
  ScenePreparationError,
  type ScenePreparationReason,
  type SceneTransformPreparation,
} from './instances/preparation';
export {
  createSceneRetirement,
  type SceneRetirement,
  SceneRetirementError,
  type SceneRetirementReason,
  type SceneRetirementStatus,
} from './instances/retirement';
export {
  assertSceneRosterObservation,
  isSceneRosterObservation,
  prepareSceneRosterParticipation,
  SceneRosterError,
  type SceneRosterFailure,
  type SceneRosterObservation,
  type SceneRosterParticipation,
  type SceneRosterPreparation,
} from './instances/roster-participation';
export {
  type SceneInstantiationContext,
  worldInstantiateSceneSteps,
} from './instances/scene-instances';
export { captureSceneSourceGuard, type SceneSourceGuard } from './instances/source-guard';
export {
  retainSceneSourceReferences,
  type SceneSourceReferenceCustody,
} from './instances/source-references';
export { SynchronousTransform } from './synchronous-transform';
