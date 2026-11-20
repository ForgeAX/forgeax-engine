import { err, ok } from '@forgeax/engine-types';
import { MaterialResource } from '../material-resource';
import {
  type MaterialSnapshotContexts,
  materialSnapshotContext,
  type RenderableSnapshot,
} from '../render-system-extract';
import { sameValue } from '../same-value';
import { captureMaterialOverrides } from './mesh-materials';
import type { MeshSourceContent } from './mesh-source-resources';
import { type MeshSourceStageInput, StagedMeshSourceError } from './staged-mesh-source';

export interface PublishedLevelMeshInput {
  readonly members: readonly number[];
  readonly chunks: readonly (readonly RenderableSnapshot[])[];
  readonly content: MeshSourceContent;
  /** Currency of the sealed row roster. The content lease owns asset currency. */
  isCurrent(): boolean;
}

/** Level transport owns the sealed inputs. The composition owns all derived residency. */
export class PublishedMeshSource implements MeshSourceStageInput {
  constructor(
    readonly namespace: object,
    private readonly input: PublishedLevelMeshInput,
  ) {}

  get members(): readonly number[] {
    return this.input.members;
  }

  get version(): object {
    return this.input;
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new StagedMeshSourceError({ reason: 'source' });
  }

  isCurrent(): boolean {
    return this.input.isCurrent();
  }

  *extract(current: () => boolean): ReturnType<MeshSourceStageInput['extract']> {
    const materialSnapshots: MaterialSnapshotContexts = new Map();
    const renderables: RenderableSnapshot[] = [];
    // Within a sealed chunk all uses of a material ID share its decoded resource.
    // A distinct decoded resource still needs to agree with the canonical snapshot.
    const adopted = new Map<MaterialResource, MaterialResource>();
    const adopt = (resource: MaterialResource): MaterialResource => {
      const known = adopted.get(resource);
      if (known !== undefined) return known;
      const snapshot = resource.snapshot;
      const context = snapshot.materialContext;
      const handle = snapshot.materialHandle;
      if (context === undefined || handle === undefined) return resource;
      const assetRevision = this.input.content.version(handle).unwrap();
      const cache = materialSnapshotContext(
        materialSnapshots,
        context.geometry,
        context.vertexColor,
      );
      const prior = cache.get(handle);
      if (prior !== undefined) {
        if (prior.assetRevision !== assetRevision || !sameValue(prior.snapshot, snapshot))
          throw new StagedMeshSourceError({ reason: 'material' });
      } else cache.set(handle, { assetRevision, snapshot });
      const accepted = prior === undefined ? resource : MaterialResource.from(prior.snapshot);
      adopted.set(resource, accepted);
      return accepted;
    };
    try {
      for (const chunk of this.input.chunks) {
        for (const row of chunk) {
          const overrides = row.materialOverrides;
          renderables.push({
            ...row,
            // A sealed M1 source keeps these poses fixed for its entire residency.
            mobility: 'static',
            material: adopt(row.material),
            materials: row.materials.map(adopt),
            ...(overrides === undefined
              ? {}
              : {
                  materialOverrides: captureMaterialOverrides(
                    overrides.map((resource) =>
                      resource === undefined ? undefined : adopt(resource),
                    ),
                  ),
                }),
          });
        }
        // The receiving protocol already bounds each sealed chunk.
        yield;
      }
      return ok({ renderables, materialSnapshots, isCurrent: current });
    } catch (cause) {
      return err(new StagedMeshSourceError({ reason: 'material' }, cause));
    }
  }

  // Only the receiving frame can open the gate. Retirement closes it before releasing rows.
  stopped(): boolean {
    return true;
  }

  dispose(): void {}
}
