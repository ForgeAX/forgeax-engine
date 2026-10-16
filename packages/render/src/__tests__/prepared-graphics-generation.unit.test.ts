import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost } from '../features/host';
import type {
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import { createRenderFeatureTarget } from '../features/targets';
import type { RenderFeature } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

function feature(): RenderFeature<{ readonly ready: true }> {
  return {
    identity: 'synthetic.generation',
    extract: () => ok({ ready: true }),
    plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
  };
}

function ref<Kind extends 'pipeline' | 'bindings'>(
  kind: Kind,
  generation = 5,
): RenderFeaturePreparedRef<Kind> {
  return { kind, generation };
}

const noVertexPipeline = ref('pipeline');
const noVertexBindings = ref('bindings');
const noVertexColor = createRenderFeatureTarget({
  kind: 'scene-color',
  format: 'rgba8unorm',
  sampleCount: 1,
});
const noVertexDepth = createRenderFeatureTarget({
  kind: 'scene-depth',
  format: 'depth24plus',
  sampleCount: 1,
});

const noVertexDraw: RenderFeatureDrawRecord = {
  kind: 'draw',
  pipeline: noVertexPipeline,
  bindings: [noVertexBindings],
  vertexData: [],
  vertexLayout: 'none',
  command: { vertexCount: 3, instanceCount: 1 },
};

const noVertexPass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [
      { resource: noVertexColor, format: noVertexColor.format, loadOp: 'load', storeOp: 'store' },
    ],
    depthStencil: {
      resource: noVertexDepth,
      format: noVertexDepth.format,
      depthLoadOp: 'load',
      depthStoreOp: 'store',
    },
  },
  draws: [noVertexDraw],
};

const noVertexState: RenderFeaturePreparedGraphicsState = {
  capabilityAvailable: true,
  generation: 5,
  attachments: [
    { resource: noVertexColor, format: noVertexColor.format },
    { resource: noVertexDepth, format: noVertexDepth.format },
  ],
  pipeline: noVertexPipeline,
  bindings: [noVertexBindings],
  vertexData: [],
  indexData: [],
};

describe('prepared graphics generation ownership', () => {
  it('accepts only the explicit no-vertex draw shape and fences its generation', () => {
    const accepted = validateRenderFeatureGraphicsPass(
      'synthetic.no-vertex',
      noVertexPass,
      noVertexState,
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.acceptedDrawCount).toBe(1);

    const { vertexLayout: _marker, ...drawWithoutMarker } = noVertexDraw;
    void _marker;
    const missingMarker = validateRenderFeatureGraphicsPass(
      'synthetic.no-vertex',
      { ...noVertexPass, draws: [drawWithoutMarker] },
      noVertexState,
    );
    expect(missingMarker.ok).toBe(false);

    const stalePipeline = validateRenderFeatureGraphicsPass('synthetic.no-vertex', noVertexPass, {
      ...noVertexState,
      pipeline: ref('pipeline', 6),
      generation: 5,
    });
    expect(stalePipeline.ok).toBe(false);

    const missingBindings = validateRenderFeatureGraphicsPass('synthetic.no-vertex', noVertexPass, {
      ...noVertexState,
      bindings: [],
    });
    expect(missingBindings.ok).toBe(false);
  });

  it('rejects stale generation and foreign owner or kind references', () => {
    const store = createPreparedGraphicsStore();
    const owner = store.beginFrame('synthetic.owner', 4);
    const foreign = store.beginFrame('synthetic.foreign', 4);
    const old = owner.prepare('pipeline', 'pipeline', { signature: 'pipeline:v1' });
    const foreignRef = foreign.prepare('pipeline', 'pipeline', { signature: 'pipeline:v1' });
    expect(old.ok).toBe(true);
    expect(foreignRef.ok).toBe(true);
    owner.commit();
    foreign.commit();

    const next = store.beginFrame('synthetic.owner', 5);
    const nextRef = next.prepare('pipeline', 'pipeline', { signature: 'pipeline:v2' });
    expect(nextRef.ok).toBe(true);
    if (old.ok && foreignRef.ok && nextRef.ok) {
      expect(next.owns(old.value)).toBe(false);
      expect(next.owns(foreignRef.value)).toBe(false);
      expect(nextRef.value).not.toBe(old.value);
      expect(nextRef.value.generation).toBe(5);
    }
    expect(next.graphicsState(true, []).generation).toBe(5);
  });

  it('keeps registration while replacing prepared state after a pipeline generation switch', () => {
    const host = createRenderFeatureHost([feature()]).unwrap();
    const before = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps: { backendKind: 'null' } as never,
    });
    const after = runSingleViewFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      generation: 2,
      caps: { backendKind: 'null' } as never,
    });

    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(before.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(after.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.features).toHaveLength(1);
    expect(host.features[0]?.identity).toBe('synthetic.generation');
    expect(host.diagnostics()[0]?.status).toBe('active');
  });
});
