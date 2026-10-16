/**
 * Last path segment of a `/`- or `\`-separated path, trailing separators
 * stripped. Inlined rather than imported from `node:path` so this module stays
 * browser-safe: the dev-server pack path (`vite-plugin-pack` `/__pack/`) runs
 * `buildCatalog` -> `deriveAssetName` in client code where `node:path` is
 * externalized and `path.basename` throws.
 */
function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Derive an asset's display name from package metadata.
 *
 * Pure function -- zero IO, zero side effects, browser-safe. Build-time
 * (build-catalog) and runtime (resolveName) share this single source of truth
 * for deterministic asset display-name resolution.
 *
 * Resolution contract:
 *   - an explicit storedName is authoritative;
 *   - a package path is the fallback when no storedName is present;
 *   - an asset without a package and without a storedName resolves to ''.
 *
 * `assetCount` remains in the signature because callers derive it from their
 * package model, but it must not erase an explicitly authored name. In
 * particular, a single authored entry in `Materials.pack.json` resolves to its
 * entry name rather than temporarily appearing as the package basename.
 */
export function deriveAssetName(
  packagePath: string | null,
  _assetCount: number,
  storedName?: string,
): string {
  if (storedName !== undefined) {
    return storedName;
  }
  if (packagePath === null) {
    return '';
  }
  return baseName(packagePath);
}
