import { readFileSync } from 'node:fs';
import { projectShaderConditionals } from '../../../shader-compiler/src/conditionals';

/** Select native texture signatures before dropping imports in numeric kernel fixtures. */
export function nativeAtmosphereSource(name: string): string {
  const source = readFileSync(new URL(`../../../shader/src/${name}.wgsl`, import.meta.url), 'utf8');
  return projectShaderConditionals(
    source,
    { STORAGE_BUFFER_AVAILABLE: true, CLUSTER_FORWARD_AVAILABLE: false },
    'all',
  ).replace(/^#.*$/gm, '');
}
