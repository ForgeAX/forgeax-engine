import type { MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import { describe, expect, it } from 'vitest';
import { selectParticleMaterialContext } from '../feature/material-source';

const context = Object.freeze({
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
} as const);
type Program = MaterialRenderProjection['passes'][number]['programs'][number];
const program = (key: string, ctx: Program['context'] = context): Program => ({
  context: Object.freeze(ctx),
  specializationKey: key,
  artifactHash: key,
  address: 'direct',
});
const projection = (programs: Program[]): MaterialRenderProjection => ({
  materialGuid: 'test',
  publicationGeneration: 1,
  specializationKey: 'test',
  artifactHash: 'test',
  runtimeValues: {},
  staticSelection: [],
  passes: [{ name: 'particle-mesh', module: 'test', programs }],
});

describe('immutable particle context facts', () => {
  it('rechecks mutable program data after a frozen context has been validated', () => {
    const kept = program('kept');
    const dropped = program('dropped', { ...context, backend: 'webgl2' });
    const p = projection([kept, dropped]);
    expect(selectParticleMaterialContext(p, context).passes[0]?.programs).toEqual([kept]);
    let reads = 0;
    Object.defineProperty(dropped, 'entry', {
      enumerable: true,
      get() {
        reads++;
        return 'main';
      },
    });
    expect(selectParticleMaterialContext(p, context)).toBe(p);
    expect(reads).toBe(0);
  });

  it('does not treat an enumerable symbol value as cloneable context data', () => {
    const invalidContext = { ...context, extra: Symbol('uncloneable') };
    const p = projection([program('kept'), program('invalid', invalidContext)]);
    expect(selectParticleMaterialContext(p, context)).toBe(p);
    expect(() => structuredClone(p)).toThrow();
  });

  it.each([
    'shallow',
    'cycle',
  ] as const)('rechecks mutable descendants inside a frozen %s graph on the next publication', (shape) => {
    const child = { value: 1 };
    const graph: { child: typeof child; self?: unknown } = { child };
    if (shape === 'cycle') graph.self = graph;
    Object.freeze(graph);
    const dropped = program('dropped', { ...context, backend: 'webgl2' });
    Object.assign(dropped, { extra: graph });
    const p = projection([program('kept'), dropped]);
    expect(selectParticleMaterialContext(p, context).passes[0]?.programs).toHaveLength(1);
    let reads = 0;
    Object.defineProperty(child, 'value', {
      enumerable: true,
      get() {
        reads++;
        return Symbol('cannot clone');
      },
    });
    expect(selectParticleMaterialContext(p, context)).toBe(p);
    expect(reads).toBe(0);
    expect(() => structuredClone(p)).toThrow();
    expect(reads).toBe(1);
  });

  it('keeps a frozen enumerable accessor on the original clone path', () => {
    let reads = 0;
    const graph = Object.freeze({
      get value() {
        reads++;
        return 1;
      },
    });
    const dropped = program('dropped', { ...context, backend: 'webgl2' });
    Object.assign(dropped, { extra: graph });
    const p = projection([program('kept'), dropped]);
    for (let frame = 0; frame < 2; frame++) {
      expect(selectParticleMaterialContext(p, context)).toBe(p);
      expect(reads).toBe(frame);
      expect(structuredClone(p).passes[0]?.programs).toHaveLength(2);
    }
    expect(reads).toBe(2);
  });

  it('keeps mutable siblings current when reusing a deeply frozen data graph', () => {
    const data = Object.freeze({ bindings: Object.freeze([Object.freeze({ binding: 0 })]) });
    const kept = program('kept');
    const dropped = program('dropped', { ...context, backend: 'webgl2' });
    Object.assign(kept, { extra: data });
    Object.assign(dropped, { extra: data });
    const p = projection([kept, dropped]);
    expect(selectParticleMaterialContext(p, context).passes[0]?.programs).toEqual([kept]);
    Object.assign(dropped, { invalid: Symbol('cannot clone') });
    expect(selectParticleMaterialContext(p, context)).toBe(p);
    expect(() => structuredClone(p)).toThrow();
  });
});
