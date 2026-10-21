import { frustum, mat4 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RenderPipeline, RhiDevice, RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { BatchTopology } from '../gpu-driven/batch-topology';
import {
  SHADOW_CASTER_PROMOTE_WINDOW,
  SHADOW_CASTER_SETTLE_FRAMES,
  ShadowCasterClassifier,
} from '../gpu-driven/shadow-caster-classes';
import {
  type ShadowDirtyRect,
  type ShadowViewIdentity,
  ShadowViewStatePool,
} from '../gpu-driven/shadow-views';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { GpuScene } from '../gpu-scene';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { MaterialResource } from '../material-resource';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import { defaultMaterialSnapshot, type RenderableSnapshot } from '../render-system-extract';
import { RenderScene } from '../scene/render-scene';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { preparedPbrSnapshot } from './gpu-driven-production-fixture';
import { updateShadowView } from './helpers/gpu-input-read-domain';

// The real classifier and view pool decide every cache hit; only the leaf
// caster encoders become constant-depth full-viewport draws, so a static-layer
// redraw would change the retained depth the test reads back.
const raster = vi.hoisted(() => ({
  staticDepth: 0,
  staticDraws: 0,
  partialDraws: 0,
  draw: undefined as ((pass: RhiRenderPassEncoder, depth: number) => void) | undefined,
}));

vi.mock('../record/shadow-pass', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../record/shadow-pass')>();
  return {
    shadowDirtyScissor: actual.shadowDirtyScissor,
    encodeStaticShadowPass: (
      _frame: unknown,
      pass: RhiRenderPassEncoder,
      _identity: unknown,
      dirty?: { readonly rects: readonly ShadowDirtyRect[]; readonly size: number },
    ) => {
      raster.staticDraws += 1;
      if (dirty === undefined) {
        raster.draw?.(pass, raster.staticDepth);
        return;
      }
      raster.partialDraws += 1;
      for (const rect of dirty.rects) {
        const scissor = actual.shadowDirtyScissor(rect, dirty.size);
        if (scissor === undefined) continue;
        pass.setScissorRect(...scissor);
        raster.draw?.(pass, raster.staticDepth);
      }
    },
    encodeDirectionalShadowPass: () => undefined,
    encodeSpotShadowPass: () => undefined,
    encodePointShadowPass: () => undefined,
  };
});

const GPU_MAP_MODE_READ = 0x0001;
const MAP_SIZE = 16;

const material = new MaterialResource(defaultMaterialSnapshot());

function placed(entityKey: number, x: number): RenderableSnapshot {
  const world = new Float32Array(mat4.identity(mat4.create()));
  world[12] = x;
  return preparedPbrSnapshot({
    assetHandle: entityKey + 3,
    transform: { world },
    localAabb: new Float32Array([-1, -1, -1, 1, 1, 1]),
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    worldId: 0,
    entityKey,
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'opaque',
        materialResourceClass: 'plain',
      },
    ],
  });
}

function topology(): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: { width: 64, height: 64, storageFormat: 'rgba8unorm', viewFormat: 'rgba8unorm' },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: { mapSize: MAP_SIZE, cascadeCount: 1 },
      spotMapSize: MAP_SIZE,
      pointCount: 0,
      pointFaceSize: 16,
      spotCount: 0,
    },
    lane: { compute: true, storageBuffer: true, multisample: false, maxColorAttachments: 8 },
    featureTopologySignature: 'shadow-static-flip-dawn',
    gpuDrivenTopologySignature: 'shadow-static-flip-dawn',
  };
}

function depthPipeline(device: RhiDevice, depth: number): RenderPipeline {
  const module = createShaderModuleImmediate(device, {
    code: `@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], ${depth.toFixed(6)}, 1.0);
}`,
  }).unwrap();
  const layout = device.createPipelineLayout({ bindGroupLayouts: [] }).unwrap();
  return device
    .createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs_main', buffers: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
    } as never)
    .unwrap();
}

