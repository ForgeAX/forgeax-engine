import { resolve } from 'node:path';
import type { PackError } from '@forgeax/engine-pack/errors';
import { STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS, scanInventory } from '@forgeax/engine-pack/scanner';
import type { ScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { owningAssetLibrary } from './asset-libraries.js';
import { isPluginAssetSourceIgnoredPath } from './build/plugin-assets.js';
import type { CommandError, ProjectFacts } from './types.js';

/** Project asset roots followed by the read-only roots of mounted asset libraries. */
export function projectSourceRoots(facts: ProjectFacts): string[] {
  return [
    ...facts.assetRoots.map((root) => resolve(facts.root, root)),
    ...facts.assetLibraries.map((library) => library.root),
  ];
}

/**
 * The one authored-source scan shared by Play, builds and `project check`, so a
 * Pack the live generation contract rejects fails the same way everywhere.
 */
export function scanProjectSources(
  facts: ProjectFacts,
  roots: readonly string[],
  options: {
    readonly sourceSnapshot?: ScriptablePackSourceSnapshot;
    readonly onSourceFailure?: (path: string, error: PackError) => void;
  } = {},
) {
  return scanInventory(roots, {
    ignorePath: (path) =>
      isPluginAssetSourceIgnoredPath(
        owningAssetLibrary(facts.assetLibraries, path)?.root ?? facts.root,
        path,
      ),
    scriptablePack: {
      ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
      metadataOnly: true,
      ...(options.sourceSnapshot === undefined ? {} : { sourceSnapshot: options.sourceSnapshot }),
    },
    ...(options.onSourceFailure === undefined ? {} : { onSourceFailure: options.onSourceFailure }),
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reports the innermost authored-source diagnostic of a failed scan. A Pack
 * source failure is wrapped as malformed metadata by the scanner; the wrapped
 * code (for example `pack-source-mutation-unsupported`) names the actual rule.
 */
export function projectSourceFailure(cause: unknown): CommandError {
  const outer = record(cause);
  const inner = record(outer?.cause);
  const owner =
    typeof inner?.code === 'string' &&
    typeof inner.expected === 'string' &&
    typeof inner.hint === 'string'
      ? inner
      : outer;
  const detail = record(owner?.detail) ?? {};
  const outerDetail = record(outer?.detail);
  return {
    code: typeof owner?.code === 'string' ? owner.code : 'project-source-invalid',
    expected:
      typeof owner?.expected === 'string' ? owner.expected : 'every authored Pack source to load',
    hint:
      typeof owner?.hint === 'string'
        ? owner.hint
        : 'Repair the reported Pack source and run project check again.',
    detail: {
      ...detail,
      ...(owner !== outer && typeof outer?.code === 'string' ? { via: outer.code } : {}),
      ...(owner !== outer && typeof outerDetail?.path === 'string'
        ? { path: outerDetail.path }
        : {}),
    },
  };
}
