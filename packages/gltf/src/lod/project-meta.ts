import { deriveDefaultLodScreenCoverages, reconcileMeshLodMeta } from '@forgeax/engine-import';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface GltfLodMetaLevel {
  readonly sourceKey: string;
  readonly guid: string;
  readonly screenCoverage?: number;
}

export interface GltfLodMetaCandidate {
  readonly rootSourceKey: string;
  readonly levels: readonly GltfLodMetaLevel[];
  readonly previous?: readonly GltfLodMetaLevel[] | undefined;
}

export interface GltfLodMetaOutput {
  readonly sourceKey: string;
  readonly meshGuid: string;
  readonly screenCoverage: number;
}

export function projectGltfLodMeta(
  input: GltfLodMetaCandidate,
): Result<
  { readonly lods: readonly GltfLodMetaOutput[] },
  { readonly code: string; readonly reason: string }
> {
  const defaults = deriveDefaultLodScreenCoverages(input.levels.length + 1);
  const previous = (input.previous ?? []).map((level) => ({
    sourceKey: level.sourceKey,
    meshGuid: level.guid,
    ...(level.screenCoverage === undefined ? {} : { screenCoverage: level.screenCoverage }),
  }));
  const next = input.levels.map((level, index) => ({
    sourceKey: level.sourceKey,
    meshGuid: level.guid,
    screenCoverage: level.screenCoverage ?? defaults[index] ?? 0,
  }));
  const reconciled = reconcileMeshLodMeta(previous, next);
  if (!reconciled.ok) return err({ code: reconciled.error.code, reason: reconciled.error.reason });
  return ok({
    lods: reconciled.value.lods.map((level) => ({
      sourceKey: level.sourceKey,
      meshGuid: level.meshGuid,
      screenCoverage: level.screenCoverage,
    })),
  });
}
