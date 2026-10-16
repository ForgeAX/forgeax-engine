import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeaturePreparationFailedError } from '../errors/render';
import { createRenderFeatureHost, settlePreparedGraphicsCompletion } from '../features/host';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

function preparedFeature(): RenderFeature<{ readonly ready: true }> {
  return {
    identity: 'synthetic.lifecycle',
    extract: () => ok({ ready: true }),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

describe('prepared graphics lifecycle ownership', () => {
  it('aborts partial preparation without changing committed state', () => {
    const store = createPreparedGraphicsStore();
    const initial = store.beginFrame('synthetic.lifecycle', 1);
    initial.prepare('pipeline', 'pipeline', { signature: 'v1' });
    initial.commit();

    const failed = store.beginFrame('synthetic.lifecycle', 2);
    failed.prepare('bindings', 'bindings', { signature: 'v2' });
    failed.abort();

    expect(store.snapshot('synthetic.lifecycle')).toMatchObject({
      generation: 1,
      items: [{ kind: 'pipeline', name: 'pipeline' }],
    });
    expect(failed.overlayItems()).toEqual([]);
  });

  it('re-prepares after recovery and makes repeated recovery idempotent', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const first = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps,
    });
    expect(first.errors).toEqual([]);

    expect(host.recover({ frameNumber: 2, caps })).toEqual(ok(undefined));
    expect(host.recover({ frameNumber: 2, caps })).toEqual(ok(undefined));
    const recovered = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 3,
      generation: 2,
      caps,
    });

    expect(recovered.errors).toEqual([]);
    expect(host.features[0]?.identity).toBe('synthetic.lifecycle');
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('releases a prepared batch that never reached queue submission during recovery', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    let releases = 0;
    const lease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const batch = host.retainPreparedGraphics('synthetic.lifecycle', [lease]).unwrap();

    expect(host.recover({ frameNumber: 5, caps })).toEqual(ok(undefined));
    expect(releases).toBe(1);
    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(releases).toBe(1);
  });

  it('keeps submitted batches alive through recovery and dispose until late completion', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    let releases = 0;
    const lease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const batch = host.retainPreparedGraphics('synthetic.lifecycle', [lease]).unwrap();

    host.markPreparedGraphicsSubmitted([batch]);
    expect(host.recover({ frameNumber: 6, caps })).toEqual(ok(undefined));
    expect(releases).toBe(0);
    expect(host.dispose()).toEqual(ok(undefined));
    expect(releases).toBe(0);

    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(releases).toBe(1);
  });

  it('recovers submitted batches when queue completion rejects and reports release errors', async () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    let releases = 0;
    const releaseError = new Error('prepared release failed');
    const firstLease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const secondLease = {
      release: () => {
        releases += 1;
        return err(releaseError as never);
      },
    };
    const first = host.retainPreparedGraphics('synthetic.lifecycle', [firstLease]).unwrap();
    const second = host.retainPreparedGraphics('synthetic.lifecycle', [secondLease]).unwrap();
    host.markPreparedGraphicsSubmitted([first, second]);

    const errors: unknown[] = [];
    const completion = Promise.reject(new Error('queue completion unavailable'));
    settlePreparedGraphicsCompletion(host, [first, second], completion, (error) => {
      errors.push(error);
    });
    await completion.catch(() => undefined);
    await Promise.resolve();

    expect(releases).toBe(2);
    expect(errors).toEqual([releaseError]);
    expect(host.retirePreparedGraphics([first, second])).toEqual(ok(undefined));
    expect(releases).toBe(2);
  });
});

for (const readyFirst of [true, false]) {
  it(`retains partial resolver allocations through pending pipelines (ready pass: ${readyFirst})`, () => {
    let releases = 0;
    const lease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const feature: RenderFeature<undefined> = {
      identity: 'pending.material',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: ['ready', 'pending'].flatMap((name) => [
                {
                  kind: 'graphics-program' as const,
                  name,
                  program: {
                    shader: name,
                    vertexLayout: 'none',
                    colorFormats: ['rgba8unorm' as const],
                  },
                },
                {
                  kind: 'graphics-bindings' as const,
                  name: `${name}-bindings`,
                  program: name,
                  values: {},
                },
              ]),
              passes: (readyFirst ? ['ready', 'pending'] : ['pending']).map((name) => ({
                kind: 'raster' as const,
                name,
                colorAttachments: [
                  { target: 'swapchain', loadOp: 'load' as const, storeOp: 'store' as const },
                ],
                draws: [
                  {
                    vertexLayout: 'none' as const,
                    vertexData: [],
                    program: name,
                    bindings: [`${name}-bindings`],
                    draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                  },
                ],
              })),
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const result = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps,
      createPreparedGraphicsResolver: (input) => ({
        leases: [lease],
        requiresGraphRebuild: false,
        release: lease.release,
        resolve: (ref) => {
          const item = input.lookup(ref);
          if (item?.name === 'pending')
            return err(
              new RenderFeaturePreparationFailedError(
                feature.identity,
                0,
                'prepare',
                'pipeline',
                'pending',
                'pipeline-pending',
                'next-frame',
              ),
            );
          return ok({ kind: ref.kind, reference: ref, handle: {} } as never);
        },
      }),
    });
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(releases).toBe(0);
    expect(result.preparedResourceBatches).toHaveLength(1);
    expect(result.requiresPreparedResourceKey).toBe(false);
    host.markPreparedGraphicsSubmitted(result.preparedResourceBatches);
    host.retirePreparedGraphics(result.preparedResourceBatches);
    expect(releases).toBe(1);
  });
}
