import { defineSystem, World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import { viewSourceFixture } from '../../__tests__/view-source.fixture';
import type { CameraSnapshot } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import { acceptedViewInspectionFrame, findMaterialSlotDrawReceipt } from '../../view-inspection';
import {
  RenderView,
  RenderViewFrameSource,
  RenderViewInput,
  RenderViews,
  recordViewSubmission,
  ViewRecorder,
  ViewSubmission,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCleanup,
  RenderCommit,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import {
  adoptViewDraws,
  DYNAMIC_GEOMETRY_COMMIT_SYSTEM,
  DYNAMIC_GEOMETRY_RESET_SYSTEM,
  registerViewDrawSystems,
  VIEW_TERRAIN_CANDIDATE_SYSTEM,
  ViewDrawReceipt,
  viewDrawReceipt,
  type WaterBakedDrawReceiptFact,
} from '../view-draw-receipt';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
  viewFrameOf,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

it('retains the source revision consumed by an accepted material draw', () => {
  const receipt = new ViewDrawReceipt(),
    draw = {
      worldIdentity: 'world',
      entityKey: 4,
      submeshIndex: 0,
      materialSlot: 1,
      materialHandle: 12,
      sourceRevision: 19,
      frameId: 7,
      deviceGeneration: 2,
      graphGeneration: 5,
    } as const;
  receipt.stageMaterialDraw(7, draw);
  receipt.commitMaterialDraws(7);
  expect(receipt.materialDraws).toEqual([draw]);

  receipt.stageMaterialDraw(8, { ...draw, frameId: 8, sourceRevision: 20 });
  receipt.discardMaterialDraws();
  expect(receipt.materialDraws).toEqual([]);
});

it('charges each distinct material draw once at the exact UTF-8 array boundary', () => {
  const receipt = new ViewDrawReceipt();
  const first = {
    worldIdentity: 'w',
    entityKey: 1,
    submeshIndex: 0,
    materialSlot: 0,
    materialHandle: 1,
    sourceRevision: 3,
    frameId: 7,
    deviceGeneration: 0,
    graphGeneration: 0,
  };
  const extra = { ...first, entityKey: 2, worldIdentity: 'a\u00e9\u6c34\u{1f30a}\ud800' };
  const limit = 16 * 1024;
  const used = new TextEncoder().encode(JSON.stringify([first, extra])).byteLength;
  extra.worldIdentity += 'a'.repeat(limit - used);
  for (const tail of ['', 'x']) {
    const row = { ...extra, worldIdentity: extra.worldIdentity + tail };
    receipt.stageMaterialDraw(7, first);
    receipt.stageMaterialDraw(7, { ...first });
    receipt.stageMaterialDraw(7, row);
    receipt.commitMaterialDraws(7);
    expect(receipt.materialDraws).toEqual(tail === '' ? [first, row] : []);
  }
});

it('does not lend a shared material draw receipt to another entity', () => {
  const onlyA = {
    worldIdentity: 'world',
    entityKey: 4,
    submeshIndex: 2,
    materialSlot: 1,
    materialHandle: 12,
    sourceRevision: 19,
    frameId: 7,
    deviceGeneration: 2,
    graphGeneration: 5,
  } as const;
  const query = {
    worldIdentity: 'world',
    materialSlot: 1,
    submeshIndices: [2],
    materialHandle: 12,
    frameId: 7,
    deviceGeneration: 2,
    graphGeneration: 5,
  } as const;

  expect(findMaterialSlotDrawReceipt([onlyA], { ...query, entityKey: 4 })).toBe(onlyA);
  expect(findMaterialSlotDrawReceipt([onlyA], { ...query, entityKey: 5 })).toBeUndefined();
  expect(
    findMaterialSlotDrawReceipt([onlyA], { ...query, entityKey: 4, materialSlot: 0 }),
  ).toBeUndefined();
  expect(
    findMaterialSlotDrawReceipt([onlyA], { ...query, entityKey: 4, submeshIndices: [0] }),
  ).toBeUndefined();
});

const terrainCapture = vi.hoisted(() => ({
  current: undefined as undefined | (() => { sections: unknown[] } | undefined),
}));
vi.mock('../../terrain/submitted.js', () => ({
  captureSubmittedTerrain: () => {
    const candidate = terrainCapture.current?.();
    if (candidate === undefined) throw new Error('terrain capture failed');
    return candidate.sections;
  },
}));

const camera = {
  entityKey: 1,
  historyVersion: 1,
  view: {
    viewport: new Float32Array([0, 0, 1, 1]),
    order: 0,
    resolutionScale: 1,
    maxRenderShortSide: 0,
    updateInterval: 1,
    enabled: true,
  },
} as unknown as CameraSnapshot;

const scope = {} as never;
const entry = (mesh: number) => ({ source: { entityKey: 7, assetHandle: mesh } }) as never;

function setup(removed?: 'commit' | 'reset') {
  const world = createRenderWorld();
  const views = new RenderViews(world);
  registerViewDrawSystems(world);
  if (removed === 'commit') {
    world
      .removeSystem(RenderCommit, registeredSystem(world, RenderCommit, 'dynamic-geometry-commit'))
      .unwrap();
    world
      .removeSystem(RenderCommit, registeredSystem(world, RenderCommit, 'terrain-receipt-commit'))
      .unwrap();
  }
  if (removed === 'reset')
    world
      .removeSystem(RenderCleanup, registeredSystem(world, RenderCleanup, 'dynamic-geometry-reset'))
      .unwrap();
  world.insertResource(
    RenderViewInput,
    viewSourceFixture({
      cameras: [camera],
      captures: [],
      primary: false,
      primaryCamera: undefined,
      canvas: { width: 64, height: 64 },
      attachment: 'w',
      targetExtent: () => undefined,
    }),
  );
  beginRenderFrame(world, 1);
  const entity = views.ordered[0] as NonNullable<(typeof views.ordered)[0]>;
  adoptViewDraws(world, entity);
  const receipt = viewDrawReceipt(world, entity)?.dynamicGeometry;
  const record = (mesh: number, accepted: boolean, frame: number) => {
    receipt?.onRenderableDraw(scope)(entry(mesh));
    recordViewSubmission(world, entity, {
      accepted,
      attempt: frame,
      scene: accepted,
      temporal: false,
    });
  };
  const draws = viewDrawReceipt(world, entity) as NonNullable<ReturnType<typeof viewDrawReceipt>>;
  return { world, receipt, record, entity, draws };
}

describe('view draw receipt systems', () => {
  it('schedules commit in RenderCommit and reset in RenderCleanup against the view submission', () => {
    const { world } = setup();
    const data = world.scheduleData();
    const commit = data
      .find((s) => s.name === 'RenderCommit')
      ?.systems.find((s) => s.name === DYNAMIC_GEOMETRY_COMMIT_SYSTEM);
    const reset = data
      .find((s) => s.name === 'RenderCleanup')
      ?.systems.find((s) => s.name === DYNAMIC_GEOMETRY_RESET_SYSTEM);
    expect(commit?.queries[0]?.read).toEqual(
      expect.arrayContaining(['ViewSubmission', 'ViewDraws']),
    );
    expect(reset?.queries[0]?.read).toEqual(
      expect.arrayContaining(['ViewSubmission', 'ViewDraws']),
    );
  });

  it('publishes an accepted attempt only through the commit system', () => {
    const lane = (removed?: 'commit') => {
      const { world, receipt, record } = setup(removed);
      record(9, true, 1);
      endRenderFrame(world);
      return receipt?.recordStageLane(scope, 7, 9);
    };
    expect(lane()).toBe('cpu');
    expect(lane('commit')).toBeUndefined();
  });

  it('clears a rejected attempt and keeps a held view until the reset system is removed', () => {
    const second = (removed?: 'reset') => {
      const { world, receipt, record } = setup(removed);
      record(9, true, 1);
      endRenderFrame(world);
      beginRenderFrame(world, 2);
      record(10, false, 2);
      endRenderFrame(world);
      return [receipt?.recordStageLane(scope, 7, 9), receipt?.recordStageLane(scope, 7, 10)];
    };
    expect(second()).toEqual([undefined, undefined]);
    expect(second('reset')).toEqual(['cpu', undefined]);
    const { world, receipt, record } = setup();
    record(9, true, 1);
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    endRenderFrame(world);
    expect(receipt?.recordStageLane(scope, 7, 9)).toBe('cpu');
  });

  it('promotes Water Baked draw facts only for accepted attempts and preserves held views', () => {
    const { world, entity, draws } = setup();
    const programContext = {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const lineage = (sourceBodyGuid: string, sourceBodyGeneration: number) => ({
      version: 'water-river-bake/2' as const,
      textureGuid: 'texture-a',
      textureRevision: 8,
      normalTextureGuid: 'normal-texture-a',
      normalTextureRevision: 9,
      normalTextureFormat: 'rgba16float' as const,
      normalBasis: 'lattice-axis0-axis1-up/1' as const,
      sourceRecipeGuid: 'recipe-a',
      sourceRecipeVersion: 'sha256:recipe-a',
      sourceBodyGuid,
      sourceBodyGeneration,
      simulationGeneration: 2,
      sequence: 3,
      frameId: 4,
      deviceGeneration: 5,
      graphGeneration: 6,
      sourceWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      sourceGeometryProjectionHash: 'a'.repeat(64),
      sourceFrame: { generation: 2, sequence: 3, step: 4, timeSeconds: 1.5 },
    });
    const first: WaterBakedDrawReceiptFact = {
      entityKey: 42,
      submeshIndex: 0,
      materialSlot: 1,
      viewIdentity: 'view-a',
      frameId: 1,
      deviceGeneration: 2,
      graphGeneration: 4,
      drawKey: 'draw-a',
      ownerWorldIdentity: 'world-a',
      materialWorldIdentity: 'world-a',
      drawBinding: {
        viewIdentity: 'view-a',
        frameGeneration: 1,
        deviceGeneration: 2,
        drawDataBufferIdentity: 100,
        drawDataDynamicOffset: 256,
        waterMeshInstanceDynamicOffset: 64,
        waterMeshInstanceBufferIdentity: 102,
        waterMeshInstanceBufferByteLength: 512,
        waterMeshInstanceRange: [64, 128],
        bakedDescriptorBufferIdentity: 103,
        bakedSamplesBufferIdentity: 104,
      },
      materialIdentity: {
        materialGuid: 'material-a',
        publicationGeneration: 3,
        specializationKey: 'material-specialization',
        artifactHash: 'material-hash',
        programKey: 'water-forward-specialization',
      },
      programIdentity: {
        pass: 'forward',
        context: programContext,
        address: 'direct',
        specializationKey: 'water-forward-specialization',
        artifactHash: 'water-forward-artifact',
      },
      sourceBodyIndices: [1, 4],
      sources: [
        {
          worldIdentity: 'world-a',
          bodyIndex: 1,
          bodyGuid: 'body-a',
          bodyGeneration: 1,
          zoneGeneration: 5,
          descriptorRange: [48, 96],
          sampleRange: [0, 144],
          binding: {
            drawDataRowOffset: 256,
            descriptorBufferIdentity: 103,
            descriptorBufferByteLength: 240,
            sampleBufferIdentity: 104,
            sampleBufferByteLength: 288,
            complete: true,
            viewIdentity: 'view-a',
            frameGeneration: 1,
            deviceGeneration: 2,
          },
          lineage: lineage('historical-body', 0),
        },
        {
          worldIdentity: 'world-a',
          bodyIndex: 4,
          bodyGuid: 'body-b',
          bodyGeneration: 2,
          zoneGeneration: 5,
          descriptorRange: [192, 240],
          sampleRange: [144, 288],
          binding: {
            drawDataRowOffset: 1024,
            descriptorBufferIdentity: 103,
            descriptorBufferByteLength: 240,
            sampleBufferIdentity: 104,
            sampleBufferByteLength: 288,
            complete: true,
            viewIdentity: 'view-a',
            frameGeneration: 1,
            deviceGeneration: 2,
          },
          lineage: lineage('body-bake-source', 1),
        },
      ],
    };
    const firstDrawBinding = first.drawBinding;
    if (firstDrawBinding === undefined) throw new Error('fixture draw binding missing');
    const firstProgramIdentity = first.programIdentity;
    if (firstProgramIdentity === undefined) throw new Error('fixture program identity missing');
    const firstLineage = first.sources?.[0]?.lineage;
    if (firstLineage === undefined) throw new Error('fixture source lineage missing');
    draws.stageWaterBakedDraw(1, first, {
      viewIdentity: 'view-a',
      deviceGeneration: 2,
      graphGeneration: 4,
    });
    draws.stageWaterBakedDraw(
      1,
      {
        ...first,
        submeshIndex: 1,
        programIdentity: {
          ...firstProgramIdentity,
          context: Object.fromEntries(
            Object.entries(programContext).reverse(),
          ) as typeof programContext,
        },
      },
      {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        graphGeneration: 4,
      },
    );
    const mutableContext = firstProgramIdentity.context as unknown as Record<string, string>;
    const mutableLineage = firstLineage as unknown as {
      textureGuid: string;
      sourceWorldMatrixM: number[];
      sourceFrame: { step: number };
    };
    mutableContext.backend = 'vulkan';
    mutableLineage.textureGuid = 'mutated-texture';
    mutableLineage.sourceWorldMatrixM[12] = 999;
    mutableLineage.sourceFrame.step = 999;
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 1,
      scene: true,
      temporal: false,
    });
    endRenderFrame(world);
    expect(draws.waterBakedDraws).toHaveLength(1);
    expect(draws.waterBakedDraws[0]?.programIdentity?.context.backend).toBe('webgpu');
    expect(draws.waterBakedDraws[0]?.sources?.[0]?.lineage?.textureGuid).toBe('texture-a');
    expect(draws.waterBakedDraws[0]?.sources?.[0]?.lineage).toMatchObject({
      sourceWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      sourceFrame: { step: 4 },
    });
    mutableContext.backend = 'webgpu';
    mutableLineage.textureGuid = 'texture-a';
    mutableLineage.sourceWorldMatrixM[12] = 3;
    mutableLineage.sourceFrame.step = 4;
    expect(draws.waterBakedDraws).toMatchObject([
      { ...first, availability: { status: 'complete' } },
    ]);

    beginRenderFrame(world, 2);
    endRenderFrame(world);
    expect(draws.waterBakedDraws).toHaveLength(1);

    if (first.sources === undefined)
      throw new Error('The detached Water receipt requires its source roster');
    beginRenderFrame(world, 3);
    draws.stageWaterBakedDraw(
      3,
      {
        ...first,
        frameId: 3,
        sources: first.sources.map((source, index) =>
          index === 0
            ? { ...source, lineage: { ...lineage('history', 0), textureGuid: '' } }
            : source,
        ),
      },
      {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        graphGeneration: 5,
      },
    );
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 3,
      scene: true,
      temporal: false,
    });
    endRenderFrame(world);
    expect(draws.waterBakedDraws[0]?.availability).toEqual({
      status: 'unavailable',
      reason: 'graph-generation-mismatch',
    });
    expect(draws.waterBakedDraws[0]?.sources?.[0]).not.toHaveProperty('lineage');

    beginRenderFrame(world, 4);
    draws.stageWaterBakedDraw(
      4,
      { ...first, frameId: 4 },
      {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        graphGeneration: 4,
      },
    );
    recordViewSubmission(world, entity, {
      accepted: false,
      attempt: 4,
      scene: false,
      temporal: false,
    });
    endRenderFrame(world);
    expect(draws.waterBakedDraws).toEqual([]);

    beginRenderFrame(world, 5);
    draws.stageWaterBakedDraw(
      5,
      {
        ...first,
        frameId: 5,
        drawBinding: { ...firstDrawBinding, drawDataDynamicOffset: 512 },
      },
      {
        viewIdentity: 'view-a',
        deviceGeneration: 2,
        graphGeneration: 4,
      },
    );
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 5,
      scene: true,
      temporal: false,
    });
    endRenderFrame(world);
    expect(draws.waterBakedDraws[0]?.availability).toEqual({
      status: 'unavailable',
      reason: 'source-identity-incomplete',
    });
  });

  it('projects a held view from its accepted ViewSubmission and receipt frame, then rejects its failed attempt', () => {
    const { world, entity, draws } = setup();
    const context = {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const fact: WaterBakedDrawReceiptFact = {
      entityKey: 42,
      submeshIndex: 0,
      materialSlot: 1,
      viewIdentity: 'view-a',
      frameId: 1,
      deviceGeneration: 2,
      graphGeneration: 4,
      drawKey: 'draw-a',
      ownerWorldIdentity: 'world-a',
      materialWorldIdentity: 'world-a',
      materialIdentity: {
        materialGuid: 'material-a',
        publicationGeneration: 3,
        specializationKey: 'material-specialization',
        artifactHash: 'material-hash',
        programKey: 'water-forward-specialization',
      },
      programIdentity: {
        pass: 'forward',
        context,
        address: 'direct',
        specializationKey: 'water-forward-specialization',
        artifactHash: 'water-forward-artifact',
      },
      sourceBodyIndices: [],
    };
    draws.stageWaterBakedDraw(1, fact);
    publishRenderSubmission(world, {
      accepted: true,
      completion: undefined,
      creditCompletion: undefined,
      generation: 0,
    });
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 1,
      scene: true,
      temporal: false,
    });
    endRenderFrame(world);
    expect(
      acceptedViewInspectionFrame(
        world.get(entity, ViewSubmission).unwrap(),
        1,
        draws.waterBakedDraws,
      ),
    ).toBe(1);

    beginRenderFrame(world, 2);
    stageViewFrame(world, entity, {} as never, false);
    expect(viewFrameOf(world, entity)).toMatchObject({ frame: 2, mode: false });
    expect(
      acceptedViewInspectionFrame(
        world.get(entity, ViewSubmission).unwrap(),
        2,
        draws.waterBakedDraws,
      ),
    ).toBeUndefined();

    publishRenderSubmission(world, {
      accepted: true,
      completion: undefined,
      creditCompletion: undefined,
      generation: 0,
    });
    recordViewSubmission(world, entity, {
      accepted: true,
      attempt: 2,
      scene: true,
      temporal: false,
    });
    expect(
      acceptedViewInspectionFrame(
        world.get(entity, ViewSubmission).unwrap(),
        2,
        draws.waterBakedDraws,
      ),
    ).toBeUndefined();
    recordViewSubmission(world, entity, {
      accepted: false,
      attempt: 2,
      scene: true,
      temporal: false,
    });
    expect(
      acceptedViewInspectionFrame(
        world.get(entity, ViewSubmission).unwrap(),
        2,
        draws.waterBakedDraws,
      ),
    ).toBeUndefined();
    endRenderFrame(world);
  });

  it('publishes drawn terrain sections only through the commit system for an accepted attempt', () => {
    const sections = [1, 2].map((n) => ({ entity: n, section: 0 }) as never);
    const presented = { hasTerrain: (entity: number) => entity === 1 } as never;
    const run = (accepted: boolean, removed?: 'commit') => {
      const { world, entity, draws } = setup(removed);
      publishRenderSubmission(world, {
        accepted: true,
        completion: undefined,
        creditCompletion: undefined,
        generation: 0,
      });
      draws.stageTerrainCandidate(1, { sections });
      draws.stageTerrainPresented(presented);
      recordViewSubmission(world, entity, {
        accepted,
        attempt: 1,
        scene: accepted,
        temporal: false,
      });
      endRenderFrame(world);
      return draws.terrain.length;
    };
    expect(run(true)).toBe(1);
    expect(run(true, 'commit')).toBe(0);
    expect(run(false)).toBe(0);
  });
});

