// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=3):
//   - packages/runtime/src/__tests__/glyph-layout-system.test.ts
//   - packages/runtime/src/__tests__/glyph-layout.test.ts
//   - packages/runtime/src/__tests__/glyph-text-pick.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import {
  AssetRegistry,
  resolveAssetHandle,
  walkMaterialPassesOverSharedRefs,
} from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { PROCEDURAL_FLOATS_PER_VERTEX } from '@forgeax/engine-geometry';
import {
  FONT_CONCURRENCY_LIMIT,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
  VERTEX_OFFSET,
} from '@forgeax/engine-graphics-extras';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { FontAsset, GlyphMetric, Handle, MeshAsset } from '@forgeax/engine-types';
import { TextError } from '@forgeax/engine-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import {
  glyphTextLayoutSystem,
  resetGlyphBakeCache,
} from '../../../render/src/glyph-text-layout-system';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

{
  // ─── from glyph-layout-system.test.ts ───
  describe('glyph-layout-system.test.ts', () => {
    // feat-20260601-gpu-resource-store-extraction M1: glyphTextLayoutSystem gained
    // a 3rd param (the GPU residency store) since in-place mesh updates moved there.
    // These CPU-side layout/bake/attach tests do not wire a device, so the store's
    // updateMesh dirty path no-ops -- the bake + MeshFilter/MeshRenderer attach
    // assertions are unaffected.
    const gpuStore = new GpuResidencyCache();

    function metric(overrides: Partial<GlyphMetric> = {}): GlyphMetric {
      return {
        advance: 10,
        bearingX: 0,
        bearingY: 8,
        size: { w: 8, h: 8 },
        region: { x: 0, y: 0, w: 8, h: 8 },
        ...overrides,
      };
    }

    function makeFont(glyphs: Record<number, GlyphMetric>): FontAsset {
      return {
        kind: 'font',
        atlas: AssetGuid.random(),
        sampler: AssetGuid.random(),
        glyphs,
        common: {
          lineHeight: 12,
          base: 8,
          distanceRange: 4,
          pxRange: 4,
          atlasWidth: 64,
          atlasHeight: 64,
        },
      };
    }

    const ASCII = (s: string): Record<number, GlyphMetric> => {
      const out: Record<number, GlyphMetric> = {};
      for (const ch of s) out[ch.codePointAt(0) as number] = metric();
      return out;
    };

    function registerFont(world: World, glyphs: Record<number, GlyphMetric>): number {
      return world.allocSharedRef('FontAsset', makeFont(glyphs)) as unknown as number;
    }

    function makeRegistry(): AssetRegistry {
      return new AssetRegistry(makeMockShaderRegistry());
    }

    function spawnLabel(world: World, fontId: number, text: string, fontSize = 1): EntityHandle {
      return world
        .spawn({
          component: GlyphText,
          data: {
            fontHandle: fontId as unknown as Handle<'FontAsset', 'shared'>,
            text,
            fontSize,
            color: [1, 1, 1, 1],
          },
        })
        .unwrap();
    }

    describe('glyphTextLayoutSystem', () => {
      beforeEach(() => resetGlyphBakeCache());

      it('(a) spawn GlyphText -> entity gains MeshFilter + MeshRenderer (AC-07)', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        const e = spawnLabel(world, fontId, 'Hi');

        // Before the pass the entity carries only GlyphText + no MeshFilter column.
        expect(world.get(e, GlyphText).ok).toBe(true);
        glyphTextLayoutSystem(world, gpuStore);
        // After one pass the layout system has baked + attached the render slots.
        expect(world.get(e, MeshFilter).ok).toBe(true);
        expect(world.get(e, MeshRenderer).ok).toBe(true);
      });

      it('(a2) draw-time integration guard: material bound + assetHandle survives (F-1/F-2)', () => {
        // Regression guard for the two M4-fixup blockers, exercised at the column
        // level a draw would read (render extract reads MeshFilter.assetHandle +
        // MeshRenderer.material from the archetype columns):
        //   F-1: MeshRenderer.material must be non-zero (a real MSDF material is
        //        bound), else extract routes to the mid-grey default unlit material
        //        and the atlas is never sampled.
        //   F-2: MeshFilter.assetHandle must read back as the registered mesh id
        //        (not the empty/dropped column that the chained-add migration bug
        //        produced when the entity already carried >=2 components).
        const assets = makeRegistry();
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        // Entity carries Transform + GlyphText (the >=2-component shape that
        // triggered the F-2 chained-add column loss) before the layout pass adds
        // MeshFilter then MeshRenderer.
        const e = world
          .spawn(
            { component: Transform, data: { pos: [1, 2, 0] } },
            {
              component: GlyphText,
              data: {
                fontHandle: fontId as unknown as Handle<'FontAsset', 'shared'>,
                text: 'Hi',
                fontSize: 1,
                color: [1, 1, 1, 1],
              },
            },
          )
          .unwrap();

        glyphTextLayoutSystem(world, gpuStore);

        // F-2 guard: MeshFilter.assetHandle reads back the registered mesh id.
        const mf = world.get(e, MeshFilter);
        expect(mf.ok).toBe(true);
        const assetHandle = (mf.unwrap() as { assetHandle: number }).assetHandle;
        expect(Number(assetHandle)).not.toBe(0);
        expect(resolveAssetHandle<MeshAsset>(world, assetHandle as never).ok).toBe(true);

        // F-1 guard: MeshRenderer.materials[0] is a real (non-zero) MSDF material handle.
        const mr = world.get(e, MeshRenderer);
        expect(mr.ok).toBe(true);
        const materials = (mr.unwrap() as unknown as { materials: Uint32Array }).materials;
        const material = materials[0] ?? 0;
        expect(Number(material)).not.toBe(0);
        // The bound material resolves to a forgeax::msdf-text pass (not default).
        const passes = walkMaterialPassesOverSharedRefs(world, material as never, assets);
        expect(passes.ok).toBe(true);
        const resolved = passes.unwrap();
        expect(resolved.passes[0]?.program.module).toBe('forgeax::msdf-text');
        expect(resolved.values?.baseColorTexture).toMatchObject({
          texture: expect.any(Uint8Array),
        });
        expect(resolved.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'tintColor', type: 'color' }),
            expect.objectContaining({ name: 'distanceRange', type: 'vec4' }),
            expect.objectContaining({ name: 'baseColorTexture', type: 'texture' }),
          ]),
        );
      });

      it('(b) dirty text -> updateMesh in place, assets size unchanged (AC-08)', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('HiABC'));
        const e = spawnLabel(world, fontId, 'Hi');

        glyphTextLayoutSystem(world, gpuStore);
        const sizeAfterBake = world.sharedRefs._liveCount();
        const mf = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        const meshHandle = mf.assetHandle;

        // Mutate text -> next pass must updateMesh in place, not register a new mesh.
        world.set(e, GlyphText, { text: 'ABC' }).unwrap();
        glyphTextLayoutSystem(world, gpuStore);

        expect(world.sharedRefs._liveCount()).toBe(sizeAfterBake); // no new registration (AC-08)
        const mf2 = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        expect(mf2.assetHandle).toBe(meshHandle); // same handle reused
      });

      it('(b2) clean re-pass does not register or mutate', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        spawnLabel(world, fontId, 'Hi');
        glyphTextLayoutSystem(world, gpuStore);
        const size1 = world.sharedRefs._liveCount();
        glyphTextLayoutSystem(world, gpuStore); // no change -> no work
        expect(world.sharedRefs._liveCount()).toBe(size1);
      });

      it('(b2.1) clean re-pass repairs a legacy cached glyph mesh slot table', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        const e = spawnLabel(world, fontId, 'Hi');

        glyphTextLayoutSystem(world, gpuStore);
        const mf = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        const mesh = resolveAssetHandle<MeshAsset>(world, mf.assetHandle as never).unwrap();
        delete (mesh as { materialSlots?: unknown }).materialSlots;

        glyphTextLayoutSystem(world, gpuStore);

        expect(mesh.materialSlots).toEqual([{ slotName: 'Default' }]);
      });

      it('(b2.2) bounds producer refs across slot reuse and tint changes', () => {
        const assets = makeRegistry();
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        const first = spawnLabel(world, fontId, 'Hi');
        glyphTextLayoutSystem(world, gpuStore);
        const baseline = world.sharedRefs._liveCount();
        const catalogBaseline = assets.assetCatalog.size;

        for (let i = 0; i < 32; i++) {
          world.set(first, GlyphText, { color: [i / 32, 0.5, 1, 1] }).unwrap();
          glyphTextLayoutSystem(world, gpuStore);
          expect(world.sharedRefs._liveCount()).toBe(baseline);
          expect(assets.assetCatalog.size).toBe(catalogBaseline);
        }

        world.despawn(first).unwrap();
        glyphTextLayoutSystem(world, gpuStore);
        expect(world.sharedRefs._liveCount()).toBe(baseline - 2);
        const replacement = spawnLabel(world, fontId, 'Hi');
        glyphTextLayoutSystem(world, gpuStore);
        expect(replacement).not.toBe(first);
        expect(world.sharedRefs._liveCount()).toBe(baseline);
      });

      it('(b2.3) a fresh world never reuses the prior PlayWorld glyph cache', () => {
        const first = new World();
        const firstFontId = registerFont(first, ASCII('Hi'));
        spawnLabel(first, firstFontId, 'Hi');
        glyphTextLayoutSystem(first, gpuStore);

        const second = new World();
        const secondFontId = registerFont(second, ASCII('Hi'));
        const secondEntity = spawnLabel(second, secondFontId, 'Hi');
        glyphTextLayoutSystem(second, gpuStore);

        const filter = second.get(secondEntity, MeshFilter);
        expect(filter.ok).toBe(true);
        const mesh = resolveAssetHandle<MeshAsset>(
          second,
          (filter.unwrap() as { assetHandle: number }).assetHandle as never,
        ).unwrap();
        expect(mesh.materialSlots).toEqual([{ slotName: 'Default' }]);
      });

      it('(b2.4) keeps runtime-derived materials out of the persistent catalog across Worlds', () => {
        const assets = makeRegistry();
        const catalogBaseline = assets.assetCatalog.size;

        for (let i = 0; i < 16; i++) {
          const world = new World();
          const fontId = registerFont(world, ASCII('Hi'));
          spawnLabel(world, fontId, 'Hi');
          glyphTextLayoutSystem(world, gpuStore);
          expect(assets.assetCatalog.size).toBe(catalogBaseline);
        }
      });

      it('(b3) empty first bake -> dirty text refreshes mesh payload bounds and draw range', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        const e = spawnLabel(world, fontId, '');

        glyphTextLayoutSystem(world, gpuStore);
        const mf = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        const meshHandle = mf.assetHandle as unknown as Handle<'MeshAsset', 'shared'>;
        const initialMesh = resolveAssetHandle<MeshAsset>(world, meshHandle).unwrap();
        expect(initialMesh.vertices.length).toBe(0);
        // Simulate a pre-material-slot runtime mesh surviving into the in-place
        // rebake path. The update owns the complete procedural mesh contract and
        // must normalize the slot table alongside its submesh draw range.
        delete (initialMesh as { materialSlots?: unknown }).materialSlots;

        world.set(e, GlyphText, { text: 'Hi' }).unwrap();
        glyphTextLayoutSystem(world, gpuStore);

        const mesh = resolveAssetHandle<MeshAsset>(world, meshHandle).unwrap();
        expect(mesh.vertices.length).toBeGreaterThan(0);
        expect(mesh.indices?.length).toBe(12);
        expect(mesh.submeshes[0]?.indexCount).toBe(12);
        expect(mesh.submeshes[0]?.vertexCount).toBe(8);
        expect(mesh.materialSlots).toEqual([{ slotName: 'Default' }]);
        expect(mesh.aabb?.[3]).toBeGreaterThan(0);
      });

      it('(c) baked mesh AABB is the conservative anchor-centered cube (non-degenerate)', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('HHHH'));
        const e = spawnLabel(world, fontId, 'HHHH');
        glyphTextLayoutSystem(world, gpuStore);

        const mf = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        const mesh = resolveAssetHandle<MeshAsset>(
          world,
          mf.assetHandle as unknown as Handle<'MeshAsset', 'shared'>,
        ).unwrap();
        const aabb = mesh.aabb as Float32Array;
        // cube centered at origin: min = -R on all axes, max = +R.
        const r = aabb[3] as number;
        expect(r).toBeGreaterThan(0);
        expect(aabb[0]).toBeCloseTo(-r, 5);
        expect(aabb[1]).toBeCloseTo(-r, 5);
        expect(aabb[2]).toBeCloseTo(-r, 5);
        expect(aabb[4]).toBeCloseTo(r, 5);
        expect(aabb[5]).toBeCloseTo(r, 5);
      });

      it('(f) 9th distinct font in one frame -> font-concurrency-exceeded (AC-20)', () => {
        const world = new World();
        // Spawn 9 labels each referencing a distinct registered font.
        for (let i = 0; i < 9; i++) {
          const fontId = registerFont(world, ASCII('A'));
          spawnLabel(world, fontId, 'A');
        }
        const result = glyphTextLayoutSystem(world, gpuStore);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(TextError);
          expect(result.error.code).toBe('font-concurrency-exceeded');
          expect(result.error.expected).toBe('8');
        }
      });

      it('(g) empty-string GlyphText -> MeshFilter with a 0-vertex mesh', () => {
        const world = new World();
        const fontId = registerFont(world, ASCII('Hi'));
        const e = spawnLabel(world, fontId, '');
        glyphTextLayoutSystem(world, gpuStore);

        expect(world.get(e, MeshFilter).ok).toBe(true);
        const mf = world.get(e, MeshFilter).unwrap() as { assetHandle: number };
        const mesh = resolveAssetHandle<MeshAsset>(
          world,
          mf.assetHandle as unknown as Handle<'MeshAsset', 'shared'>,
        ).unwrap();
        expect(mesh.vertices.length).toBe(0);
      });
    });
  });
}

