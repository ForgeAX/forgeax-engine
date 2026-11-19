import { expect, it } from 'vitest';
import { ShaderRegistry } from '../index.js';

const source = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }';
const registry = () => new ShaderRegistry({ manifestUrl: undefined });

it('retains the declared fog contract with exact CPU programs through adoption and device fork', () => {
  const owner = registry();
  owner.installMaterialArtifact('game::fog', {
    source,
    paramSchema: [],
    forwardFog: 'height-vertex/1',
  });
  const first = owner.findMaterialArtifact('game::fog').unwrap();
  expect(first.program.forwardFog).toBe('height-vertex/1');
  expect(Object.isFrozen(first.program)).toBe(true);
  const receiver = registry();
  receiver.installMaterialArtifactsFrom(owner);
  expect(receiver.findMaterialArtifact('game::fog').unwrap().program.forwardFog).toBe(
    'height-vertex/1',
  );
  const fork = receiver.forkForDevice({
    createShaderModule() {
      throw new Error('CPU admission must not create a GPU module');
    },
  });
  fork.installMaterialArtifactsFrom(receiver);
  expect(fork.findMaterialArtifact('game::fog').unwrap().program.forwardFog).toBe(
    'height-vertex/1',
  );
  expect(receiver.materialProgram(source).forwardFog).toBe('height-vertex/1');
  expect(registry().materialProgram(source).forwardFog).toBeUndefined();
});

it('rejects an unsupported raw program fog contract before publishing the shader', () => {
  const owner = registry();
  expect(() =>
    owner.installMaterialArtifact('game::invalid', {
      source,
      paramSchema: [],
      forwardFog: 'future/99' as 'height-vertex/1',
    }),
  ).toThrow('Unsupported Forward fog contract');
  expect(owner.findMaterialArtifact('game::invalid').ok).toBe(false);
  owner.installMaterialArtifact('game::invalid', {
    source,
    paramSchema: [{ name: 'factor', type: 'f32' }],
    forwardFog: 'height-vertex/1',
  });
  expect(owner.findMaterialArtifact('game::invalid').unwrap().program.forwardFog).toBe(
    'height-vertex/1',
  );
});
