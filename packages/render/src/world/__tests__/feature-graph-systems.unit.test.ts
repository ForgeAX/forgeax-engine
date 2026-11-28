import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { World } from '@forgeax/engine-ecs';
import { type PhysicsWorld, PhysicsWorldResource } from '@forgeax/engine-physics';
import {
  compiledRenderGraphPassDeclarations,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import { advancedWaterFixture } from '../../__tests__/advanced-water-fixture';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  stageFeatureFrame,
  submitFeatureFrame,
} from '../../__tests__/feature-frame-driver';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import { compileSharedFeatureGraph } from '../../assembly/feature-frame-graph';
import { viewSharedFeatureGraphPassName } from '../../features/frame-plan';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../../features/host';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../../features/prepared-gpu-work';
import {
  createRenderFeatureProjectionState,
  projectRenderFeaturePlans,
} from '../../features/render-graph-contribution';
import {
  importSharedGraphTextures,
  sharedGraphTextures,
} from '../../features/shared-graph-textures';
import type { RenderFeature } from '../../features/types';
import type { RenderSystemInternals } from '../../record/render-context';

import {
  createWaterAdvancedFeature,
  WATER_ADVANCED_FEATURE_IDENTITY,
} from '../../water/advanced-feature';
import { createWaterFluidFeature, waterFluidRenderFrame } from '../../water/fluid-feature';
import {
  encodeSharedFeatureGraph,
  RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
  releaseSharedFeatureGraphHistory,
  sharedFeatureGraphOutcome,
  sharedFeaturePreparationPending,
  stageSharedFeatureGraph,
} from '../feature-graph-systems';
import { stageRecordedFeatureGraph } from '../feature-systems';
import { RENDER_GRAPH_SEAL_SYSTEM } from '../graph-seal-systems';
import { frameEncoder } from '../record-systems';
import { ViewSubmission } from '../render-views';
import {
  endRenderFrame,
  publishRenderSubmission,
  RenderRecord,
  runRenderRecord,
} from '../render-world';

