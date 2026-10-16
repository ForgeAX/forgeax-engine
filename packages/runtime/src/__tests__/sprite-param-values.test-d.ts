// w1 / M1 — sprite values type-level fixture (feat-20260527-sprite-nineslice).
// feat-20260625-refactor-sprite-as-transparent-mesh M3 / w11 update (D-4, D-6,
// F-3): paramSchema is UBO-aligned (4 vec4 + baseColorTexture); SpriteParamValues
// mirrors this 1:1.
//
// Type-level fixture for the sprite material `values` literal at the
// MaterialAsset construction call-site. This is the AI-user-facing
// autocomplete + ts-expect-error surface for the post-w11 sprite paramSchema.
//
// SpriteParamValues is a local helper type — it is NOT a public sibling
// type of MaterialAsset (plan-strategy section D-1: do not introduce a
// SpriteMaterialAsset variant). It mirrors the field set of
// `packages/shader/src/sprite.material.json#paramSchema` 1:1 so AI users
// get the right autocomplete and the right ts-expect-error when they pass
// the wrong shape.
//
// Field set must match paramSchema name set: colorTint / region /
// pivotAndSize / slicesAndMode (UBO vec4 fields) + baseColorTexture
// (texture2d). Bidirectional diff check is the implementer's responsibility
// at commit time (plan-strategy R-7 fixture-schema alignment).
//
// slicesAndMode encodes sliceMode in the .w sign (D-3 sentinel): positive
// or zero -> stretch; NEGATIVE -> tile. The wire format on the GPU side
// reads `slicesAndMode.w < 0` as the tile dispatch (sprite.wgsl uses
// abs() to recover the magnitude). The pre-w11 fixture's `sliceMode: 0|1`
// split is replaced by this single vec4 with sentinel encoding.
//
// 4 ts-expect-error assertions:
//   (a) slicesAndMode as 3-tuple [1, 2, 3] is rejected — must be 4-tuple
//   (b) region as 3-tuple [0, 0, 1] is rejected — must be 4-tuple
//   (c) baseColorTexture as a number is rejected — must be string GUID
//   (d) missing required `baseColorTexture` field is rejected

import { describe, it } from 'vitest';

// Local helper type — paramSchema field set 1:1, no public re-export.
// `baseColorTexture` is required (paramSchema entry has no default); the
// 4 UBO vec4 fields are optional (paramSchema entries carry defaults so
// the writer falls back to identity bytes via std140 zero-fill).
type SpriteParamValues = {
  baseColorTexture: string;
  colorTint?: readonly [number, number, number, number];
  region?: readonly [number, number, number, number];
  pivotAndSize?: readonly [number, number, number, number];
  slicesAndMode?: readonly [number, number, number, number];
};

describe('w11 type-level - sprite values UBO-aligned schema (M3)', () => {
  it('accepts a fully-specified literal with slicesAndMode + pivotAndSize', () => {
    const _ok: SpriteParamValues = {
      baseColorTexture: 'tex-guid',
      colorTint: [1, 1, 1, 1],
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      // Stretch (positive .w): slicesAndMode = [l, t, r, b].
      slicesAndMode: [0.25, 0.25, 0.75, 0.75],
    };
    void _ok;
  });

  it('accepts the tile sentinel encoding (negative .w) on slicesAndMode', () => {
    const _ok: SpriteParamValues = {
      baseColorTexture: 'tex-guid',
      // Tile (negative .w): the shader reads abs() for the magnitude and
      // the sign for tile vs stretch (plan-strategy D-3 sentinel).
      slicesAndMode: [0.25, 0.25, 0.25, -0.25],
    };
    void _ok;
  });

  it('rejects slicesAndMode with wrong arity', () => {
    const _bad: SpriteParamValues = {
      baseColorTexture: 'tex-guid',
      // @ts-expect-error - slicesAndMode must be a 4-tuple, not a 3-tuple
      slicesAndMode: [1, 2, 3],
    };
    void _bad;
  });

  it('rejects region with wrong arity', () => {
    const _bad: SpriteParamValues = {
      baseColorTexture: 'tex-guid',
      // @ts-expect-error - region must be a 4-tuple, not a 3-tuple
      region: [0, 0, 1],
    };
    void _bad;
  });

  it('rejects baseColorTexture as a non-string handle', () => {
    const _bad: SpriteParamValues = {
      // @ts-expect-error - baseColorTexture must be a string AssetGuid
      baseColorTexture: 42,
    };
    void _bad;
  });

  it('rejects literal missing the required `baseColorTexture` field', () => {
    // @ts-expect-error - `baseColorTexture` is required (paramSchema entry has no default)
    const _bad: SpriteParamValues = {
      slicesAndMode: [0, 0, 1, 1],
    };
    void _bad;
  });
});
