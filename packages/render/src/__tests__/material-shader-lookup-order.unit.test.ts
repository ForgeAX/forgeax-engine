import { createStandardPbrArtifactReceipt, ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  type MaterialShaderArtifactRequest,
  resolveMaterialShaderArtifact,
} from '../assembly/material/assembly';

const rigid = 'forgeax::default-standard-pbr';
const skin = 'forgeax::pbr-skin';
const fallback = 'forgeax::default-standard-pbr-skin';
const shadow = 'forgeax::default-shadow-caster';

function registry(ids: readonly string[]) {
  const owner = new ShaderRegistry({ manifestUrl: undefined });
  for (const id of ids)
    owner.installMaterialArtifact(id, {
      source: 'fn fs_main() -> vec4f { return vec4f(1.0); }',
      paramSchema: [],
      receipt: createStandardPbrArtifactReceipt(id === skin || id === fallback),
    });
  return owner;
}

function traced(owner: ShaderRegistry, calls: string[], failure?: Error) {
  return {
    findMaterialArtifact(id: string) {
      calls.push(`find:${id}`);
      if (failure !== undefined) throw failure;
      return owner.findMaterialArtifact(id);
    },
    materialShaderManifestEntry(id: string) {
      calls.push(`manifest:${id}`);
      return owner.materialShaderManifestEntry(id);
    },
    materialProgram(source: string) {
      calls.push('program');
      return owner.materialProgram(source);
    },
  };
}

describe('material shader lookup ordering', () => {
  it.each([
    [skin, fallback],
    [fallback, skin],
  ])('keeps %s first and %s as its only fallback', (first, second) => {
    const calls: string[] = [];
    const result = resolveMaterialShaderArtifact(first, traced(registry([second]), calls));
    expect(result?.material).toBe(first);
    expect(calls.filter((call) => call.startsWith('find:'))).toEqual([
      `find:${first}`,
      `find:${second}`,
    ]);
    calls.length = 0;
    expect(
      resolveMaterialShaderArtifact(first, traced(registry([first, second]), calls)),
    ).toBeDefined();
    expect(calls.filter((call) => call.startsWith('find:'))).toEqual([`find:${first}`]);
  });

  it('selects only the shadow-caster lookup before subsequent option callbacks', () => {
    const calls: string[] = [],
      owner = registry([skin, fallback, shadow]);
    let passReads = 0;
    const options: MaterialShaderArtifactRequest = {
      get pass() {
        calls.push('pass');
        return ++passReads === 1 ? 'shadow' : 'forward';
      },
    };
    const result = resolveMaterialShaderArtifact(skin, traced(owner, calls), options);
    expect(result?.material).toBe(shadow);
    expect(result?.pass).toBe('forward');
    expect(calls.filter((call) => call.startsWith('find:'))).toEqual([`find:${shadow}`]);
    expect(calls[0]).toBe('pass');
  });

  it('keeps the first registry exception identity without reading later request fields', () => {
    const calls: string[] = [],
      failure = Error('registry');
    let thrown: unknown;
    try {
      resolveMaterialShaderArtifact(rigid, traced(registry([rigid]), calls, failure), {
        get variantSet(): string {
          calls.push('variant');
          throw Error('unused');
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(calls).toEqual([`find:${rigid}`]);
  });

  it('does not allocate an iterable lookup-name array on a warm direct lookup', () => {
    const owner = registry([rigid]);
    resolveMaterialShaderArtifact(rigid, owner);
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    if (descriptor === undefined) throw Error('Missing standard array iterator');
    const original = descriptor.value as (this: unknown[]) => IterableIterator<unknown>;
    let lookupArrays = 0;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      ...descriptor,
      value(this: unknown[]) {
        if (this.length === 1 && this[0] === rigid) lookupArrays++;
        return original.call(this);
      },
    });
    try {
      for (let draw = 0; draw < 64; draw++) resolveMaterialShaderArtifact(rigid, owner);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, descriptor);
    }
    expect(lookupArrays).toBe(0);
  });
  it('retains fallback after a present entry has no admitted receipt', () => {
    const owner = registry([fallback]),
      calls: string[] = [];
    owner.installMaterialArtifact(skin, { source: 'fn fs_main() {}', paramSchema: [] });
    expect(resolveMaterialShaderArtifact(skin, traced(owner, calls))?.material).toBe(skin);
    expect(calls.filter((call) => call.startsWith('find:'))).toEqual([
      `find:${skin}`,
      `find:${fallback}`,
    ]);
  });

  it('keeps captured alias names when the first registry callback changes request pass', () => {
    const owner = registry([fallback, shadow]),
      calls: string[] = [];
    const options: MaterialShaderArtifactRequest = { pass: 'forward' };
    const shader = traced(owner, calls),
      find = shader.findMaterialArtifact;
    shader.findMaterialArtifact = (id) => {
      Object.assign(options, { pass: 'shadow' });
      return find(id);
    };
    expect(resolveMaterialShaderArtifact(skin, shader, options)?.material).toBe(skin);
    expect(calls.filter((call) => call.startsWith('find:'))).toEqual([
      `find:${skin}`,
      `find:${fallback}`,
    ]);
  });
});
