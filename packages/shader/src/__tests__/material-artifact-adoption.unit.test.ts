import { expect, it } from 'vitest';
import { createMaterialProgramArtifactReceipt, ShaderRegistry } from '../index.js';

function registry() {
  return new ShaderRegistry({ manifestUrl: undefined });
}

function entry(name = 'factor') {
  const paramSchema = [{ name, type: 'f32' as const }];
  return {
    source: '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }',
    paramSchema,
    receipt: createMaterialProgramArtifactReceipt({
      schema: paramSchema,
      directEntry: 'vs_main',
      vertexInputs: [],
    }),
  };
}

it('rejects a later duplicate before adopting any earlier program or schema', () => {
  const source = registry();
  source.installMaterialArtifact('game::first', entry());
  source.installMaterialArtifact('game::existing', entry());
  const target = registry();
  target.installMaterialArtifact('game::existing', entry('existing'));
  const before = target.paramSchemaProjectionStats();
  expect(() => target.installMaterialArtifactsFrom(source)).toThrow('already registered');
  expect(target.findMaterialArtifact('game::first').ok).toBe(false);
  expect(target.paramSchemaProjectionStats()).toEqual(before);
  const corrected = registry();
  corrected.installMaterialArtifact('game::first', entry());
  target.installMaterialArtifactsFrom(corrected);
  expect(target.findMaterialArtifact('game::first').ok).toBe(true);
});

it('preflights a schema retained by earlier failed direct installation before committing the batch', () => {
  const target = registry();
  expect(() =>
    target.installMaterialArtifact('game::failed', {
      ...entry('previous'),
      source: 'fn bad() { textureSample(baseColorTexture, s, uv); }',
    }),
  ).toThrow('samples texture');
  const before = target.paramSchemaProjectionStats();
  const source = registry();
  source.installMaterialArtifact('game::first', entry());
  source.installMaterialArtifact('game::failed', entry('changed'));
  expect(() => target.installMaterialArtifactsFrom(source)).toThrow('different schema content');
  expect(target.findMaterialArtifact('game::first').ok).toBe(false);
  expect(target.paramSchemaProjectionStats()).toEqual(before);
  const corrected = registry();
  corrected.installMaterialArtifact('game::first', entry());
  corrected.installMaterialArtifact('game::failed', entry('previous'));
  target.installMaterialArtifactsFrom(corrected);
  const adopted = target.findMaterialArtifact('game::failed').unwrap();
  expect(adopted.paramSchema[0]?.name).toBe('previous');
  expect(adopted.paramSchema).toBe(adopted.paramSchemaProjection.schema);
});

it('retains CPU program facts in a device fork without transferring device modules', () => {
  const source = registry();
  source.installMaterialArtifact('game::first', entry());
  const fork = source.forkForDevice({
    createShaderModule() {
      throw new Error('CPU admission must not create a GPU module');
    },
  });
  expect(fork.findMaterialArtifact('game::first').ok).toBe(false);
  fork.installMaterialArtifactsFrom(source);
  const original = source.findMaterialArtifact('game::first').unwrap();
  const adopted = fork.findMaterialArtifact('game::first').unwrap();
  expect(adopted.program).toBe(original.program);
  expect(adopted.receipt).toBe(original.receipt);
  expect(adopted.paramSchema).toBe(original.paramSchema);
  expect(adopted.paramSchemaProjection).not.toBe(original.paramSchemaProjection);
  expect(fork.paramSchemaProjectionStats()).toEqual({
    admissions: 1,
    derivations: 0,
    projections: 1,
  });
});

it('retains the immutable registered success publication without letting callers poison lookup', () => {
  const source = registry();
  source.installMaterialArtifact('game::first', entry());
  const first = source.findMaterialArtifact('game::first');
  expect(source.findMaterialArtifact('game::first')).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(() => Object.assign(first, { value: undefined })).toThrow(TypeError);
  expect(source.findMaterialArtifact('game::first').unwrap()).toBe(first.unwrap());
  const receiver = registry();
  receiver.installMaterialArtifactsFrom(source);
  const adopted = receiver.findMaterialArtifact('game::first');
  expect(receiver.findMaterialArtifact('game::first')).toBe(adopted);
  expect(adopted).not.toBe(first);
  expect(adopted.unwrap().program).toBe(first.unwrap().program);
});
