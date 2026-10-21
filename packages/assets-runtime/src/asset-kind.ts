import type { AssetKind, BuiltinAssetKind } from '@forgeax/engine-types';

/** Create the type witness shared by one custom decoder lease and its loads. */
export function defineAssetKind<P, K extends string = string>(kind: K): AssetKind<P, K> {
  return Object.freeze({ kind }) as AssetKind<P, K>;
}

// Exhaustive admission boundary: a custom payload's optional `kind` field never
// selects built-in validation or makes an unvalidated custom asset editable.
const BUILTIN_KINDS = {
  plugin: true,
  mesh: true,
  texture: true,
  equirect: true,
  sampler: true,
  material: true,
  scene: true,
  skeleton: true,
  skin: true,
  'animation-clip': true,
  'animation-graph': true,
  audio: true,
  'ies-profile': true,
  font: true,
  'render-pipeline': true,
  tileset: true,
  video: true,
  'particle-effect': true,
  terrain: true,
  'navigation-mesh': true,
} satisfies Record<BuiltinAssetKind, true>;

export function isBuiltinAssetKind(kind: string): kind is BuiltinAssetKind {
  return Object.hasOwn(BUILTIN_KINDS, kind);
}
