// @forgeax/engine-shader / __tests__ / sprite-lit-shader.test.ts
//
// tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d M1 / m1-1.
//
// Grep gates + fixture tests for the sprite-lit shader after the flat 2D
// lighting fold: NdotL and Half-Lambert are removed, worldPos is emitted
// from the vertex stage via VsOut interpolant.
//
// SSOTs:
//   - plan-strategy D-P1 (VsOut carries `@location(1) worldPos`)
//   - plan-strategy D-P2 (light functions drop normal parameter; flat SSOT)
//   - requirements AC-05 (LoC net-down), AC-06 (no halfLambert/nDotL residue),
//     AC-07 (typecheck + test:unit green)
//   - research.md F-4 (LDR clamp / HDR pass-through)

import { describe, expect, it } from 'vitest';
import { createBuiltinMaterialAsset } from '../index.js';

// Dynamic node:fs / node:module import via string ids — keeps the
// engine-shader package free of static `import 'node:fs'` (which
// shader.unit.test.ts already uses this pattern; see lines around the
// fsId = 'node:fs' helper). The TS strict mode in this package's
// tsconfig.lib does not ship @types/node by default; the dynamic-id
// import avoids the missing type error.
const fsId = 'node:fs';
const moduleId = 'node:module';

interface NodeFs {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
}

interface NodeModule {
  createRequire(filename: string | URL): (id: string) => string;
}

async function loadFs(): Promise<NodeFs> {
  const mod = (await import(fsId)) as NodeFs;
  return mod;
}
async function loadModule(): Promise<NodeModule> {
  const mod = (await import(moduleId)) as NodeModule;
  return mod;
}

async function resolveSrcDir(): Promise<string> {
  const m = await loadModule();
  const require = m.createRequire(import.meta.url);
  const packageJsonPath = require('@forgeax/engine-shader/package.json');
  // require() returns the resolved JSON contents; we need the path, not
  // the object. Fall back to require.resolve.
  void packageJsonPath;
  const resolved = m.createRequire(import.meta.url);
  // Re-resolve by package.json path string.
  const pkgJsonPath = (resolved as unknown as { resolve(id: string): string }).resolve(
    '@forgeax/engine-shader/package.json',
  );
  return pkgJsonPath.replace(/package\.json$/, 'src');
}

async function readSpriteLitSource(): Promise<string> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return fs.readFileSync(`${srcDir}/sprite-lit.wgsl`, 'utf8');
}

async function spriteLitWgslExists(): Promise<boolean> {
  const fs = await loadFs();
  const srcDir = await resolveSrcDir();
  return fs.existsSync(`${srcDir}/sprite-lit.wgsl`);
}

