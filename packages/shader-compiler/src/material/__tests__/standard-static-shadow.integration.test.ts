import { describe, expect, it } from 'vitest';
import { cookStaticShadow, OPAQUE_SWITCHES } from './standard-static-shadow.fixture';

describe('static Standard shadow coverage', () => {
  it('retains authored normal maps in color while removing them from shadow evaluation', async () => {
    const { shadow, forward } = await cookStaticShadow({ normalMapped: true });
    for (const compiled of [forward.compile, forward.sceneCompile]) {
      expect(compiled?.wgsl).toMatch(/(?:surfaceSample\w*|textureSample\w*)\(normalTexture,/);
    }
    expect(forward.abi.resourceSlots.some((slot) => slot.parameter === 'normalTexture')).toBe(true);
    expect(forward.abi.vertexInputs.some((input) => input.semantic === 'normal')).toBe(true);
    expect(shadow.abi.vertexInputs.map((input) => input.semantic)).toEqual(['position']);
    expect(shadow.compile.wgsl).not.toMatch(
      /(?:surfaceSample\w*|textureSample\w*)\(normalTexture,/,
    );
  });

  it.each([
    'mesh',
    'skinned',
  ] as const)('publishes the actual %s position-only shadow contract', async (geometry) => {
    const { shadow, forward } = await cookStaticShadow({ context: { geometry } });
    expect(shadow.abi.vertexInputs.map((input) => input.semantic)).toEqual(
      geometry === 'skinned' ? ['position', 'skinIndex', 'skinWeight'] : ['position'],
    );
    expect(shadow.abi.alphaMask).toEqual({ cutoff: '', source: '' });
    expect(shadow.abi.materialRow.fields).not.toContain('alphaCutoff');
    expect(forward.abi.alphaMask).toEqual({ cutoff: '', source: '' });
    for (const compiled of [shadow.compile, shadow.sceneCompile]) {
      expect(compiled).toBeDefined();
      expect(compiled?.wgsl).not.toMatch(/\b(?:dpdx|dpdy|surfaceSample|displaceVertex)\s*\(/);
      expect(compiled?.wgsl).toContain('applyViewClipping');
      expect(compiled?.wgsl).toContain('applyLocalClipping');
    }
    expect(shadow.sceneCompile?.wgsl).toContain('applyLodCoverage');
    expect(forward.compile.wgsl).toContain('surfaceSample');
    expect(forward.compile.wgsl).not.toMatch(/\.alphaCutoff\b/);
  });

  it('keeps runtime-zero, displaced and custom coverage on their authored paths', async () => {
    const runtime = await cookStaticShadow({ staticSwitches: {} });
    expect(runtime.shadow.compile.wgsl).toContain('displaceVertex');
    expect(runtime.shadow.compile.wgsl).toContain('surfaceSample');
    expect(runtime.shadow.abi.alphaMask?.cutoff).toBe('alphaCutoff');
    for (const feature of ['alphaClipping', 'alphaHash', 'displacement'] as const) {
      const dynamic = await cookStaticShadow({
        staticSwitches: { ...OPAQUE_SWITCHES, [feature]: true },
      });
      expect(dynamic.shadow.compile.wgsl).toContain('surfaceSample');
      if (feature === 'alphaHash') {
        expect(dynamic.shadow.abi.alphaMask).toEqual({ cutoff: '', source: '' });
        expect(dynamic.shadow.abi.materialRow.fields).toContain('alphaHash');
        expect(dynamic.shadow.compile.wgsl).toMatch(/\.alphaHash\b/);
      }
    }
    const custom = await cookStaticShadow({ custom: true });
    expect(custom.shadow.compile.wgsl).toContain('surfaceSample');
    expect(custom.shadow.compile.wgsl).toMatch(/if \([^\n]+ < 0\.5f\) \{\s+discard;/);
  });

  it.each([
    'mesh',
    'skinned',
  ] as const)('removes stock map inputs from %s constant alpha coverage', async (geometry) => {
    const { shadow } = await cookStaticShadow({
      context: { geometry },
      staticSwitches: { ...OPAQUE_SWITCHES, textures: false, alphaClipping: true },
    });
    expect(shadow.abi.vertexInputs.map((input) => input.semantic)).toEqual(
      geometry === 'skinned'
        ? ['position', 'normal', 'skinIndex', 'skinWeight']
        : ['position', 'normal'],
    );
    expect(shadow.abi.alphaMask.cutoff).toBe('alphaCutoff');
    for (const compiled of [shadow.compile, shadow.sceneCompile]) {
      const vertexOutput = compiled?.wgsl.match(/struct VsOut[^}]*}/)?.[0];
      expect(vertexOutput).toBeDefined();
      expect(vertexOutput).not.toMatch(/(?:uv0And1|objectBasis0|tangentWS)/);
    }
  });

  it('keeps the selected contract valid in the uniform fallback', async () => {
    const cooked = await cookStaticShadow({ context: { capability: 'uniform-fallback' } });
    expect(cooked.shadow.sceneCompile).toBeUndefined();
    expect(cooked.shadow.abi.vertexInputs.map((input) => input.semantic)).toEqual(['position']);
    expect(cooked.shadow.abi.alphaMask).toEqual({ cutoff: '', source: '' });
    expect(cooked.forward.compile.wgsl).not.toMatch(/\.alphaCutoff\b/);
  });
});
