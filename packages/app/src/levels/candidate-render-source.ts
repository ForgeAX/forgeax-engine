import type { AssetContentLease } from '@forgeax/engine-assets-runtime/internal';
import type {
  LevelSourceHost,
  SourceViewPreparation,
  StagedMeshSource,
  StagedMeshSourceError,
} from '@forgeax/engine-render/internal';
import type { SceneRosterObservation } from '@forgeax/engine-scene/internal';
import { ok, type Result } from '@forgeax/engine-types';

export interface LevelRenderSelection {
  readonly active: boolean;
  readonly frameId: number;
  readonly revision: number;
}

export interface CandidateRenderSource extends Omit<StagedMeshSource, 'group' | 'setActive'> {
  setActive(active: boolean): Result<void | Promise<LevelRenderSelection>, StagedMeshSourceError>;
}

export interface CandidateRenderPreparation {
  readonly source: CandidateRenderSource;
  readonly prepareViews?: (current: () => boolean) => SourceViewPreparation;
}

export interface CandidateRenderHost {
  current(): boolean;
  beginStagedGroup(
    observation: SceneRosterObservation,
    content: AssetContentLease,
  ): Result<CandidateRenderPreparation, StagedMeshSourceError>;
}

export class LevelViewObsoleteError extends Error {
  constructor(cause: unknown) {
    super('The current Renderer Views require Level preparation', { cause });
  }
}

/** Only the local adapter can use a Render-owned group token. */
export function localLevelRenderHost(host: LevelSourceHost): CandidateRenderHost {
  return {
    current: host.current,
    beginStagedGroup(observation, content) {
      const begun = host.beginStagedGroup(observation, content);
      if (!begun.ok) return begun;
      const source = begun.value;
      return ok({
        source,
        prepareViews: (current) => host.prepareViews(source.group, current),
      });
    },
  };
}
