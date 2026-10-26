import type { RenderPipeline, RhiCaps } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeaturePreparedRef } from '../features/prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from '../features/prepared-graphics-store';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

function oldLookup(transaction: PreparedGraphicsTransaction, reference: RenderFeaturePreparedRef) {
  return [...transaction.overlayItems(), ...transaction.committedItems()].find(
    (item) => item.reference === reference,
  );
}
function equalLookup(
  transaction: PreparedGraphicsTransaction,
  references: readonly RenderFeaturePreparedRef[],
) {
  for (const reference of references)
    expect(transaction.lookup(reference)).toBe(oldLookup(transaction, reference));
}
function pipeline(transaction: PreparedGraphicsTransaction, name: string, signature = name) {
  return transaction.prepare('pipeline', name, { signature }).unwrap();
}

describe('prepared graphics owner lookup', () => {
  it('admits only touched committed and exact overlay references, including two versions of one name', () => {
    const store = createPreparedGraphicsStore();
    const first = store.beginFrame('feature', 1);
    const original = pipeline(first, 'same', 'old');
    const untouched = pipeline(first, 'untouched');
    first.commit().unwrap();
    const next = store.beginFrame('feature', 1);
    expect(next.lookup(original)).toBeUndefined();
    const replacement = pipeline(next, 'same', 'new');
    expect(pipeline(next, 'same', 'old')).toBe(original);
    const foreign = pipeline(store.beginFrame('other', 1), 'same');
    const otherGeneration = pipeline(store.beginFrame('feature', 2), 'same');
    const clone = { ...original };
    equalLookup(next, [original, replacement, untouched, foreign, otherGeneration, clone]);
    expect(next.lookup(original)?.signature).toBe('old');
    expect(next.lookup(replacement)?.signature).toBe('new');
    expect(next.lookup(untouched)).toBeUndefined();
    expect(next.lookup(clone)).toBeUndefined();
  });

  it('preserves abort and commit visibility and held transaction ownership after retirement/recovery', () => {
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 1);
    const original = pipeline(seed, 'held');
    const published = seed.commit().unwrap();
    const held = store.beginFrame('feature', 1);
    held.retainResources(() => true);
    const overlay = pipeline(held, 'overlay');
    equalLookup(held, [original, overlay]);
    held.abort();
    equalLookup(held, [original, overlay]);
    expect(held.lookup(original)).toBe(published.items[0]);
    expect(held.lookup(overlay)).toBeUndefined();
    equalLookup(seed, [original]);
    seed.abort(); // Already committed: original behavior is a no-op.
    equalLookup(seed, [original]);
    store.beginFrame('feature', 1).commit().unwrap(); // Retire everything from the next publication.
    expect(store.beginFrame('feature', 1).lookup(original)).toBeUndefined();
    equalLookup(held, [original]); // The already captured transaction owns its old immutable slot.
    store.invalidate('feature', 2);
    const recovered = store.beginFrame('feature', 2);
    const current = pipeline(recovered, 'held');
    equalLookup(recovered, [original, current]);
    expect(recovered.lookup(original)).toBeUndefined();
    expect(recovered.lookup(current)).toBeDefined();
    expect(published.items[0]?.reference).toBe(original);
  });

  it('retains the binding pipeline closure without admitting untouched siblings', () => {
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 7);
    const program = seed
      .prepare('pipeline', 'program', {
        shader: 'synthetic',
        vertexLayout: 'none',
        colorFormats: ['rgba8unorm'],
      })
      .unwrap();
    const binding = seed.prepare('bindings', 'view', { pipeline: program, values: {} }).unwrap();
    const sibling = pipeline(seed, 'other');
    seed.commit().unwrap();
    const held = store.beginFrame('feature', 7);
    held.retainResources((name) => name === 'view');
    equalLookup(held, [program, binding, sibling]);
    expect(held.lookup(program)).toBeDefined();
    expect(held.lookup(binding)).toBeDefined();
    expect(held.lookup(sibling)).toBeUndefined();
  });

  it.each([
    32, 256, 1024,
  ])('does one existing owner lookup without enumerating %i resources', (width) => {
    const transaction = createPreparedGraphicsStore().beginFrame('scale', 1);
    const references = Array.from({ length: width }, (_, i) => pipeline(transaction, `p${i}`));
    const reference = references[width - 1];
    if (reference === undefined) throw new Error('Missing final reference');
    let legacyVisits = 0;
    const expected = [...transaction.overlayItems(), ...transaction.committedItems()].find(
      (item) => {
        legacyVisits += 1;
        return item.reference === reference;
      },
    );
    expect(legacyVisits).toBe(width);
    const overlay = vi.spyOn(transaction, 'overlayItems');
    const committed = vi.spyOn(transaction, 'committedItems');
    const ownerReads = vi.spyOn(WeakMap.prototype, 'get');
    let actual: ReturnType<PreparedGraphicsTransaction['lookup']>;
    let readCount = 0;
    try {
      actual = transaction.lookup(reference);
      readCount = ownerReads.mock.calls.length;
    } finally {
      ownerReads.mockRestore();
    }
    expect(actual).toBe(expected);
    expect(readCount).toBe(1);
    expect(overlay).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it('the actual feature host resolver callback uses owner lookup for changing multi-pass frames', () => {
    let revision = 0;
    const feature: RenderFeature<undefined> = {
      identity: 'lookup.host',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: Array.from({ length: 16 }, (_, i) => [
                {
                  kind: 'graphics-program' as const,
                  name: `p${i}`,
                  program: {
                    shader: `shader:${revision}:${i}`,
                    vertexLayout: 'none' as const,
                    colorFormats: ['rgba8unorm' as const],
                  },
                },
                { kind: 'graphics-bindings' as const, name: `b${i}`, program: `p${i}`, values: {} },
              ]).flat(),
              passes: [0, 15].map((i) => ({
                kind: 'raster' as const,
                name: `draw${i}`,
                colorAttachments: [
                  { target: 'swapchain', loadOp: 'load' as const, storeOp: 'store' as const },
                ],
                draws: [
                  {
                    vertexLayout: 'none' as const,
                    vertexData: [],
                    program: `p${i}`,
                    bindings: [`b${i}`],
                    draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                  },
                ],
              })),
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    let resolved = 0;
    let enumerations = 0;
    try {
      for (revision = 0; revision < 3; revision += 1) {
        const result = runSingleViewFeatureFrame(host, {
          worlds: [],
          owner: 0,
          frameNumber: revision + 1,
          generation: 1,
          caps: { backendKind: 'null' } as unknown as RhiCaps,
          createPreparedGraphicsResolver: (input) => ({
            leases: [],
            requiresGraphRebuild: false,
            release: () => ok(undefined),
            resolve: (reference) => {
              const overlay = vi.spyOn(input.transaction, 'overlayItems');
              const committed = vi.spyOn(input.transaction, 'committedItems');
              overlay.mockClear();
              committed.mockClear();
              const item = input.lookup(reference);
              expect(item?.reference).toBe(reference);
              enumerations += overlay.mock.calls.length + committed.mock.calls.length;
              overlay.mockRestore();
              committed.mockRestore();
              resolved += 1;
              return ok({ kind: reference.kind, reference, handle: {} } as never);
            },
          }),
        });
        expect(result.errors).toEqual([]);
        result.onSubmitted();
      }
      expect(resolved).toBe(12);
      expect(enumerations).toBe(0);
    } finally {
      host.dispose();
    }
  });
  it('the actual resolver revalidates ownership before a cached handle after abort', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const store = createPreparedGraphicsStore();
    const seed = store.beginFrame('feature', 1);
    const descriptor = {
      shader: 'synthetic',
      vertexLayout: 'none' as const,
      colorFormats: ['rgba8unorm' as const],
    };
    const committed = seed.prepare('pipeline', 'committed', descriptor).unwrap();
    seed.commit().unwrap();
    const transaction = store.beginFrame('feature', 1);
    transaction.retainResources(() => true);
    const overlay = transaction.prepare('pipeline', 'overlay', descriptor).unwrap();
    const handle = {} as RenderPipeline;
    const resolver = createPreparedGraphicsResolver({
      device,
      featureIdentity: 'feature',
      generation: 1,
      capabilityAvailable: true,
      lookup: (reference) => transaction.lookup(reference),
      resolvePipeline: () => ok(handle),
      resolveBindings: () => ok(undefined),
    });
    try {
      expect(resolver.resolve(committed).unwrap().handle).toBe(handle);
      expect(resolver.resolve(overlay).unwrap().handle).toBe(handle);
      transaction.abort();
      expect(resolver.resolve(committed).unwrap().handle).toBe(handle);
      expect(resolver.resolve(overlay).ok).toBe(false);
      expect(resolver.resolve({ ...committed }).ok).toBe(false);
    } finally {
      resolver.release().unwrap();
    }
  });

  it('shares transaction authority across different and reordered view resource closures', () => {
    let revision = 0;
    const feature: RenderFeature<undefined> = {
      identity: 'lookup.views',
      extract: () => ok(undefined),
      plan: (_snapshot, context) =>
        ok({
          work: context.views.map((view) => ({
            scope: { view: view.identity },
            resources: [
              {
                kind: 'graphics-program' as const,
                name: 'program',
                program: {
                  shader: `${view.identity}:${revision}`,
                  vertexLayout: 'none' as const,
                  colorFormats: ['rgba8unorm' as const],
                },
              },
              {
                kind: 'graphics-bindings' as const,
                name: 'binding',
                program: 'program',
                values: { view: view.identity },
              },
            ],
            passes: [
              {
                kind: 'raster' as const,
                name: 'draw',
                colorAttachments: [
                  { target: 'swapchain', loadOp: 'load' as const, storeOp: 'store' as const },
                ],
                draws: [
                  {
                    vertexLayout: 'none' as const,
                    vertexData: [],
                    program: 'program',
                    bindings: ['binding'],
                    draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                  },
                ],
              },
            ],
          })),
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const resolved: string[] = [];
    try {
      for (const viewOrder of [
        ['left', 'right'],
        ['right', 'left'],
      ]) {
        revision += 1;
        const batch = host.runFrame(
          viewOrder.map((identity) => ({
            identity,
            render: true,
            worlds: [],
            owner: 0,
            frameNumber: revision,
            generation: 1,
            caps: { backendKind: 'null' } as unknown as RhiCaps,
            createPreparedGraphicsResolver: (input) => ({
              leases: [],
              requiresGraphRebuild: false,
              release: () => ok(undefined),
              resolve: (reference) => {
                const item = input.lookup(reference);
                expect(item).toBe(oldLookup(input.transaction, reference));
                expect(item?.featureIdentity).toBe(feature.identity);
                if (item?.descriptor?.kind === 'pipeline') resolved.push(item.descriptor.shader);
                return ok({ kind: reference.kind, reference, handle: {} } as never);
              },
            }),
          })),
        );
        expect(batch.frame.errors).toEqual([]);
        batch.frame.onSubmitted();
        for (const view of batch.views.values()) {
          expect(view.errors).toEqual([]);
          view.onSubmitted();
        }
        batch.onSubmitted();
      }
      expect(resolved).toEqual(['left:1', 'right:1', 'right:2', 'left:2']);
    } finally {
      host.dispose();
    }
  });
});