async function fixture(
  systemEncode = false,
  preparationPending = false,
  featureIdentity = 'shared-copy',
  computeProjection = false,
) {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: () =>
        preparationPending
          ? err(
              new RhiError({
                code: 'rhi-not-available',
                expected: 'the requested program is prepared',
                hint: 'retry after shader preparation',
              }),
            )
          : ok(shader),
      isPending: () => preparationPending,
    }),
  });
  const nativePreparation = preparationPending;
  const submitted = vi.fn();
  const aborted = vi.fn();
  let withWork = true;
  const feature: RenderFeature<undefined> = {
    identity: featureIdentity,
    extract: () => ok(undefined),
    profileGraphPasses: (viewScopes) =>
      viewScopes.map((view) => ({
        view,
        name: viewSharedFeatureGraphPassName(view, 'shared-copy-pass'),
        kind: 'copy',
      })),
    plan: () =>
      ok(
        withWork
          ? {
              work: [
                {
                  scope:
                    featureIdentity === WATER_ADVANCED_FEATURE_IDENTITY
                      ? { view: 'view' }
                      : 'frame',
                  resources: [
                    ...(nativePreparation || computeProjection
                      ? [
                          {
                            kind: 'compute-program' as const,
                            name: 'shared-program',
                            program: ownRenderFeatureProgramData({
                              wgsl: 'synthetic',
                              entryPoints: ['main'],
                              ...(computeProjection
                                ? {
                                    bindings: [
                                      {
                                        entries: [
                                          {
                                            binding: 0,
                                            visibility: 4,
                                            buffer: { type: 'storage' as const },
                                          },
                                        ],
                                      },
                                    ],
                                  }
                                : {}),
                            }),
                          },
                        ]
                      : []),
                    {
                      kind: 'buffer',
                      name: 'source',
                      size: 16,
                      usage: ['copy-src'],
                      data: new Uint32Array([7, 0, 0, 0]),
                    },
                    { kind: 'buffer', name: 'destination', size: 16, usage: ['storage'] },
                    ...(computeProjection
                      ? [
                          ownRenderFeatureProgramData({
                            kind: 'compute-bindings' as const,
                            name: 'shared-bindings',
                            program: 'shared-program',
                            entries: [{ binding: 0, resource: 'destination' }],
                          }),
                        ]
                      : []),
                  ],
                  passes: [
                    ...(computeProjection
                      ? [
                          {
                            kind: 'compute' as const,
                            name: 'shared-compute-pass',
                            program: 'shared-program',
                            bindings: 'shared-bindings',
                            dispatches: [
                              {
                                kind: 'direct' as const,
                                entryPoint: 'main',
                                workgroups: [1] as const,
                              },
                            ],
                          },
                        ]
                      : [
                          {
                            kind: 'copy' as const,
                            name: 'shared-copy-pass',
                            copies: [{ source: 'source', destination: 'destination', size: 16 }],
                          },
                        ]),
                  ],
                },
              ],
            }
          : { work: [] },
      ),
    onFrameSubmitted: submitted,
    onFrameAborted: aborted,
  };
  const host = createRenderFeatureHost([feature as RenderFeature<unknown>]).unwrap();
  const sourceWorld = new World();
  const staged = stageFeatureFrame(host, [
    {
      identity: 'view',
      render: true,
      world: sourceWorld,
      frameNumber: 1,
      generation: 0,
      caps: device.caps,
      gpuWork: gpu,
    },
  ]);
  if (staged.kind !== 'sealed') throw new Error(`Feature frame ${staged.kind}`);
  expect(staged.batch.frame.errors).toEqual([]);
  const world = host.world;
  const internals = {
    device,
    canvas: { width: 8, height: 8 },
    renderWorld: world,
    featureHost: host,
    framePassNames: [] as string[],
    errorRegistry: { fire: vi.fn() },
  } as unknown as RenderSystemInternals & { framePassNames: string[] };
  stageSharedFeatureGraph(world, internals, []);
  // These kernel tests isolate compile from encode; system execution has its own same-path tests.
  if (!systemEncode)
    world
      .removeSystem(
        RenderRecord,
        registeredSystem(world, RenderRecord, 'render-feature-graph-encode'),
      )
      .unwrap();
  const record = () => runRenderRecord(world, { device, frameId: 1 });
  const next = (active = true) => {
    withWork = active;
    stageFeatureFrame(host, [
      {
        identity: 'view',
        render: true,
        world: sourceWorld,
        frameNumber: 2,
        generation: 0,
        caps: device.caps,
        gpuWork: gpu,
      },
    ]);
    stageSharedFeatureGraph(world, internals, []);
  };
  const finish = (accepted: boolean, completion?: Promise<void>) => {
    publishRenderSubmission(world, {
      accepted,
      completion,
      creditCompletion: undefined,
      generation: 0,
    });
    endRenderFrame(world);
  };
  const dispose = () => {
    host.dispose();
    gpu.dispose().unwrap();
  };
  return {
    world,
    host,
    feature,
    device,
    staged,
    internals,
    submitted,
    aborted,
    record,
    next,
    ready: () => {
      preparationPending = false;
    },
    finish,
    dispose,
  };
}

