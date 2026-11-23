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

/** Assemble the production optical helpers used by both native numeric oracles. */
export function nativeAtmosphereKernel(): string {
  const common = nativeAtmosphereSource('common');
  const toneMapping = nativeAtmosphereSource('tone-mapping');
  const structs = ['AtmosphereMedium', 'View'].map((name) => {
    const body = new RegExp(`struct ${name} \\{[\\s\\S]*?\\};`).exec(common)?.[0];
    if (body === undefined) throw new Error(`Missing production struct ${name}`);
    return body;
  });
  const outputTransform = ['acesInput', 'acesOutput', 'tonemapAcesFilmic'].map((name) =>
    productionFunction(toneMapping, name),
  );
  return [
    ...outputTransform,
    ...structs,
    productionFunction(common, 'view_atmosphere_aerial_enabled'),
    productionFunction(common, 'view_atmosphere_fast_ap'),
    productionFunction(common, 'view_atmosphere_fast_ap_samples'),
    'fn atmosphere_scene_visibility(m:AtmosphereMedium,p:vec3<f32>)->f32{return 1.0;}',
    ...[
      'atmosphere-table-access',
      'atmosphere-optics',
      'atmosphere-coordinates',
      'atmosphere-sampling',
    ].map(nativeAtmosphereSource),
  ].join('\n');
}

function productionFunction(source: string, name: string): string {
  const body = new RegExp(`fn ${name}\\([\\s\\S]*?\n}`).exec(source)?.[0];
  if (body === undefined) throw new Error(`Missing production function ${name}`);
  return body;
}
