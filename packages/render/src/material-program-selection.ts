import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  assertMaterialStaticSelection,
  findMaterialPassProgram,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import {
  type MaterialCookRasterContext,
  materialProgramContextForPass,
} from '@forgeax/engine-pack/material-cook';
import {
  findVariantByDefines,
  isShaderTemplateManifestRow,
  materialShaderVariantsWithAxis,
  rayMaterialNeedsCoverage,
} from '@forgeax/engine-shader';
import type {
  MaterialAsset,
  MaterialPass,
  MaterialProgramAbi,
  MaterialSurfaceModel,
} from '@forgeax/engine-types';
import { materialProgramUsesSkin } from '@forgeax/engine-types';
import { runtimeMaterialShaderIdForMaterial } from './material-resource';
import { isCanonicalStandardPbrMaterialShader } from './pbr-pipeline';
import type { MaterialSceneIndexProgramKey, MaterialSnapshot } from './render-system-extract';

/**
 * A skinned row certifies its position when the program it actually draws
 * with does: a stock axis program (the default ShadowCaster) selects its
 * `SKINNING_DISABLED=false` variants for Skin geometry, so every one of them
 * must carry the proof; the static primary receipt says nothing about them.
 */
export function skinnedPositionProof(
  receipt: MaterialProgramAbi | undefined,
  key: string,
  shaders: Pick<AssetRegistry['shaderRegistry'], 'materialShaderManifestEntry'>,
): boolean {
  if (receipt !== undefined && materialProgramUsesSkin(receipt))
    return receipt.positionBounds === 'standard-input';
  const manifest = shaders.materialShaderManifestEntry(key);
  if (
    key === 'forgeax::default-shadow-caster' &&
    manifest !== undefined &&
    isShaderTemplateManifestRow(manifest)
  ) {
    // The stock caster's producer supplies one position contract for every Skin recipe.
    const selected = findVariantByDefines(manifest, { SKINNING_DISABLED: false })?.receipt;
    return selected?.positionBounds === 'standard-input' && materialProgramUsesSkin(selected);
  }
  if (manifest === undefined) return false;
  let found = false;
  for (const variant of materialShaderVariantsWithAxis(manifest, 'SKINNING_DISABLED', false)) {
    if (
      variant.receipt?.positionBounds !== 'standard-input' ||
      !materialProgramUsesSkin(variant.receipt)
    )
      return false;
    found = true;
  }
  return found;
}

/**
 * Select the runtime identity for one resolved material. A cooked publication
 * owns the composed material artifact identity; the authored pass module is
 * the built-in fallback used before that publication is ready.
 */
export function materialProgramKeysForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  vertexColorAvailable = false,
): Readonly<Record<string, string>> | undefined {
  return materialProgramKeysForAddress(material, assets, context, 'direct', vertexColorAvailable);
}

/** Raster remains usable without a ray program; a ray consumer must refuse that absence. */
export function materialSurfaceProgramsForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  effective: Parameters<typeof rayMaterialNeedsCoverage>[0],
): MaterialSnapshot['materialSurfacePrograms'] {
  if (
    context === undefined ||
    context.backend === 'webgl2' ||
    context.capability === 'uniform-fallback' ||
    context.geometry !== 'mesh' ||
    context.instrumentation !== 'none'
  )
    return undefined;
  const projection = materialProjectionForSelection(material, assets);
  const pass = material.passes?.find((entry) => entry.name.toLowerCase() === 'forward');
  if (projection === undefined || pass === undefined) return undefined;
  const programs: NonNullable<MaterialSnapshot['materialSurfacePrograms']> = {};
  for (const surfaceContext of ['ray-hit', 'card-capture'] as const) {
    try {
      const selected = findMaterialPassProgram(projection, pass.name, {
        backend: context.backend,
        capability: 'storage-buffer',
        pipeline: 'ray',
        geometry: 'mesh',
        ...(surfaceContext === 'ray-hit'
          ? ({ pass: 'ray-hit', profile: 'forgeax-material-ray-v1' } as const)
          : ({ pass: 'card-capture', profile: 'forgeax-material-card-v4' } as const)),
        toolchain: context.toolchain,
        instrumentation: 'none',
      });
      if (selected === undefined) continue;
      Object.assign(programs, {
        [surfaceContext]:
          surfaceContext === 'ray-hit'
            ? {
                programKey: selected.specializationKey,
                evaluateCoverage: rayMaterialNeedsCoverage(effective),
              }
            : { programKey: selected.specializationKey },
      });
    } catch (error) {
      if (
        isMissingMaterialProgram(error) &&
        (error as { detail?: { matches?: number } }).detail?.matches === 0
      )
        continue;
      throw error;
    }
  }
  return Object.keys(programs).length === 0 ? undefined : programs;
}

