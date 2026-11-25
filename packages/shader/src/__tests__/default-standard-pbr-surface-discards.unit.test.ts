import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createMaterialShaderProgram,
  STANDARD_SURFACE_DISCARD_CLIPPING_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_AXIS,
  STANDARD_SURFACE_DISCARD_LOD_COVERAGE,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '../index';

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const shader = read('default-standard-pbr.wgsl');

function surfaceInputBody(source: string): string {
  const start = source.indexOf('fn standardSurfaceInput(');
  const end = source.indexOf('\nfn ', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, end);
}

describe('Standard surface discard override', () => {
  it('exports one stable override id and distinct bits', () => {
    expect(STANDARD_SURFACE_DISCARDS_OVERRIDE).toBe('64001');
    expect(STANDARD_SURFACE_DISCARDS_OVERRIDE).not.toBe(STANDARD_TEXTURE_MASK_OVERRIDE);
    expect(STANDARD_SURFACE_DISCARD_LOD_COVERAGE).toBe(1);
    expect(STANDARD_SURFACE_DISCARD_VIEW_CLIPPING).toBe(2);
  });

  it('declares the discards as one source axis and no pipeline override', () => {
    expect(shader).not.toContain('@id(64001)');
    expect(shader).toContain('#pragma variant_axis LOD_DITHER');
    expect(shader).toContain('#pragma variant_axis CLIPPING_PLANES');
    expect(STANDARD_SURFACE_DISCARD_LOD_AXIS).toBe('LOD_DITHER');
    expect(STANDARD_SURFACE_DISCARD_CLIPPING_AXIS).toBe('CLIPPING_PLANES');
  });

  it('keeps the shared surface LOD coverage and view clipping calls inside the source macro', () => {
    const body = surfaceInputBody(shader);
    expect(body).toMatch(
      /#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true\s*#if LOD_DITHER == true\s*#if WATER_WAVES_AVAILABLE == true\s*applyLodCoverage\(in\.clip\.xy, bitcast<f32>\(in\.materialAddress\.w\)\);\s*#else\s*applyLodCoverage\(in\.clip\.xy, in\.lodFade\);\s*#endif\s*#endif\s*#endif/,
    );
    expect(body).not.toContain('applyViewClipping(');
    const rejection = shader.slice(
      shader.indexOf('fn standardSurfaceRejected('),
      shader.indexOf('fn alphaTestSurface('),
    );
    expect(rejection).toMatch(
      /#if CLIPPING_PLANES == true\s*if \(viewClippingRejected\(standardPositionWS, false\)\) \{ return true; \}\s*#endif/,
    );
    expect(rejection).not.toContain('discard;');
    expect(body).not.toContain('standardSurfaceDiscards');
    // Material-local clipping is a per-material fact and stays unconditional.
    expect(body).toMatch(/#ifdef MATERIAL_CLIPPING_AVAILABLE\s*applyLocalClipping\(/);
  });

  it('shares temporal raster coverage and preserves the skin template', () => {
    const temporal = shader.slice(shader.indexOf('fn materialTemporal('));
    expect(temporal).toMatch(/\n {2}applyViewClipping\(in\.clippingPositionWS, false\);/);
    expect(temporal).toMatch(/\n {2}applyLodCoverage\(in\.clip\.xy, in\.temporal\.z\);/);
    const packedVelocity =
      'return encodeSceneVelocityRaster(materialTemporal(in), in.previousClip);';
    expect(temporal).toContain(packedVelocity);
    const skin = read('default-standard-pbr-skin.wgsl');
    expect(skin).toContain(packedVelocity);
    expect(skin).not.toContain('standardSurfaceDiscards');
  });

  it('rejects uncovered Water geometry in every Standard raster entry after Surface evaluation', () => {
    for (const entry of [
      'fs_main',
      'fs_opaque',
      'fs_forward_screen',
      'fs_oit',
      'fs_oit_premultiplied',
      'fs_gbuffer',
      'fs_depth_masked',
    ]) {
      const start = shader.indexOf(`fn ${entry}(`);
      expect(start, entry).toBeGreaterThanOrEqual(0);
      const end = shader.indexOf('\n}', start);
      const body = shader.slice(start, end);
      expect(body, entry).toContain('if (!standardWaterCovered) { discard; }');
      expect(body, entry).toMatch(
        /(?:standardForward|standardGBuffer|evaluateStandardSurface|standardAoInput)[\s\S]*if \(!standardWaterCovered\)/,
      );
    }
    expect(shader).toMatch(
      /fn evaluateStandardSurface\([\s\S]*?let input = standardSurfaceInput\(/,
    );
    const evaluator = surfaceInputBody(shader);
    expect(evaluator).toContain('!(in.worldNormal.w <= 0.0)');
    expect(evaluator).toContain('waterMeshCoverageContains(');
    expect(evaluator).toContain('waterDynamicBoundsContains(');
  });

  it('records declared numeric override ids on the material program', () => {
    const program = createMaterialShaderProgram(`
      // @id(9) override commented: u32 = 0u;
      @id(64000) override standardTextureMask: u32 = 0u;
      @id( 64001u ) override standardSurfaceDiscards: u32 = 3u;
      override unnamed: bool = false;
    `);
    expect(program.overrideIds).toEqual(['64000', '64001']);
    expect(Object.isFrozen(program.overrideIds)).toBe(true);
    expect(createMaterialShaderProgram('synthetic').overrideIds).toEqual([]);
    expect(createMaterialShaderProgram(shader).overrideIds).not.toContain(
      STANDARD_SURFACE_DISCARDS_OVERRIDE,
    );
  });
});

it('reads shadow reception per draw, folding only a shadow-free View override', () => {
  expect(shader).toContain('@id(64002) override standardShadowReception: u32 = 1u;');
  expect(shader).toMatch(
    /fn standardReceivesShadows\(in : VsOut\) -> bool \{\s*if \(standardShadowReception == 0u\) \{ return false; \}\s*#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true\s*return \(standardMaterialRow\(in\) & STANDARD_NO_RECEIVE_BIT\) == 0u;/,
  );
});
