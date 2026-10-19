import { describe, expect, it } from 'vitest';
import { coalesceNativeReadOnlyDepthPasses } from '../features/native-read-only-depth-passes';
import type { RenderFeatureWork } from '../features/plan';

type Raster = Extract<RenderFeatureWork['passes'][number], { kind: 'raster' }>;
const pass = (id: number, sampled = false): Raster => ({
  kind: 'raster',
  name: `vfx.blended.${id}.raster`,
  colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
  depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
  ...(sampled ? { sampledTargets: ['depth'], sceneDepth: 'before-pass' as const } : {}),
  draws: [
    {
      program: 'read-only',
      bindings: [`material-${id}`],
      vertexData: [],
      draw: { kind: 'draw', vertexCount: 3, instanceCount: id + 1 },
    },
  ],
});
const readOnly = new Set(['read-only']);

describe('stock VFX read-only depth demand', () => {
  it('unions sampled-depth demand in authored blend order without a snapshot', () => {
    const source = [pass(0, true), pass(1), pass(2, true), pass(3)];
    const before = structuredClone(source);
    const result = coalesceNativeReadOnlyDepthPasses(source, readOnly);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sceneDepth: 'before-pass',
      sampledTargets: ['depth'],
      draws: source.flatMap((p) => p.draws),
    });
    expect(source).toEqual(before);
  });

  it('preserves per-pass and per-draw visibility, including an entirely disabled batch', () => {
    const source = [pass(0), { ...pass(1, true), enabled: false }, pass(2)];
    const middle = source[1];
    if (middle === undefined) throw new Error('Missing fixture');
    const result = coalesceNativeReadOnlyDepthPasses(source, readOnly);
    expect(result[0]?.enabled).toBe(true);
    if (result[0]?.kind !== 'raster') throw new Error('Missing raster');
    expect(result[0].draws.map((d) => d.enabled !== false)).toEqual([true, false, true]);
    const hidden = coalesceNativeReadOnlyDepthPasses(
      source.map((p) => ({ ...p, enabled: false })),
      readOnly,
    );
    expect(hidden[0]?.enabled).toBe(false);
    if (hidden[0]?.kind !== 'raster') throw new Error('Missing raster');
    expect(hidden[0].draws.every((d) => d.enabled === false)).toBe(true);
  });

  it.each([
    { colorAttachments: [{ target: 'other', loadOp: 'load', storeOp: 'store' }] },
    { colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }] },
    { colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'discard' }] },
    { depthStencilAttachment: { target: 'other', depthLoadOp: 'load', depthStoreOp: 'store' } },
    { depthStencilAttachment: { target: 'depth', depthLoadOp: 'clear', depthStoreOp: 'store' } },
    { depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'discard' } },
    { sampledTargets: ['unrelated'] },
    {
      draws: [
        {
          program: 'writer-or-unknown',
          bindings: [],
          vertexData: [],
          draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
        },
      ],
    },
  ] satisfies Partial<Raster>[])('keeps the original barrier for %j', (change) => {
    const source = [pass(0, true), { ...pass(1), ...change }, pass(2, true)];
    expect(coalesceNativeReadOnlyDepthPasses(source, readOnly)).toHaveLength(3);
  });

  it('keeps the original barrier when a pass has no depth attachment', () => {
    const { depthStencilAttachment: _depth, ...withoutDepth } = pass(1);
    expect(
      coalesceNativeReadOnlyDepthPasses([pass(0, true), withoutDepth, pass(2, true)], readOnly),
    ).toHaveLength(3);
  });

  it('retains compute, copy and shadow boundaries', () => {
    const shadow = { kind: 'shadow-caster' as const, name: 'shadow', draws: pass(0).draws };
    const result = coalesceNativeReadOnlyDepthPasses([pass(0), shadow, pass(1)], readOnly);
    expect(result).toHaveLength(3);
    expect(result[1]).toBe(shadow);
  });

  it('accepts read-only sampling and preserves a snapshot writer or unready pipeline boundary', () => {
    const sampled = { ...pass(0, true), sceneDepth: 'read-only' as const };
    const merged = coalesceNativeReadOnlyDepthPasses([sampled, pass(1)], readOnly);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ sceneDepth: 'read-only', sampledTargets: ['depth'] });
    expect(coalesceNativeReadOnlyDepthPasses([sampled, pass(1)], new Set())).toHaveLength(2);
  });
});
