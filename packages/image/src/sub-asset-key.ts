/**
 * Sub-asset-key shape mirroring the in-flight gltf-loader feat (plan-strategy
 * section 2.2 D-4 same-shape). Each sub-asset emitted into a `*.meta.json`
 * sidecar (uniformly `<source>.meta.json` across image / gltf arms,
 * dispatched on top-level `importer` field per feat-20260521) carries a
 * `{kind, name?, indexFallback}` triple so the importer can deterministically
 * match an existing sub-asset across reimports (charter P5 producer/consumer
 * split + AC-14 cross-feat alignment).
 *
 * The image disk schema is currently single-sub-asset; this file collapses
 * to `kind='texture'` + `indexFallback='textures/0'` so the same matching
 * algorithm is reusable when the future cubemap / array-layer feat lands
 * (plan-strategy R5 free-form schema).
 */

export interface SubAssetKey {
  /** Discriminator literal -- 'texture' for engine-image; 'mesh' / 'material' / 'scene' / 'image' for gltf-loader. */
  readonly kind: string;
  /** Optional human-readable name field; absent when the source has no symbolic identifier. */
  readonly name?: string;
  /** Path-style fallback identifier (e.g. 'images/0' / 'meshes/0'); always non-empty. */
  readonly indexFallback: string;
}

export interface SubAssetKeyInput {
  readonly kind: string;
  readonly sourceIndex: number;
  readonly name?: string;
}

/**
 * Construct a sub-asset key from importer input. The `indexFallback` is
 * synthesised from the kind literal + sourceIndex so two importers
 * (image / gltf-loader) emit identical fallback strings for the same
 * `(kind, sourceIndex)` pair (AC-14).
 */
export function subAssetKey(input: SubAssetKeyInput): SubAssetKey {
  const indexFallback = `${input.kind}s/${input.sourceIndex}`;
  if (input.name !== undefined) {
    return { kind: input.kind, name: input.name, indexFallback };
  }
  return { kind: input.kind, indexFallback };
}

/**
 * Two-phase equality predicate used by reimportReuseMeta for GUID
 * preservation across reimports:
 *
 * Phase 1 -- (kind + name + idx) full match: identical in all three fields
 * Phase 2 -- (kind + idx) match: same kind + indexFallback, name absent or
 *            equal (collapses when both sides omit name)
 * Phase 3 -- otherwise: false (importer mints fresh UUIDv7)
 *
 * The two phases are folded into a single boolean predicate here; the
 * reimportReuseMeta caller iterates the existing subAssets list and picks
 * the first hit (deterministic order; matches AC-16 byte-identical
 * reimport).
 */
export function subAssetKeyEqual(a: SubAssetKey, b: SubAssetKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.indexFallback !== b.indexFallback) return false;
  // name comparison: undefined === undefined is fine; if one side has a name
  // and the other does not, the keys are NOT equal (charter P4 explicit
  // failure -- name carries a meaningful identifier when present)
  if (a.name !== b.name) return false;
  return true;
}