{
  // ─── from glyph-layout.test.ts ───
  describe('glyph-layout.test.ts', () => {
    // Minimal metric: 10-unit advance, square 8x8 glyph, bearingY=8 (sits on baseline).
    function metric(overrides: Partial<GlyphMetric> = {}): GlyphMetric {
      return {
        advance: 10,
        bearingX: 0,
        bearingY: 8,
        size: { w: 8, h: 8 },
        region: { x: 0, y: 0, w: 8, h: 8 },
        ...overrides,
      };
    }

    function makeFont(glyphs: Record<number, GlyphMetric>, notdef?: GlyphMetric): FontAsset {
      return {
        kind: 'font',
        atlas: 0 as never,
        sampler: 0 as never,
        glyphs,
        common: {
          lineHeight: 12,
          base: 8,
          distanceRange: 4,
          pxRange: 4,
          atlasWidth: 64,
          atlasHeight: 64,
        },
        ...(notdef !== undefined ? { notdef } : {}),
      };
    }

    const STRIDE = PROCEDURAL_FLOATS_PER_VERTEX;

    describe('layoutGlyphText', () => {
      it('(a) N glyphs -> 4N vertices / 6N indices', () => {
        const H = 'H'.codePointAt(0) as number;
        const i = 'i'.codePointAt(0) as number;
        const font = makeFont({ [H]: metric(), [i]: metric() });
        const out = layoutGlyphText(font, 'Hi', 1);
        expect(out.vertices.length).toBe(2 * 4 * STRIDE); // 8 verts
        expect(out.indices.length).toBe(2 * 6); // 12 indices
      });

      it('(b) absent codepoints fall back to notdef and still count (TOFU, AC-14)', () => {
        // Empty glyph map but a notdef present -> 'AB' renders 2 TOFU quads.
        const font = makeFont({}, metric({ region: { x: 56, y: 56, w: 8, h: 8 } }));
        const out = layoutGlyphText(font, 'AB', 1);
        expect(out.vertices.length).toBe(2 * 4 * STRIDE);
        expect(out.indices.length).toBe(2 * 6);
        // both quads use the notdef atlas region -> uv of first vertex is notdef's
        // top-left region normalized by atlas size.
        const u0 = out.vertices[VERTEX_OFFSET.uv] as number; // vertex 0 uv.u
        expect(u0).toBeCloseTo(56 / 64, 5);
      });

      it('(c) \\n second line baseline y offset = -lineHeight (AC-21)', () => {
        const A = 'A'.codePointAt(0) as number;
        const B = 'B'.codePointAt(0) as number;
        const font = makeFont({ [A]: metric(), [B]: metric() });
        const out = layoutGlyphText(font, 'A\nB', 1);
        // 2 glyphs (newline emits no quad).
        expect(out.vertices.length).toBe(2 * 4 * STRIDE);
        // Glyph A vertex 0 y vs glyph B vertex 0 y differ by exactly lineHeight.
        const aY0 = out.vertices[1] as number; // glyph0 vert0 position.y
        const bY0 = out.vertices[4 * STRIDE + 1] as number; // glyph1 vert0 position.y
        expect(bY0).toBeCloseTo(aY0 - font.common.lineHeight, 5);
      });

      it('(d) empty string -> 0 vertices / 0 indices', () => {
        const font = makeFont({});
        const out = layoutGlyphText(font, '', 1);
        expect(out.vertices.length).toBe(0);
        expect(out.indices.length).toBe(0);
        expect(out.radius).toBe(0);
      });

      it('(e) conservative sphere R covers the farthest glyph quad corner (D-5)', () => {
        const H = 'H'.codePointAt(0) as number;
        const font = makeFont({ [H]: metric() });
        const out = layoutGlyphText(font, 'HHHH', 1);
        // farthest corner distance from origin (anchor) must be <= R.
        let maxCornerDist = 0;
        for (let v = 0; v < out.vertices.length; v += STRIDE) {
          const x = out.vertices[v] as number;
          const y = out.vertices[v + 1] as number;
          maxCornerDist = Math.max(maxCornerDist, Math.hypot(x, y));
        }
        expect(out.radius).toBeGreaterThanOrEqual(maxCornerDist - 1e-6);
        expect(out.radius).toBeGreaterThan(0);
      });

      it('(f) 9th distinct font in one frame -> font-concurrency-exceeded (D-8/AC-20)', () => {
        resetFontConcurrency();
        for (let id = 1; id <= FONT_CONCURRENCY_LIMIT; id++) {
          expect(() => trackFontConcurrency(id)).not.toThrow();
        }
        let caught: unknown;
        try {
          trackFontConcurrency(FONT_CONCURRENCY_LIMIT + 1);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(TextError);
        expect((caught as TextError).code).toBe('font-concurrency-exceeded');
        expect((caught as TextError).expected).toBe('8');
        resetFontConcurrency();
      });

      it('re-tracking an already-active font id does not exceed the limit', () => {
        resetFontConcurrency();
        for (let id = 1; id <= FONT_CONCURRENCY_LIMIT; id++) trackFontConcurrency(id);
        // re-tracking an existing id is a no-op, not a 9th distinct font.
        expect(() => trackFontConcurrency(1)).not.toThrow();
        resetFontConcurrency();
      });
    });
  });
}