/**
 * Return the exact direct/scene-index programs selected for one renderer
 * context.  The selection result is kept next to the key projection so
 * consumers that validate a mesh contract can inspect the producer ABI
 * without rebuilding pass/context matching from payload order.
 */
export interface MaterialProgramSelection {
  readonly pass: string;
  readonly context: MaterialCookRasterContext;
  readonly specializationKey: string;
  readonly abi?: MaterialProgramAbi;
}

function materialProjectionForSelection(material: MaterialAsset, assets: AssetRegistry) {
  const projection = assets.getMaterialProjectionForPayload(material);
  assertMaterialStaticSelection(material.staticSwitches, projection);
  return projection;
}

export function materialProgramSelectionsForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  address: 'direct' | 'scene-index' = 'direct',
  vertexColorAvailable = false,
): readonly MaterialProgramSelection[] | undefined {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined) return undefined;
  if (context === undefined)
    throw new Error('Published material selection requires renderer-owned compiler context');
  return (material.passes ?? []).map((pass) => {
    const mode = String(
      (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
    );
    const selectedContext = materialProgramContextForPass(context, mode);
    const selected = selectMaterialPassProgram(
      projection,
      pass.name,
      selectedContext,
      address,
      vertexColorAvailable,
    );
    return {
      pass: pass.name,
      context: selectedContext,
      specializationKey: selected.specializationKey,
      ...(selected.abi === undefined ? {} : { abi: selected.abi }),
    };
  });
}

/** Freeze lineage from the accepted payload and its already selected programs. */
export function materialPublicationForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  selected: readonly MaterialProgramSelection[] | undefined,
  vertexColorAvailable = false,
): MaterialSnapshot['materialPublication'] {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined || selected === undefined) return undefined;
  return Object.freeze({
    identity: Object.freeze({
      materialGuid: projection.materialGuid,
      publicationGeneration: projection.publicationGeneration,
      specializationKey: projection.specializationKey,
      artifactHash: projection.artifactHash,
    }),
    programs: Object.freeze(
      selected.map((program) =>
        Object.freeze({
          pass: program.pass,
          context: Object.freeze({ ...program.context }),
          address: 'direct' as const,
          specializationKey: program.specializationKey,
          artifactHash: selectMaterialPassProgram(
            projection,
            program.pass,
            program.context,
            'direct',
            vertexColorAvailable,
          ).artifactHash,
        }),
      ),
    ),
  });
}

/** Resolve the producer's scene-index program key for each cooked Pass. */
export function materialSceneIndexProgramKeysForMaterial(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  vertexColorAvailable = false,
): Readonly<Record<string, MaterialSceneIndexProgramKey>> | undefined {
  const projection = materialProjectionForSelection(material, assets);
  if (projection === undefined) return undefined;
  if (context === undefined)
    throw new Error('Published material selection requires renderer-owned compiler context');
  const entries: Record<string, MaterialSceneIndexProgramKey> = {};
  for (const pass of material.passes ?? []) {
    const mode = String(
      (pass.renderState?.tags as Record<string, unknown> | undefined)?.LightMode ?? pass.name,
    );
    const selectedContext = materialProgramContextForPass(context, mode);
    try {
      const selected = findMaterialPassProgram(
        projection,
        pass.name,
        selectedContext,
        'scene-index',
        vertexColorAvailable,
      );
      if (selected === undefined) continue;
      entries[pass.name] = {
        specializationKey: selected.specializationKey,
        pass: selectedContext.pass,
      };
    } catch (error) {
      if (!isMissingMaterialProgram(error)) throw error;
    }
  }
  return Object.keys(entries).length === 0 ? undefined : entries;
}

function isMissingMaterialProgram(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly code?: unknown }).code === 'material-specialization-not-cooked'
  );
}

function materialProgramKeysForAddress(
  material: MaterialAsset,
  assets: AssetRegistry,
  context: MaterialCookRasterContext | undefined,
  address: 'direct' | 'scene-index',
  vertexColorAvailable = false,
): Readonly<Record<string, string>> | undefined {
  const selections = materialProgramSelectionsForMaterial(
    material,
    assets,
    context,
    address,
    vertexColorAvailable,
  );
  return selections === undefined
    ? undefined
    : Object.fromEntries(
        selections.map(({ pass, specializationKey }) => [pass, specializationKey]),
      );
}

/** The authored Surface/root defines semantics; cooked program hashes do not. */
export function materialSurfaceModel(
  passes: readonly MaterialPass[],
  declared: MaterialSurfaceModel | undefined,
): MaterialSurfaceModel | undefined {
  if (declared !== undefined) return declared;
  const authored = runtimeMaterialShaderIdForMaterial(passes, undefined);
  return isCanonicalStandardPbrMaterialShader(authored) &&
    !passes.some(
      (pass) =>
        (pass.renderState?.tags as Readonly<Record<string, unknown>> | undefined)?.SurfaceKind ===
        'full-custom',
    )
    ? 'standard'
    : undefined;
}
