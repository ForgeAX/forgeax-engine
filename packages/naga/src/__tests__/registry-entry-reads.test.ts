import { assert, expect, it } from 'vitest';
import { ShaderRegistry } from '../../../shader/src/ShaderRegistry';
import { emit_reflection, parse, parseReflectionWire, validate } from '../index';

it('retains immutable native entry facts across private publication and registry forks', async () => {
  const source =
    'struct P { value: vec4<f32>, unused: vec4<f32>, } @group(1) @binding(0) var<uniform> p: P; @vertex fn vs_main() -> @builtin(position) vec4<f32> { return p.value; }';
  const module = (await validate((await parse(source)).unwrap())).unwrap();
  try {
    const entryPoints = parseReflectionWire(
      (await emit_reflection(module, '{}')).unwrap(),
    ).entryPoints;
    assert(entryPoints !== undefined);
    const prepared = new ShaderRegistry({ manifestUrl: undefined });
    prepared.installMaterialArtifact('game::entry-reads', { source, paramSchema: [], entryPoints });
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    expect(registry.materialProgram(source).entryPoints).toBeUndefined();
    registry.installMaterialArtifactsFrom(prepared);
    const program = registry.findMaterialArtifact('game::entry-reads').unwrap().program;
    expect(program.entryPoints).toEqual(entryPoints);
    expect(Object.isFrozen(program.entryPoints?.[0]?.bindings[0]?.fields)).toBe(true);
    expect(registry.materialProgram(source)).toBe(program);
    expect(
      registry
        .forkForDevice({
          createShaderModule: () => {
            throw new Error('No GPU construction');
          },
        } as never)
        .materialProgram(source),
    ).toBe(program);
  } finally {
    module.free();
  }
});
