import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createMaterialShaderProgram,
  STANDARD_SURFACE_DISCARD_LOD_COVERAGE,
  STANDARD_SURFACE_DISCARD_VIEW_CLIPPING,
  STANDARD_SURFACE_DISCARDS_OVERRIDE,
  STANDARD_TEXTURE_MASK_OVERRIDE,
} from '../index';

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
const shader = read('default-standard-pbr.wgsl');

function evaluateStandardSurfaceBody(source: string): string {
  const start = source.indexOf('fn evaluateStandardSurface(');
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

  it('declares the override exactly once in the template, defaulting to both discards', () => {
    expect(shader.match(/@id\(64001\)/g)).toHaveLength(1);
    expect(shader).toContain('@id(64001) override standardSurfaceDiscards: u32 = 3u;');
  });

  it('gates only the shared surface LOD coverage and view clipping discards', () => {
    const body = evaluateStandardSurfaceBody(shader);
    expect(body).toMatch(
      /#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true\s*if \(\(standardSurfaceDiscards & 1u\) != 0u\) \{\s*applyLodCoverage\(in\.clip\.xy, bitcast<f32>\(in\.materialAddress\.w\)\);\s*\}\s*#endif/,
    );
    expect(body).toMatch(
      /if \(\(standardSurfaceDiscards & 2u\) != 0u\) \{\s*applyViewClipping\(in\.worldPos, false\);\s*\}/,
    );
    // Material-local clipping is a per-material fact and stays unconditional.
    expect(body).toMatch(/#ifdef MATERIAL_CLIPPING_AVAILABLE\s*applyLocalClipping\(/);
  });

  it('leaves the temporal entry and the skin template unchanged', () => {
    const temporal = shader.slice(shader.indexOf('fn fs_temporal('));
    expect(temporal).toMatch(/\n {2}applyViewClipping\(in\.clippingPositionWS, false\);/);
    expect(temporal).toMatch(/\n {2}applyLodCoverage\(in\.clip\.xy, in\.temporal\.z\);/);
    expect(read('default-standard-pbr-skin.wgsl')).not.toContain('standardSurfaceDiscards');
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
    expect(createMaterialShaderProgram(shader).overrideIds).toContain(
      STANDARD_SURFACE_DISCARDS_OVERRIDE,
    );
  });
});
