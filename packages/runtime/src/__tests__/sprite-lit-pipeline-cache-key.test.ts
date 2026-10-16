// @forgeax/engine-runtime / __tests__ / sprite-lit-pipeline-cache-key.test.ts
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t2.
//
// Red-stage tests for the sprite-lit pipeline cache-key STRING ISOLATION
// (D-11 remap, AC-08 post-rewrite).
//
// post-PR-#520 reality: pipeline cache lives inside createRenderer behind
// `getMaterialShaderPipeline(materialShaderId, isHdr, renderState?, topology?,
// indexFormat?, variantSet?, passKind?, meshAttributes?, sampleCount?,
// colorFormatOverride?)`. The cache key is keyed FIRST by the
// `materialShaderId` string, so the addition of `forgeax::sprite-lit`
// strictly grows the cache by net-new keys without colliding with the
// pre-existing `forgeax::sprite` family of PSOs.
//
// This test exercises the STRING shape of the cache key prefix (without
// booting WebGPU). The full PSO build path is exercised by t11 smoke +
// t12 pixel-parity.
//
// SSOTs:
//   - render-system.ts getMaterialShaderPipeline 9-arg signature SSOT
//   - plan-strategy D-11 (AC-08 remap: cache key string isolation)
//   - plan-strategy D-1 (D-6 mirror sprite, NO shared registration)
//   - requirements AC-08 / AC-12

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SPRITE_ID: string = 'forgeax::sprite';
const SPRITE_LIT_ID: string = 'forgeax::sprite-lit';

/**
 * Lower bound TS port of the per-shader cache key. The real key in
 * createRenderer concatenates more fields (renderState, topology,
 * indexFormat, variantSet, passKind, meshAttributes, sampleCount,
 * colorFormatOverride), but the FIRST segment is always
 * `materialShaderId` — D-11 string isolation is established by that
 * leading segment alone, regardless of the suffix shape.
 *
 * For test purposes we model the 9-arg key flatly with `::` separators.
 */
interface PipelineKeyParts {
  readonly materialShaderId: string;
  readonly isHdr: boolean;
  readonly variantSet?: string;
  readonly passKind?: 'forward' | 'shadow-caster';
  readonly sampleCount?: number;
}

function deriveCacheKey(p: PipelineKeyParts): string {
  return [
    p.materialShaderId,
    p.isHdr ? 'hdr' : 'ldr',
    p.variantSet ?? '',
    p.passKind ?? 'forward',
    String(p.sampleCount ?? 1),
  ].join('::');
}

describe('sprite-lit pipeline cache-key string isolation (D-11 remap, AC-08)', () => {
  it('cache key prefix begins with materialShaderId (D-11 leading segment SSOT)', () => {
    const key = deriveCacheKey({ materialShaderId: SPRITE_LIT_ID, isHdr: false });
    expect(key.startsWith(`${SPRITE_LIT_ID}::`)).toBe(true);
  });

  it('sprite-lit key NEVER prefix-collides with sprite key (D-11 string isolation)', () => {
    // The post-PR-#520 cache is keyed on the full string, but the
    // `materialShaderId` leading segment is the critical isolator: if
    // it changes, the suffix can never produce a collision. Validate
    // that the two shader id strings are PREFIX-incomparable (neither
    // is a prefix of the other, even at the `::` separator).
    expect(SPRITE_LIT_ID.startsWith(`${SPRITE_ID}::`)).toBe(false);
    expect(SPRITE_ID.startsWith(`${SPRITE_LIT_ID}::`)).toBe(false);
    // And the shader ids differ outright.
    expect(SPRITE_ID === SPRITE_LIT_ID).toBe(false);
  });

  it('product of (sprite, sprite-lit) x (ldr, hdr) yields 4 distinct keys', () => {
    const keys = new Set<string>();
    for (const id of [SPRITE_ID, SPRITE_LIT_ID]) {
      for (const isHdr of [false, true]) {
        keys.add(deriveCacheKey({ materialShaderId: id, isHdr }));
      }
    }
    expect(keys.size).toBe(4);
  });

  it('product of (sprite, sprite-lit) x (ldr, hdr) x (msaa 1/4) yields 8 distinct keys', () => {
    // AC-12 anchor: sprite's pre-existing 4 PSO family (sampleCount 1/4 x
    // isHdr false/true) is preserved; sprite-lit adds a parallel 4 PSO
    // family, NOT sharing slots.
    const keys = new Set<string>();
    for (const id of [SPRITE_ID, SPRITE_LIT_ID]) {
      for (const isHdr of [false, true]) {
        for (const sampleCount of [1, 4]) {
          keys.add(deriveCacheKey({ materialShaderId: id, isHdr, sampleCount }));
        }
      }
    }
    expect(keys.size).toBe(8);
  });

  it('cache key changes when isHdr flips (negative gate vs key collapse)', () => {
    const ldr = deriveCacheKey({ materialShaderId: SPRITE_LIT_ID, isHdr: false });
    const hdr = deriveCacheKey({ materialShaderId: SPRITE_LIT_ID, isHdr: true });
    expect(ldr).not.toBe(hdr);
  });

  it('createRenderer wiring contract: sprite-lit must be registered alongside sprite', async () => {
    // Static source gate: createRenderer.ts must mention both shader
    // identifiers in its registration code path. The literal must
    // appear in source for the runtime to ship sprite-lit as a
    // recognised material shader.
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      fileURLToPath(new URL('../../../render/src/assembly/webgpu-renderer.ts', import.meta.url)),
      'utf8',
    );
    // Once t7 wires it, both literals appear (sprite already in tree).
    expect(src.includes("'forgeax::sprite'")).toBe(true);
    expect(src.includes("'forgeax::sprite-lit'")).toBe(true);
  });
});
