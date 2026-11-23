import type { StandardSceneSurfaceAdmission } from '../temporal/scene-data';
import { createSceneDataCatalog, type SceneDataCatalog } from '../temporal/scene-data-catalog';
import { sameSceneSurfaceAdmission } from '../temporal/standard-scene-data-admission';

/** One admitted view owns catalog authority for its current surface and device. */
export class FeatureSceneDataView {
  private readonly catalogs = new WeakMap<{ readonly identity: string }, SceneDataCatalog>();

  constructor(
    readonly identity: string,
    readonly admission: StandardSceneSurfaceAdmission | undefined,
    readonly revision: number,
    readonly deviceGeneration: number,
    readonly rgba16floatRenderable: boolean,
  ) {}

  catalog(feature: { readonly identity: string }, generation: number): SceneDataCatalog {
    const current = this.catalogs.get(feature);
    if (current?.generation === generation) return current;
    const catalog = createSceneDataCatalog({
      featureIdentity: feature.identity,
      viewIdentity: this.identity,
      deviceGeneration: this.deviceGeneration,
      rgba16floatRenderable: this.rgba16floatRenderable,
      generation,
      planIdentity: `${feature.identity}:${this.identity}:${generation}`,
      ...(this.admission === undefined
        ? {}
        : {
            surfaceAdmission: this.admission,
            surfaceAdmissionRevision: this.revision,
          }),
    });
    this.catalogs.set(feature, catalog);
    return catalog;
  }
}

/** The full input roster establishes view lifetime. Older frames may still own their admitted view. */
export class FeatureSceneDataViews {
  private readonly active = new Map<string, FeatureSceneDataView>();
  private revision = 0;

  admit(
    identity: string,
    admission: StandardSceneSurfaceAdmission | undefined,
    deviceGeneration: number,
    rgba16floatRenderable: boolean,
  ): FeatureSceneDataView {
    const current = this.active.get(identity);
    if (
      current !== undefined &&
      current.deviceGeneration === deviceGeneration &&
      current.rgba16floatRenderable === rgba16floatRenderable &&
      sameSceneSurfaceAdmission(current.admission, admission)
    )
      return current;
    const view = new FeatureSceneDataView(
      identity,
      admission,
      ++this.revision,
      deviceGeneration,
      rgba16floatRenderable,
    );
    this.active.set(identity, view);
    return view;
  }

  retainViews(roster: ReadonlyMap<string, unknown>): void {
    for (const id of this.active.keys()) if (!roster.has(id)) this.active.delete(id);
  }

  clear(): void {
    this.active.clear();
  }
}
