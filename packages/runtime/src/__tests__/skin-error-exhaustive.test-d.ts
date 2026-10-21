// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): skin cluster
// exhaustive type-level regression guard (see render-error-exhaustive.test-d.ts
// header for the shared pattern rationale). SkinErrorCode folds the 3-member
// SkinExtractErrorCode subset union.

import type { SkinError, SkinErrorCode } from '@forgeax/engine-skinning';

function exhaustiveSwitchOnSkinCode(code: SkinErrorCode): string {
  switch (code) {
    case 'skin-asset-unresolved':
      return code;
    case 'skin-joint-path-unresolved':
      return code;
    case 'skin-instances-coexist-forbidden':
      return code;
    // SkinExtractErrorCode subset union (extract-stage fail-fast).
    case 'skeleton-resolve-failed':
      return code;
    case 'joint-count-mismatch':
      return code;
    case 'joint-entity-dangling':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function narrowSkinError(err: SkinError): void {
  switch (err.code) {
    case 'skin-asset-unresolved':
      void err.detail.skinEntity;
      void err.detail.skeletonHandle;
      break;
    case 'skin-joint-path-unresolved':
      void err.detail.skinEntity; // number
      void err.detail.path; // readonly string[]
      break;
    case 'skin-instances-coexist-forbidden':
      void err.detail.entity; // number
      break;
    case 'skeleton-resolve-failed':
      void err.detail.entity; // number
      void err.detail.skeletonHandle; // number
      break;
    case 'joint-count-mismatch':
      void err.detail.entity; // number
      void err.detail.expected; // number
      void err.detail.actual; // number
      break;
    case 'joint-entity-dangling':
      void err.detail.entity; // number
      void err.detail.jointIndex; // number
      break;
    default: {
      const exhaustive: never = err;
      void exhaustive;
    }
  }
}

export type _SkinExhaustiveChecks = {
  /** @internal forces tsc to type-check the exhaustive switch on SkinErrorCode. */
  _check: ReturnType<typeof exhaustiveSwitchOnSkinCode>;
  /** @internal forces tsc to type-check the SkinError detail narrowing. */
  _narrow: typeof narrowSkinError;
};
