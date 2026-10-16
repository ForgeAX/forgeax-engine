// sprite-variants.unit.test.ts -- feat-20260625-sprite-instances-and-tilemap-terrain-static-batch
// M2 / w6 (red before w7).
//
// Structural test for the new PER_INSTANCE_REGION variant axis on sprite.wgsl.
// Pre-w7 expectations (RED):
//   sprite.wgsl declares ONE axis (STORAGE_BUFFER_AVAILABLE) -- the variant
//   matrix is 2x1 = 2; assertion (a) below expects 2x2 = 4 and fails.
// Post-w7 expectations (GREEN):
//   sprite.wgsl declares TWO axes (STORAGE_BUFFER_AVAILABLE +
//   PER_INSTANCE_REGION) for a 2x2 = 4 matrix; common.wgsl InstanceData
//   gains an #if PER_INSTANCE_REGION == true conditional region field; the
//   non-9-slice path in sprite.wgsl chooses its UV-region source via the
//   same conditional, while the 9-slice path keeps reading material.region
//   regardless (D-5; OOS-3 + 9-slice not in PER_INSTANCE_REGION scope).
//
// Reverse-falsifier assertions (b) lock the axis to sprite.wgsl alone -- if
// somebody copies the #pragma into common.wgsl the cartesian product would
// double pbr / unlit variant counts (D-4 explicitly rejected).
//
// Why structural / file-read rather than naga.parse: this package
// physically isolates naga (4 grep gates) -- cross-module compile
// validation lives in packages/runtime/src/__tests__/dawn/. Source-text
// grep is the established idiom (ibl-modules-parse.test.ts;
// register-material-shader.test.ts M1-w1 block).
//
// node:* are accessed via `await import(varId)` (vite-ignore) so the
// shader tsconfig keeps `types: ["@webgpu/types"]` without pulling in
// `@types/node` (the established cross-package pattern).
//
// Anchors:
//   - requirements §AC-04 (4-variant cartesian matrix for sprite shading
//     model under PER_INSTANCE_REGION x STORAGE_BUFFER_AVAILABLE)
//   - plan-strategy §2 D-4 (axis declared only in sprite.wgsl, never in
//     common.wgsl, so pbr/unlit do not pick up the new define)
//   - plan-strategy §2 D-5 (9-slice path always reads material.region
//     even when PER_INSTANCE_REGION=true; the instance-region field only
//     drives the legacy single-quad path)
//   - plan-strategy §4 R-2 / R-3 / R-6 (variant matrix isolation +
//     useSlices compatibility + uniform-fallback safety)

import { beforeAll, describe, expect, it } from 'vitest';

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

let fs!: NodeFs;
let srcDir!: string;

beforeAll(async () => {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const urlId = 'node:url';
  fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
  const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
  const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
  const here = url.fileURLToPath(import.meta.url);
  srcDir = path.resolve(path.dirname(here), '..');
});

function readWgsl(file: string): string {
  return fs.readFileSync(`${srcDir}/${file}`, 'utf8');
}

