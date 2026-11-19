import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import type { Asset } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { abortFeatureFrame } from '../../__tests__/feature-frame-driver';
import { runSingleViewFeatureFrame } from '../../__tests__/single-view-feature-fixture';
import { createRenderFeatureHost } from '../host';

it('plans captured local input after the World changes without extracting again', async () => {
  const world = new World();
  const entity = world.spawn({ component: Transform, data: { pos: [2, 0, 0] } }).unwrap();
  const caps = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps;
  let extracts = 0;
  let planned: number | undefined;
  const host = createRenderFeatureHost([
    {
      identity: 'source-capture',
      extract(context) {
        expect(context.world).toBe(world);
        extracts++;
        return ok(world.get(entity, Transform).unwrap().pos[0]);
      },
      plan(data) {
        planned = data as number;
        return ok({ work: [] });
      },
    },
  ]).unwrap();
  try {
    const sourceFeatures = host.captureSource({ world, frameNumber: 1, views: [], caps });
    world.set(entity, Transform, { pos: [3, 0, 0] }).unwrap();
    const frame = runSingleViewFeatureFrame(host, { world, sourceFeatures, frameNumber: 1, caps });
    expect(frame.errors).toEqual([]);
    expect(extracts).toBe(1);
    expect(planned).toBe(2);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});

it('resolves the exact captured source asset before a current-scope reader', async () => {
  const world = new World();
  const caps = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps;
  const value = { kind: 'material', passes: [] } as unknown as Asset;
  const host = createRenderFeatureHost([
    {
      identity: 'source-asset-version',
      extract(context) {
        context.referenceAssetVersion?.({ handle: 7, revision: 3, value });
        return ok({ handle: 7, revision: 3 });
      },
      plan(data: { handle: number; revision: number }, context) {
        expect(context.resolveAsset?.(data.handle, data.revision).unwrap()).toBe(value);
        return ok({ work: [] });
      },
    },
  ]).unwrap();
  try {
    const sourceFeatures = host.captureSource({ world, frameNumber: 1, views: [], caps });
    const frame = runSingleViewFeatureFrame(host, {
      world,
      sourceFeatures,
      frameNumber: 1,
      caps,
      resolveAsset() {
        throw new Error('The current source cannot resolve a captured revision');
      },
    });
    expect(frame.errors).toEqual([]);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});

it('retains an extract failure for the existing optional Feature failure policy', async () => {
  const world = new World();
  const caps = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap().caps;
  const host = createRenderFeatureHost([
    {
      identity: 'source-failure',
      extract() {
        throw new Error('source rejected');
      },
      plan() {
        throw new Error('a rejected extract cannot reach plan');
      },
    },
  ]).unwrap();
  try {
    const sourceFeatures = host.captureSource({ world, frameNumber: 1, views: [], caps });
    expect(sourceFeatures[0]?.result.ok).toBe(false);
    const frame = runSingleViewFeatureFrame(host, { world, sourceFeatures, frameNumber: 1, caps });
    expect(frame.errors.map((error) => error.code)).toEqual(['render-feature-stage-failed']);
  } finally {
    abortFeatureFrame(host);
    host.dispose();
  }
});
