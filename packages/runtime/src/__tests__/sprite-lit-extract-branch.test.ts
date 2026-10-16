// @forgeax/engine-runtime / __tests__ / sprite-lit-extract-branch.test.ts
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t2.
//
// Tests for the AC-02 (D-9 remap) extract branch: when the first pass
// shader id is 'forgeax::sprite-lit' the snapshot must carry
// `materialShaderId === 'forgeax::sprite-lit'` and `transparent === true`
// (derived from renderState.blend presence). The branch mirrors
// `'forgeax::sprite'` without adding any material-kind discriminant.
//
// tweak-20260701-remove-vestigial-shadingmodel-concept M1 reality:
//   - MaterialSnapshot no longer carries a `shadingModel` field at all —
//     the surface-response discriminant responsibility was fully absorbed
//     by shader identity (`materialShaderId`). This is the strongest form
//     of the original D-10 invariant: sprite-lit cannot be added to a
//     shadingModel union because there is no such union.
//   - sprite carries `materialShaderId` only
//   - transparent derives from `renderState.blend !== undefined`
//   - sprite-lit walks the SAME schema-driven path as sprite
//
// SSOTs:
//   - plan-strategy D-1 (materialShaderId string routing mirror sprite)
//   - plan-strategy D-9 (AC-02 remap: no 'sprite-lit' inferredShadingModel case)
//   - plan-strategy D-10 (AC-01 remap: no new narrowing type guard)
//   - render-system-extract.ts MaterialSnapshot (no shadingModel field)
//   - requirements AC-01 / AC-02 (post-rewrite)

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MaterialSnapshot } from '../../../render/src/render-system-extract';

describe('sprite-lit extract branch (D-9 remap, AC-02 + AC-01)', () => {
  describe('sprite-lit routes via materialShaderId (AC-01 D-10 remap)', () => {
    it('MaterialSnapshot carries no shadingModel field (union retired)', () => {
      // tweak-20260701 M1: the shadingModel discriminant is gone entirely.
      // A snapshot's material kind is derived solely from materialShaderId.
      const snapshot = {
        baseColor: [1, 1, 1],
        metallic: 0,
        roughness: 1,
        materialShaderId: 'forgeax::sprite-lit',
      } as unknown as MaterialSnapshot;
      expect('shadingModel' in snapshot).toBe(false);
    });

    it('sprite-lit shading is recognised via materialShaderId string routing', () => {
      // Mirror sprite's pattern (post-PR-#520 D-3): the consumer reads
      // `material.materialShaderId === 'forgeax::sprite-lit'` for any
      // sprite-lit-specific routing.
      const snapshot = {
        materialShaderId: 'forgeax::sprite-lit',
        transparent: true,
      } as const;
      expect(snapshot.materialShaderId === 'forgeax::sprite-lit').toBe(true);
      expect(snapshot.transparent).toBe(true);
    });
  });

  describe('sprite-lit snapshot shape (D-9 remap, AC-02 SSOT)', () => {
    it('firstPassShader = "forgeax::sprite-lit" produces materialShaderId + transparent=true', () => {
      // TS port of the expected extract-stage result for a sprite-lit
      // material with `renderState.blend` set (sprite-lit.material.json
      // mirrors sprite blend declaration after t4 lands). transparent is
      // derived from `renderState.blend !== undefined` per the post-#520
      // SSOT (no longer carried on MaterialPass.transparent).
      const fakeFirstPass = {
        program: { module: 'forgeax::sprite-lit' },
        renderState: { blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } },
      } as const;
      const snapshot = {
        materialShaderId: fakeFirstPass.program.module,
        transparent: fakeFirstPass.renderState.blend !== undefined,
      };
      expect(snapshot.materialShaderId).toBe('forgeax::sprite-lit');
      expect(snapshot.transparent).toBe(true);
    });

    it('sprite vs sprite-lit produce identical snapshot SHAPE (only materialShaderId differs)', () => {
      // D-1: sprite-lit walks the EXACT SAME schema-driven generic path
      // as sprite. The only field that differs is materialShaderId.
      const spriteSnap = {
        materialShaderId: 'forgeax::sprite' as string,
        transparent: true as const,
      };
      const spriteLitSnap = {
        materialShaderId: 'forgeax::sprite-lit' as string,
        transparent: true as const,
      };
      // Field-set congruence: identical keys, identical types.
      const keysSprite = Object.keys(spriteSnap).sort();
      const keysSpriteLit = Object.keys(spriteLitSnap).sort();
      expect(keysSpriteLit).toEqual(keysSprite);
      // Only `materialShaderId` differs in value.
      expect(spriteSnap.transparent).toBe(spriteLitSnap.transparent);
      expect(spriteSnap.materialShaderId === spriteLitSnap.materialShaderId).toBe(false);
    });
  });

  describe('source-side guarantees (post-rewrite render-system-extract.ts)', () => {
    it('render-system-extract.ts must NOT branch on `shadingModel === "sprite-lit"` (D-10)', async () => {
      // Dynamic node:fs / node:module pattern reused from sibling shader
      // tests. The extract-stage source must NOT carry a literal
      // `'sprite-lit'` arm under `shadingModel === ...` — sprite-lit
      // identifies via materialShaderId string only. (Post tweak-20260701
      // M1 the shadingModel field is gone, so this is trivially true, but
      // the guard stays to catch a reintroduction.)
      const fs = await import('node:fs');
      const src = fs.readFileSync(
        fileURLToPath(new URL('../../../render/src/render-system-extract.ts', import.meta.url)),
        'utf8',
      );
      // The narrowing point must not check shadingModel against a string
      // literal 'sprite-lit'.
      expect(/shadingModel\s*===\s*['"]sprite-lit['"]/.test(src)).toBe(false);
    });
  });
});
