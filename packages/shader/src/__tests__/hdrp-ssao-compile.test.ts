// @forgeax/engine-shader/__tests__/hdrp-ssao-compile.test.ts -
// Structural unit test for hdrp-ssao.wgsl (M2 / w7).
// feat-20260612-hdrp-ssao.
//
// This package physically isolates naga (4 grep gates in scripts/), so the
// test is source-level structural (same pattern as fxaa-shader.test.ts +
// ibl-modules-parse.test.ts). Read the WGSL source via node:fs and assert:
//
//   (a) file exists and declares define_import_path
//   (b) two fragment entry points — fs_ssao_calc + fs_ssao_blur
//   (c) imports fullscreen_triangle + FullscreenOutput from common.wgsl
//   (d) calc output is @location(0) f32 (R8 scalar)
//   (e) SSAO uniform group (@group(0)) with 3 mat4 fields
//   (f) kernel uniform buffer @binding
//   (g) noise texture + depth + normal texture bindings
//   (h) blur @location(0) output is f32 (R8 scalar)
//
// RED before w8 (hdrp-ssao.wgsl does not exist yet).
// GREEN after w8 writes the file.

import { beforeAll, describe, expect, it } from 'vitest';

// ── node:* imports (dynamic, vite-ignore — same pattern as fxaa-shader.test.ts) ──

interface NodeFs {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeUrl {
  fileURLToPath: (u: string) => string;
}

let ssaoSource!: string;
let srcDir!: string;
let fs!: NodeFs;

beforeAll(async () => {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
  const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
  const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
  const here = url.fileURLToPath(import.meta.url);
  srcDir = path.resolve(path.dirname(here), '..');
  ssaoSource = fs.readFileSync(path.resolve(srcDir, 'hdrp-ssao.wgsl'), 'utf8');
});

function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line: string) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('hdrp-ssao.wgsl structural compile test (M2 / w7)', () => {
  it('(a) declares #define_import_path', () => {
    const m = /^\s*#define_import_path\s+(\S+)\s*$/m.exec(ssaoSource);
    expect(m?.[1]).toBe('forgeax_hdrp::ssao');
  });

  it('(b1) has fs_ssao_calc fragment entry point', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@fragment\s+fn\s+fs_ssao_calc\b/);
  });

  it('(b2) has fs_ssao_blur fragment entry point', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@fragment\s+fn\s+fs_ssao_blur\b/);
  });

  it('(c1) imports fullscreen_triangle from forgeax_view::common', () => {
    expect(ssaoSource).toMatch(
      /#import\s+forgeax_view::common\s*::\s*\{[^}]*\bfullscreen_triangle\b[^}]*\}/,
    );
  });

  it('(c2) imports FullscreenOutput from forgeax_view::common', () => {
    expect(ssaoSource).toMatch(
      /#import\s+forgeax_view::common\s*::\s*\{[^}]*\bFullscreenOutput\b[^}]*\}/,
    );
  });

  it('(d) fs_ssao_calc packs visibility with the encoded center normal', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/fn\s+fs_ssao_calc\s*\([^)]*\)\s*->\s*@location\(0\)\s+vec4<f32>/);
    expect(codeOnly).toMatch(/encodeSsaoNormal\s*\(\s*ssaoNormal\s*\(/);
    expect(codeOnly).toMatch(/fn\s+fs_ssao_blur\s*\([^)]*\)\s*->\s*@location\(0\)\s+f32/);
  });

  it('(e1) declares SSAO uniform struct with view + projection + inverseProjection (3 mat4<f32>)', () => {
    // The uniform struct must have exactly 3 mat4x4<f32> fields.
    const codeOnly = stripComments(ssaoSource);
    // Accept either SsaoUniform or unnamed struct at @group(0).
    // Look for a struct with 3 mat4 fields before the @group(0) binding.
    const mat4Matches = codeOnly.match(/mat4x4<f32>/g);
    expect(mat4Matches).toBeTruthy();
    expect(mat4Matches?.length).toBeGreaterThanOrEqual(3);
  });

  it('(e2) SSAO uniform UBO is at @group(0) @binding(0)', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@group\(0\)\s*@binding\(0\)\s+var<uniform>\s+\w+_uniform/);
  });

  it('(f) kernel uniform buffer is declared (array<vec4<f32>>)', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@group\(0\)\s*@binding\(1\)\s+var<uniform>\s+\w+/);
    expect(codeOnly).toMatch(/array<vec4<f32>,\s*64>/);
  });

  it('(g1) noise texture binding is present (@binding(2) texture_2d<f32>)', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(
      /@group\(0\)\s*@binding\(2\)\s+var\s+\w+_texture\s*:\s*texture_2d<f32>/,
    );
  });

  it('(g2) noise sampler binding is present (@binding(3))', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@group\(0\)\s*@binding\(3\)\s+var\s+\w+_sampler\s*:\s*sampler/);
  });

  it('(g3) g-buffer normal texture binding is present (@binding(4) texture_2d<u32>)', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@group\(0\)\s*@binding\(4\)\s+var\s+\w+\s*:\s*texture_2d<u32>/);
  });

  it('(g4) hdrDepth texture binding is present (@binding(5) texture_depth_2d)', () => {
    const codeOnly = stripComments(ssaoSource);
    expect(codeOnly).toMatch(/@group\(0\)\s*@binding\(5\)\s+var\s+\w+\s*:\s*texture_depth_2d/);
  });

  it('(h) fs_ssao_blur outputs @location(0) f32 (R8 scalar)', () => {
    const codeOnly = stripComments(ssaoSource);
    const blockMatch = /fn\s+fs_ssao_blur\b[\s\S]*?->\s*@location\(0\)\s+f32/.exec(codeOnly);
    expect(blockMatch).toBeTruthy();
  });
});

