import type { AssetArtifactError } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface ArtifactPathContext {
  readonly packageRoot: string;
  readonly guid: string;
  readonly artifactKey: string;
}

const PATH_HINT =
  'use a normalized package-relative artifact path without traversal, absolute prefixes, or remote URLs';

export function validateArtifactPath(
  locator: string,
  context: ArtifactPathContext,
): Result<string, AssetArtifactError> {
  const decoded = decodeLocator(locator);
  if (!decoded.ok) return invalidPath(locator, context);

  const normalized = normalizeRelativePath(decoded.value);
  if (!normalized) return invalidPath(locator, context);

  return ok(normalized);
}

function decodeLocator(locator: string): Result<string, null> {
  let decoded = locator;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return err(null);
  }
  return ok(decoded);
}

function normalizeRelativePath(locator: string): string | null {
  if (locator.length === 0 || locator.includes('://')) return null;
  if (locator.startsWith('/') || /^[A-Za-z]:[\\/]/.test(locator)) return null;

  const segments = locator.replaceAll('\\', '/').split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '..') return null;
    if (segment === '' || segment === '.') continue;
    normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join('/') : null;
}

function invalidPath(
  locator: string,
  context: ArtifactPathContext,
): Result<never, AssetArtifactError> {
  return err({
    code: 'asset-artifact-path-invalid',
    expected: 'a normalized package-relative artifact path',
    hint: PATH_HINT,
    detail: {
      guid: context.guid,
      artifactKey: context.artifactKey,
      observed: locator,
      expected: context.packageRoot,
    },
  });
}

/** Inspect decoded Pack descriptors without opening or copying artifact bodies. */
export function visitPackArtifactDescriptors(
  pack: unknown,
  visit: (
    descriptor: Readonly<Record<string, unknown>> & { readonly path: string },
  ) => string | undefined,
  requireMaps = false,
): string | undefined {
  const assets = pack && typeof pack === 'object' && 'assets' in pack ? pack.assets : undefined;
  if (!Array.isArray(assets)) return 'published Pack does not contain an assets array';
  for (const asset of assets) {
    if (asset === null || typeof asset !== 'object')
      return 'published Pack contains a non-object asset row';
    const artifacts: unknown = asset.artifacts;
    if (artifacts === undefined && !requireMaps) continue;
    if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts))
      return 'published Pack contains an invalid asset artifact map';
    for (const [key, raw] of Object.entries(artifacts)) {
      if (raw === null || typeof raw !== 'object')
        return `artifact descriptor ${key} is not an object`;
      const descriptor = raw as Record<string, unknown>;
      if (typeof descriptor.path !== 'string' || (!requireMaps && descriptor.path.length === 0))
        return `artifact descriptor ${key} has no package-relative path`;
      const error = visit(descriptor as typeof descriptor & { path: string });
      if (error !== undefined) return error;
    }
  }
  return undefined;
}