describe('shared Feature graph systems', () => {
  it('releases superseded shared compute graphs while the newest projection stays published', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const f = await fixture(false, false, 'shared-compute', true);
    const released = (() => {
      expect(f.record().ok).toBe(true);
      expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
      const outcome = sharedFeatureGraphOutcome(f.world);
      assert(outcome?.ok && outcome.receipt.kind === 'compiled');
      const weak = new WeakRef(outcome.receipt.graph);
      f.finish(true, Promise.resolve());
      return weak;
    })();
    try {
      for (let frame = 0; frame < 8; frame++) {
        f.next();
        expect(f.record().ok).toBe(true);
        expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
        f.finish(true, Promise.resolve());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      for (let attempt = 0; attempt < 10 && released.deref() !== undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
      }
      expect(sharedGraphTextures(f.host)?.graph).toBeDefined();
      expect(released.deref()).toBeUndefined();
    } finally {
      f.dispose();
    }
  });
  it('declares the exact compiled physical name of a hoisted conditional pass', async () => {
    const f = await fixture(false, false, WATER_ADVANCED_FEATURE_IDENTITY);
    try {
      const declarations = f.host.profileGraphPasses(['view']);
      expect(declarations).toEqual([
        {
          view: 'view',
          name: viewSharedFeatureGraphPassName('view', 'shared-copy-pass'),
          kind: 'copy',
        },
      ]);
      expect(f.record().ok).toBe(true);
      const compiled = sharedFeatureGraphOutcome(f.world);
      if (compiled?.ok !== true || compiled.receipt.kind !== 'compiled')
        throw new Error('Missing compiled shared graph');
      expect(compiled.receipt.graph.inspect().passes.map((pass) => pass.name)).toContain(
        declarations[0]?.name,
      );
      f.finish(false);
    } finally {
      f.dispose();
    }
  });

  it('declares hoisted Water targets and projects their writes before frame VFX consumers', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const waterTarget = {
      kind: 'feature-texture' as const,
      featureIdentity: WATER_ADVANCED_FEATURE_IDENTITY,
      name: 'water-surface',
      viewIdentity: 'main',
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
    };
    const vfx: RenderFeature<unknown> = {
      identity: 'forgeax.vfx-render.gpu-particles',
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: 'frame',
              resources: [
                {
                  kind: 'compute-program',
                  name: 'sample-water-program',
                  program: ownRenderFeatureProgramData({
                    wgsl: 'synthetic',
                    entryPoints: ['sampleWater'],
                    bindings: [
                      {
                        entries: [
                          {
                            binding: 0,
                            visibility: 4,
                            texture: { sampleType: 'float', viewDimension: '2d' },
                          },
                        ],
                      },
                    ],
                  }),
                },
                {
                  kind: 'prepared-gpu-resource',
                  name: 'water-surface-view',
                  resource: { kind: 'texture-view', value: undefined },
                  logicalTarget: waterTarget,
                },
                {
                  kind: 'compute-bindings',
                  name: 'sample-water-bindings',
                  program: 'sample-water-program',
                  entries: [{ binding: 0, resource: 'water-surface-view' }],
                },
              ],
              passes: [
                {
                  kind: 'compute',
                  name: 'sample-current-water',
                  program: 'sample-water-program',
                  bindings: 'sample-water-bindings',
                  dispatches: [
                    { kind: 'direct', entryPoint: 'sampleWater', workgroups: [1, 1, 1] },
                  ],
                },
              ],
            },
          ],
        }),
    };
    const water: RenderFeature<unknown> = {
      identity: WATER_ADVANCED_FEATURE_IDENTITY,
      extract: () => ok(undefined),
      plan: () =>
        ok({
          work: [
            {
              scope: { view: 'main' },
              resources: [
                {
                  kind: 'graph-texture',
                  name: 'water-surface',
                  allocationKey: 'water-surface',
                  materialSource: true,
                  descriptor: {
                    format: 'rgba8unorm',
                    size: { width: 8, height: 8, depthOrArrayLayers: 1 },
                    usage: 0x0c,
                  },
                },
                {
                  kind: 'prepared-gpu-resource',
                  name: 'water-surface-storage',
                  resource: { kind: 'texture-view', value: undefined },
                  logicalTarget: waterTarget,
                },
                {
                  kind: 'compute-program',
                  name: 'write-water-program',
                  program: ownRenderFeatureProgramData({
                    wgsl: 'synthetic',
                    entryPoints: ['writeWater'],
                    bindings: [
                      {
                        entries: [
                          {
                            binding: 0,
                            visibility: 4,
                            storageTexture: {
                              access: 'write-only',
                              format: 'rgba8unorm',
                              viewDimension: '2d',
                            },
                          },
                        ],
                      },
                    ],
                  }),
                },
                {
                  kind: 'compute-bindings',
                  name: 'write-water-bindings',
                  program: 'write-water-program',
                  entries: [{ binding: 0, resource: 'water-surface-storage' }],
                },
              ],
              passes: [
                {
                  kind: 'compute',
                  name: 'write-current-water',
                  program: 'write-water-program',
                  bindings: 'write-water-bindings',
                  dispatches: [{ kind: 'direct', entryPoint: 'writeWater', workgroups: [1, 1, 1] }],
                },
              ],
            },
          ],
        }),
    };
    const host = createRenderFeatureHost([vfx, water]).unwrap();
    const internals = {
      device,
      canvas: { width: 8, height: 8 },
      featureHost: host,
      errorRegistry: { fire: vi.fn() },
    } as unknown as RenderSystemInternals;
    let graph: NonNullable<ReturnType<typeof compileSharedFeatureGraph>> | undefined;
    try {
      const batch = prepareFeatureFrame(host, [
        {
          identity: 'main',
          render: true,
          world: host.world,
          frameNumber: 1,
          generation: 0,
          deviceGeneration: 0,
          caps: device.caps,
          gpuWork: gpu,
        },
      ]);
      expect(batch.frame.errors).toEqual([]);
      const waterView = batch.views.get('main');
      assert(waterView);
      graph = compileSharedFeatureGraph(internals, batch.frame, [], batch.views);
      assert(graph);
      const passes = graph.inspect().passes;
      const producer = passes.find((pass) => pass.name === 'view:main:write-current-water');
      const consumer = passes.find((pass) => pass.name === 'sample-current-water');
      assert(producer);
      assert(consumer);
      expect(consumer.executionIndex).toBeGreaterThan(producer.executionIndex);
      expect(consumer.dependencies).toContain(producer.name);
    } finally {
      await graph?.retire();
      abortFeatureFrame(host);
      host.dispose().unwrap();
      gpu.dispose().unwrap();
    }
  });

  it('keeps Advanced history shared across Body replacement, foam readiness and pending sources', async () => {
    const source = await advancedWaterFixture(undefined, ['shallow', 'shallowFoam'], 'ocean');
    const unexpectedPhysics = () => {
      throw new Error('This shared-history fixture must not query native body geometry');
    };
    const physics: PhysicsWorld = {
      dispose() {},
      setGravity: unexpectedPhysics,
      getGravity: unexpectedPhysics,
      raycast: unexpectedPhysics,
      teleport: unexpectedPhysics,
      synchronizeCharacter: unexpectedPhysics,
      moveAndSlide: unexpectedPhysics,
      step: unexpectedPhysics,
      getBodyCount: unexpectedPhysics,
      hasBody: unexpectedPhysics,
      getCommittedColliderPrimitives: unexpectedPhysics,
      intersectsCommittedBodyObb: () => ok(false),
    };
    source.world.insertResource(PhysicsWorldResource, physics);
    source.world.update(1 / 60).unwrap();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'unit plan module' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const advanced = createWaterAdvancedFeature({});
    const fluid = createWaterFluidFeature({
      contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
    });
    const host = createRenderFeatureHost([fluid, advanced]).unwrap();
    const internals = {
      device,
      canvas: { width: 16, height: 16 },
      featureHost: host,
      immediateShaderModuleFactory: { createShaderModule: () => ok(shader) },
      errorRegistry: { fire: vi.fn() },
    } as unknown as RenderSystemInternals;
    const graphs: NonNullable<ReturnType<typeof compileSharedFeatureGraph>>[] = [];
    const unavailableQuery = source.water.queryBody('pending-source', {
      positionM: [10, 4, 20],
      timeSeconds: 1,
      flags: 0,
    });
    assert(!unavailableQuery.ok);
    let simulation = source.simulation;
    let stableHistory: unknown;
    const stableSolver = new Map<string, unknown>();
    try {
      for (let frameNumber = 1; frameNumber <= 8; frameNumber++) {
        if (frameNumber === 2) {
          const body = source.water.snapshot(simulation.body.guid);
          assert(body);
          source.water.hotReloadBody(body.guid, 'body-v2', body.asset).unwrap();
          simulation = source.water
            .createAdvancedSimulation(simulation.recipe, simulation.body.guid)
            .unwrap();
          expect(simulation.body.generation).toBeGreaterThan(source.simulation.body.generation);
          stableHistory = undefined;
          stableSolver.clear();
        }
        const query =
          frameNumber === 6
            ? vi.spyOn(source.water, 'queryBody').mockReturnValueOnce(unavailableQuery)
            : undefined;
        simulation
          .update({
            deltaSeconds: 1 / 60,
            timeSeconds: frameNumber,
            centerXZ: [10, 20],
            yawRadians: 0,
          })
          .unwrap();
        query?.mockRestore();
        if (frameNumber === 6) expect(simulation.inspect().status).toBe('waiting-water-surface');
        const visible = frameNumber !== 2 && frameNumber !== 4;
        const batch = prepareFeatureFrame(host, [
          ...['main', 'secondary'].map((identity) => ({
            identity,
            render: true,
            world: source.world,
            frameNumber,
            generation: 0,
            deviceGeneration: 0,
            caps: {
              ...device.caps,
              compute: true,
              storageBuffer: true,
              storageTexture: true,
              rgba16floatStorage: true,
              rgba32floatStorage: true,
            },
            limits: { maxTextureDimension2D: 8192 },
            frame: {
              frameNumber,
              waterFoamMaterials:
                frameNumber !== 4
                  ? [
                      {
                        worldIdentity: source.world.identity,
                        bodyGuid: simulation.body.guid,
                        bodyGeneration:
                          frameNumber === 2
                            ? source.simulation.body.generation
                            : simulation.body.generation,
                        materialHandle: 8,
                        mapping: {
                          kind: 'mapped' as const,
                          centerXZ: [10, 20] as const,
                          extentM: 64,
                        },
                      },
                    ]
                  : [],
            },
            gpuWork: gpu,
          })),
        ]);
        try {
          expect(batch.frame.errors).toEqual([]);
          const render = waterFluidRenderFrame(host.features);
          expect(render?.contactFoam !== undefined).toBe(visible);
          const graph = compileSharedFeatureGraph(
            internals,
            batch.frame,
            [],
            batch.views,
            graphs.at(-1),
          );
          assert(
            graph,
            'Advanced history needs a stable shared graph owner without a foam consumer',
          );
          graphs.push(graph);
          const publication = sharedGraphTextures(host);
          const grid = publication?.textures.find((entry) =>
            entry.name.endsWith('-source-grid-local16'),
          );
          assert(grid);
          expect(grid.scope).toBe('view:main');
          expect(grid.label).toContain(`-b${simulation.body.generation}-g1`);
          const physical = graph.getColorTargetTexture(grid.label);
          assert(physical);
          stableHistory ??= physical;
          expect(physical).toBe(stableHistory);
          const solver = graph
            .inspect()
            .resources.filter((entry) => /-(grid|field|foam|normals)-state-b/.test(entry.label));
          expect(solver).toHaveLength(4);
          for (const state of solver ?? []) {
            const physical = graph.getColorTargetTexture(state.label);
            assert(physical);
            if (!stableSolver.has(state.label)) stableSolver.set(state.label, physical);
            expect(physical).toBe(stableSolver.get(state.label));
          }
          const passes = graph.inspect().passes.map((pass) => pass.name);
          expect(passes.filter((name) => name.endsWith('-initialize-state'))).toHaveLength(
            frameNumber <= 2 ? 1 : 0,
          );
          expect(
            passes.filter((name) => name.endsWith('-publish-shallow')),
            `frame ${frameNumber}`,
          ).toHaveLength(frameNumber === 6 ? 0 : 1);
          expect(passes.filter((name) => name.endsWith('-copy-history'))).toHaveLength(1);
          expect(
            [...(publication?.passes ?? [])].filter((pass) => pass.name.endsWith('-copy-history')),
          ).toHaveLength(1);
          for (const view of batch.views.values()) {
            const builder = new RenderGraphBuilder();
            const projection = createRenderFeatureProjectionState();
            importSharedGraphTextures(builder, publication, projection.graphTextures);
            for (const pass of publication?.passes ?? []) projection.projected.add(pass);
            const compute = vi.spyOn(builder, 'addComputePass');
            projectRenderFeaturePlans(
              builder,
              view.plans
                .map(getRenderFeaturePlanExecutionProjection)
                .filter((plan): plan is RenderFeaturePlanExecution => plan !== undefined),
              {
                state: projection,
                resolveTarget: () => undefined,
                reportError: (error) => {
                  throw error;
                },
              },
            ).unwrap();
            expect(compute).not.toHaveBeenCalled();
          }
          const before = simulation.inspect().submittedSequence;
          const encoder = device.createCommandEncoder().unwrap();
          const compute = vi.spyOn(encoder, 'beginComputePass');
          graph.execute({ encoder, runtime: internals }).unwrap();
          expect(
            compute.mock.calls.some(([descriptor]) => descriptor?.label?.endsWith('-retain-state')),
          ).toBe(false);
          expect(simulation.inspect().submittedSequence).toBe(before);
          if (frameNumber === 8) {
            graph.discardExecution();
            abortFeatureFrame(host);
            expect(simulation.inspect().submittedSequence).toBe(before);
            continue;
          }
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          graph.commitExecution();
          submitFeatureFrame(host);
          expect(simulation.inspect().submittedSequence > before).toBe(frameNumber !== 6);
        } finally {
          for (const resources of batch.preparedResourceBatches) resources.release().unwrap();
        }
      }
    } finally {
      for (const graph of graphs) await graph.retire();
      host.dispose().unwrap();
      gpu.dispose().unwrap();
    }
  });

  it('keeps every view WaterInfo history in the shared graph without fluid demand', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    let submittedViews = new Set<string>();
    const feature: RenderFeature<readonly string[]> = {
      identity: 'water-info-producer',
      extract: ({ views }) => ok(views.map((view) => view.identity)),
      plan: (views) =>
        ok({
          work: views.map((view) => ({
            scope: { view },
            resources: [
              {
                kind: 'graph-texture',
                name: 'water-info-history',
                allocationKey: 'water-info-history',
                materialSource: true,
                descriptor: {
                  format: 'rgba16float',
                  size: { width: 8, height: 8, depthOrArrayLayers: 1 },
                  lifetime: 'persistent',
                  usage: 0x0c,
                },
              },
              {
                kind: 'prepared-gpu-resource',
                name: 'history-view',
                resource: { kind: 'texture-view', value: undefined },
                logicalTarget: 'water-info-history',
              },
              {
                kind: 'compute-program',
                name: 'history-program',
                program: ownRenderFeatureProgramData({
                  wgsl: 'synthetic',
                  entryPoints: ['main'],
                  bindings: [
                    {
                      entries: [
                        {
                          binding: 0,
                          visibility: 4,
                          ...(submittedViews.has(view)
                            ? { texture: { sampleType: 'float', viewDimension: '2d' } as const }
                            : {
                                storageTexture: {
                                  access: 'write-only',
                                  format: 'rgba16float',
                                  viewDimension: '2d',
                                } as const,
                              }),
                        },
                      ],
                    },
                  ],
                }),
              },
              {
                kind: 'compute-bindings',
                name: 'history-bindings',
                program: 'history-program',
                entries: [{ binding: 0, resource: 'history-view' }],
              },
            ],
            passes: [
              {
                kind: 'compute',
                name: submittedViews.has(view) ? 'water-info-retain' : 'water-info-capture',
                program: 'history-program',
                bindings: 'history-bindings',
                dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1, 1, 1] }],
              },
            ],
          })),
        }),
      onFrameSubmitted: (views) => {
        submittedViews = new Set(views);
      },
    };
    const host = createRenderFeatureHost([feature as RenderFeature<unknown>]).unwrap();
    const internals = {
      device,
      canvas: { width: 8, height: 8 },
      featureHost: host,
      errorRegistry: { fire: vi.fn() },
    } as unknown as RenderSystemInternals;
    const graphs: NonNullable<ReturnType<typeof compileSharedFeatureGraph>>[] = [];
    let stableHistory: unknown;
    try {
      for (const views of [
        ['camera:a'],
        ['camera:b', 'camera:a'],
        ['camera:a', 'camera:b'],
        ['camera:a'],
        ['camera:a', 'camera:b'],
      ]) {
        const frameNumber = graphs.length + 1;
        const staged = stageFeatureFrame(
          host,
          views.map((identity) => ({
            identity,
            render: true,
            world: host.world,
            frameNumber,
            generation: 0,
            caps: device.caps,
            gpuWork: gpu,
          })),
        );
        if (staged.kind !== 'sealed') throw new Error(`Feature frame ${staged.kind}`);
        expect(staged.batch.frame.errors).toEqual([]);
        const graph = compileSharedFeatureGraph(
          internals,
          staged.batch.frame,
          [],
          staged.batch.views,
          graphs.at(-1),
        );
        if (graph === undefined) throw new Error('WaterInfo has no shared graph owner');
        graphs.push(graph);
        const publication = sharedGraphTextures(host);
        const passes = views.map(
          (view) => `view:${view}:water-info-${submittedViews.has(view) ? 'retain' : 'capture'}`,
        );
        expect(
          graph
            .inspect()
            .passes.map((pass) => pass.name)
            .sort(),
        ).toEqual(passes.sort());
        expect(publication?.textures.map((entry) => entry.scope).sort()).toEqual(
          views.map((view) => `view:${view}`).sort(),
        );
        expect(publication?.passes.size).toBe(views.length);
        expect(
          [...(publication?.passes ?? [])].every((pass) => !pass.name.startsWith('view:')),
        ).toBe(true);
        const history = publication?.textures.find((entry) => entry.scope === 'view:camera:a');
        if (history === undefined) throw new Error('Stable WaterInfo history is missing');
        const physical = graph.getColorTargetTexture(history.label);
        expect(physical).toBeDefined();
        stableHistory ??= physical;
        expect(physical).toBe(stableHistory);
        const encoder = device.createCommandEncoder().unwrap();
        graph.execute({ encoder, runtime: internals }).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        graph.commitExecution();
        submitFeatureFrame(host);
        for (const resources of staged.batch.preparedResourceBatches) resources.release().unwrap();
      }
    } finally {
      for (const graph of graphs) await graph.retire();
      host.dispose().unwrap();
      gpu.dispose().unwrap();
    }
  });

  it('holds shared compilation while native preparation is pending and retries ready without acknowledgment', async () => {
    const f = await fixture(true, true);
    try {
      expect(f.staged.batch.frame.preparationPending).toBe(true);
      expect(f.record().ok).toBe(true);
      expect(sharedFeatureGraphOutcome(f.world)).toBeUndefined();
      expect(sharedFeaturePreparationPending(f.world)).toBe(true);
      expect(sharedGraphTextures(f.host)).toBeUndefined();
      f.finish(true, Promise.resolve());
      expect(f.submitted).not.toHaveBeenCalled();
      f.ready();
      f.next();
      expect(f.record().ok).toBe(true);
      expect(sharedFeatureGraphOutcome(f.world)?.ok).toBe(true);
      expect(sharedFeaturePreparationPending(f.world)).toBe(false);
      f.finish(true, Promise.resolve());
      expect(f.submitted).toHaveBeenCalledTimes(1);
    } finally {
      f.dispose();
    }
  });

  it('publishes shared exports before any view graph compiles', async () => {
    const f = await fixture();
    const record = f.world.scheduleData().find((schedule) => schedule.name === 'RenderRecord');
    const compile = record?.systems.find(
      (system) => system.name === RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
    );
    expect(compile).toBeDefined();
    expect(
      record?.systems.find((system) => system.name === RENDER_GRAPH_SEAL_SYSTEM)?.after,
    ).toContain(compile?.name);
    f.finish(false);
    f.dispose();
  });

  it('compiles before execution and acknowledges exactly its encoded receipt', async () => {
    const f = await fixture();
    expect(sharedFeatureGraphOutcome(f.world)).toBeUndefined();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true || compiled.receipt.kind !== 'compiled')
      throw new Error('Missing compiled receipt');
    expect(compiled.receipt.plans).toBe(f.staged.batch.frame.plans);
    const graphInfo = compiled.receipt.graph.inspect();
    expect(graphInfo.passes.map((pass) => pass.name)).toContain('shared-copy-pass');
    f.internals.framePassNames.length = 0;
    const inspect = vi.spyOn(compiled.receipt.graph, 'inspect');
    const encoder = frameEncoder(f.world);
    const copies = vi.spyOn(encoder, 'copyBufferToBuffer');
    expect(copies).not.toHaveBeenCalled();
    const encoded = encodeSharedFeatureGraph(f.world, encoder);
    expect(encoded.ok && encoded.value).toBe(compiled.receipt);
    expect(copies).toHaveBeenCalledTimes(1);
    expect(inspect).not.toHaveBeenCalled();
    expect(f.internals.observationGraphGeneration).toBe(graphInfo.generation);
    expect(f.internals.framePassNames).toEqual(
      compiledRenderGraphPassDeclarations(compiled.receipt.graph).map((pass) => pass.name),
    );
    expect(f.submitted).not.toHaveBeenCalled();
    expect(encodeSharedFeatureGraph(f.world, encoder).ok).toBe(false);
    expect(copies).toHaveBeenCalledTimes(1);
    f.finish(true, Promise.resolve());
    expect(f.submitted).toHaveBeenCalledTimes(1);
    expect(f.aborted).not.toHaveBeenCalled();
    expect(sharedFeatureGraphOutcome(f.world)).toBeUndefined();
    f.dispose();
  });

  it('has no graph or acknowledgment when its compile system is removed', async () => {
    const f = await fixture();
    f.world
      .removeSystem(
        RenderRecord,
        registeredSystem(f.world, RenderRecord, 'render-feature-graph-compile'),
      )
      .unwrap();
    expect(f.record().ok).toBe(true);
    const encoded = encodeSharedFeatureGraph(f.world, frameEncoder(f.world));
    expect(encoded.ok).toBe(false);
    if (!encoded.ok)
      expect(encoded.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'record' },
      });
    f.finish(false);
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it('returns encode failure as data without advancing Feature history', async () => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const encoder = frameEncoder(f.world);
    vi.spyOn(encoder, 'copyBufferToBuffer').mockImplementation(() => {
      throw new Error('copy rejected');
    });
    const encoded = encodeSharedFeatureGraph(f.world, encoder);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok)
      expect(encoded.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'record' },
      });
    f.finish(false);
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it.each([
    'stale-frame',
    'stale-generation',
    'rejected-view',
  ] as const)('does not acknowledge a delayed graph receipt with %s', async (failure) => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true) throw new Error('Missing compiled receipt');
    const receipt = compiled.receipt;
    const rejected = f.world
      .spawn({
        component: ViewSubmission,
        data: {
          accepted: false,
          attempt: receipt.frame,
          scene: true,
          temporal: false,
        },
      })
      .unwrap();
    // The compiler receipt models a late encoder notification; no backend acceptance is inferred.
    stageRecordedFeatureGraph(f.world, {
      ...receipt,
      frame: receipt.frame + (failure === 'stale-frame' ? 1 : 0),
      generation: receipt.generation + (failure === 'stale-generation' ? 1 : 0),
      view: failure === 'rejected-view' ? rejected : undefined,
    });
    f.finish(true, Promise.resolve());
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
    f.dispose();
  });

  it.each([
    'host',
    'world-owner',
  ] as const)('retires retained history after its last-use fence on %s disposal', async (disposal) => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const compiled = sharedFeatureGraphOutcome(f.world);
    if (compiled?.ok !== true || compiled.receipt.kind !== 'compiled')
      throw new Error('Missing compiled receipt');
    const retire = vi.spyOn(compiled.receipt.graph, 'retire');
    expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    f.finish(true, completion);
    expect(retire).not.toHaveBeenCalled();
    vi.spyOn(f.device.queue, 'onSubmittedWorkDone').mockReturnValue(
      completion.then(() => undefined),
    );
    if (disposal === 'host') f.host.dispose().unwrap();
    else releaseSharedFeatureGraphHistory(f.world);
    expect(sharedGraphTextures(f.host)).toBeUndefined();
    expect(retire).not.toHaveBeenCalled();
    resolve();
    await completion;
    await Promise.resolve();
    expect(retire).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it.each([
    'replacement',
    'zero-work',
  ] as const)('retires submitted history only after the %s frame completes', async (path) => {
    const f = await fixture();
    expect(f.record().ok).toBe(true);
    const first = sharedFeatureGraphOutcome(f.world);
    if (first?.ok !== true || first.receipt.kind !== 'compiled') throw new Error('Missing graph');
    const retire = vi.spyOn(first.receipt.graph, 'retire');
    expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
    f.finish(true, Promise.resolve());
    f.next(path === 'replacement');
    expect(sharedGraphTextures(f.host)).toBeUndefined();
    expect(f.record().ok).toBe(true);
    const second = sharedFeatureGraphOutcome(f.world);
    expect(second?.ok && second.receipt.kind).toBe(path === 'replacement' ? 'compiled' : 'empty');
    expect(encodeSharedFeatureGraph(f.world, frameEncoder(f.world)).ok).toBe(true);
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    f.finish(true, completion);
    expect(retire).not.toHaveBeenCalled();
    resolve();
    await completion;
    await Promise.resolve();
    expect(retire).toHaveBeenCalledTimes(1);
    f.dispose();
  });
});

