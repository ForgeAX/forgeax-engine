import { describe, expect, it } from 'vitest';
import { RenderGraph } from '../graph.js';

const colorTarget = {
  format: 'rgba8unorm',
  size: { w: 4, h: 4 },
} as const;

function makeDevice(): {
  readonly device: object;
  readonly created: object[];
  readonly destroyed: object[];
} {
  const created: object[] = [];
  const destroyed: object[] = [];
  const device = {
    createTexture: () => {
      const texture = { id: `texture-${created.length + 1}` };
      created.push(texture);
      return { ok: true as const, value: texture };
    },
    createTextureView: (texture: object) => ({
      ok: true as const,
      value: { texture },
    }),
    destroyTexture: (texture: object) => {
      destroyed.push(texture);
      return { ok: true as const, value: undefined };
    },
    queue: { onSubmittedWorkDone: () => Promise.resolve(undefined) },
  };
  return { device, created, destroyed };
}

const compileOptions = {
  backendKind: 'webgpu' as const,
  caps: { backendKind: 'webgpu', compute: true, storageBuffer: true } as never,
};

describe('RenderGraph alias-source refusal and recovery', () => {
  it('refuses an absent source without mutation, then repairs on the same graph', () => {
    const graph = new RenderGraph();
    const { device, created, destroyed } = makeDevice();
    const executed: string[] = [];

    expect(graph.addColorTarget('active', colorTarget).ok).toBe(true);
    expect(graph.addColorTarget('sibling', colorTarget).ok).toBe(true);
    graph.addPass('active-pass', {
      reads: [],
      writes: ['active'],
      execute: () => executed.push('active-pass'),
    });
    graph.addPass('sibling-pass', {
      reads: [],
      writes: ['sibling'],
      execute: () => executed.push('sibling-pass'),
    });

    expect(graph.compile({ ...compileOptions, device: device as never }).ok).toBe(true);
    const initialResources = graph.listResources();
    const initialPasses = graph.listPasses();
    const initialActiveTexture = graph.getColorTargetTexture('active');
    const initialSiblingTexture = graph.getColorTargetTexture('sibling');
    const initialCreatedCount = created.length;

    const refused = graph.addColorTargetAlias('alias', 'missing-source');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected an absent alias source to be refused');
    expect(refused.error.code).toBe('alias-source-missing');
    expect(refused.error.detail).toEqual({
      aliasKey: 'alias',
      sourceKey: 'missing-source',
    });
    expect(graph.listResources()).toEqual(initialResources);
    expect(graph.listPasses()).toEqual(initialPasses);
    expect(graph.getColorTargetTexture('alias')).toBeUndefined();
    expect(graph.getColorTargetView('alias')).toBeUndefined();
    expect(created).toHaveLength(initialCreatedCount);

    graph.execute(undefined);
    expect(executed).toEqual(['active-pass', 'sibling-pass']);

    expect(graph.addColorTarget('source', colorTarget).ok).toBe(true);
    expect(graph.addColorTargetAlias('alias', 'source').ok).toBe(true);
    graph.addPass('source-pass', {
      reads: [],
      writes: ['source'],
      execute: () => executed.push('source-pass'),
    });
    graph.addPass('alias-pass', {
      reads: ['source'],
      writes: ['alias'],
      execute: () => executed.push('alias-pass'),
    });

    const repaired = graph.compile({ ...compileOptions, device: device as never });
    expect(repaired.ok).toBe(true);
    expect(graph.getColorTargetTexture('active')).toBe(initialActiveTexture);
    expect(graph.getColorTargetTexture('sibling')).toBe(initialSiblingTexture);
    expect(graph.getColorTargetTexture('alias')).toBe(graph.getColorTargetTexture('source'));
    expect(graph.getColorTargetView('alias')).toBe(graph.getColorTargetView('source'));

    graph.execute(undefined);
    expect(executed).toEqual([
      'active-pass',
      'sibling-pass',
      'active-pass',
      'sibling-pass',
      'source-pass',
      'alias-pass',
    ]);

    graph.drain();
    graph.drain();
    expect(destroyed).toHaveLength(created.length);
    expect(new Set(destroyed)).toEqual(new Set(created));
  });

  it('keeps chained aliases on one source allocation through resize and retirement', () => {
    const graph = new RenderGraph();
    const { device, created, destroyed } = makeDevice();
    graph.addColorTarget('source', { format: 'rgba8unorm', size: 'swapchain' }).unwrap();
    graph.addColorTargetAlias('alias', 'source').unwrap();
    graph.addColorTargetAlias('alias-2', 'alias').unwrap();
    for (const name of ['source', 'alias', 'alias-2'])
      graph.addPass(`${name}-pass`, { reads: [], writes: [name] });
    for (const size of [4, 8]) {
      graph.setSwapChainSize(size, size);
      graph.compile({ ...compileOptions, device: device as never }).unwrap();
      expect(graph.getColorTargetTexture('alias')).toBe(graph.getColorTargetTexture('source'));
      expect(graph.getColorTargetView('alias-2')).toBe(graph.getColorTargetView('source'));
    }
    expect(created).toHaveLength(2);
    graph.drain();
    expect(destroyed).toHaveLength(2);
    expect(new Set(destroyed)).toEqual(new Set(created));
  });
});
