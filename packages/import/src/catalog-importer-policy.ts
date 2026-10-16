import type { CatalogImporterPolicy } from '@forgeax/engine-pack/build';
import { SHADER_RESERVED_IMPORTER_KEY } from './import-runner.js';

export type { CatalogImporterPolicy } from '@forgeax/engine-pack/build';

/** Provider keys whose external declarations have a standard Catalog route. */
export const DEFAULT_CATALOG_IMPORTER_KEYS = [
  'image',
  'gltf',
  'fbx',
  'obj',
  'stl',
  'svg',
  'audio',
  'font',
  'ui',
] as const;

export type CatalogImporterDisposition = 'publish' | 'exclude' | 'missing';

/**
 * Resolve Catalog visibility from provider registration, not from a Vite
 * adapter's importer list. The shader transform is deliberately excluded;
 * every other provider must either be a standard provider or be registered by
 * the host before its declarations can become authoritative.
 */
export function catalogImporterPolicy(
  importer: string,
  hostImporterKeys: ReadonlySet<string>,
): CatalogImporterPolicy {
  if (importer === SHADER_RESERVED_IMPORTER_KEY) {
    return {
      disposition: 'exclude',
      hostProvided: false,
      expected: 'the provider must publish cooked runtime output before Catalog projection',
      hint: 'remove the source declaration from Pack roots or publish its cooked runtime module',
    };
  }
  if ((DEFAULT_CATALOG_IMPORTER_KEYS as readonly string[]).includes(importer)) {
    return {
      disposition: 'publish',
      hostProvided: false,
      expected: 'a standard Catalog provider declaration',
      hint: 'let the provider producer materialize the declared output',
    };
  }
  if (hostImporterKeys.has(importer)) {
    return {
      disposition: 'publish',
      hostProvided: true,
      expected: 'a registered host Catalog provider declaration',
      hint: 'let the registered provider materialize the declared output',
    };
  }
  return {
    disposition: 'missing',
    hostProvided: false,
    expected: 'the sidecar importer must be present in the registered provider set',
    hint: 'wire the provider through the host importer registry before building the Catalog',
  };
}
