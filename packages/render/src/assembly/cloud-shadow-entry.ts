import type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';

/** Keep the cloud-shadow shader and View layout on one capability branch. */
function hasCloudShadowViewBindings(wgsl: string): boolean {
  return /@group\(0\)\s*@binding\((?:16|17)\)\s/.test(wgsl);
}

export function selectCloudShadowCompatibleEntry(
  entry: ManifestEntry,
  materialEntry: MaterialShaderManifestEntry | undefined,
  projectorAvailable: boolean,
): ManifestEntry {
  if (projectorAvailable || !hasCloudShadowViewBindings(entry.wgsl)) return entry;
  const fallback = materialEntry?.variants.find(
    (variant) =>
      variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE !== true &&
      (!('PROJECTOR_AVAILABLE' in variant.defines) ||
        variant.defines.PROJECTOR_AVAILABLE === false) &&
      !hasCloudShadowViewBindings(variant.composedWgsl),
  );
  return fallback === undefined ? entry : { ...entry, wgsl: fallback.composedWgsl };
}
