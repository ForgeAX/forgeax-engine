import { describe, expect, it } from 'vitest';
import type { DuplicateResourceDetail } from '../errors.js';
import { RenderGraph } from '../graph.js';
import { ResourceRegistry } from '../resource-registry.js';

const firstDescriptor = {
  format: 'rgba8unorm',
  size: { w: 4, h: 4 },
  usage: 0,
} as const;

const replacementDescriptor = {
  format: 'rgba16float',
  size: { w: 8, h: 8 },
  usage: 0,
} as const;

type DeclarationResult = {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: {
    readonly code: string;
    readonly detail?: DuplicateResourceDetail;
  };
};

function expectDuplicate(result: unknown, resourceKey: string): void {
  const declaration = result as DeclarationResult;
  expect(declaration.ok).toBe(false);
  expect(declaration.error?.code).toBe('duplicate-resource');
  expect(declaration.error?.detail).toEqual({ resourceKey });
}

function makeDevice(): {
  readonly device: unknown;
  readonly counts: { created: number; views: number; destroyed: number };
} {
  const counts = { created: 0, views: 0, destroyed: 0 };
  const device = {
    createTexture: () => {
      counts.created += 1;
      return { ok: true as const, value: { id: `texture-${counts.created}` } };
    },
    createTextureView: () => {
      counts.views += 1;
      return { ok: true as const, value: { id: `view-${counts.views}` } };
    },
    destroyTexture: () => {
      counts.destroyed += 1;
      return { ok: true as const, value: undefined };
    },
    queue: { onSubmittedWorkDone: () => Promise.resolve(undefined) },
  };
  return { device, counts };
}

const compileOptions = {
  backendKind: 'webgpu' as const,
  caps: { backendKind: 'webgpu', compute: true, storageBuffer: true } as never,
};

describe('resource declaration collision preflight', () => {
  it.each([
    ['target/target', 'target-target'],
    ['resource/target', 'resource-target'],
    ['source/reused-alias-key', 'source-alias'],
    ['alias/target', 'alias-target'],
  ])('ResourceRegistry rejects %s without replacing the first entry', (kind, key) => {
    const registry = new ResourceRegistry();
    let first: unknown;
    let duplicate: unknown;

    if (kind === 'target/target') {
      first = registry.addColorTarget(key, firstDescriptor);
      duplicate = registry.addColorTarget(key, replacementDescriptor);
    } else if (kind === 'resource/target') {
      first = registry.add(key, { kind: 'texture', lifetime: 'persistent' });
      duplicate = registry.addColorTarget(key, replacementDescriptor);
    } else if (kind === 'source/reused-alias-key') {
      first = registry.addColorTarget(key, firstDescriptor);
      duplicate = registry.addColorTargetAlias(key, key);
    } else {
      registry.addColorTarget('source', firstDescriptor);
      first = registry.addColorTargetAlias(key, 'source');
      duplicate = registry.addColorTarget(key, replacementDescriptor);
    }

    expectDuplicate(duplicate, key);
    const firstEntry = (first as { readonly value?: unknown }).value ?? first;
    expect(registry.get(key)).toBe(firstEntry);
  });

  it.each([
    ['target/target', 'target-target'],
    ['resource/target', 'resource-target'],
    ['source/reused-alias-key', 'source-alias'],
    ['alias/target', 'alias-target'],
  ])('RenderGraph rejects %s before allocation and keeps the active graph', (kind, key) => {
    const graph = new RenderGraph();
    const { device, counts } = makeDevice();

    if (kind === 'target/target') {
      graph.addColorTarget(key, firstDescriptor);
    } else if (kind === 'resource/target') {
      graph.addResource(key, { kind: 'texture', lifetime: 'persistent' });
    } else if (kind === 'source/reused-alias-key') {
      graph.addColorTarget(key, firstDescriptor);
    } else {
      graph.addColorTarget('source', firstDescriptor);
      graph.addColorTargetAlias(key, 'source');
    }

    const executed: string[] = [];
    graph.addPass('first-pass', {
      reads: [],
      writes: [key],
      execute: () => executed.push('first-pass'),
    });
    const initial = graph.compile({ ...compileOptions, device: device as never });
    expect(initial.ok).toBe(true);
    const initialResources = graph.listResources();
    const initialPasses = graph.listPasses();
    const initialTexture = graph.getColorTargetTexture(key);
    const initialView = graph.getColorTargetView(key);
    const countsBeforeCollision = { ...counts };

    let duplicate: unknown;
    if (kind === 'target/target' || kind === 'alias/target') {
      duplicate = graph.addColorTarget(key, replacementDescriptor);
    } else if (kind === 'resource/target') {
      duplicate = graph.addColorTarget(key, replacementDescriptor);
    } else {
      duplicate = graph.addColorTargetAlias(key, key);
    }

    expectDuplicate(duplicate, key);
    expect(counts).toEqual(countsBeforeCollision);

    const repaired = graph.compile({ ...compileOptions, device: device as never });
    expect(repaired.ok).toBe(true);
    expect(graph.listResources()).toEqual(initialResources);
    expect(graph.listPasses()).toEqual(initialPasses);
    expect(graph.getColorTargetTexture(key)).toBe(initialTexture);
    expect(graph.getColorTargetView(key)).toBe(initialView);

    graph.execute(undefined);
    expect(executed).toEqual(['first-pass']);
    graph.drain();
    expect(counts.destroyed).toBe(countsBeforeCollision.created);
  });
});
