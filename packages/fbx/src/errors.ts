// errors.ts — FbxError definitions SSOT + factory.
//
// Per requirements AC-09 + plan-strategy D-5 (DIP), FbxErrorCode +
// FbxErrorDetail + FbxError + the private error policy owner are the FBX
// importer's own error SSOT, local to this package. Subsequent milestones
// append per-section members as needed.
//
// Producers MUST go through `fbxErr` so any FbxErrorCode addition that
// lacks a matching detail variant fails at the call site (TS exhaustive
// per-arm).

export { err, ok, type Result } from '@forgeax/engine-types';

// === FbxErrorCode — closed union SSOT ===

/**
 * Closed `FbxErrorCode` union derived from the private `DetailFor` map below.
 * That map is the single code/detail authority for parser diagnostics; the
 * ufbx WASM parser needs no native-addon build step.
 *
 * Domain-separated from `ImportErrorCode` (importer dispatch surface in
 * @forgeax/engine-types) and `AssetErrorCode` (runtime registry surface).
 */
export type FbxErrorCode = keyof DetailFor;

// === Per-code detail shapes ===

/** `fbx-mesh-type-unsupported` payload: surface type + mesh name. */
export interface FbxMeshTypeUnsupportedDetail {
  readonly meshType: 'nurbs' | 'patch';
  readonly meshName: string;
}

export interface FbxLodDisplayModeUnsupportedDetail {
  readonly displayMode: 'eShow' | 'eHide';
}

export type FbxAnimationTargetInvalidDetail =
  | {
      readonly reason: 'hierarchy-cycle';
      readonly nodeIndex: number;
    }
  | {
      readonly reason:
        | 'name-missing'
        | 'path-invalid'
        | 'path-duplicate'
        | 'path-not-found'
        | 'id-collision';
      readonly clipIndex: number;
      readonly channelIndex: number;
      readonly targetNode: string;
    };

/** Discriminated detail family unifying all FbxError variants. */
export type FbxErrorDetail = DetailFor[FbxErrorCode];

// === FbxError discriminated union ===

export type FbxError = {
  readonly [C in FbxErrorCode]: {
    readonly code: C;
    readonly expected: string;
    readonly hint: string;
    readonly detail: DetailFor[C];
  };
}[FbxErrorCode];

// === Private expected/hint policy owner + public hint projection ===

const fbxErrorPolicy = {
  'fbx-mesh-type-unsupported': {
    expected: 'all meshes in the file are polygon (triangles/quads), not NURBS or patch surfaces',
    hint: 'NURBS and patch surfaces are not supported; convert to polygon mesh in a DCC tool before import',
  },
  'fbx-animation-target-invalid': {
    expected:
      'an acyclic hierarchy where every animation channel uniquely matches one named Scene node and stable target ID',
    hint: 'name every node, keep the hierarchy acyclic, and export unique full animation target paths',
  },
  'fbx-lod-display-mode-unsupported': {
    expected: 'FbxLODGroup display mode to preserve one selectable level per view',
    hint: 'change the FbxLODGroup display mode to eLODGroup or remove the forced display mode before import',
  },
} satisfies {
  readonly [Code in FbxErrorCode]: {
    readonly expected: string;
    readonly hint: string;
  };
};

export const FBX_ERROR_HINTS: Readonly<Record<FbxErrorCode, string>> = Object.fromEntries(
  Object.entries(fbxErrorPolicy).map(([code, policy]) => [code, policy.hint]),
) as Readonly<Record<FbxErrorCode, string>>;

// === DetailFor map + fbxErr factory ===

interface DetailFor {
  readonly 'fbx-mesh-type-unsupported': FbxMeshTypeUnsupportedDetail;
  readonly 'fbx-animation-target-invalid': FbxAnimationTargetInvalidDetail;
  readonly 'fbx-lod-display-mode-unsupported': FbxLodDisplayModeUnsupportedDetail;
}

/**
 * Build a fully-typed FbxError. The discriminated-union return type lets
 * call sites narrow with `switch (e.code)` on the result.
 *
 * Charter P3 explicit-failure: `expected` + `hint` fields are sourced from
 * the private policy owner — no producer can omit them.
 */
export function fbxErr<C extends FbxErrorCode>(
  code: C,
  detail: DetailFor[C],
): Extract<FbxError, { readonly code: C }> {
  return {
    code,
    expected: fbxErrorPolicy[code].expected,
    hint: fbxErrorPolicy[code].hint,
    detail,
  } as Extract<FbxError, { readonly code: C }>;
}