/** Production-shaped classifier + view pool + typed graph with a depth readback. */
async function harness(initial: readonly RenderableSnapshot[], matrix?: Float32Array) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const pipelines = new Map<number, RenderPipeline>();
  raster.draw = (pass, depth) => {
    let pipeline = pipelines.get(depth);
    if (pipeline === undefined) {
      pipeline = depthPipeline(device, depth);
      pipelines.set(depth, pipeline);
    }
    pass.setPipeline(pipeline);
    pass.draw(3);
  };

  const projection = new RenderScene();
  const boundsOf = (slot: Parameters<RenderScene['cullingWorldBoundsAt']>[0]) =>
    projection.cullingWorldBoundsAt(slot);
  const availability = GpuScene.create(device, 4).unwrap();
  if (availability.status !== 'available') throw new Error('GPU Scene unavailable');
  const scene = availability.scene;
  const apply = (values: readonly RenderableSnapshot[]) => {
    const delta = projection.apply(
      values.map((value) => ({
        kind: 'update' as const,
        worldId: value.worldId,
        entityKey: value.entityKey,
        snapshot: value,
      })),
    );
    return scene.sync(delta, undefined, boundsOf).unwrap();
  };
  apply(initial);
  const batches = new BatchTopology();
  batches.rebuild(projection.slotsSnapshot());
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const pool = ShadowViewStatePool.create({
    device,
    shaderModuleFactory: { createShaderModule: () => ok(shader) },
  }).unwrap();
  const classifier = new ShadowCasterClassifier();
  const planes = frustum.fromViewProjection(
    frustum.create(),
    matrix ?? mat4.identity(mat4.create()),
  );
  const finalIdentity: ShadowViewIdentity = { kind: 'directional', index: 0 };
  const staticIdentity: ShadowViewIdentity = { ...finalIdentity, layer: 'static' };

  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const targets = addTypedShadowPasses(graph, topology(), {
    projectGpuDrivenShadow: () => ok(undefined),
  }).unwrap();
  const directional = targets.directional;
  if (directional === undefined) throw new Error('directional shadow target missing');
  const readback = device
    .createBuffer({
      size: 256 * MAP_SIZE,
      usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
    })
    .unwrap();
  const output = graph
    .importBuffer(
      'static-flip-readback',
      { size: 256 * MAP_SIZE, usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST },
      () => readback,
    )
    .unwrap();
  graph
    .addCopyPass('static-flip-depth-readback', {
      accesses: [
        { resource: directional.view, usage: 'copy-src' },
        { resource: output, usage: 'copy-dst' },
      ],
      encode: ({ encoder, resources }) =>
        encoder.copyTextureToBuffer(
          { texture: resources.texture(directional.texture).unwrap() },
          {
            buffer: resources.buffer(output).unwrap(),
            bytesPerRow: 256,
            rowsPerImage: MAP_SIZE,
          },
          { width: MAP_SIZE, height: MAP_SIZE, depthOrArrayLayers: 1 },
        ),
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();

  const ledger = new ShadowRasterLedger();
  /** One production-shaped frame; returns the static cache decision and centre depth. */
  const frame = async () => {
    const classes = classifier.update(
      { slots: projection.slotsSnapshot(), slotAt: (slot) => projection.slotAt(slot) },
      scene,
    );
    const sourcePlan = batches.query(batches.sourcePlan(), undefined);
    updateShadowView(pool, {
      identity: staticIdentity,
      sourcePlan,
      scene,
      planes,
      ...(matrix === undefined ? {} : { matrix }),
      candidatePrimitiveIndices: classes.staticSlots,
      ignoredChangeSlots: classes.dynamicSlots,
    }).unwrap();
    updateShadowView(pool, {
      identity: finalIdentity,
      sourcePlan,
      scene,
      planes,
      candidatePrimitiveIndices: classes.dynamicSlots,
    }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    ledger.begin();
    compiled
      .execute({
        encoder,
        frameState: { spotShadowSnapshots: [], shadowRaster: ledger },
        gpuDrivenShadowViews: pool,
        pipelineState: { perPassResources: {} },
      } as unknown as RenderPipelineFrame)
      .unwrap();
    ledger.commit();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    pool._commitResourceReplacement();
    const mapped = (await readback.mapAsync(GPU_MAP_MODE_READ)).unwrap();
    const depth = new Float32Array(mapped.getMappedRange().unwrap().slice(0));
    mapped.unmap();
    const view = ledger
      .inspect()
      .views.find((entry) => entry.identity.layer === 'static' && entry.identity.index === 0);
    return {
      cache: view?.cache,
      dirtyRects: pool.dirtyRects(staticIdentity),
      staticSlots: classes.staticSlots,
      centre: depth[(MAP_SIZE / 2) * 64 + MAP_SIZE / 2],
      depth,
    };
  };

  const dispose = async () => {
    (await compiled.retire()).unwrap();
    raster.draw = undefined;
    device.destroyBuffer(readback).unwrap();
    pool.dispose();
    scene.dispose();
  };
  return {
    apply,
    remove: (entityKey: number) => {
      const delta = projection.apply([{ kind: 'remove', worldId: 0, entityKey }]);
      scene.sync(delta, undefined, boundsOf).unwrap();
      batches.apply(delta);
    },
    frame,
    dispose,
  };
}

/** Frames until both casters are static; the static layer then holds `raster.staticDepth`. */
async function settleBoth(frame: () => Promise<{ readonly staticSlots: ReadonlySet<number> }>) {
  const limit = SHADOW_CASTER_SETTLE_FRAMES + 2 * SHADOW_CASTER_PROMOTE_WINDOW;
  let settled = await frame();
  for (let step = 0; step < limit && settled.staticSlots.size < 2; step += 1)
    settled = await frame();
  expect([...settled.staticSlots]).toEqual([0, 1]);
}

describe('static shadow layer across caster class flips (Dawn pixel readback)', () => {
  it.each([
    'bounded',
    'unbounded',
  ] as const)('retains static depth when a %s dynamic caster is removed', async (bounds) => {
    const { apply, remove, frame, dispose } = await harness([placed(1, 0), placed(2, 0.25)]);
    try {
      raster.staticDepth = 0.3;
      await frame();
      const moved = placed(2, 0.5);
      const { localAabb: _localAabb, ...unbounded } = moved;
      apply([bounds === 'bounded' ? moved : unbounded]);
      const cleared = await frame();
      expect(cleared.cache).toBe('miss');
      expect([...cleared.staticSlots]).toEqual([0]);
      const baseline = await frame();
      expect(baseline.cache).toBe('hit');
      expect(baseline.centre).toBeCloseTo(0.3, 5);
      const staticDraws = raster.staticDraws;
      // Any erroneous static redraw now overwrites the retained depth.
      raster.staticDepth = 0.9;
      remove(2);
      const removed = await frame();
      expect(removed.cache).toBe('hit');
      expect([...removed.staticSlots]).toEqual([0]);
      expect(raster.staticDraws).toBe(staticDraws);
      expect(removed.centre).toBe(baseline.centre);
    } finally {
      await dispose();
    }
  });

  it('keeps the static layer depth with zero static rasters while an out-of-view caster flips', async () => {
    // Caster 1 sits inside the light frustum, caster 2 far outside it.
    const { apply, frame, dispose } = await harness([placed(1, 0), placed(2, 50)]);

    // Both casters settle into the static layer, which rasters at depth 0.3.
    raster.staticDepth = 0.3;
    const settleLimit = SHADOW_CASTER_SETTLE_FRAMES + 2 * SHADOW_CASTER_PROMOTE_WINDOW;
    await settleBoth(frame);
    const baseline = (await frame()).centre;
    expect(baseline).toBeCloseTo(0.3, 5);

    // Any static redraw from here on would write 0.9 instead of 0.3.
    raster.staticDepth = 0.9;
    const drawsBefore = raster.staticDraws;
    apply([placed(2, 60)]);
    const flipped = await frame();
    expect([...flipped.staticSlots]).toEqual([0]);
    expect(flipped.cache).toBe('hit');
    expect(flipped.centre).toBe(baseline);
    // The out-of-view caster stays dynamic, then settles back: no static raster.
    // A move right after promotion may back off its settle threshold.
    let rejoined = flipped;
    for (let step = 0; step < 4 * settleLimit && rejoined.staticSlots.size < 2; step += 1) {
      rejoined = await frame();
      expect(rejoined.cache).toBe('hit');
      expect(rejoined.centre).toBe(baseline);
    }
    expect([...rejoined.staticSlots]).toEqual([0, 1]);
    expect(raster.staticDraws).toBe(drawsBefore);

    // Falsifier: the in-view caster flipping must re-raster the static layer.
    apply([placed(1, 0.25)]);
    const inView = await frame();
    expect([...inView.staticSlots]).toEqual([1]);
    expect(inView.cache).toBe('miss');
    expect(raster.staticDraws).toBe(drawsBefore + 1);
    expect(inView.centre).toBeCloseTo(0.9, 5);

    await dispose();
  });

  it.each([
    'transform',
    'mesh',
  ] as const)('re-rasters only the changed caster footprint after a %s update', async (change) => {
    // Top-down orthographic light over x,z in [-32, 32]: one texel is 4 units.
    const ortho = mat4.orthographic(mat4.create(), -32, 32, -32, 32, 0.1, 100);
    const lookAt = mat4.lookAt(mat4.create(), [0, 50, 0], [0, 0, 0], [0, 0, -1]);
    const matrix = new Float32Array(mat4.multiply(mat4.create(), ortho, lookAt));
    const { apply, frame, dispose } = await harness([placed(1, -10), placed(2, 10)], matrix);
    const texel = (x: number, depth: Float32Array) =>
      depth[(MAP_SIZE / 2) * 64 + Math.floor(((x + 32) / 64) * MAP_SIZE)];

    raster.staticDepth = 0.3;
    await settleBoth(frame);
    const baseline = await frame();
    expect(baseline.cache).toBe('hit');
    expect(texel(-10, baseline.depth)).toBeCloseTo(0.3, 5);

    // Caster 1 moves and leaves the static layer: only its footprint redraws.
    raster.staticDepth = 0.9;
    const partialBefore = raster.partialDraws;
    if (change === 'transform') apply([placed(1, -12)]);
    else apply([{ ...placed(1, -10), assetHandle: 99 }]);
    const moved = await frame();
    expect([...moved.staticSlots]).toEqual([1]);
    expect(moved.cache).toBe('miss');
    expect(moved.dirtyRects).toHaveLength(1);
    expect(raster.partialDraws).toBe(partialBefore + 1);
    expect(texel(-10, moved.depth)).toBeCloseTo(0.9, 5);
    expect(texel(10, moved.depth)).toBeCloseTo(0.3, 5);
    expect(moved.centre).toBeCloseTo(0.3, 5);
    let redrawn = 0;
    for (let row = 0; row < MAP_SIZE; row += 1)
      for (let col = 0; col < MAP_SIZE; col += 1)
        if (Math.abs((moved.depth[row * 64 + col] ?? 0) - 0.9) < 1e-5) redrawn += 1;
    expect(redrawn).toBeGreaterThan(0);
    expect(redrawn).toBeLessThanOrEqual(4 * 4);

    await dispose();
  });
});
