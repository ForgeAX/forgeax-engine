import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { semanticDdcKey as ownerSemanticDdcKey } from './key.js';

export interface BuildDdcInput {
  readonly schemaVersion: string;
  readonly importerVersion: string;
  readonly codecVersion: string;
  readonly sourceDependencies: readonly (
    | string
    | { readonly path: string; readonly digest: string }
  )[];
  readonly settings: unknown;
  readonly declaredGuids: readonly string[];
  readonly cookProfile: string;
  readonly sourceOverrides?: unknown;
  readonly publish?: unknown;
}

export function resolveDdcRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return join(current, 'node_modules/.cache/forgeax-ddc');
    }
    const parent = dirname(current);
    if (parent === current) return join(resolve(cwd), 'node_modules/.cache/forgeax-ddc');
    current = parent;
  }
}

/** Derive the build key while keeping publish URLs out of the semantic identity. */
export function semanticBuildKey(input: BuildDdcInput): string {
  const hasSourceOverrides =
    input.sourceOverrides !== undefined &&
    typeof input.sourceOverrides === 'object' &&
    input.sourceOverrides !== null &&
    !Array.isArray(input.sourceOverrides) &&
    Object.keys(input.sourceOverrides).length > 0;
  const settings = hasSourceOverrides
    ? { settings: input.settings, sourceOverrides: input.sourceOverrides }
    : input.settings;
  return ownerSemanticDdcKey({
    schemaVersion: input.schemaVersion,
    importer: input.importerVersion,
    codec: input.codecVersion,
    settings,
    sourceBytes: input.sourceDependencies
      .map((dependency) =>
        typeof dependency === 'string'
          ? dependency.replaceAll('\\', '/').replace(/^.*\/(assets\/)/, '$1')
          : dependency.digest,
      )
      .sort()
      .map((digest) => new TextEncoder().encode(digest)),
    declaredGuids: input.declaredGuids,
    targetProfile: input.cookProfile,
    producer: input.importerVersion,
  });
}
