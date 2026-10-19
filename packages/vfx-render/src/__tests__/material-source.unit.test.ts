import {
  findMaterialPassProgram,
  type MaterialRenderProjection,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { MaterialAsset, MaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createHostMaterialSource,
  type ParticleMaterialSource,
  projectParticleMaterial,
  selectParticleMaterialContext,
} from '../feature/material-source';

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
type Context = NonNullable<Parameters<typeof selectParticleMaterialContext>[1]>;
const world = {} as World;
const material = {} as MaterialAsset;
const program = (
  key: string,
  ctx: Context = context,
  color = false,
): Program & { readonly context: Context } => ({
  context: Object.freeze(ctx),
  specializationKey: key,
  artifactHash: key,
  address: 'direct',
  abi: { vertexInputs: color ? [{ semantic: 'color' }] : [] } as unknown as MaterialProgramAbi,
});
const projection = (rows: Program[]): MaterialRenderProjection => ({
  materialGuid: 'test',
  publicationGeneration: 1,
  specializationKey: 'test',
  artifactHash: 'test',
  runtimeValues: {},
  staticSelection: [],
  passes: [{ name: 'particle-mesh', module: 'test', programs: rows }],
});

describe('stock particle material transport domain', () => {
  it('uses the exact selector including color preference without retaining another frame', () => {
    const plain = program('plain'),
      color = program('color', context, true),
      other = program('other', { ...context, backend: 'webgl2' }),
      p = projection([plain, other, color]);
    const next = selectParticleMaterialContext(p, context);
    expect(next.passes[0]?.programs).toEqual([plain, color]);
    expect(p.passes[0]?.programs).toHaveLength(3);
    expect(findMaterialPassProgram(next, 'particle-mesh', context, 'direct', true)).toBe(
      findMaterialPassProgram(p, 'particle-mesh', context, 'direct', true),
    );
    Object.assign(color.abi ?? {}, { vertexInputs: [] });
    expect(() =>
      findMaterialPassProgram(
        selectParticleMaterialContext(p, context),
        'particle-mesh',
        context,
        'direct',
        true,
      ),
    ).toThrow(); // still ambiguous
  });
  it('preserves missing and ambiguous failures at the receiving selector', () => {
    expect(
      selectParticleMaterialContext(
        projection([program('a', { ...context, backend: 'webgl2' })]),
        context,
      ).passes[0]?.programs,
    ).toHaveLength(1);
    expect(() =>
      findMaterialPassProgram(
        selectParticleMaterialContext(projection([program('a'), program('b')]), context),
        'particle-mesh',
        context,
        'direct',
        true,
      ),
    ).toThrow();
  });
  it('does not invoke nested ABI or context getters to prune', () => {
    let reads = 0;
    const row = program('a');
    Object.defineProperty(row.abi, 'vertexInputs', {
      get() {
        reads++;
        throw Error('nested');
      },
    });
    const p = projection([row]);
    selectParticleMaterialContext(p, context);
    expect(reads).toBe(0);
    const c = { ...context };
    Object.defineProperty(c, 'backend', {
      get() {
        reads++;
        return 'webgpu';
      },
    });
    const q = projection([program('b', c)]);
    expect(selectParticleMaterialContext(q, context)).toBe(q);
    expect(reads).toBe(0);
  });
  it('keeps exotic descriptor failures on the original transport path', () => {
    const row = program('a');
    Object.assign(row, {
      abi: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('descriptor trap');
          },
        },
      ),
    });
    const p = projection([row]);
    expect(selectParticleMaterialContext(p, context)).toBe(p);
    expect(() => structuredClone(p)).toThrow();
  });
  it('keeps unknown passes and current mutable render state/runtime values', () => {
    const p = projection([program('a'), program('b', { ...context, backend: 'webgl2' })]);
    Object.assign(p.passes[0] ?? {}, { renderState: { depthWrite: false } });
    const unknown = { name: 'custom', module: 'test', programs: [program('custom')] };
    Object.assign(p, { passes: [...p.passes, unknown] });
    const next = selectParticleMaterialContext(p, context);
    expect(next.passes[1]).toBe(unknown);
    expect(next.passes[0]?.renderState).toBe(p.passes[0]?.renderState);
    expect(next.runtimeValues).toBe(p.runtimeValues);
  });
  it('reselects each device domain and keeps an absent domain complete', () => {
    const a = program('a'),
      b = program('b', { ...context, backend: 'webgl2' }),
      p = projection([a, b]);
    expect(selectParticleMaterialContext(p, undefined)).toBe(p);
    expect(selectParticleMaterialContext(p, context).passes[0]?.programs).toEqual([a]);
    expect(selectParticleMaterialContext(p, b.context).passes[0]?.programs).toEqual([b]);
  });
  it('preserves raw getter receiver, argument count, exceptions and repeated reads', () => {
    let reads = 0,
      calls = 0;
    const raw: ParticleMaterialSource = {
      read: () => undefined,
      get projection() {
        reads++;
        return function (this: unknown, ...args: unknown[]) {
          expect(this).toBe(raw);
          expect(args).toHaveLength(2);
          calls++;
          throw Error('raw');
        };
      },
    };
    for (let i = 0; i < 2; i++)
      expect(() => projectParticleMaterial(raw, world, material, context)).toThrow('raw');
    expect(reads).toBe(2);
    expect(calls).toBe(2);
  });
  it('only passes the context to the internal runtime host provider', () => {
    const observed: unknown[] = [];
    const source = createHostMaterialSource(
      () => undefined,
      () => true,
      (_w, _m, c) => {
        observed.push(c);
        return undefined;
      },
    );
    source.projection?.(world, material);
    projectParticleMaterial(source, world, material, context);
    expect(observed).toEqual([undefined, context]);
  });
});