function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function variantAxes(src: string): readonly string[] {
  const matches = stripComments(src).match(/#pragma\s+variant_axis\s+\w+/g) ?? [];
  return matches;
}

describe('w6 (a) -- sprite.wgsl declares the PER_INSTANCE_REGION + STORAGE_BUFFER_AVAILABLE pair (AC-04)', () => {
  it('sprite.wgsl carries storage, atmosphere and instance-region axes', () => {
    const axes = variantAxes(readWgsl('sprite.wgsl'));
    expect(axes).toHaveLength(3);
    expect(axes).toContain('#pragma variant_axis ATMOSPHERE_AVAILABLE');
    expect(axes).toContain('#pragma variant_axis STORAGE_BUFFER_AVAILABLE');
    expect(axes).toContain('#pragma variant_axis PER_INSTANCE_REGION');
  });
});

describe('w6 (b) -- pbr / unlit / sprite-adjacent shaders DO NOT pick up PER_INSTANCE_REGION (D-4 reverse falsifier)', () => {
  // The reverse-falsifier guards plan-strategy D-4: if PER_INSTANCE_REGION
  // is declared in common.wgsl the cartesian product would double the
  // pbr / unlit variant count for zero runtime benefit. These assertions
  // pin the axis to sprite.wgsl exclusively.
  const NON_SPRITE_SHADERS = [
    'common.wgsl',
    'default-standard-pbr.wgsl',
    'default-standard-pbr-skin.wgsl',
    'unlit.wgsl',
    'shadow_caster.wgsl',
    'msdf-text.wgsl',
  ] as const;

  for (const file of NON_SPRITE_SHADERS) {
    it(`${file} does NOT declare #pragma variant_axis PER_INSTANCE_REGION`, () => {
      const src = readWgsl(file);
      expect(src).not.toMatch(/#pragma\s+variant_axis\s+PER_INSTANCE_REGION/);
    });
  }

  it('default-standard-pbr.wgsl keeps its material axes (none touch PER_INSTANCE_REGION)', () => {
    const axes = variantAxes(readWgsl('default-standard-pbr.wgsl'));
    expect(axes).toEqual([
      '#pragma variant_axis STORAGE_BUFFER_AVAILABLE',
      '#pragma variant_axis ATMOSPHERE_AVAILABLE',
      '#pragma variant_axis CLUSTER_FORWARD_AVAILABLE',
      '#pragma variant_axis VERTEX_COLOR_AVAILABLE',
      '#pragma variant_axis PROBE_BLEND_AVAILABLE',
      '#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE',
      '#pragma variant_axis TRANSMISSION_AVAILABLE',
      '#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE',
      '#pragma variant_axis PROJECTOR_AVAILABLE',
      '#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
      '#pragma variant_axis REFLECTION_FALLBACK_AVAILABLE',
      '#pragma variant_axis COVERAGE_ONLY',
      '#pragma variant_axis VISIBLE_SURFACE_AVAILABLE',
    ]);
  });

  it('unlit.wgsl keeps its storage and vertex-color axes', () => {
    const axes = variantAxes(readWgsl('unlit.wgsl'));
    expect(axes).toEqual([
      '#pragma variant_axis STORAGE_BUFFER_AVAILABLE',
      '#pragma variant_axis ATMOSPHERE_AVAILABLE',
      '#pragma variant_axis VERTEX_COLOR_AVAILABLE',
      '#pragma variant_axis COVERAGE_ONLY',
      '#pragma variant_axis SKINNING_DISABLED',
    ]);
  });
});

describe('w6 (c) -- 9-slice path keeps reading material.region under PER_INSTANCE_REGION=true (D-5)', () => {
  // OOS-3 + plan-strategy §2 D-5 lock 9-slice off the per-instance region
  // path. The structural assertions encode that:
  //   1. common.wgsl InstanceData carries the conditional region field so
  //      the WGSL compiles for PER_INSTANCE_REGION=true x useSlices=true.
  //   2. sprite.wgsl useSlices branch still references material.region
  //      (not instances[idx].region) regardless of axis state.
  //   3. The conditional that switches region sources lives ONLY inside
  //      the non-9-slice branch -- the useSlices branch keeps a literal
  //      `material.region` lookup (folded through region.zw / region.xy).

  it('common.wgsl wraps the InstanceData region field in #if PER_INSTANCE_REGION == true', () => {
    const src = readWgsl('common.wgsl');
    // bug-20260610 SSOT (recorded in shader.unit.test.ts M1-w1): naga_oil's
    // `#ifdef` only checks key presence, so the project standardised on
    // `#if NAME == true` whenever a false branch is live. The new conditional
    // follows the same idiom.
    expect(src).toMatch(/#if\s+PER_INSTANCE_REGION\s*==\s*true[\s\S]*?region\s*:\s*vec4<f32>/);
  });

  it('common.wgsl InstanceData declares localFromInstance UNCONDITIONALLY (region is the only conditional field)', () => {
    const src = readWgsl('common.wgsl');
    // The struct still opens with localFromInstance regardless of axis state.
    // The PER_INSTANCE_REGION conditional appends `region: vec4<f32>` after
    // localFromInstance; it never wraps the base field.
    expect(src).toMatch(
      /struct\s+InstanceData\s*\{[^}]*localFromInstance\s*:\s*mat4x4<f32>[^}]*\}/s,
    );
  });

  it('sprite.wgsl useSlices branch keeps reading material.region (D-5; not instances[idx].region)', () => {
    const src = stripComments(readWgsl('sprite.wgsl'));
    // Slice the useSlices block (`if (useSlices) { ... } else { ... }`) and
    // assert it contains material.region but not instances[...].region.
    const ifMatch = src.match(/if\s*\(\s*useSlices\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{/);
    expect(ifMatch, '9-slice branch (if (useSlices) { ... }) must be present').not.toBeNull();
    const sliceBlock = ifMatch?.[1] ?? '';
    expect(sliceBlock).toMatch(/material\.region/);
    expect(sliceBlock).not.toMatch(/instances\s*\[[^\]]*\]\s*\.\s*region/);
  });

  it('sprite.wgsl non-9-slice branch switches region source via #if PER_INSTANCE_REGION == true', () => {
    const src = readWgsl('sprite.wgsl');
    // The else-branch (no slices) is the only place the conditional region
    // source applies. Grep the file for the conditional + both legs --
    // material.region (false leg) and instances[...].region (true leg).
    expect(src).toMatch(/#if\s+PER_INSTANCE_REGION\s*==\s*true/);
    // True leg must reference instances[idx].region (per-instance region).
    expect(src).toMatch(/instances\s*\[[^\]]*\]\s*\.\s*region/);
    // False leg must still reference material.region (default behaviour).
    expect(src).toMatch(/material\.region/);
  });
});

describe('w6 (d) -- MAX_UNIFORM_INSTANCES=128 stays unchanged under the new axis (R-6 uniform-fallback safety)', () => {
  // Per research §Q-R-4.3 + plan-strategy §4 R-6:
  //   stride = mat4 64 B + vec4 16 B = 80 B per instance
  //   uniform-fallback worst case = 80 B x 128 = 10240 B
  //   WebGL2 minimum UBO binding size = 16384 B
  // 10240 < 16384 so the existing 128-cap survives. The shader-side
  // expression of that contract is the literal `array<InstanceData, 128>`
  // in common.wgsl's uniform fallback branch; this test pins the 128 there.

  it('common.wgsl uniform-fallback declares array<InstanceData, 128> (unchanged from pre-feat)', () => {
    const src = readWgsl('common.wgsl');
    expect(src).toMatch(
      /#if\s+STORAGE_BUFFER_AVAILABLE\s*==\s*true[\s\S]*?@group\(3\)[\s\S]*?#else[\s\S]*?@group\(3\)\s+@binding\(0\)\s+var<uniform>\s+instances\s*:\s*array<InstanceData,\s*128>/,
    );
  });

  it('common.wgsl mentions MAX_UNIFORM_INSTANCES=128 doc anchor (charter F1 grep gate)', () => {
    // The plan locks the cap at 128 even under the new 80 B stride
    // (10240 B < 16384 B WebGL2 floor). Pin the doc anchor that explains
    // why so a future drift attempt has to update the explanation too.
    const src = readWgsl('common.wgsl');
    expect(src).toMatch(/MAX_UNIFORM_INSTANCES\s*=\s*128/);
  });
});

describe('HDR/display fragment contract', () => {
  for (const file of ['sprite.wgsl', 'sprite-lit.wgsl'] as const) {
    it(`${file} keeps LDR OETF in fs_main and HDR output linear`, () => {
      const src = stripComments(readWgsl(file));
      const ldrStart = src.indexOf('fn fs_main(');
      const hdrStart = src.indexOf('fn fs_main_hdr(');
      expect(ldrStart).toBeGreaterThanOrEqual(0);
      expect(hdrStart).toBeGreaterThan(ldrStart);

      const ldrBody = src.slice(ldrStart, hdrStart);
      const hdrBody = src.slice(hdrStart);
      expect(ldrBody).toContain('linear_to_srgb(');
      expect(hdrBody).not.toContain('linear_to_srgb(');
      expect(hdrBody).toContain('return vec4<f32>');
    });
  }
});
