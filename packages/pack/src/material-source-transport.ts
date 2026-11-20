import { err, ok, type Result } from '@forgeax/engine-types';
import {
  createMaterialArtifactDigest,
  MATERIAL_RASTER_SOURCES_PATH,
  type MaterialCookProgram,
  type MaterialCookRasterSourceArtifact,
  type SourceCookedMaterialRecord,
  validateCookedMaterialRecord,
  validateMaterialRasterSourcePublication,
  validateSourceCookedMaterialRecord,
} from './evidence/material-cook.js';
import type { PackageFinalizerError, PackageProductAsset } from './package-finalizer.js';

function materialSourceFailure(
  guid: string,
  expected: string,
): Result<never, PackageFinalizerError> {
  return err({
    code: 'invalid-material-source',
    expected,
    hint: 'rebuild the material and raster source from the same Pack cook',
    detail: { guid, key: MATERIAL_RASTER_SOURCES_PATH },
  });
}

function readSourceArtifact(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function canUseSource(program: MaterialCookProgram): boolean {
  return program.selections.every(
    ({ context, address, abi }) =>
      context.pipeline !== 'ray' && address !== undefined && abi !== undefined,
  );
}

function compactMaterialAsset(
  asset: PackageProductAsset,
): Result<PackageProductAsset, PackageFinalizerError> {
  if (asset.kind !== 'material' || asset.payload.cooked === undefined) return ok(asset);
  const compiled = validateCookedMaterialRecord(asset.payload.cooked, (path, digest) => {
    const body = asset.artifacts[path];
    if (body?.mediaType === 'text/wgsl' && createMaterialArtifactDigest(body.bytes) === digest)
      return body.bytes;
    return undefined;
  });
  if (!compiled.ok)
    return materialSourceFailure(asset.guid, `a valid cook at ${compiled.error.detail.field}`);
  const publication = validateMaterialRasterSourcePublication(
    readSourceArtifact(asset.artifacts[MATERIAL_RASTER_SOURCES_PATH]?.bytes),
    compiled.value,
  );
  if (!publication.ok)
    return materialSourceFailure(
      asset.guid,
      `raster source matching ${publication.error.detail.field}`,
    );
  const removedPaths = new Set<string>();
  const retainedPaths = new Set<string>();
  const programs = compiled.value.programs.map((program) => {
    const { path, digest, mediaType } = program.artifact;
    if (!canUseSource(program)) {
      retainedPaths.add(path);
      return program;
    }
    removedPaths.add(path);
    const artifact: MaterialCookRasterSourceArtifact = {
      backing: 'raster-source',
      path,
      digest,
      mediaType,
    };
    return { ...program, artifact };
  });
  const source: SourceCookedMaterialRecord = {
    ...compiled.value,
    schemaVersion: 'material-cook/6',
    programs,
  };
  const staged = validateSourceCookedMaterialRecord(source);
  if (!staged.ok)
    return materialSourceFailure(
      asset.guid,
      `valid raster source transport at ${staged.error.detail.field}`,
    );
  return ok({
    ...asset,
    payload: { ...asset.payload, cooked: staged.value },
    artifacts: Object.fromEntries(
      Object.entries(asset.artifacts).filter(
        ([key]) => !removedPaths.has(key) || retainedPaths.has(key),
      ),
    ),
  });
}

/** Apply delivery policy after the producer's complete Cook record has been created. */
export function compactRasterSourcePackageAssets(
  assets: readonly PackageProductAsset[],
): Result<readonly PackageProductAsset[], PackageFinalizerError> {
  const compacted: PackageProductAsset[] = [];
  for (const asset of assets) {
    const ready = compactMaterialAsset(asset);
    if (!ready.ok) return ready;
    compacted.push(ready.value);
  }
  return ok(compacted);
}
