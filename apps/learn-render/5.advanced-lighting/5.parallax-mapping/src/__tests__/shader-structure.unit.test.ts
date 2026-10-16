// Structural assertions on parallax.wgsl. The shading math needs a GPU to
// validate (covered by the dawn + browser smokes); this unit test guards the
// SOURCE STRUCTURE that the smokes assume: all three LO 5.5 algorithm paths are
// present and discriminable, the engine TBN helper is imported, and the
// source does not duplicate the generated MaterialAsset interface.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SHADER_PATH = resolve(here, '..', 'parallax.wgsl');
const PACK_PATH = resolve(here, '..', 'parallax.pack.json');
const src = readFileSync(SHADER_PATH, 'utf8');

describe('parallax.wgsl source structure (LO 5.5)', () => {
  it('declares the module import path + reuses the engine TBN helper', () => {
    expect(src).toContain('#define_import_path learn_render::5_5_parallax');
    expect(src).toContain('#import forgeax_pbr::tbn');
    expect(src).toContain('decodeTangentSpaceNormalRg');
  });

  it('carries all three LO 5.5 algorithm paths, each discriminable', () => {
    expect(src).toMatch(/fn\s+parallaxBasic\s*\(/);
    expect(src).toMatch(/fn\s+parallaxSteep\s*\(/);
    expect(src).toMatch(/fn\s+parallaxOcclusion\s*\(/);
  });

  it('dispatches the three paths by material.algoMode (f32 threshold)', () => {
    expect(src).toContain('material.algoMode');
    // basic must NOT divide by viewDir.z (LO offset-limiting fidelity, F-1);
    // steep/POM DO divide by viewDir.z. So the "/ viewDir.z" token appears in
    // steep + POM but the basic function body must not contain it.
    const basicBody = src.slice(
      src.indexOf('fn parallaxBasic'),
      src.indexOf('fn parallaxSteep'),
    );
    expect(basicBody).not.toContain('/ viewDir.z');
    expect(src).toContain('/ viewDir.z'); // present in steep/POM
  });

  it('consumes the generated interface without redeclaring group-1 bindings', () => {
    expect(src).toContain('baseColorTexture_sampler');
    expect(src).toContain('normalTexture_sampler');
    expect(src).toContain('heightTexture_sampler');
    expect(src).not.toMatch(/struct\s+ParallaxMaterial/);
    expect(src).not.toMatch(/@group\(1\)\s+@binding\(/);
  });
});

describe('parallax.pack.json MaterialAsset payload', () => {
  const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8')) as {
    assets: Array<{
      kind: string;
      payload: {
        passes: Array<{ program: { module: string } }>;
        parameters: Array<{ name: string; type: string }>;
      };
    }>;
  };
  const material = pack.assets.find((asset) => asset.kind === 'material')?.payload;

  it('matches the registered shader identifier', () => {
    expect(material?.passes[0]?.program.module).toBe('learn_render::5_5_parallax');
  });

  it('declares three texture fields incl. heightTexture (the per-shader BGL win)', () => {
    const textures = material?.parameters.filter((p) => p.type === 'texture').map((p) => p.name);
    expect(textures).toEqual(['baseColorTexture', 'normalTexture', 'heightTexture']);
  });

  it('orders heightScale + algoMode as the only two f32 fields (UBO overlay slots 4/5)', () => {
    const f32s = material?.parameters.filter((p) => p.type === 'f32').map((p) => p.name);
    expect(f32s).toEqual(['heightScale', 'algoMode']);
  });
});
