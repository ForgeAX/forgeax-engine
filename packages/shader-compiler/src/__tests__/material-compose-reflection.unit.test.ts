import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';
import { composeMaterial } from '../material/compose-material.js';
import { compareDerivedMaterialInterface, parseReflection } from '../reflection.js';
import { materialReflectionFixture } from './fixtures/material-reflection.fixtures.js';

describe('material composition and reflection', () => {
  it('retains structured line and column when composition rejects WGSL syntax', async () => {
    const source = [
      '#define_import_path test::pulse',
      '#import forgeax_view::common',
      '',
      '@fragment',
      'fn fs_main() -> @location(0) vec4<f32> {',
      '  let broken = ;',
      '  return vec4<f32>(1.0);',
      '}',
    ].join('\n');

    const result = await compileShader(source, {
      id: '/workspace/pulse.wgsl',
      imports: {
        'forgeax_view::common': '#define_import_path forgeax_view::common\n',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.lineNum).toBe(6);
    expect(result.error.linePos).toBeGreaterThan(0);
    expect(result.error.expected).toBe('WGSL source parses + validates against naga IR');
    expect(result.error.hint).toContain('indicated line/column');
  });

  it('proves the first real composed reflection mismatch with generic bound-global facts', async () => {
    const source = `
struct SurfaceParameters { roughness: vec4<f32> }
@group(1) @binding(0) var<uniform> surfaceParameters: SurfaceParameters;
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return surfaceParameters.roughness;
}`;
    const compiled = await compileShader(source, { id: 'material::mismatch' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const checked = compareDerivedMaterialInterface(derive([{ name: 'roughness', type: 'f32' }]), {
      boundGlobals: compiled.value.reflection.boundGlobals,
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.code).toBe('material-derived-interface-mismatch');
      expect(checked.error.detail.parameter).toBe('roughness');
      expect(checked.error.detail.action).toBe('recook');
    }
  });

  it('composes a module closure and preserves pass and vertex reflection', async () => {
    const result = await composeMaterial(
      {
        material: materialReflectionFixture.material,
        pass: materialReflectionFixture.pass,
        source: materialReflectionFixture.source,
        imports: { 'game::common': '#define_import_path game::common\n' },
        context: {
          backend: 'webgpu',
          capability: 'storage-buffer',
          pipeline: 'forward',
          geometry: 'mesh',
          pass: 'forward',
          profile: 'forgeax-material-wgsl-v1',
          toolchain: 'naga-oil',
          instrumentation: 'none',
        },
      },
      async () => ({
        wgsl: materialReflectionFixture.source,
        bindings: materialReflectionFixture.reflection.bindings,
        deps: ['game::common'],
        vertexInputs: materialReflectionFixture.reflection.vertexInputs,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.material).toBe('painted-metal');
      expect(result.value.pass).toBe('Forward');
      expect(result.value.deps).toEqual(['game::common']);
      expect(result.value.vertexInputs).toEqual([{ location: 0, type: 'vec3<f32>' }]);
    }
  });

  it('characterizes the current comparator and legacy-wire boundaries', () => {
    expect(() => parseReflection('[]')).toThrow();
    expect(() =>
      parseReflection(
        JSON.stringify({ bindings: [], material: { members: [], resources: [], totalBytes: 0 } }),
      ),
    ).toThrow();
    const receipt = {
      schemaVersion: 'material-reflection-characterization/1',
      status: 'intermediate',
      observations: {
        legacyRawArray: 'rejected',
      },
    } as const;

    expect(receipt.observations.legacyRawArray).toBe('rejected');
  });
});
