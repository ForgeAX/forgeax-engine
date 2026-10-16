import { describe, expect, it, vi } from 'vitest';
import * as programs from '../material/program';
import { ShaderRegistry } from '../ShaderRegistry';

describe('registry-owned material programs', () => {
  it.each([
    ['line masks block opener', '// /* @group(2) @binding(3)\n', 'skin'],
    ['block masks line opener', '/* // @group(2) @binding(3)\n */', 'skin'],
    ['nested markers', '/* /* @group(2) @binding(3) */ // */', 'skin'],
    ['line ends before declaration', '// @group(2) @binding(3)', 'skin'],
    ['unterminated block', '/* @group(2) @binding(3)', 'mesh'],
    ['unterminated nested block', '/* /* */ @group(2) @binding(3)', 'mesh'],
  ] as const)('preserves comment termination and nesting: %s', (_name, prefix, expected) => {
    const source = `${prefix}\n@group(2) @binding(1) var<uniform> skin: mat4x4f;`;
    expect(programs.createMaterialShaderProgram(source).group2).toBe(expected);
  });

  it('keeps token boundaries and deeply nested comments without exposing their declarations', () => {
    const nested = `${'/*'.repeat(2048)} @group(2) @binding(9) ${'*/'.repeat(2048)}`;
    const program = programs.createMaterialShaderProgram(`${nested}
      struct/**/Input { @location(0) pos: vec3f, @location(1) uv1: vec2f }
      @vertex/**/fn vs_main(input: Input) -> @builtin(position) vec4f { return vec4f(input.pos, 1); }
      @group/**/(2) @binding/**/(1) var<uniform> skin: mat4x4f;
    `);
    expect(program.group2).toBe('skin');
    expect(program.uvSetCount).toBe(2);
    expect(programs.createMaterialShaderProgram('// @group(2) @binding(1)').group2).toBe('mesh');
  });

  it('admits vertex UV count once, including a known absence for opaque shadow programs', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const source = `struct Input { @location(0) position: vec3f, @location(2) uv: vec2f, @location(9) uv7_: vec2f }
      @vertex fn vs_main(input: Input) -> @builtin(position) vec4f { return vec4f(input.position, 1); }`;
    const program = registry.materialProgram(source);
    expect(program.uvSetCount).toBe(8);
    expect(
      registry.materialProgram(
        `/* outer /* inner */ struct Fake { @location(2) uv9_: vec2f } */ ${source}`,
      ).uvSetCount,
    ).toBe(8);
    const shadow = registry.materialProgram(
      '@vertex fn vs_shadow(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f { return vec4f(0); }',
    );
    expect(shadow).toHaveProperty('uvSetCount', undefined);
    for (let frame = 0; frame < 100; frame++) {
      expect(registry.materialProgram(source)).toBe(program);
      expect(registry.materialProgram(shadow.source)).toBe(shadow);
    }
  });
  it('shares one source analysis across registrations, variants, lookups and device replacement', () => {
    const source = '@group(2) @binding(3) var<uniform> cluster: vec4f;';
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const analyze = vi.spyOn(programs, 'createMaterialShaderProgram');
    try {
      registry.installMaterialArtifact('forgeax::first', { source, paramSchema: [] });
      registry.installMaterialArtifact('forgeax::second', { source, paramSchema: [] });
      const first = registry.findMaterialArtifact('forgeax::first').unwrap().program;
      const second = registry.findMaterialArtifact('forgeax::second').unwrap().program;
      const replacement = registry.forkForDevice({ createShaderModule: vi.fn() });
      for (let frame = 0; frame < 100; frame += 1) {
        expect(registry.materialProgram(source)).toBe(first);
        expect(replacement.materialProgram(source)).toBe(first);
      }
      expect(first).toBe(second);
      expect(first.group2).toBe('cluster');
      expect(Object.isFrozen(first)).toBe(true);
      expect(analyze).toHaveBeenCalledTimes(1);

      const changed = registry.materialProgram(
        '@group(2) @binding(1) var<uniform> skin: mat4x4<f32>;',
      );
      expect(changed.group2).toBe('skin');
      expect(changed.identity).not.toBe(first.identity);
      expect(analyze).toHaveBeenCalledTimes(2);
      expect(first.group2).toBe('cluster');
    } finally {
      analyze.mockRestore();
    }
  });

  it.each([
    ['declaration only', '@group(1) @binding(0) var<uniform> params: vec4f;', false],
    ['reversed attributes', '@binding(0) @group(1) var<uniform> params: vec4f;', false],
    [
      'fragment helper read',
      '@group(1) @binding(0) var<uniform> params: vec4f; fn shade() -> vec4f { return params; }',
      true,
    ],
    [
      'vertex helper read',
      '@group(1) @binding(0) var<uniform> params: vec4f; fn position() -> f32 { return params.x; }',
      true,
    ],
    [
      'another entry read',
      '@group(1) @binding(0) var<uniform> params: vec4f; @compute @workgroup_size(1) fn other() { let value = params.x; }',
      true,
    ],
    [
      'address reference',
      '@group(1) @binding(0) var<uniform> params: vec4f; fn helper() { let address = &params; }',
      true,
    ],
    [
      'nested comments',
      '/* outer /* inner */ @group(1) @binding(0) var<uniform> fake: vec4f; */ @group(1) @binding(0) var<uniform> params: vec4f; fn helper() -> vec4f { return params; }',
      true,
    ],
    [
      'comment references only',
      '@group(1) /* nested /* params */ params */ @binding(0) var<uniform> params: vec4f; // params',
      false,
    ],
    [
      'comment token boundary',
      '@group(1) @binding(0) var<uniform> params: vec4f; fn helper() -> f32 { return params/* comment */.x; }',
      true,
    ],
    [
      'unrecognized binding expression',
      '@group(MATERIAL_GROUP) @binding(0) var<uniform> params: vec4f;',
      true,
    ],
    [
      'aliased binding in another entry',
      '@group(1) @binding(0) var<uniform> unused: vec4f; @group(1) @binding(0) var<uniform> used: vec4f; fn helper() -> vec4f { return used; }',
      true,
    ],
    [
      'unknown alias beside unused declaration',
      '@group(1) @binding(0) var<uniform> unused: vec4f; @group(GROUP) @binding(0) var<uniform> used: vec4f; fn helper() -> vec4f { return used; }',
      true,
    ],
    [
      'unsupported identifier beside unused declaration',
      '@group(1) @binding(0) var<uniform> unused: vec4f; @group(1) @binding(0) var<uniform> \u4f7f\u7528: vec4f;',
      true,
    ],
    ['unknown source', 'synthetic', true],
  ] as const)('keeps material uniform use conservative: %s', (_name, source, required) => {
    expect(programs.createMaterialShaderProgram(source).materialUniformRequired).toBe(required);
  });

  it('derives both binding decisions from the selected source while ignoring comments', () => {
    const program = programs.createMaterialShaderProgram(`
      // @group(2) @binding(9) var<uniform> notCluster: vec4f;
      /* @group(2) @binding(1) var<uniform> notSkin: vec4f; */
      @group(2) @binding(0) var<storage> rows: array<u32>;
      @group(3) @binding(1) var<storage, read> probes: array<vec4<f32>>;
    `);
    expect(program.group2).toBe('mesh');
    expect(program.probeBlendRecordRequired).toBe(true);
    expect(
      programs.createMaterialShaderProgram(
        '@group(3) @binding(1) var<storage> visible: array<vec2<u32>>;',
      ).probeBlendRecordRequired,
    ).toBe(false);
  });

  it('retains literal material bindings once, including reordered attributes and aliases', () => {
    const program = programs.createMaterialShaderProgram(`
      /* @group(1) @binding(21) var absent: sampler; */
      @binding(18) @group(1) var sharedSampler: SamplerAlias;
      @group(1u) @binding(22u) var backdrop: texture_2d<f32>;
      @group(2) @binding(21) var unrelated: sampler;
      @group(1) @binding(0) var<uniform> material: vec4f;
    `);
    expect(program.materialBindings).toEqual([18, 22, 0]);
    expect(Object.isFrozen(program.materialBindings)).toBe(true);
    expect(programs.createMaterialShaderProgram('synthetic').materialBindings).toBeUndefined();
    expect(
      programs.createMaterialShaderProgram('@group(GROUP) @binding(21) var unknown: sampler;')
        .materialBindings,
    ).toBeUndefined();
    expect(
      programs.createMaterialShaderProgram(`
      @group(1) @binding(18) var known: sampler;
      @group(1) @binding((21)) var unknown: sampler;
    `).materialBindings,
    ).toBeUndefined();
    expect(
      programs.createMaterialShaderProgram(`
      @group(1) @binding(18) var known: sampler;
      @group((1)) @binding((21)) var unknown: sampler;
    `).materialBindings,
    ).toBeUndefined();
  });
});
