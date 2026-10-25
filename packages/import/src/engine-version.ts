import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let version: string | undefined;

/**
 * `name@version` of the Engine package that runs this producer, read from the
 * nearest named package manifest. Pack evaluation imports Engine modules that
 * no source closure records, so cached products bind to the Engine release.
 */
export function engineProducerVersion(): string {
  if (version !== undefined) return version;
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        version = `${manifest.name}@${manifest.version}`;
        return version;
      }
    } catch {}
    if (dirname(directory) === directory) {
      version = 'unknown';
      return version;
    }
  }
}
