import { dirname, resolve } from 'node:path';
import { deriveAssetName } from './deriveAssetName.js';

function deriveSourceName(metaFileName: string): string {
  return metaFileName.replace(/\.meta\.json$/, '');
}

export function resolveAssetSource(metaPath: string, source: string | undefined): string {
  if (source === undefined) {
    const metaDir = dirname(metaPath);
    const metaName = deriveAssetName(metaPath, 1);
    const derived = deriveSourceName(metaName);
    return resolve(metaDir, derived);
  }
  return resolve(dirname(metaPath), source);
}