describe('view-terrain-candidate system', () => {
  const opts = {} as const;

  function stagedSetup(capture: () => unknown, removed = false) {
    terrainCapture.current = capture as typeof terrainCapture.current;
    const world = createRenderWorld();
    world.insertResource(
      RenderViewInput,
      Object.assign(new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }), {
        world: new World(),
      }),
    );
    registerViewDrawSystems(world);
    if (removed)
      world
        .removeSystem(
          RenderPrepare,
          registeredSystem(world, RenderPrepare, 'view-terrain-candidate'),
        )
        .unwrap();
    const recorder = {
      prepareViewFrame: () => ({
        ok: true as const,
        value: { renderables: [], dispatch: [], cameras: [camera] } as unknown as ExtractedFrame,
      }),
    };
    registerViewFrameStub(world, recorder.prepareViewFrame);
    const staged = world.spawn({ component: RenderView, data: {} }).unwrap();
    const held = world.spawn({ component: RenderView, data: {} }).unwrap();
    for (const entity of [staged, held]) {
      const state = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, { scene: {} }));
      world.addComponent(entity, { component: ViewRecorder, data: { state } }).unwrap();
      adoptViewDraws(world, entity);
    }
    const systemToken1 = defineSystem({
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) => stageViewFrame(world, staged, opts),
    });
    world.addSystem(RenderExtract, systemToken1).unwrap();
    return { world, staged, held };
  }

  const presented = { hasTerrain: (entity: number) => entity === 1 } as never;
  const candidate = {
    sections: [1, 2].map((n) => ({ entity: n, section: 0 }) as never),
  };

  function frameOf(removed: boolean, accepted: boolean, capture = () => candidate as never) {
    const { world, staged, held } = stagedSetup(capture, removed);
    beginRenderFrame(world, 1);
    for (const entity of [staged, held])
      viewDrawReceipt(world, entity)?.stageTerrainPresented(presented);
    publishRenderSubmission(world, {
      accepted,
      completion: undefined,
      creditCompletion: undefined,
      generation: 0,
    });
    for (const entity of [staged, held])
      recordViewSubmission(world, entity, {
        accepted,
        attempt: 1,
        scene: accepted,
        temporal: false,
      });
    endRenderFrame(world);
    return [staged, held].map((entity) => viewDrawReceipt(world, entity)?.terrain.length);
  }

  it('captures the staged view candidate in RenderPrepare and commits the presented part', () => {
    expect(frameOf(false, true)).toEqual([1, 0]);
  });

  it('publishes nothing without the system, for a rejected frame, or a failed capture', () => {
    expect(frameOf(true, true)).toEqual([0, 0]);
    expect(frameOf(false, false)).toEqual([0, 0]);
    expect(frameOf(false, true, () => undefined as never)).toEqual([0, 0]);
  });

  it('declares its view reads, phase order and no writes in the schedule', () => {
    const { world } = stagedSetup(() => undefined);
    const prepare = world
      .scheduleData()
      .find((data) => data.name === 'RenderPrepare')
      ?.systems.find((data) => data.name === VIEW_TERRAIN_CANDIDATE_SYSTEM);
    expect(prepare?.after).toEqual([RENDER_VIEW_FRAME_SYSTEM]);
    expect(prepare?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame', 'ViewDraws']);
    expect(prepare?.queries[0]?.write ?? []).toEqual([]);
  });
});
