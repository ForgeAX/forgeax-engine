import type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';

type EntrySource = { readonly wgsl: string };

/**
 * Inline material source from the artifact represented by each row's identity.
 * The direct entry map can intentionally select a different capability variant
 * than the material row's all-true primary variant.
 */
export function inlineMaterialShaderComposedWgsl(
  materialShaders: readonly MaterialShaderManifestEntry[],
  entries: ReadonlyMap<string, EntrySource>,
  variantWgsl: ReadonlyMap<string, string>,
): MaterialShaderManifestEntry[] {
  return materialShaders.map((material) => {
    const defaultEntry = entries.get(material.identifier) ?? entries.get(material.sourcePath);
    const variants = material.variants.map((variant) => {
      const variantKey = `${material.sourcePath}#${variant.definesKey}`;
      const identifierVariantKey = `${material.identifier}#${variant.definesKey}`;
      const wgslSource =
        variantWgsl.get(identifierVariantKey) ??
        variantWgsl.get(variantKey) ??
        variant.composedWgsl;
      return { ...variant, composedWgsl: wgslSource };
    });

    let entryComposedWgsl = defaultEntry?.wgsl ?? material.composedWgsl;
    if (material.variants.length > 0) {
      if (material.hash === undefined) {
        throw new Error(`material primary compiled hash is missing: ${material.identifier}`);
      }
      const primaryMatches = material.variants.filter(
        (variant) =>
          variant.hash === material.hash &&
          (material.sourceDigest === undefined || variant.sourceDigest === material.sourceDigest),
      );
      if (primaryMatches.length === 0) {
        throw new Error(
          `material primary artifact is not represented by variants: ${material.identifier}`,
        );
      }
      const primarySources = primaryMatches.map(
        (variant) =>
          variantWgsl.get(`${material.identifier}#${variant.definesKey}`) ??
          variantWgsl.get(`${material.sourcePath}#${variant.definesKey}`),
      );
      const primaryWgsl = primarySources[0];
      if (primaryWgsl === undefined || primarySources.some((source) => source !== primaryWgsl)) {
        throw new Error(
          `material primary source is missing or ambiguous for ${material.identifier}`,
        );
      }
      entryComposedWgsl = primaryWgsl;
    }

    return { ...material, composedWgsl: entryComposedWgsl, variants };
  });
}
