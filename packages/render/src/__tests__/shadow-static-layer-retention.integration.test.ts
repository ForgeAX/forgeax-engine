import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  type ShadowDirtyRect,
  type ShadowViewIdentity,
  ShadowViewStatePool,
} from '../gpu-driven/shadow-views';
import { StaticShadowLayers } from '../gpu-driven/static-shadow-layers';
import { GpuScene } from '../gpu-scene';
import type { ShadowViewInvalidationReason } from '../inspection-types';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import type { TerrainShadowReceiver } from '../terrain/shadow-family';
import { addTypedShadowPasses } from '../typed-shadow-passes';

function spotTopology(spotMapSize = 32): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: { width: 64, height: 64, storageFormat: 'rgba8unorm', viewFormat: 'rgba8unorm' },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: 'disabled',
      spotMapSize,
      pointCount: 0,
      pointFaceSize: 16,
      spotCount: 1,
    },
    lane: { compute: true, storageBuffer: true, multisample: false, maxColorAttachments: 8 },
    featureTopologySignature: 'static-layer-retention',
    gpuDrivenTopologySignature: 'static-layer-retention',
  };
}

/** A pool whose every view hits: only the targets decide what rasters. */
const hitPool = {
  invalidationReason: (_identity: ShadowViewIdentity): ShadowViewInvalidationReason | undefined =>
    undefined,
  dirtyRects: (_identity: ShadowViewIdentity): readonly ShadowDirtyRect[] | undefined => undefined,
  texelCulled: () => undefined,
  cameraCulled: () => undefined,
  submission: () => undefined,
};

async function nullDevice(): Promise<RhiDevice> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap();
}

function compile(
  device: RhiDevice,
  staticLayers?: StaticShadowLayers,
  spotMapSize?: number,
  terrainReceivers?: readonly TerrainShadowReceiver[],
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const base = spotTopology(spotMapSize);
  const topology: RenderPipelineTopology =
    terrainReceivers === undefined
      ? base
      : {
          ...base,
          shadow: {
            ...base.shadow,
            spotCount: 0,
            directional: { mapSize: 32, cascadeCount: 1, terrainReceivers },
          },
        };
  addTypedShadowPasses(
    graph,
    topology,
    () => ok(undefined),
    undefined,
    undefined,
    staticLayers,
  ).unwrap();
  return graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
}

/** Runs one frame and returns each spot view's decision as `layer:reason`. */
function frame(
  device: RhiDevice,
  compiled: ReturnType<typeof compile>,
  staticLayers: StaticShadowLayers | undefined,
  outcome: 'submit' | 'abort' = 'submit',
  operations?: string[],
  gpuShadowViews: Pick<
    ShadowViewStatePool,
    'invalidationReason' | 'dirtyRects' | 'texelCulled' | 'cameraCulled' | 'submission'
  > = hitPool,
): string[] {
  const ledger = new ShadowRasterLedger();
  ledger.begin();
  const encoder = device.createCommandEncoder().unwrap();
  if (operations !== undefined) {
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (descriptor) => {
      operations.push(`raster:${descriptor.label}`);
      return begin(descriptor);
    };
    const copy = encoder.copyTextureToTexture.bind(encoder);
    encoder.copyTextureToTexture = (source, destination, size) => {
      operations.push(
        `copy:${JSON.stringify({ source: source.origin, destination: destination.origin, size })}`,
      );
      copy(source, destination, size);
    };
  }
  compiled
    .execute({
      encoder,
      frameState: { spotShadowSnapshots: [], shadowRaster: ledger },
      gpuDrivenShadowViews: gpuShadowViews,
      runtime: { device },
      pipelineState: { perPassResources: { shadowSampler: null } },
      dispatch: [],
    } as unknown as RenderPipelineFrame)
    .unwrap();
  if (outcome === 'abort') {
    staticLayers?._abort();
  } else {
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    staticLayers?._commit();
  }
  ledger.commit();
  return ledger
    .inspect()
    .views.map(
      (view) =>
        `${view.identity.terrainReceiver === undefined ? (view.identity.layer ?? 'final') : `terrain-${view.identity.terrainReceiver.worldId}-${view.identity.terrainReceiver.entityKey}`}:${'invalidationReason' in view ? view.invalidationReason : 'hit'}`,
    );
}