it('encodes the shared Feature graph in RenderRecord without a manual encode call', async () => {
  const f = await fixture(true);
  try {
    expect(f.record().ok).toBe(true);
    const { sharedFeatureGraphEncoded } = await import('../feature-graph-systems');
    expect(sharedFeatureGraphEncoded(f.world)).toBe(true);
    expect(f.submitted).not.toHaveBeenCalled();
    f.finish(true, Promise.resolve());
    expect(f.submitted).toHaveBeenCalledTimes(1);
    expect(f.aborted).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

it('does not encode or acknowledge routed scene inputs when their view stops before graph seal', async () => {
  const f = await fixture(true);
  try {
    const { ViewCaptureWork } = await import('../capture-systems');
    f.world
      .spawn({
        component: ViewCaptureWork,
        data: {
          state: f.world.allocUniqueRef('ViewCaptureWork', {
            frame: 1,
            outcome: {
              kind: 'prepared',
              value: { sceneInputs: [{}], cube: [], auxiliaryCameras: [], faces: [] },
            },
          }),
        },
      })
      .unwrap();
    expect(f.record().ok).toBe(true);
    const { sharedFeatureGraphEncoded, sharedFeatureSceneInputsPending } = await import(
      '../feature-graph-systems'
    );
    expect(sharedFeatureGraphEncoded(f.world)).toBe(false);
    expect(sharedFeatureSceneInputsPending(f.world)).toBe(true);
    f.finish(false, Promise.resolve());
    expect(f.submitted).not.toHaveBeenCalled();
    expect(f.aborted).toHaveBeenCalledTimes(1);
    expect(f.world.execution.health).toBe('healthy');
  } finally {
    f.dispose();
  }
});