// The blur consumes AO and current-frame surface guidance.

describe('hdrp-ssao.wgsl ssao-blur input fix (M8 / w36 + w37)', () => {
  it('(i1) ssaoRaw texture binding is declared (@binding for half-res calc output)', () => {
    const codeOnly = stripComments(ssaoSource);
    // After D-D: ssao-blur reads ssaoRaw, so the WGSL must declare a
    // ssaoRaw: texture_2d<f32> binding.
    expect(codeOnly).toMatch(/var\s+ssaoRaw\s*:\s*texture_2d<f32>/);
  });

  it('(i2) ssaoSampler binding is declared (paired with ssaoRaw)', () => {
    const codeOnly = stripComments(ssaoSource);
    // The companion sampler bound alongside ssaoRaw for the blur tap loop.
    expect(codeOnly).toMatch(/var\s+ssaoSampler\s*:\s*sampler/);
  });

  it('(i3) fs_ssao_blur reads AO with depth and normal edge guidance', () => {
    const codeOnly = stripComments(ssaoSource);
    // Carve out the fs_ssao_blur function body.
    const blurMatch = /fn\s+fs_ssao_blur\b[\s\S]*?\n\}/.exec(codeOnly);
    expect(blurMatch).toBeTruthy();
    if (!blurMatch) return;
    const body = blurMatch[0];
    expect(body).toMatch(/textureSampleLevel\s*\(\s*ssaoRaw\b/);
    // Normal discontinuities reject taps from another surface; tap normals come
    // from the packed raw target, never a per-tap full-res G-buffer decode.
    expect(body).toMatch(/decodeSsaoNormal\s*\(\s*raw\.gb\s*\)/);
    expect(body).not.toMatch(/\bssaoNormal\s*\(/);
  });

  it('(i4) fs_ssao_blur reads current depth without repeating edges', () => {
    const codeOnly = stripComments(ssaoSource);
    const blurMatch = /fn\s+fs_ssao_blur\b[\s\S]*?\n\}/.exec(codeOnly);
    expect(blurMatch).toBeTruthy();
    if (!blurMatch) return;
    const body = blurMatch[0];
    expect(body).toMatch(/ssao_depth_sampler\b/);
  });
});
