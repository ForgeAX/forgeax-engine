import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../../../render/src/features/host';
import { renderFeaturePlanSignature } from '../../../render/src/features/plan';
import { coalesceVfxRasterPasses } from '../feature/raster-passes';

type Pass = Parameters<typeof coalesceVfxRasterPasses>[0][number];
const pass = (id: number, change: Partial<Pass> = {}): Pass => ({
  kind: 'raster',
  name: `emitter-${id}.raster`,
  enabled: true,
  colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
  depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'store' },
  draws: [
    {
      program: `program-${id}`,
      bindings: [],
      vertexData: [],
      draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
    },
  ],
  ...change,
});

describe('VFX raster encoder sharing', () => {
  it('keeps every ordered draw and leaves source declarations untouched', () => {
    const source = [pass(2), pass(0), pass(1)];
    const before = structuredClone(source);
    const result = coalesceVfxRasterPasses(source, 'blended');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('vfx.blended.0.raster');
    expect(result[0]?.draws).toEqual(source.flatMap((p) => p.draws));
    expect(source).toEqual(before);
    expect(coalesceVfxRasterPasses([], 'opaque')).toEqual([]);
  });

  it.each([
    { colorAttachments: [{ target: 'other', loadOp: 'load', storeOp: 'store' }] },
    { colorAttachments: [{ target: 'color', loadOp: 'clear', storeOp: 'store' }] },
    { colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'discard' }] },
    { colorAttachments: [] },
    { depthStencilAttachment: { target: 'other', depthLoadOp: 'load', depthStoreOp: 'store' } },
    { depthStencilAttachment: { target: 'depth', depthLoadOp: 'clear', depthStoreOp: 'store' } },
    { depthStencilAttachment: { target: 'depth', depthLoadOp: 'load', depthStoreOp: 'discard' } },
    { sampledTargets: ['depth'] },
  ] satisfies Partial<Pass>[])('retains a pass boundary for %j', (change) => {
    const source = [pass(0), pass(1, change), pass(2)];
    const result = coalesceVfxRasterPasses(source, 'opaque');
    expect(result).toHaveLength(3);
    expect(result.flatMap((p) => p.draws)).toEqual(source.flatMap((p) => p.draws));
  });

  it('retains one graph signature while only the middle emitter visibility changes', () => {
    const host = createRenderFeatureHost([]).unwrap();
    const source = [pass(0), pass(1), pass(2)] as const;
    const initial = { resources: [], passes: coalesceVfxRasterPasses(source, 'blended') };
    const signature = renderFeaturePlanSignature(initial);
    const admitted = host.recordPlanSignature?.('particles', initial);
    for (const visible of [false, true, false]) {
      const changed = [source[0], pass(1, { enabled: visible }), source[2]];
      const plan = { resources: [], passes: coalesceVfxRasterPasses(changed, 'blended') };
      expect(plan.passes).toHaveLength(1);
      expect(plan.passes[0]?.draws.map((draw) => draw.enabled !== false)).toEqual([
        true,
        visible,
        true,
      ]);
      expect(plan.passes[0]?.draws.map((draw) => draw.program)).toEqual([
        'program-0',
        'program-1',
        'program-2',
      ]);
      expect(renderFeaturePlanSignature(plan)).toBe(signature);
      expect(host.recordPlanSignature?.('particles', plan)).toBe(admitted);
    }
    const hidden = {
      resources: [],
      passes: coalesceVfxRasterPasses(
        source.map((pass) => ({ ...pass, enabled: false })),
        'blended',
      ),
    };
    expect(hidden.passes).toHaveLength(1);
    expect(hidden.passes[0]?.enabled).toBe(false);
    expect(hidden.passes[0]?.draws.every((draw) => draw.enabled === false)).toBe(true);
    expect(host.recordPlanSignature?.('particles', hidden)).toBe(admitted);
    expect(host.recordPlanSignature?.('particles', initial)).toBe(admitted);
    expect(source.every((item) => item.enabled === true)).toBe(true);
    host.dispose();
  });

  it('keeps the boundary when depth is absent on only one side', () => {
    const { depthStencilAttachment: _depth, ...withoutDepth } = pass(1);
    expect(coalesceVfxRasterPasses([pass(0), withoutDepth, pass(2)], 'opaque')).toHaveLength(3);
  });

  it('keeps each explicitly requested pre-pass snapshot at its original draw boundary', () => {
    const source = [
      pass(0, { sampledTargets: ['depth'], sceneDepth: 'before-pass' }),
      pass(1, { sampledTargets: ['depth'], sceneDepth: 'before-pass' }),
    ];
    expect(coalesceVfxRasterPasses(source, 'blended')).toHaveLength(2);
  });

  it.each([true, false])('merges equal sampled-depth state with enabled=%s', (enabled) => {
    const source = [
      pass(0, { sampledTargets: ['depth'], enabled }),
      pass(1, { sampledTargets: ['depth'], enabled }),
    ];
    const result = coalesceVfxRasterPasses(source, 'blended');
    expect(result).toHaveLength(1);
    expect(result[0]?.sampledTargets).toEqual(['depth']);
    expect(result[0]?.enabled).toBe(enabled);
    expect(result[0]?.draws).toHaveLength(2);
  });
});
