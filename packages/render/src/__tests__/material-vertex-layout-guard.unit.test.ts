import { createMeshBuilder, deriveVertexBufferLayout } from '@forgeax/engine-geometry';
import { describe, expect, it, vi } from 'vitest';
import { buildPipelineForMaterialShader, type PipelineBuilderContext } from '../pipeline-builder';
import { declaredVertexInputs } from '../vertex-input-guard';

// A material whose vertex stage reads a tangent, like the pre-fix stock unlit.
const tangentReader = `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  // @location(9) commented: vec4<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
};
@vertex fn vs_main(in: VertexInput, @builtin(instance_index) instance: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(in.position + in.tangent.xyz * 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;

// A line-list mesh keeps exactly the streams it authored (no derived tangent).
function tangentlessVertexBuffers(): GPUVertexBufferLayout[] {
  const mesh = createMeshBuilder({
    attributes: {
      position: new Float32Array([0, 0, 0, 1, 0, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0]),
    },
    indices: [0, 1],
    submeshes: [{ topology: 'line-list' }],
  })
    .build()
    .unwrap();
  return deriveVertexBufferLayout(mesh.attributes) as unknown as GPUVertexBufferLayout[];
}

function build(passKind: 'forward' | 'shadow-caster', vertexBuffers: GPUVertexBufferLayout[]) {
  const createRenderPipeline = vi.fn((_descriptor: unknown) => ({ ok: true, value: {} }));
  const createShaderModule = vi.fn(() => ({ ok: true, value: {} }));
  const result = buildPipelineForMaterialShader(
    'test::tangent-reader',
    { source: tangentReader, paramSchema: [] },
    {
      device: { createRenderPipeline },
      shaderModuleFactory: { createShaderModule },
      pipelineLayout: {},
      vertexBuffers,
      colorFormat: 'rgba8unorm',
      colorFormats: passKind === 'shadow-caster' ? [] : ['rgba8unorm'],
      depthFormat: 'depth32float',
    } as unknown as PipelineBuilderContext,
    undefined,
    undefined,
    'vs_main',
    'fs_main',
    undefined,
    passKind,
  );
  return { result, createRenderPipeline, createShaderModule };
}

describe('material pipeline vertex-layout guard', () => {
  it('reads the selected entry inputs, skipping builtins and comments', () => {
    expect(declaredVertexInputs(tangentReader, 'vs_main')).toEqual([
      { location: 0, name: 'position' },
      { location: 1, name: 'normal' },
      { location: 2, name: 'uv' },
      { location: 3, name: 'tangent' },
    ]);
    expect(
      declaredVertexInputs(
        '@vertex fn vs(@location(0) p: vec3f, @location(5) c: vec4f) -> @builtin(position) vec4f { return vec4f(p, c.x); }',
        'vs',
      ).map((input) => input.location),
    ).toEqual([0, 5]);
    expect(declaredVertexInputs(tangentReader, 'vs_missing')).toEqual([]);
  });

  it.each([
    'forward',
    'shadow-caster',
  ] as const)('%s: a mesh missing an input fails with a structured error before pipeline creation', (passKind) => {
    const { result, createRenderPipeline, createShaderModule } = build(
      passKind,
      tangentlessVertexBuffers(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('rhi-descriptor-invalid');
    expect(result.error.expected).toContain("'test::tangent-reader'");
    expect(result.error.expected).toContain('@location(3) tangent');
    expect(result.error.hint).toContain('skipped');
    expect(createRenderPipeline).not.toHaveBeenCalled();
    expect(createShaderModule).not.toHaveBeenCalled();
  });

  it('admits a mesh layout that supplies every declared input', () => {
    const complete = deriveVertexBufferLayout({
      position: new Float32Array(3),
      normal: new Float32Array(3),
      uv: new Float32Array(2),
      tangent: new Float32Array(4),
    }) as unknown as GPUVertexBufferLayout[];
    const { result, createRenderPipeline } = build('forward', complete);
    expect(result.ok).toBe(true);
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
  });
});