function expectFullCopies(operations: readonly string[], producerName = 'shadowCascade0.static') {
  const expected = [0, 1, 2].map(
    (z) =>
      `copy:${JSON.stringify({
        source: { x: 0, y: 0, z: 0 },
        destination: { x: 0, y: 0, z },
        size: { width: 32, height: 32, depthOrArrayLayers: 1 },
      })}`,
  );
  expect(operations.filter((op) => op.startsWith('copy:'))).toEqual(expected);
  const producer = operations.indexOf(`raster:${producerName}`);
  expect(producer).toBeGreaterThanOrEqual(0);
  for (const copy of expected) expect(operations.indexOf(copy)).toBeGreaterThan(producer);
  expect(operations.indexOf('raster:shadowCascade0.terrain-0-7')).toBeGreaterThan(
    operations.indexOf(expected[1] ?? 'missing-copy'),
  );
  expect(operations.indexOf('raster:shadowCascade0.terrain-1-7')).toBeGreaterThan(
    operations.indexOf(expected[2] ?? 'missing-copy'),
  );
}

describe('static shadow layer retention', () => {
  it('fully copies every Terrain family after a partial static producer update', async () => {
    const device = await nullDevice();
    const staticLayers = new StaticShadowLayers(device);
    const compiled = compile(device, staticLayers, undefined, [
      { worldId: 0, entityKey: 7 },
      { worldId: 1, entityKey: 7 },
    ]);
    frame(device, compiled, staticLayers);
    const partialPool: typeof hitPool = {
      ...hitPool,
      invalidationReason: (identity) =>
        identity.kind === 'directional' ? 'content-changed' : undefined,
      dirtyRects: (identity) =>
        identity.layer === 'static' ? [{ x0: 0.25, y0: 0.25, x1: 0.5, y1: 0.5 }] : undefined,
    };
    const operations: string[] = [];
    expect(frame(device, compiled, staticLayers, 'submit', operations, partialPool)).toEqual([
      'static:content-changed',
      'final:content-changed',
      'terrain-0-7:content-changed',
      'terrain-1-7:content-changed',
    ]);
    expect(operations).not.toContain('raster:shadowCascade0.static');
    expectFullCopies(operations, 'shadowCascade0.static-partial');
    operations.length = 0;
    expect(frame(device, compiled, staticLayers, 'submit', operations)).toEqual([
      'static:hit',
      'final:hit',
      'terrain-0-7:hit',
      'terrain-1-7:hit',
    ]);
    expect(operations.filter((op) => op.startsWith('copy:'))).toEqual([]);
    (await compiled.retire()).unwrap();
    staticLayers.dispose();
  });

  it('recomposes every Terrain family after an aborted static-layer submit even when the logical GPU pool hits', async () => {
    const device = await nullDevice();
    const staticLayers = new StaticShadowLayers(device);
    const compiled = compile(device, staticLayers, undefined, [
      { worldId: 0, entityKey: 7 },
      { worldId: 1, entityKey: 7 },
    ]);
    const operations: string[] = [];
    expect(frame(device, compiled, staticLayers, 'abort', operations)).toEqual([
      'static:graph-compiled',
      'final:graph-compiled',
      'terrain-0-7:graph-compiled',
      'terrain-1-7:graph-compiled',
    ]);
    expectFullCopies(operations);
    operations.length = 0;
    // These are real Null graph/encoder executions with no caster draw. The
    // invariant is producer/copy/raster scheduling, not depth image quality.
    expect(frame(device, compiled, staticLayers, 'submit', operations)).toEqual([
      'static:graph-compiled',
      'final:static-layer-changed',
      'terrain-0-7:static-layer-changed',
      'terrain-1-7:static-layer-changed',
    ]);
    expectFullCopies(operations);
    operations.length = 0;
    expect(frame(device, compiled, staticLayers, 'submit', operations)).toEqual([
      'static:hit',
      'final:hit',
      'terrain-0-7:hit',
      'terrain-1-7:hit',
    ]);
    expect(operations.filter((op) => op.startsWith('copy:'))).toEqual([]);
    (await compiled.retire()).unwrap();
    staticLayers.dispose();
  });

  it('keeps a retained static layer across a graph recompile with the real view pool', async () => {
    const device = await nullDevice();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const available = GpuScene.create(device, 1).unwrap();
    if (available.status !== 'available') throw new Error('scene unavailable');
    const pool = ShadowViewStatePool.create({
      device,
      shaderModuleFactory: { createShaderModule: () => ok(shader) },
    }).unwrap();
    const staticLayers = pool.staticLayers;
    const sourcePlan = new BatchTopology().plan();
    const matrix = new Float32Array(mat4.identity(mat4.create()));
    const planes = frustum.fromViewProjection(frustum.create(), matrix);
    const identities: readonly ShadowViewIdentity[] = [
      { kind: 'spot', index: 0, layer: 'static' },
      { kind: 'spot', index: 0 },
    ];
    const update = (graphGeneration: number) =>
      identities.map(
        (identity) =>
          pool
            .update({
              identity,
              sourcePlan,
              scene: available.scene,
              matrix,
              planes,
              targetSize: 32,
              graphGeneration,
            })
            .unwrap().cache,
      );
    const run = (compiled: ReturnType<typeof compile>) => {
      const decisions = frame(device, compiled, staticLayers, 'submit', undefined, pool);
      pool._commitResourceReplacement();
      return decisions;
    };
    const first = compile(device, staticLayers);
    expect(update(1)).toEqual(['invalidated', 'invalidated']);
    expect(run(first)).toEqual(['static:graph-compiled', 'final:graph-compiled']);
    expect(update(1)).toEqual(['hit', 'hit']);
    expect(run(first)).toEqual(['static:hit', 'final:hit']);
    (await first.retire()).unwrap();

    // Only the final target belongs to the replacement graph.
    const second = compile(device, staticLayers);
    expect(update(2)).toEqual(['hit', 'invalidated']);
    expect(run(second)).toEqual(['static:hit', 'final:graph-compiled']);
    expect(update(2)).toEqual(['hit', 'hit']);
    expect(run(second)).toEqual(['static:hit', 'final:hit']);
    (await second.retire()).unwrap();
    pool.dispose();
    available.scene.dispose();
  });

  it('re-rasters a graph-owned static layer on every recompile', async () => {
    const device = await nullDevice();
    for (let graph = 0; graph < 2; graph += 1) {
      const compiled = compile(device);
      expect(frame(device, compiled, undefined)).toEqual([
        'static:graph-compiled',
        'final:graph-compiled',
      ]);
      (await compiled.retire()).unwrap();
    }
  });

  it('retains nothing from an aborted submit, and the final layer follows', async () => {
    const device = await nullDevice();
    const staticLayers = new StaticShadowLayers(device);
    const compiled = compile(device, staticLayers);
    expect(frame(device, compiled, staticLayers, 'abort')).toEqual([
      'static:graph-compiled',
      'final:graph-compiled',
    ]);
    // The final view's own target survived, but the static depth it copies
    // never reached a submit, so both layers rebuild.
    expect(frame(device, compiled, staticLayers)).toEqual([
      'static:graph-compiled',
      'final:static-layer-changed',
    ]);
    expect(frame(device, compiled, staticLayers)).toEqual(['static:hit', 'final:hit']);
    (await compiled.retire()).unwrap();
    staticLayers.dispose();
  });

  it('replaces the array when its shape changes and destroys the old one after submit', async () => {
    const device = await nullDevice();
    const destroy = vi.spyOn(device, 'destroyTexture');
    const staticLayers = new StaticShadowLayers(device);
    const small = compile(device, staticLayers, 32);
    frame(device, small, staticLayers);
    (await small.retire()).unwrap();
    const graphDestroys = destroy.mock.calls.length;

    const large = compile(device, staticLayers, 64);
    expect(frame(device, large, staticLayers)).toEqual([
      'static:graph-compiled',
      'final:graph-compiled',
    ]);
    expect(destroy.mock.calls.length - graphDestroys).toBe(1);
    expect(frame(device, large, staticLayers)).toEqual(['static:hit', 'final:hit']);
    (await large.retire()).unwrap();
    staticLayers.dispose();
  });
});