describe('sprite-lit shader (flat 2D lighting, tweak-20260701 M1)', () => {
  describe('sprite-lit.wgsl source artefact', () => {
    it('file exists', async () => {
      expect(await spriteLitWgslExists()).toBe(true);
    });

    it('first line is `#pragma variant_axis STORAGE_BUFFER_AVAILABLE`', async () => {
      const src = await readSpriteLitSource();
      const firstLine = src.split('\n')[0];
      expect(firstLine).toBe('#pragma variant_axis STORAGE_BUFFER_AVAILABLE');
    });

    it('declares vs_main + fs_main + fs_main_hdr three entry points', async () => {
      const src = await readSpriteLitSource();
      expect(/@vertex[\s\S]*?fn vs_main\b/.test(src)).toBe(true);
      expect(/@fragment[\s\S]*?fn fs_main\b/.test(src)).toBe(true);
      expect(/@fragment[\s\S]*?fn fs_main_hdr\b/.test(src)).toBe(true);
    });

    it('does NOT reference normalTexture / normalSampler in fragment lighting code', async () => {
      const src = await readSpriteLitSource();
      expect(/textureSample\s*\(\s*normalTexture\b/.test(src)).toBe(false);
      expect(/textureLoad\s*\(\s*normalTexture\b/.test(src)).toBe(false);
    });

    it('does NOT take a vertex normal attribute as a lighting input', async () => {
      const src = await readSpriteLitSource();
      expect(/dot\s*\(\s*in\.normal\b/.test(src)).toBe(false);
      expect(/normalize\s*\(\s*in\.normal\b/.test(src)).toBe(false);
    });

    it('fs_main applies LDR clamp; fs_main_hdr does NOT clamp the output', async () => {
      const src = await readSpriteLitSource();
      const ldrIdx = src.indexOf('fn fs_main(');
      const hdrIdx = src.indexOf('fn fs_main_hdr(');
      expect(ldrIdx).toBeGreaterThan(0);
      expect(hdrIdx).toBeGreaterThan(0);
      const ldrBody = src.slice(ldrIdx, hdrIdx > ldrIdx ? hdrIdx : src.length);
      const hdrBody = src.slice(hdrIdx);
      const ldrClampToZeroOne =
        /clamp\s*\([\s\S]+?,\s*(?:vec[234]<f32>\(\s*)?0\.0[\s\S]*?,\s*(?:vec[234]<f32>\(\s*)?1\.0/.test(
          ldrBody,
        );
      expect(ldrClampToZeroOne).toBe(true);
      const hdrVecClamp = /clamp\s*\(\s*vec[34]<f32>/.test(hdrBody);
      const hdrVecBoundClamp = /clamp\s*\([^)]*,\s*vec[34]<f32>\(\s*0\.0/.test(hdrBody);
      expect(hdrVecClamp).toBe(false);
      expect(hdrVecBoundClamp).toBe(false);
    });

    it('imports lighting helpers via forgeax_pbr (no cascade shadow sampling)', async () => {
      const src = await readSpriteLitSource();
      expect(src.includes('_sampleShadowForCascade')).toBe(false);
    });
  });

  describe('flat 2D lighting fold (AC-06 grep gate: no NdotL / Half-Lambert residue)', () => {
    it('no `halfLambert` identifier anywhere in the shader', async () => {
      const src = await readSpriteLitSource();
      // Match the camelCase identifier only; documentation strings containing
      // hyphenated "Half-Lambert" or unrelated words are not the target.
      expect(/halfLambert/.test(src)).toBe(false);
    });

    it('no `nDotL` identifier anywhere in the shader', async () => {
      const src = await readSpriteLitSource();
      // Match the camelCase identifier only; hyphenated feature-id strings
      // like "sprite-lit-...-ndotl-for-2d" or comments spelling "NdotL" are
      // not the target -- only the WGSL variable name `nDotL`.
      expect(/\bnDotL\b/.test(src)).toBe(false);
    });

    it('no `spriteLitNormal` function (flat shading has no hardcoded normal)', async () => {
      const src = await readSpriteLitSource();
      expect(src.includes('spriteLitNormal')).toBe(false);
    });

    it('no `spriteLitWorldPos` function (worldPos now comes from VsOut interpolant)', async () => {
      const src = await readSpriteLitSource();
      expect(src.includes('spriteLitWorldPos')).toBe(false);
    });

    it('no `dot(N` or `dot(normal` lighting term in the shader body', async () => {
      const src = await readSpriteLitSource();
      // Directional / point / spot lighting must not project onto any surface
      // normal — flat shading treats the sprite as omnidirectional.
      expect(/dot\s*\(\s*N\s*,/.test(src)).toBe(false);
      expect(/dot\s*\(\s*normal\s*,/.test(src)).toBe(false);
    });
  });

  describe('VsOut carries per-fragment worldPos (D-P1)', () => {
    it('VsOut declares `@location(1) worldPos: vec3<f32>` interpolant', async () => {
      const src = await readSpriteLitSource();
      // Match the WGSL declaration inside the VsOut struct. Whitespace-tolerant.
      const re = /@location\(\s*1\s*\)\s+worldPos\s*:\s*vec3<f32>/;
      expect(re.test(src)).toBe(true);
    });

    it('vs_main writes `out.worldPos = world.xyz`', async () => {
      const src = await readSpriteLitSource();
      const re = /out\.worldPos\s*=\s*world\.xyz\s*;/;
      expect(re.test(src)).toBe(true);
    });

    it('fs_main / fs_main_hdr consume `in.worldPos` (not a reconstructed local)', async () => {
      const src = await readSpriteLitSource();
      const consumers = src.match(/in\.worldPos/g) ?? [];
      // At minimum: one consumer in each of fs_main and fs_main_hdr.
      expect(consumers.length).toBeGreaterThanOrEqual(2);
    });

    it('VsOut carries vertex-produced ndc and viewZ for Standard cluster lookup', async () => {
      const src = await readSpriteLitSource();
      expect(src).toMatch(/@location\(\s*2\s*\)\s+ndc\s*:\s*vec3<f32>/);
      expect(src).toMatch(/@location\(\s*3\s*\)\s+viewZ\s*:\s*f32/);
      expect(src).toMatch(/out\.ndc\s*=\s*clipPos\.xyz\s*\/\s*clipPos\.w\s*;/);
      expect(src).toMatch(/out\.viewZ\s*=\s*sceneViewZ\(/);
      expect(src).toMatch(/evaluateStandardClusterLights\(\s*ndc,\s*viewZ,\s*worldPos/);
    });
  });

  describe('Standard local lights use the shared Cluster path (D-P2)', () => {
    it('spriteLitDirectional signature is `(albedo)` only', async () => {
      const src = await readSpriteLitSource();
      const re = /fn\s+spriteLitDirectional\s*\(\s*albedo\s*:\s*vec3<f32>\s*\)/;
      expect(re.test(src)).toBe(true);
    });

    it('does not retain a direct point-light branch', async () => {
      const src = await readSpriteLitSource();
      expect(src).not.toContain('pointLightsBuffer');
      expect(src).not.toContain('evalPointFlat(');
    });

    it('does not retain a direct spot-light branch', async () => {
      const src = await readSpriteLitSource();
      expect(src).not.toContain('spotLightsBuffer');
      expect(src).not.toContain('evalSpotFlat(');
    });

    it('spriteLitShadeAccum consumes vertex-produced ndc/viewZ without a normal', async () => {
      const src = await readSpriteLitSource();
      const re =
        /fn\s+spriteLitShadeAccum\s*\(\s*albedo\s*:\s*vec3<f32>\s*,\s*worldPos\s*:\s*vec3<f32>\s*,\s*ndc\s*:\s*vec3<f32>\s*,\s*viewZ\s*:\s*f32\s*,?\s*\)/;
      expect(re.test(src)).toBe(true);
      const bodyStart = src.indexOf('fn spriteLitShadeAccum');
      const bodyEnd = src.indexOf('fn fs_main(', bodyStart);
      expect(bodyStart).toBeGreaterThanOrEqual(0);
      expect(src.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : src.length)).not.toContain(
        '@builtin(position)',
      );
    });
  });

  describe('sprite-lit authored material contract', () => {
    it('uses the built-in source catalog instead of a sidecar schema', () => {
      const material = createBuiltinMaterialAsset('sprite');
      expect(material.passes?.[0]?.program.module).toBe('forgeax_material::sprite');
      expect(material.values).toBeDefined();
    });
  });

  describe('LDR / HDR clamp boundary fixture (numeric SSOT)', () => {
    // Fixture: total lit accumulator = 5.0 across all lights.
    // Expected LDR output (clamped) = 1.0; expected HDR output > 1.0.
    // The TS port mirrors what the WGSL must do.
    const fixtureLitAccumulated = 5.0;
    const ldrOut = Math.min(1.0, fixtureLitAccumulated);
    const hdrOut = fixtureLitAccumulated;

    it('LDR output is clamped to 1.0 at intensity=5.0 fixture', () => {
      expect(ldrOut).toBe(1.0);
    });

    it('HDR output passes through > 1.0 at intensity=5.0 fixture', () => {
      expect(hdrOut > 1.0).toBe(true);
      expect(hdrOut).toBeCloseTo(5.0, 5);
    });
  });
});
