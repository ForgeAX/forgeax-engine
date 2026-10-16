/** Immutable Scene collection policy shared by runtime collectors. */
export interface SceneCollectProfile {
  readonly includeComponent: (componentName: string, transient: boolean) => boolean;
  readonly includeField: (componentName: string, fieldName: string, transient: boolean) => boolean;
}

export const SCENE_COLLECT_PROFILE: SceneCollectProfile = Object.freeze({
  includeComponent: (_componentName: string, transient: boolean) => !transient,
  includeField: (_componentName: string, _fieldName: string, transient: boolean) => !transient,
});
