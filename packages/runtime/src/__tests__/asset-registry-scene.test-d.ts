// asset-registry-scene.test-d - type-level assertion that the 5-element
// AssetUnion exhaustive switch narrows correctly without a default arm
// (feat-20260514-scene-as-world-blueprint w6 / AC-01 / AC-03; merged with
// feat-20260514-ecs-children-instances-managed-buffer-array M3 / w15 which
// retired the `'instanced-buffer-asset'` variant -> Asset closed-union
// 5 -> 4, then widened to 5 again with the new `'scene'` member).
//
// w3 widens `Asset` to include `SceneAsset` and the runtime exhaustiveness
// guard narrows correctly. The exhaustive switch below doubles as a
// negative regression: deleting any case produces a `never` flow (TS reports
// `Type 'SceneAsset' is not assignable to type 'never'` at the affected
// arm), so this file fails fast if the union ever drifts.
//
// feat-20260623 M2 / w8: AssetBrand retired (PR #496 eliminated brand concept);
// the brand(asset) function and local AssetBrand type are removed. The Asset
// union exhaustive switch is the remaining type-level guard.
//
// Charter mapping: proposition 3 (machine-readable union > prose) +
// proposition 4 (explicit failure: closed-union exhaustive switch needs no
// default fallback; tsc strict mode guards completeness).

import type { Asset } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';

describe('Asset union covers all engine-known kinds', () => {
  it('Asset union is the closed type-level discriminator for engine-known assets', () => {
    // Asset is the SSOT for engine-known asset types; exhaustiveness is
    // enforced by TypeScript's closed-union narrowing. A missing member
    // triggers `Type 'XxxAsset' is not assignable to type 'never'`.
    expectTypeOf<Asset['kind']>().toEqualTypeOf<
      | 'mesh'
      | 'texture'
      | 'sampler'
      | 'material'
      | 'scene'
      | 'equirect'
      | 'skeleton'
      | 'skin'
      | 'animation-clip'
      | 'animation-graph'
      | 'audio'
      | 'font'
      | 'render-pipeline'
      | 'tileset'
      | 'video'
      | 'particle-effect'
      | 'ies-profile'
      | 'plugin'
      | 'terrain'
      | 'navigation-mesh'
    >();
  });
});
