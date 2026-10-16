import { deriveDefaultLodScreenCoverages, reconcileMeshLodMeta } from '@forgeax/engine-import';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface FbxLodMetaLevel {
  readonly sourceKey: string;
  readonly guid: string;
  readonly screenCoverage?: number;
}

export interface FbxLodMetaOutput {
  readonly sourceKey: string;
  readonly guid: string;
  readonly screenCoverage: number;
}

export function projectFbxLodMeta(input: {
  readonly rootSourceKey: string;
  readonly levels: readonly FbxLodMetaLevel[];
  readonly previous?: readonly FbxLodMetaLevel[] | undefined;
}): Result<
  { readonly lods: readonly FbxLodMetaOutput[] },
  { readonly code: string; readonly reason: string }
> {
  const defaults = deriveDefaultLodScreenCoverages(input.levels.length + 1);
  const next = input.levels.map((level, index) => ({
    sourceKey: level.sourceKey,
    meshGuid: level.guid,
    ...(level.screenCoverage === undefined
      ? { screenCoverage: defaults[index] ?? 0 }
      : { screenCoverage: level.screenCoverage }),
  }));
  const previous = (input.previous ?? []).map((level) => ({
    sourceKey: level.sourceKey,
    meshGuid: level.guid,
    ...(level.screenCoverage === undefined ? {} : { screenCoverage: level.screenCoverage }),
  }));
  const reconciled = reconcileMeshLodMeta(previous, next);
  if (!reconciled.ok) return err({ code: reconciled.error.code, reason: reconciled.error.reason });
  return ok({
    lods: reconciled.value.lods.map((level) => ({
      sourceKey: level.sourceKey,
      guid: level.meshGuid,
      screenCoverage: level.screenCoverage,
    })),
  });
}
