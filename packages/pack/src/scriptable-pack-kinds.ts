import type { Asset } from '@forgeax/engine-types';

/** Closed ordinary kind vocabulary shared by Pack discovery and producers. */
export type ScriptablePackAssetKind = Asset['kind'];

export const SCRIPTABLE_PACK_ASSET_KINDS = [
  'plugin',
  'mesh',
  'material',
  'scene',
  'texture',
  'texture-generator',
  'gpu-texture',
  'equirect',
  'sampler',
  'font',
  'render-pipeline',
  'tileset',
  'video',
  'skeleton',
  'skin',
  'animation-clip',
  'animation-graph',
  'audio',
  'particle-effect',
  'ies-profile',
  'terrain',
  'navigation-mesh',
  'water-body',
  'water-zone',
  'water-wave-set',
  'water-brush-recipe',
  'water-simulation-recipe',
] as const satisfies readonly ScriptablePackAssetKind[];

export function isScriptablePackAssetKind(value: string): value is ScriptablePackAssetKind {
  return (SCRIPTABLE_PACK_ASSET_KINDS as readonly string[]).includes(value);
}
