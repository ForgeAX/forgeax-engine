import { createRequire } from 'node:module';
import { dirname } from 'node:path';

/** The exact-version Engine installation this View package depends on. */
export function installedEngineRoot(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('@forgeax/engine/package.json'));
  } catch {
    return undefined;
  }
}
