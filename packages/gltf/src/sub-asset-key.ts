// sub-asset-key.ts - sub-asset addressing key (w13).
//
// `subAssetKey` builds the deterministic three-tuple
// `{ kind, name, indexFallback }` from a parsed GltfDoc item; the tuple
// is the input to the two-stage matching algorithm in
// `reimport-reuse-meta.ts`. Pure function, no I/O.
//
// `indexFallback` literal shape: `${pluralKind}/${sourceIndex}` (per
// plan-decisions.md L-2 and bevy_gltf comparison wiki section 3 - forgeax
// keeps the bevy `meshes/<i>` style anchor as the second-stage match key).
// Pluralisation is closed: glTF 2.0 sub-asset categories are `mesh`,
// `material`, `scene`, `node`, `texture`, `image`, `sampler`, `animation`,
// `camera`, `skin`. Tier-B v1 only emits the first three; the closed map
// fails closed for unrecognised inputs (charter proposition 4 explicit
// failure - any new kind the importer learns to emit MUST be registered
// here, otherwise the build break is the warning).

export interface GltfDocItemLike {
  readonly kind: string;
  readonly sourceIndex: number;
  readonly name?: string;
}

export interface SubAssetKey {
  readonly kind: string;
  readonly name: string | null;
  readonly indexFallback: string;
}

const PLURAL: Readonly<Record<string, string>> = {
  mesh: 'meshes',
  material: 'materials',
  scene: 'scenes',
  node: 'nodes',
  texture: 'textures',
  image: 'images',
  sampler: 'samplers',
  animation: 'animations',
  camera: 'cameras',
  skin: 'skins',
  skeleton: 'skeletons',
  'animation-clip': 'animation-clips',
};

function pluraliseKind(kind: string): string {
  const known = PLURAL[kind];
  if (known !== undefined) return known;
  // Unknown kinds fall back to a naive `+s` so `subAssetKey` stays total
  // (no exception path); the importer will normally never emit an
  // unknown kind because parseGltf only constructs items from the closed
  // Tier-B list.
  return `${kind}s`;
}

export function subAssetKey(item: GltfDocItemLike): SubAssetKey {
  return {
    kind: item.kind,
    name: item.name ?? null,
    indexFallback: `${pluraliseKind(item.kind)}/${item.sourceIndex}`,
  };
}
