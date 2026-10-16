// feat-20260704-runtime-tier1-decomposition M2 / w13 (AC-07 c): asset cluster
// exhaustive type-level regression guard (see render-error-exhaustive.test-d.ts
// header for the shared pattern rationale).

import type { AssetRuntimeError, AssetRuntimeErrorCode } from '@forgeax/engine-assets-runtime';

function exhaustiveSwitchOnAssetCode(code: AssetRuntimeErrorCode): string {
  switch (code) {
    case 'material-resolved-empty-passes':
      return code;
    case 'mesh-ssbo-capacity-exceeded':
      return code;
    case 'mesh-ssbo-ceiling-reached':
      return code;
    case 'scene-collect-entity-ref-out-of-closure':
      return code;
    case 'scene-collect-asset-guid-unresolved':
      return code;
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function narrowAssetError(err: AssetRuntimeError): void {
  switch (err.code) {
    case 'material-resolved-empty-passes':
      void err.detail.materialGuid; // string
      void err.detail.reason; // 'missing-parent' | 'no-pass-in-chain'
      break;
    case 'mesh-ssbo-capacity-exceeded':
      void err.detail.requested; // number
      void err.detail.capacity; // number
      void err.detail.ceiling; // number
      break;
    case 'mesh-ssbo-ceiling-reached':
      void err.detail.requested; // number
      void err.detail.capacity; // number
      void err.detail.ceiling; // number
      break;
    case 'scene-collect-entity-ref-out-of-closure':
      void err.detail.entity; // number
      void err.detail.field; // string
      void err.detail.target; // number
      break;
    case 'scene-collect-asset-guid-unresolved':
      void err.detail.field; // string
      break;
    default: {
      const exhaustive: never = err;
      void exhaustive;
    }
  }
}

export type _AssetExhaustiveChecks = {
  /** @internal forces tsc to type-check the exhaustive switch on AssetRuntimeErrorCode. */
  _check: ReturnType<typeof exhaustiveSwitchOnAssetCode>;
  /** @internal forces tsc to type-check the AssetRuntimeError detail narrowing. */
  _narrow: typeof narrowAssetError;
};
