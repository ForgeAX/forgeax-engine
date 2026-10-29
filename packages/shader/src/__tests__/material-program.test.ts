import { describe, expect, it, vi } from 'vitest';
import * as programs from '../material/program';
import { ShaderRegistry } from '../ShaderRegistry';

describe('registry-owned material programs', () => {
  it('adds published entry reads to warmed source facts without rescanning or retaining caller data', () => {
    const source = 'struct Input { @location(0) pos: vec3f } @vertex fn main(v: Input) {}';
    const receiving = new ShaderRegistry({ manifestUrl: undefined });
    const staged = new ShaderRegistry({ manifestUrl: undefined });
    const reads = [
      {
        name: 'main',
        stage: 'vertex' as const,
        bindings: [{ group: 1, binding: 0, fields: ['scale'] }],
      },
    ];
    const analyze = vi.spyOn(programs, 'createMaterialShaderProgram');
    try {
      const warmed = receiving.materialProgram(source);
      staged.installMaterialArtifact(
        'forgeax::published',
        { source, paramSchema: [], entryPoints: reads },
        receiving,
      );
      const program = staged.findMaterialArtifact('forgeax::published').unwrap().program;
      expect(program.entryPoints).toEqual(reads);
      expect(program.vertexInputRequired).toBe(true);
      expect(program.sampledUserTextureFields).toBe(warmed.sampledUserTextureFields);
      expect(program.identity).toBe(warmed.identity);
      expect(analyze).toHaveBeenCalledTimes(1);
      reads[0]?.bindings[0]?.fields.push('mutated');
      expect(program.entryPoints?.[0]?.bindings[0]?.fields).toEqual(['scale']);
      receiving.installMaterialArtifactsFrom(staged);
      expect(receiving.materialProgram(source)).toBe(program);
      expect(receiving.forkForDevice({ createShaderModule: vi.fn() }).materialProgram(source)).toBe(
        program,
      );
    } finally {
      analyze.mockRestore();
    }
  });

  it('rejects conflicting entry reads for the same immutable source before publishing a shader', () => {
    const source = '@vertex fn main() {}';
    const receiving = new ShaderRegistry({ manifestUrl: undefined });
    const reads = [{ name: 'main', stage: 'vertex' as const, bindings: [] }];
    const accepted = receiving.materialProgram(source, reads);
    const staged = new ShaderRegistry({ manifestUrl: undefined });
    expect(() =>
      staged.installMaterialArtifact(
        'forgeax::conflict',
        {
          source,
          paramSchema: [],
          entryPoints: [{ name: 'main', stage: 'vertex', bindings: [{ group: 1, binding: 0 }] }],
        },
        receiving,
      ),
    ).toThrow('entry read contract');
    expect(staged.findMaterialArtifact('forgeax::conflict').ok).toBe(false);
    expect(receiving.materialProgram(source)).toBe(accepted);
  });

  it('reuses sampled texture facts while checking each staged schema and exact source', () => {
    const source = `// textureSample(normalTexture, s, uv)
      fn read() { textureSampleLevel(baseColorTexture, s, uv, 0); }
      /* textureSample(metallicRoughnessTexture, s, uv) */`;
    const receiving = new ShaderRegistry({ manifestUrl: undefined });
    const warmed = receiving.materialProgram(source);
    expect(warmed.sampledUserTextureFields).toEqual(['baseColorTexture']);
    expect(Object.isFrozen(warmed.sampledUserTextureFields)).toBe(true);
    const staged = new ShaderRegistry({ manifestUrl: undefined });
    const schema = [{ name: 'baseColorTexture', type: 'texture2d' as const }];
    staged.installMaterialArtifact('game::valid', { source, paramSchema: schema }, receiving);
    receiving.installMaterialArtifactsFrom(staged);
    expect(receiving.findMaterialArtifact('game::valid').unwrap().program).toBe(warmed);
    expect(() =>
      staged.installMaterialArtifact('game::missing', { source, paramSchema: [] }, receiving),
    ).toThrow('samples texture(s) [baseColorTexture]');
    const changed = `${source}\nfn normal() { textureSample(normalTexture, s, uv); }`;
    expect(() =>
      staged.installMaterialArtifact(
        'game::changed',
        { source: changed, paramSchema: schema },
        receiving,
      ),
    ).toThrow('samples texture(s) [normalTexture]');
    expect(receiving.findMaterialArtifact('game::missing').ok).toBe(false);
    expect(receiving.findMaterialArtifact('game::changed').ok).toBe(false);
    schema.push({ name: 'normalTexture', type: 'texture2d' });
    expect(receiving.findMaterialArtifact('game::valid').unwrap().paramSchema).toHaveLength(1);
    expect(receiving.forkForDevice({ createShaderModule: vi.fn() }).materialProgram(source)).toBe(
      warmed,
    );
  });

  it.each([
    ['struct input', 'struct Input { @location(0) pos: vec3f } @vertex fn main(v: Input) {}', true],
    ['direct input', '@vertex fn main(@location(0) pos: vec3f) {}', true],
    [
      'fullscreen output',
      'struct Output { @location(0) uv: vec2f } @vertex fn main(@builtin(vertex_index) id: u32) -> Output {}',
      false,
    ],
    [
      'commented input',
      '/* outer /* inner */ struct Input { @location(0) pos: vec3f } @vertex fn unused(v: Input) {} */ @vertex fn main(@builtin(vertex_index) id: u32) {}',
      false,
    ],
    [
      'separated tokens',
      'struct/**/Input { @location(0) pos: vec3f } @vertex/**/fn main(v: Input) {}',
      true,
    ],
    [
      'exact type name',
      'struct Input { @location(0) pos: vec3f } struct InputExtra { @builtin(vertex_index) id: u32 } @vertex fn main(v: InputExtra) {}',
      false,
    ],
  ] as const)('retains the vertex input requirement with the immutable program: %s', (_name, source, required) => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const program = registry.materialProgram(source);
    expect(program.vertexInputRequired).toBe(required);
    expect(programs.materialShaderVertexInputRequired(source)).toBe(required);
    expect(registry.forkForDevice({ createShaderModule: vi.fn() }).materialProgram(source)).toBe(
      program,
    );
  });
  it('selects the first declared vertex input with exact type names and preserves a UV absence', () => {
    const source = `struct Output { @location(0) uv7: vec2f }
      struct Input { @location(0) position: vec3f }
      struct InputExtra { @location(1) uv3: vec2f }
      @vertex fn first(v: InputExtra) -> Output { return Output(); }
      @vertex fn second(v: Input) -> Output { return Output(); }`;
    expect(programs.createMaterialShaderProgram(source).uvSetCount).toBeUndefined();
    expect(
      programs.createMaterialShaderProgram(source.replace('position: vec3f', 'uv1: vec2f'))
        .uvSetCount,
    ).toBe(2);
    expect(
      programs.createMaterialShaderProgram(source.replace('@vertex fn second', 'fn second'))
        .uvSetCount,
    ).toBe(4);
  });
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

it('keeps source identity available beyond historical cumulative source quotas', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const common = `//${'x'.repeat(16 * 1024 * 1024)}\n`;
  const sources = Array.from({ length: 9 }, (_, index) =>
    registry.shaderSource(`${common}// ${index}`),
  );
  expect(registry.sourceInspection().logicalBytes).toBeGreaterThan(256 * 1024 * 1024);
  const fork = registry.forkForDevice({ createShaderModule: vi.fn() });
  for (const source of sources) expect(fork.shaderSource(source)).toBe(source);
}, 60000);

it('captures material source once before source-reference verification', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  let reads = 0;
  const first = 'fn sourceA() {}';
  const second = 'fn sourceB() {}';
  registry.installMaterialArtifact('game::accessor-source', {
    get source() {
      return ++reads === 1 ? first : second;
    },
    paramSchema: [],
  });
  expect(reads).toBe(1);
  expect(registry.findMaterialArtifact('game::accessor-source').unwrap().program.source).toBe(
    first,
  );
  expect(registry.materialProgram(second).source).toBe(second);
});
