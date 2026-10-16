import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { Asset, MaterialAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
  type VfxGpuTickIntent,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { resolveFeatureWorkResources } from '../../../render/src/features/frame-plan';
import { renderFeaturePlanSignature } from '../../../render/src/features/plan';
import {
  createCameraProvider,
  createVfxRuntimeHost as createRuntimeHost,
  createSceneDepthProvider,
  PARTICLE_INPUT_SHADER_IDENTIFIERS,
  PARTICLE_SHADER_IDENTIFIERS,
} from '../index.js';
import {
  gpuParticleRenderFeature,
  planPasses,
  planResources,
  withVfxFrameSubmission,
} from './vfx-frame-fixture';

type VfxTickFixture = Omit<VfxGpuTickIntent, 'effect'>;

function createVfxRuntimeHost(options: Parameters<typeof createRuntimeHost>[0]) {
  const host = createRuntimeHost(options);
  withVfxFrameSubmission(host.feature);
  return host;
}

/** Keep legacy hand-authored fixtures executable on the one-cut Program v3 runtime. */
function asV3Effect(input: unknown): VfxGpuEffectAsset {
  type FixtureRecord = Record<string, unknown>;
  const value = input as FixtureRecord;
  const program = value.program as FixtureRecord;
  const emitters = (program.emitters as readonly FixtureRecord[]).map((emitter) => {
    const renderers = (emitter.renderers ?? []) as readonly FixtureRecord[];
    const reflection = emitter.reflection as FixtureRecord;
    return {
      ...emitter,
      reflection: {
        hooks: ['vfx_spawn', 'vfx_update'],
        imports: [],
        resources: reflection.resources ?? [],
        entryPoints: reflection.entryPoints ?? [],
        bindings: reflection.bindings ?? [],
        layout: reflection.layout ?? {
          version: 3,
          parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
          custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
          core: VFX_PARTICLE_CORE_LAYOUT,
          customLayout: {
            name: 'VfxCustom',
            fields: [],
            size: 0,
            alignment: 1,
            stride: 0,
            lanes: 0,
          },
          fingerprint: 'sha256:legacy-fixture-layout',
        },
        dataInterfaces: reflection.dataInterfaces ?? [],
        eventChannels: reflection.eventChannels ?? [],
        events: reflection.events ?? [],
        eventEntryPoint: 'forgeax_vfx_event_main',
        stages: reflection.stages ?? [],
        renderers: renderers.map((renderer) => ({
          topology: renderer.kind,
          resource: `${renderer.kind}Instances`,
          capacity: renderer.capacity ?? emitter.capacity,
          overflow: 'drop-newest',
          enabled: renderer.enabled !== false,
          shaderInputs: [],
          attributes: {},
          materialInputs: renderer.materialInputs ?? [],
          ...(renderer.materialInputDefinitions === undefined
            ? {}
            : { materialInputDefinitions: renderer.materialInputDefinitions }),
          ...(renderer.historyLength === undefined
            ? {}
            : { historyLength: renderer.historyLength }),
          ...(renderer.castShadows === undefined ? {} : { castShadows: renderer.castShadows }),
          ...(renderer.receiveShadows === undefined
            ? {}
            : { receiveShadows: renderer.receiveShadows }),
        })),
      },
    };
  });
  return {
    ...value,
    schemaVersion: 3,
    program: { ...program, format: 'forgeax-vfx-program-4', emitters },
  } as unknown as VfxGpuEffectAsset;
}

describe('GPU VFX public host', () => {
  it('owns loader and FixedUpdate attachment without exposing simulation internals', async () => {
    const world = new World();
    const registered: unknown[] = [];
    const assets = {
      loaders: { registerPackLoader: (loader: unknown) => registered.push(loader) },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({
      camera: {
        read: () => ({
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: new Float32Array(16),
        }),
      },
    });

    const attached = await host.attachWorld({ world, assets: assets as never });
    expect(attached).toMatchObject({ ok: true, value: { state: 'attached' } });
    expect(registered).toHaveLength(1);
    expect(host.feature.requiredMaterialShaders).toEqual([
      ...Object.values(PARTICLE_SHADER_IDENTIFIERS),
      'forgeax::vfx-render.particles.mesh-unlit',
      'forgeax::vfx-render.particles.mesh-inputs-unlit',
      ...Object.values(PARTICLE_INPUT_SHADER_IDENTIFIERS),
    ]);
    expect(await host.detachWorld({ world })).toMatchObject({
      ok: true,
      value: { state: 'detached' },
    });
  });

  it.each([
    false,
    true,
  ])('preserves the registry receiver and declared depth writes: %s', async (writesDepth) => {
    const world = new World();
    const lookups: string[] = [];
    class StatefulAssets {
      readonly material: MaterialAsset = {
        kind: 'material',
        passes: [
          {
            name: 'particle-billboard',
            program: { module: 'custom-depth' },
            renderState: { depthWriteEnabled: writesDepth },
          },
        ],
      };
      readonly loaders = { registerPackLoader: () => {} };

      lookup<T extends Asset = Asset>(guid: string): T | undefined {
        if (this !== assets) throw new Error('asset registry receiver was lost');
        lookups.push(guid);
        return guid === 'material-guid' ? (this.material as T) : undefined;
      }
    }
    const assets = new StatefulAssets();
    const host = createVfxRuntimeHost({
      camera: {
        read: () => ({
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        }),
      },
    });
    expect(await host.attachWorld({ world, assets })).toMatchObject({ ok: true });

    const intent = {
      player: world.spawn().unwrap(),
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      reset: true,
      channelInputs: [],
      emitter: {
        id: 'receiver-check',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// receiver check',
        reflection: {
          entryPoints: [
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_update_main',
            'forgeax_vfx_scan_blocks_main',
            'forgeax_vfx_scan_block_offsets_main',
            'forgeax_vfx_add_offsets_main',
            'forgeax_vfx_compact_main',
            'forgeax_vfx_billboard_main',
            'forgeax_vfx_mesh_main',
            'forgeax_vfx_ribbon_main',
            'forgeax_vfx_trail_history_main',
            'forgeax_vfx_trail_offsets_main',
            'forgeax_vfx_trail_main',
            'forgeax_vfx_beam_main',
          ],
          bindings: [],
        },
        renderers: [{ kind: 'billboard', material: 'material-guid' }],
      },
    } as unknown as VfxTickFixture;
    const planned = host.feature.plan(
      {
        worlds: [
          {
            world,
            runtime: {
              isEmitterSessionEnabled: () => true,
              setEmitterCameraVisibility: () => {},
              markEventDispatched: () => {},
              commit: () => {},
            },
            camera: {
              position: new Float32Array(3),
              right: new Float32Array([1, 0, 0]),
              up: new Float32Array([0, 1, 0]),
              viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            },
            intents: [intent],
          },
        ],
        frameNumber: 1,
      } as never,
      {
        targets: [
          { name: 'scene-color', kind: 'color', format: 'rgba8unorm-srgb', sampleCount: 1 },
          { name: 'scene-depth', kind: 'depth', format: 'depth24plus', sampleCount: 1 },
        ],
        caps: {},
        frame: { frameNumber: 1 },
        generation: 1,
        materialShaderBindingContract: () => ({
          bindings: 'group-0-resource',
          sceneDepth: writesDepth ? 'before-pass' : 'read-only',
        }),
      } as never,
    );
    expect(planned.ok).toBe(true);
    expect(lookups).toEqual(['material-guid']);
    if (planned.ok) {
      expect(
        planResources(planned.value).find((resource) => resource.kind === 'graphics-program'),
      ).toMatchObject({ program: { renderState: { depthWriteEnabled: writesDepth } } });
      expect(planPasses(planned.value).find((pass) => pass.kind === 'raster')).toMatchObject({
        sceneDepth: writesDepth ? 'before-pass' : 'read-only',
      });
      expect(
        planResources(planned.value).find((resource) => resource.kind === 'compute-program'),
      ).toMatchObject({
        program: {
          entryPoints: [
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_update_main',
            'forgeax_vfx_scan_blocks_main',
            'forgeax_vfx_compact_main',
            'forgeax_vfx_billboard_main',
          ],
        },
      });
      expect(planResources(planned.value)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'graphics-bindings',
            values: expect.objectContaining({ sceneDepthBinding: 0 }),
            logicalTargets: { sceneDepth: 'scene-depth' },
          }),
        ]),
      );
    }
    host.feature.onFrameSubmitted?.({ worlds: [], frameNumber: 1 } as never);
    expect(host.feature.inspect()).toMatchObject({
      frameNumber: 1,
      dispatches: expect.any(Number),
      indirectDraws: expect.any(Number),
      subjectOutputs: expect.any(Number),
    });
    expect(host.feature.inspect().dispatches).toBeGreaterThan(0);
    expect(host.feature.inspect().indirectDraws).toBeGreaterThan(0);
    expect(host.feature.inspect().subjectOutputs).toBeGreaterThan(0);
    const emptyPlan = host.feature.plan(
      { worlds: [], frameNumber: 2 } as never,
      {
        targets: [],
        caps: {},
        frame: { frameNumber: 2 },
        generation: 1,
        materialShaderBindingContract: () => ({
          bindings: 'group-0-resource',
          sceneDepth: 'read-only',
        }),
      } as never,
    );
    expect(emptyPlan).toMatchObject({
      ok: true,
      value: {
        work: [
          { scope: 'frame', passes: [] },
          { scope: { view: 'main' }, passes: [] },
        ],
      },
    });
    host.feature.onFrameSubmitted?.({ worlds: [], frameNumber: 2 } as never);
    expect(host.feature.inspect()).toEqual({
      frameNumber: 2,
      dispatches: 0,
      indirectDraws: 0,
      subjectOutputs: 0,
    });
    await host.detachWorld({ world });
  });

  it('fences preview controls to one attached host generation', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({ camera: { read: () => undefined } });
    expect(host.acquireControl(world)).toMatchObject({
      ok: false,
      error: { code: 'vfx-host-control-world-detached' },
    });

    expect(await host.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    const acquired = host.acquireControl(world);
    expect(acquired).toMatchObject({ ok: true, value: { generation: 1 } });
    if (!acquired.ok) throw new Error(acquired.error.code);
    const effect = world.allocSharedRef('ParticleEffectAsset', {} as never);
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();

    expect(
      acquired.value.setEmitterSessionEnabled({
        player,
        emitterId: 'sparks',
        enabled: false,
      }),
    ).toMatchObject({ ok: true, value: { state: 'disabled', generation: 1 } });
    expect(
      world
        .getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY)
        .isEmitterSessionEnabled(player, 'sparks'),
    ).toBe(false);
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: true,
      value: { state: 'queued', generation: 1 },
    });
    expect(acquired.value.setPlayerRenderConsumption({ player, enabled: false })).toMatchObject({
      ok: true,
      value: { state: 'paused', generation: 1 },
    });
    expect(acquired.value.setPlayerRenderConsumption({ player, enabled: true })).toMatchObject({
      ok: true,
      value: { state: 'enabled', generation: 1 },
    });

    world.despawn(player).unwrap();
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-host-control-player-unavailable',
        detail: { player, requestedGeneration: 1, currentGeneration: 1 },
      },
    });

    expect(await host.detachWorld({ world })).toMatchObject({ ok: true });
    expect(await host.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    expect(acquired.value.replay({ player })).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-host-control-stale-generation',
        detail: { requestedGeneration: 1, currentGeneration: 2 },
      },
    });
    expect(host.acquireControl(world)).toMatchObject({ ok: true, value: { generation: 2 } });
  });

  it('declares every pending emitter program in one feature plan', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const secondPlayer = world.spawn().unwrap();
    let committed = 0;
    let dispatchedEvents = 0;
    const intent = (
      id: string,
      owner: typeof player = player,
      renderers: VfxTickFixture['emitter']['renderers'] = [],
    ): VfxTickFixture => ({
      sequence: 1,
      player: owner,
      emitter: {
        id,
        module: `${id}.vfx.wgsl`,
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'local',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: `// ${id}`,
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_update_main',
            'forgeax_vfx_billboard_main',
            'forgeax_vfx_mesh_main',
            'forgeax_vfx_ribbon_main',
            'forgeax_vfx_trail_history_main',
            'forgeax_vfx_trail_offsets_main',
            'forgeax_vfx_trail_main',
            'forgeax_vfx_beam_main',
          ],
          bindings:
            renderers.length === 0
              ? []
              : [
                  {
                    entries: [0, 1, 2, 3, 4, 5, 6, 8, 9].map((binding) => ({
                      binding,
                      visibility: 4,
                      buffer: { type: binding === 1 ? 'uniform' : 'storage' },
                    })),
                  },
                ],
        } as never,
        renderers,
      },
      programFingerprint: id,
      reset: true,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: 0,
      tick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: 0,
        generation: 0,
        sequence: 1,
        fingerprint: id,
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const feature = gpuParticleRenderFeature({ camera: { read: () => undefined } });
    const runtime = {
      isEmitterSessionEnabled: () => true,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {
        dispatchedEvents += 1;
      },
      commit: () => {
        committed += 1;
      },
    };
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const planned = feature.plan(
      {
        worlds: [
          {
            world,
            runtime,
            camera,
            intents: [
              intent('first'),
              intent('second', secondPlayer),
              { ...intent('first'), reset: false, sequence: 3 },
            ],
          },
        ],
        frameNumber: 1,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      planResources(planned.value)
        .filter((resource) => resource.kind === 'compute-program')
        .map((resource) => resource.name),
    ).toEqual([
      expect.stringContaining(`.p-${Number(player).toString(36)}.e-0.`),
      expect.stringContaining(`.p-${Number(secondPlayer).toString(36)}.e-1.`),
    ]);
    expect(
      planResources(planned.value)
        .filter((resource) => resource.kind === 'compute-program')
        .map((resource) => resource.program.entryPoints),
    ).toEqual([
      ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_main'],
      ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_main'],
    ]);
    expect(
      planPasses(planned.value).filter(
        (pass) => pass.kind === 'compute' && pass.name.includes('.e-0.tick-'),
      ),
    ).toHaveLength(2);
    expect(committed).toBe(0);
    expect(dispatchedEvents).toBe(0);
    feature.onFrameSubmitted?.({
      worlds: [
        {
          world,
          runtime,
          camera,
          intents: [],
        },
      ],
      frameNumber: 1,
    } as never);
    // Submission consumes the ledger captured by plan, not the declarative
    // plan call itself.  The runtime is committed once and all three queued
    // ticks have their event counters acknowledged.
    expect(committed).toBe(1);
    expect(dispatchedEvents).toBe(3);

    const warm = feature.plan(
      {
        worlds: [
          { world, runtime, camera, intents: [{ ...intent('first'), reset: false, sequence: 4 }] },
        ],
        frameNumber: 2,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 2 }, generation: 1 } as never,
    );
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(
      planResources(warm.value).some(
        (resource) => resource.kind === 'compute-program' && resource.name.includes('.e-0.'),
      ),
    ).toBe(true);
    const warmParticles = planResources(warm.value).find(
      (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
    );
    expect(warmParticles).toBeDefined();
    expect(warmParticles).not.toHaveProperty('data');
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 2 } as never);

    const reset = feature.plan(
      {
        worlds: [
          { world, runtime, camera, intents: [{ ...intent('first'), reset: true, sequence: 5 }] },
        ],
        frameNumber: 3,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 3 }, generation: 1 } as never,
    );
    expect(reset.ok).toBe(true);
    if (reset.ok)
      expect(
        planResources(reset.value).some(
          (resource) => resource.kind === 'compute-program' && resource.name.includes('.e-0.'),
        ),
      ).toBe(true);
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 3 } as never);

    const projectedFirst = feature.plan(
      {
        worlds: [
          {
            world,
            runtime,
            camera,
            intents: [
              intent('projected', player, [{ kind: 'billboard', material: 'particle-material' }]),
            ],
          },
        ],
        frameNumber: 4,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 4 }, generation: 1 } as never,
    );
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 4 } as never);
    const projectedSecond = feature.plan(
      {
        worlds: [
          {
            world,
            runtime,
            camera,
            intents: [
              {
                ...intent('projected', player, [
                  { kind: 'billboard', material: 'particle-material' },
                ]),
                reset: false,
                sequence: 2,
              },
              {
                ...intent('projected', player, [
                  { kind: 'billboard', material: 'particle-material' },
                ]),
                reset: false,
                sequence: 3,
              },
            ],
          },
        ],
        frameNumber: 5,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 5 }, generation: 1 } as never,
    );
    expect(projectedFirst.ok).toBe(true);
    expect(projectedSecond.ok).toBe(true);
    if (projectedFirst.ok && projectedSecond.ok) {
      const projectionBinding = (plan: typeof projectedFirst.value) =>
        planResources(plan).find(
          (resource) =>
            resource.kind === 'compute-bindings' &&
            resource.name.endsWith('.renderer-0.compute-bindings'),
        );
      const firstBinding = projectionBinding(projectedFirst.value);
      const secondBinding = projectionBinding(projectedSecond.value);
      expect(firstBinding).toBeDefined();
      expect(secondBinding).toBeDefined();
      if (firstBinding?.kind === 'compute-bindings' && secondBinding?.kind === 'compute-bindings') {
        expect(firstBinding.entries).toEqual(secondBinding.entries);
        expect(firstBinding.entries.find((entry) => entry.binding === 8)?.resource).toContain(
          '.projection-event-inputs',
        );
      }
    }
  });

  it('keeps masked bindings warm and sends effect-relative time to WGSL', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const intent = (tick: number): VfxTickFixture => ({
      sequence: tick + 1,
      player,
      emitter: {
        id: 'masked',
        module: 'masked.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'local',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// masked',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        } as never,
        renderers: [],
      },
      programFingerprint: 'masked-program',
      reset: tick === 0,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: tick + 7,
      tick,
      seed: 1,
      playCycle: 0,
      spawnCount: tick === 0 ? 1 : 0,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick,
        generation: 0,
        sequence: tick + 1,
        fingerprint: 'masked-program',
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    let sessionEnabled = true;
    const runtime = {
      isEmitterSessionEnabled: () => sessionEnabled,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: () => {},
    };
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array(16),
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const context = { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never;
    const frame = (intents: readonly VfxTickFixture[], frameNumber: number) =>
      ({
        worlds: [{ world, runtime, camera, intents }],
        frameNumber,
      }) as never;

    const active = feature.plan(frame([intent(0)], 1), context);
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const runtimeWrite = planResources(active.value).find(
      (resource) => resource.kind === 'buffer' && resource.name.endsWith('.runtime'),
    );
    expect(runtimeWrite?.kind === 'buffer' ? runtimeWrite.data : undefined).toBeInstanceOf(
      Uint8Array,
    );
    const runtimeBytes = runtimeWrite?.kind === 'buffer' ? runtimeWrite.data : undefined;
    expect(new Uint32Array((runtimeBytes as Uint8Array).buffer)[1]).toBe(7);
    sessionEnabled = false;
    const masked = feature.plan(frame([intent(1)], 2), context);
    expect(masked).toMatchObject({
      ok: true,
      value: {
        work: [
          { scope: 'frame', resources: [], passes: [] },
          { scope: { view: 'main' }, resources: [], passes: [] },
        ],
      },
    });
    sessionEnabled = true;
    const resumed = feature.plan(frame([intent(2)], 3), context);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(planResources(resumed.value).length).toBeGreaterThan(0);
  });

  it('acknowledges a skipped head and keeps a reset resource identity across retry', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const commits: number[] = [];
    let dispatched = 0;
    const makeIntent = (id: string, sequence: number, reset: boolean): VfxTickFixture => ({
      sequence,
      player,
      emitter: {
        id,
        module: `${id}.vfx.wgsl`,
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: `// ${id}`,
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        } as never,
        renderers: [],
      },
      programFingerprint: `${id}-program`,
      reset,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: sequence,
      tick: sequence,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: sequence,
        generation: 0,
        sequence,
        fingerprint: `${id}-program`,
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const runtime = {
      renderGeneration: 1,
      isEmitterSessionEnabled: (_player: number, emitterId: string) => emitterId !== 'masked',
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {
        dispatched += 1;
      },
      commit: (sequence: number) => {
        commits.push(sequence);
      },
    };
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const frame = (frameNumber: number) =>
      ({
        worlds: [
          {
            world,
            runtime,
            camera,
            intents: [makeIntent('masked', 1, false), makeIntent('visible', 2, true)],
          },
        ],
        frameNumber,
      }) as never;
    const context = { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never;
    const first = feature.plan(frame(1), context);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstProgram = planResources(first.value).find(
      (resource) => resource.kind === 'compute-program',
    );
    expect(firstProgram?.name).toContain('.e-0.');
    feature.onFrameAborted?.(frame(1));

    const retry = feature.plan(frame(1), context);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const retryProgram = planResources(retry.value).find(
      (resource) => resource.kind === 'compute-program',
    );
    expect(retryProgram?.name).toBe(firstProgram?.name);
    feature.onFrameSubmitted?.(frame(1));
    expect(commits).toEqual([[1, 2]]);
    expect(dispatched).toBe(1);
  });

  it('keeps resets ordered through retry and isolates storage by World', () => {
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const makeIntent = (
      player: VfxTickFixture['player'],
      id: string,
      sequence: number,
      reset: boolean,
      requiresDataInterface = false,
    ): VfxTickFixture => ({
      sequence,
      player,
      emitter: {
        id,
        module: `${id}.vfx.wgsl`,
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: `// ${id}`,
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
          ...(requiresDataInterface
            ? {
                dataInterfaces: [
                  {
                    token: 'vfx:camera',
                    kind: 'camera' as const,
                    binding: 0,
                    bindingType: 'uniform' as const,
                    lifetime: 'generation' as const,
                  },
                ],
              }
            : {}),
        } as never,
        renderers: [],
      },
      programFingerprint: `${id}-program`,
      reset,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: sequence,
      tick: sequence,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: sequence,
        generation: 0,
        sequence,
        fingerprint: `${id}-program`,
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const makeRuntime = () => {
      let enabled = true;
      const commits: number[] = [];
      return {
        get enabled() {
          return enabled;
        },
        set enabled(value: boolean) {
          enabled = value;
        },
        renderGeneration: 1,
        isEmitterSessionEnabled: () => enabled,
        setEmitterCameraVisibility: () => {},
        markEventDispatched: () => {},
        commit: (sequence: number) => commits.push(sequence),
        commits,
      };
    };
    const world = new World();
    const otherWorld = new World();
    const player = world.spawn().unwrap();
    const otherPlayer = otherWorld.spawn().unwrap();
    const runtime = makeRuntime();
    const otherRuntime = makeRuntime();
    let dataReady = false;
    const feature = gpuParticleRenderFeature({
      camera: { read: () => camera },
      dataInterfaces: {
        resolve: () =>
          dataReady ? ({ ok: true, value: { resources: [] } } as never) : ({ ok: false } as never),
      },
    });
    const context = { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never;
    const frame = (
      frameNumber: number,
      entries: readonly { world: World; runtime: typeof runtime; intents: VfxTickFixture[] }[],
    ) =>
      ({
        worlds: entries.map((entry) => ({ ...entry, camera })),
        frameNumber,
      }) as never;

    const first = feature.plan(
      frame(1, [
        {
          world,
          runtime,
          intents: [
            makeIntent(player, 'ordered', 1, false),
            makeIntent(player, 'ordered', 2, true),
          ],
        },
      ]),
      context,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const programNames = planResources(first.value)
      .filter((resource) => resource.kind === 'compute-program')
      .map((resource) => resource.name);
    expect(programNames).toEqual([expect.stringContaining('.e-0.compute-program')]);
    expect(planPasses(first.value).map((pass) => pass.name)).toEqual([
      expect.stringContaining('.tick-0.simulate'),
      expect.stringContaining('.tick-1.reset'),
      expect.stringContaining('.tick-1.simulate'),
    ]);
    const resetParticles = planResources(first.value).find(
      (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
    );
    expect(resetParticles).not.toHaveProperty('data');
    feature.onFrameAborted?.(frame(1, [{ world, runtime, intents: [] }]));

    const retry = feature.plan(
      frame(1, [
        {
          world,
          runtime,
          intents: [
            makeIntent(player, 'ordered', 1, false),
            makeIntent(player, 'ordered', 2, true),
          ],
        },
      ]),
      context,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(
      planResources(retry.value)
        .filter((resource) => resource.kind === 'compute-program')
        .map((resource) => resource.name),
    ).toEqual(programNames);
    const retryResetParticles = planResources(retry.value).find(
      (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
    );
    expect(retryResetParticles).not.toHaveProperty('data');
    expect(planPasses(retry.value)).toEqual(planPasses(first.value));
    feature.onFrameSubmitted?.(frame(1, [{ world, runtime, intents: [] }]));
    expect(runtime.commits).toEqual([[1, 2]]);

    // A reset blocked by render consumption must stay deferred.  It must not
    // clear accepted storage or leak a fake GPU state into a later tick.
    runtime.enabled = false;
    const skipped = feature.plan(
      frame(2, [{ world, runtime, intents: [makeIntent(player, 'ordered', 3, true)] }]),
      context,
    );
    expect(skipped).toMatchObject({
      ok: true,
      value: {
        work: [
          { scope: 'frame', resources: [], passes: [] },
          { scope: { view: 'main' }, resources: [], passes: [] },
        ],
      },
    });
    feature.onFrameSubmitted?.(frame(2, [{ world, runtime, intents: [] }]));
    expect(runtime.commits).toEqual([[1, 2]]);
    runtime.enabled = true;
    const afterSkipped = feature.plan(
      frame(3, [{ world, runtime, intents: [makeIntent(player, 'ordered', 4, false)] }]),
      context,
    );
    expect(afterSkipped.ok).toBe(true);
    if (!afterSkipped.ok) return;
    expect(
      planResources(afterSkipped.value).some(
        (resource) => resource.kind === 'compute-program' && resource.name.includes('.e-0.'),
      ),
    ).toBe(true);
    feature.onFrameSubmitted?.(frame(3, [{ world, runtime, intents: [] }]));

    // Two deferred resets reuse storage but each initializes in command order
    // when the provider becomes available.
    const deferredIntents = [
      makeIntent(player, 'ordered', 5, true, true),
      makeIntent(player, 'ordered', 6, true, true),
    ];
    const deferred = feature.plan(
      frame(4, [{ world, runtime, intents: deferredIntents }]),
      context,
    );
    expect(deferred).toMatchObject({
      ok: true,
      value: {
        work: [
          { scope: 'frame', resources: [], passes: [] },
          { scope: { view: 'main' }, resources: [], passes: [] },
        ],
      },
    });
    feature.onFrameSubmitted?.(frame(4, [{ world, runtime, intents: [] }]));
    dataReady = true;
    const resumedDeferred = feature.plan(
      frame(5, [{ world, runtime, intents: deferredIntents }]),
      context,
    );
    expect(resumedDeferred.ok).toBe(true);
    if (!resumedDeferred.ok) return;
    const deferredPrograms = planResources(resumedDeferred.value)
      .filter((resource) => resource.kind === 'compute-program')
      .map((resource) => resource.name);
    expect(deferredPrograms).toEqual(programNames);
    expect(planPasses(resumedDeferred.value).map((pass) => pass.name)).toEqual([
      expect.stringContaining('.tick-0.reset'),
      expect.stringContaining('.tick-0.simulate'),
      expect.stringContaining('.tick-1.reset'),
      expect.stringContaining('.tick-1.simulate'),
    ]);
    expect(
      planResources(resumedDeferred.value).filter(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
      ),
    ).toEqual([expect.objectContaining({ name: resetParticles?.name })]);
    feature.onFrameSubmitted?.(frame(5, [{ world, runtime, intents: [] }]));

    // The other World starts at the same local sequence with independent storage.
    const other = feature.plan(
      frame(4, [
        {
          world: otherWorld,
          runtime: otherRuntime,
          intents: [makeIntent(otherPlayer, 'ordered', 1, true)],
        },
      ]),
      context,
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const otherProgram = planResources(other.value).find(
      (resource) => resource.kind === 'compute-program',
    );
    expect(otherProgram).toBeDefined();
    expect(otherProgram?.name).not.toBe(programNames[0]);

    // Detaching and reattaching the same World creates a new runtime
    // incarnation.  Its first reset may reuse the local player/emitter IDs,
    // but its GPU resource identity must not collide with the old attachment.
    const replacementRuntime = makeRuntime();
    const replacement = feature.plan(
      frame(6, [
        {
          world,
          runtime: replacementRuntime,
          intents: [makeIntent(player, 'ordered', 1, true)],
        },
      ]),
      context,
    );
    expect(replacement.ok).toBe(true);
    if (replacement.ok) {
      const replacementProgram = planResources(replacement.value).find(
        (resource) => resource.kind === 'compute-program',
      );
      expect(replacementProgram?.name).toContain('.compute-program');
      expect(replacementProgram?.name).not.toBe(programNames[0]);
    }
  });

  it('defers a reset while player render consumption is paused', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const intent: VfxTickFixture = {
      sequence: 1,
      player,
      emitter: {
        id: 'paused-reset',
        module: 'paused-reset.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 1, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// paused reset',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        } as never,
        renderers: [],
      },
      programFingerprint: 'paused-reset-program',
      reset: true,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: 0,
      tick: 1,
      seed: 2,
      playCycle: 1,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 2,
        tick: 1,
        generation: 0,
        sequence: 1,
        fingerprint: 'paused-reset-program',
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    };
    let consumptionEnabled = false;
    const commits: { readonly sequence: number; readonly published: readonly number[] }[] = [];
    const runtime = {
      renderGeneration: 1,
      isEmitterSessionEnabled: () => true,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: (sequence: number, published: readonly number[] = []) =>
        commits.push({ sequence, published }),
    };
    const feature = gpuParticleRenderFeature({
      camera: { read: () => camera },
      playerConsumption: { isEnabled: () => consumptionEnabled },
    });
    const frame = (frameNumber: number) =>
      ({ worlds: [{ world, runtime, camera, intents: [intent] }], frameNumber }) as never;

    const paused = feature.plan(frame(1), {
      targets: [],
      caps: {},
      frame: { frameNumber: 1 },
      generation: 1,
    } as never);
    expect(paused?.ok).toBe(true);
    if (paused?.ok) {
      expect(planPasses(paused.value)).toHaveLength(0);
      expect(paused.value.work.find((work) => work.scope === 'frame')?.passes).toEqual([]);
    }
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 1 } as never);
    expect(commits).toEqual([]);

    consumptionEnabled = true;
    const resumed = feature.plan(frame(2), {
      targets: [],
      caps: {},
      frame: { frameNumber: 2 },
      generation: 1,
    } as never);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(
        planResources(resumed.value).some((resource) => resource.kind === 'compute-program'),
      ).toBe(true);
    }
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 2 } as never);
    expect(commits).toEqual([{ sequence: [1], published: [1] }]);
  });

  it('keeps a paused reset barrier local to its player stream', () => {
    const world = new World();
    const pausedPlayer = world.spawn().unwrap();
    const healthyPlayer = world.spawn().unwrap();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const intent = (
      player: VfxTickFixture['player'],
      id: string,
      sequence: number,
      reset: boolean,
    ): VfxTickFixture => ({
      sequence,
      player,
      emitter: {
        id,
        module: `${id}.vfx.wgsl`,
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: `// ${id}`,
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
        } as never,
        renderers: [],
      },
      programFingerprint: id,
      reset,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: sequence,
      tick: sequence,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: sequence,
        generation: 0,
        sequence,
        fingerprint: id,
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const runtime = {
      renderGeneration: 0,
      isEmitterSessionEnabled: () => true,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: () => {},
    };
    const feature = gpuParticleRenderFeature({
      camera: { read: () => camera },
      playerConsumption: {
        isEnabled: (_world, player) => player !== pausedPlayer,
      },
    });
    const planned = feature.plan(
      {
        worlds: [
          {
            world,
            runtime,
            camera,
            intents: [
              intent(pausedPlayer, 'paused', 1, true),
              intent(healthyPlayer, 'healthy', 2, true),
            ],
          },
        ],
        frameNumber: 1,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const computePrograms = planResources(planned.value)
      .filter((resource) => resource.kind === 'compute-program')
      .map((resource) => resource.name);
    expect(computePrograms).toEqual([
      expect.stringContaining(`.p-${Number(healthyPlayer).toString(36)}.e-`),
    ]);
    expect(
      planPasses(planned.value).some(
        (pass) =>
          pass.name.includes(`.p-${Number(healthyPlayer).toString(36)}.e-`) &&
          pass.name.includes('.tick-0'),
      ),
    ).toBe(true);
    expect(
      planPasses(planned.value).some(
        (pass) =>
          pass.name.includes(`.p-${Number(pausedPlayer).toString(36)}.e-`) &&
          pass.name.includes('.tick-0'),
      ),
    ).toBe(false);
  });

  it('preserves a seed reset across a paused real runtime', async () => {
    const world = new World();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const effect = {
      guid: 'paused-seed-reset',
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: 'sha256:paused-seed-reset',
      emitters: [{ id: 'reset', capacity: 4 }],
      program: {
        format: 'forgeax-vfx-program-2',
        fingerprint: 'sha256:paused-seed-reset',
        emitters: [
          {
            id: 'reset',
            module: 'paused-seed-reset.vfx.wgsl',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            simulationWhenCulled: 'continue',
            schedule: { rate: 1, bursts: [{ time: 0, count: 1 }] },
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
            wgsl: '// paused seed reset',
            reflection: {
              hooks: ['vfx_spawn', 'vfx_update'],
              imports: [],
              resources: [],
              entryPoints: ['forgeax_vfx_spawn_main'],
              bindings: [],
            },
            renderers: [],
          },
        ],
      },
    } as unknown;
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({ camera: { read: () => camera } });
    expect(await host.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    const handle = world.allocSharedRef('ParticleEffectAsset', asV3Effect(effect));
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const extract = (frameNumber: number) => {
      const result = host.feature.extract?.({ worlds: [world], frameNumber } as never);
      expect(result?.ok).toBe(true);
      if (result === undefined || !result.ok) throw new Error('VFX extraction failed');
      return result.value;
    };
    const plan = (frameNumber: number) =>
      host.feature.plan?.(extract(frameNumber), {
        targets: [],
        caps: {},
        frame: { frameNumber },
        generation: 1,
      } as never);
    const submit = (frameNumber: number) =>
      host.feature.onFrameSubmitted?.({ worlds: [], frameNumber } as never);

    world.update(1 / 60).unwrap();
    const first = plan(1);
    expect(first?.ok).toBe(true);
    submit(1);
    const firstCommitted = runtime.lastCommittedEmitter(player, 'reset');
    expect(firstCommitted).toMatchObject({ seed: 1, reset: true, phaseTick: 0 });

    const control = host.acquireControl(world).unwrap();
    control.setPlayerRenderConsumption({ player, enabled: false }).unwrap();
    world.set(player, ParticleEffectPlayer, { seed: 2 }).unwrap();
    world.update(1 / 60).unwrap();
    const paused = plan(2);
    expect(paused?.ok).toBe(true);
    if (paused?.ok) {
      expect(planPasses(paused.value)).toHaveLength(0);
      expect(paused.value.work.find((work) => work.scope === 'frame')?.passes).toEqual([
        expect.objectContaining({ name: expect.stringMatching(/\.reset$/), enabled: false }),
        expect.objectContaining({
          name: expect.stringMatching(/\.simulate$/),
          enabled: false,
        }),
      ]);
    }
    submit(2);
    expect(runtime.lastCommittedEmitter(player, 'reset')).toBe(firstCommitted);
    expect(runtime.snapshot()[0]).toMatchObject({ seed: 2, reset: true, phaseTick: 0 });

    control.setPlayerRenderConsumption({ player, enabled: true }).unwrap();
    const resumed = plan(3);
    expect(resumed?.ok).toBe(true);
    submit(3);
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.lastCommittedEmitter(player, 'reset')).toMatchObject({
      seed: 2,
      reset: true,
      phaseTick: 0,
    });
    await host.detachWorld({ world });
  });

  it('writes trail history once per fixed tick before the final projection', () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const renderer = {
      kind: 'trail' as const,
      material: 'trail-material',
      historyLength: 4,
      capacity: 2,
      width: 0.1,
    };
    const disabledRenderer = { ...renderer, enabled: false as const };
    const intent = (sequence: number, reset: boolean): VfxTickFixture => ({
      sequence,
      player,
      emitter: {
        id: 'trail',
        module: 'trail.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 0, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// trail',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_trail_history_main',
            'forgeax_vfx_trail_main',
          ],
          bindings: [
            {
              entries: [0, 1, 2, 3, 4, 5, 6, 8, 9].map((binding) => ({
                binding,
                visibility: 4,
                buffer: { type: binding === 1 ? 'uniform' : 'storage' },
              })),
            },
          ],
        } as never,
        renderers: [renderer, disabledRenderer],
      },
      programFingerprint: 'trail-program',
      reset,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: sequence,
      tick: sequence,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      instancePatchCount: 0,
      parameterBlock: new Uint8Array(),
      canonicalPayload: new Uint8Array(),
      replayInput: {
        seed: 1,
        tick: sequence,
        generation: 0,
        sequence,
        fingerprint: 'trail-program',
        payload: new Uint8Array(),
        values: {},
        channelInputs: [],
        droppedCount: 0,
      },
      channelInputs: [],
      eventCounters: {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      },
    });
    const runtime = {
      renderGeneration: 1,
      isEmitterSessionEnabled: () => true,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: () => {},
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const planned = feature.plan(
      {
        worlds: [{ world, runtime, camera, intents: [intent(1, true), intent(2, false)] }],
        frameNumber: 1,
      } as never,
      { targets: [], caps: {}, frame: { frameNumber: 1 }, generation: 1 } as never,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const historyPasses = planPasses(planned.value).filter(
      (pass) => pass.kind === 'compute' && pass.name.endsWith('.history-bindings.write'),
    );
    expect(historyPasses).toHaveLength(2);
    expect(
      planResources(planned.value).find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.renderer-0.history'),
      ),
    ).toMatchObject({ size: 4 * (4 + 1) * 16 });
    expect(
      planResources(planned.value).some(
        (resource) => resource.kind === 'buffer' && resource.name.includes('.renderer-1.history'),
      ),
    ).toBe(false);
    expect(
      planPasses(planned.value).findIndex((pass) => pass.name.includes('.tick-0.simulate')),
    ).toBeLessThan(
      planPasses(planned.value).findIndex((pass) =>
        pass.name.includes('.tick-0.renderer-0.history-bindings.write'),
      ),
    );
    expect(
      planPasses(planned.value).findIndex((pass) =>
        pass.name.includes('.tick-0.renderer-0.history-bindings.write'),
      ),
    ).toBeLessThan(
      planPasses(planned.value).findIndex((pass) => pass.name.includes('.tick-1.simulate')),
    );
    expect(historyPasses.map((pass) => pass.name)).toEqual([
      expect.stringContaining('.tick-0.renderer-0.history-bindings.write'),
      expect.stringContaining('.tick-1.renderer-0.history-bindings.write'),
    ]);
  });

  it('rejects a second host without replacing the first World runtime', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const options = {
      camera: {
        read: () => undefined,
      },
    };
    const first = createVfxRuntimeHost(options);
    const second = createVfxRuntimeHost(options);
    expect(await first.attachWorld({ world, assets: assets as never })).toMatchObject({ ok: true });
    expect(await second.attachWorld({ world, assets: assets as never })).toMatchObject({
      ok: false,
      error: { code: 'vfx-host-world-attach-failed' },
    });
    expect(await first.detachWorld({ world })).toMatchObject({ ok: true });
  });

  it('keeps depth readiness on the host contract for a real renderer frame', () => {
    const host = createVfxRuntimeHost({
      camera: { read: () => undefined },
      providers: [
        createCameraProvider({ available: () => true }),
        createSceneDepthProvider({
          available: () => true,
          sampleCount: 1,
          resource: () => ({ kind: 'texture-view', value: {} }),
        }),
      ],
    });
    const result = host.resolveDataInterfaces({
      requirements: [
        {
          token: 'vfx:scene-depth',
          kind: 'scene-depth',
          binding: 9,
          bindingType: 'sampled-depth',
          lifetime: 'generation',
        },
      ],
      generation: 1,
    });
    expect(result).toMatchObject({ ok: true, value: { readiness: 'ready' } });
  });

  it('refreshes a paused emitter after the camera re-enters without a queued tick', async () => {
    const world = new World();
    const viewProjection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection,
    };
    const effect = {
      guid: 'culling-effect',
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: 'sha256:culling',
      emitters: [{ id: 'paused', capacity: 4 }],
      program: {
        format: 'forgeax-vfx-program-2',
        fingerprint: 'sha256:culling',
        emitters: [
          {
            id: 'paused',
            module: 'paused.vfx.wgsl',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            simulationWhenCulled: 'pause',
            schedule: { rate: 1, bursts: [] },
            bounds: { kind: 'sphere', center: [10, 0, 0], radius: 0.25 },
            wgsl: '// paused',
            reflection: {
              hooks: ['vfx_spawn', 'vfx_update'],
              imports: [],
              resources: [],
              entryPoints: ['forgeax_vfx_spawn_main'],
              bindings: [],
            },
            renderers: [],
          },
        ],
      },
    } as unknown;
    const handle = world.allocSharedRef('ParticleEffectAsset', asV3Effect(effect));
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 3, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const extract = (frameNumber: number) => {
      const result = feature.extract?.({ worlds: [world], frameNumber } as never);
      expect(result?.ok).toBe(true);
      if (result === undefined || !result.ok) throw new Error('VFX extraction failed');
      return result.value;
    };
    const plan = (frameNumber: number) =>
      feature.plan?.(extract(frameNumber), {
        targets: [],
        caps: {},
        frame: { frameNumber },
        generation: 1,
      } as never);

    world.update(1 / 60).unwrap();
    const hidden = plan(1);
    expect(hidden).toMatchObject({
      ok: true,
      value: {
        work: [
          { scope: 'frame', resources: [], passes: [] },
          { scope: { view: 'main' }, resources: [], passes: [] },
        ],
      },
    });
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 1 } as never);
    // The reset was discovered after FixedUpdate while the emitter was
    // culled, so it remains queued rather than being acknowledged as a fake
    // GPU state.
    expect(runtime.snapshot().length).toBeGreaterThan(0);

    viewProjection[12] = -10;
    const visibleWithoutTick = extract(2);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({ cameraVisible: false });
    // Extraction cannot update source visibility from an authored aspect.
    // The submitted Renderer view feedback is the sole visibility authority.
    // The reset discovered while hidden remains queued until this re-entry;
    // visibility refresh must not consume it as a skipped state.
    expect(visibleWithoutTick.worlds[0]?.intents.length).toBeGreaterThan(0);
    const reentry = plan(2);
    expect(reentry?.ok).toBe(true);
    feature.onFrameSubmitted?.({ worlds: [], frameNumber: 2 } as never);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({ cameraVisible: true });
    world.update(1 / 60).unwrap();
    const resumed = plan(3);
    expect(resumed?.ok).toBe(true);
    if (resumed?.ok) expect(planPasses(resumed.value).length).toBeGreaterThan(0);
  });

  it('keeps resource topology but preserves ordered draws when queued and retained emitters exchange positions', async () => {
    const world = new World();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const emitters = ['first', 'second'].map((id) => ({
      id,
      capacity: 4,
      backend: { required: 'gpu' },
      space: 'world',
      simulationWhenCulled: 'continue',
      schedule: { rate: 1, bursts: [] },
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 0.25 },
      wgsl: `// ${id}`,
      reflection: {
        entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_billboard_main'],
        bindings: [],
      },
      renderers: [{ kind: 'billboard', material: 'material' }],
    }));
    const effect = asV3Effect({
      guid: 'alternating-effect',
      kind: 'particle-effect',
      programFingerprint: 'sha256:alternating',
      emitters: emitters.map(({ id, capacity }) => ({ id, capacity })),
      program: { fingerprint: 'sha256:alternating', emitters },
    });
    const handle = world.allocSharedRef('ParticleEffectAsset', effect);
    world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle, playing: true } })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const extract = (frameNumber: number) =>
      feature.extract({ worlds: [world], frameNumber } as never).unwrap();
    const plan = (frame: ReturnType<typeof extract>) =>
      feature
        .plan(frame, {
          targets: [],
          caps: {},
          frame: { frameNumber: frame.frameNumber },
          generation: 1,
        } as never)
        .unwrap();
    world.update(1 / 60).unwrap();
    const initial = extract(1);
    plan(initial);
    feature.onFrameSubmitted?.(initial);
    world.update(1 / 60).unwrap();
    const next = extract(2);
    expect(next.worlds[0]?.retained).toHaveLength(2);
    const queued = (emitter: string, frameNumber: number) =>
      plan({
        ...next,
        frameNumber,
        worlds: next.worlds.map((entry) => ({
          ...entry,
          intents: entry.intents.filter((intent) => intent.emitter.id === emitter),
        })),
      });
    const first = queued('first', 2);
    const second = queued('second', 3);
    const views = (result: typeof first) =>
      resolveFeatureWorkResources(result.work)
        .filter((row) => row.work.scope !== 'frame')
        .map((row) => renderFeaturePlanSignature(row.closure));
    expect(views(first)).not.toEqual(views(second));
    const viewResources = (result: typeof first) =>
      resolveFeatureWorkResources(result.work)
        .filter((row) => row.work.scope !== 'frame')
        .map((row) => renderFeaturePlanSignature({ resources: row.closure.resources, passes: [] }));
    expect(viewResources(first)).toEqual(viewResources(second));
    const rasterNames = (result: typeof first) =>
      planPasses(result)
        .filter((pass) => pass.kind === 'raster')
        .flatMap((pass) => pass.draws.map((draw) => draw.program));
    expect(rasterNames(second)).toEqual([...rasterNames(first)].reverse());
    expect(planPasses(first).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(1);
    expect(planPasses(second).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(1);
    expect(planPasses(first).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    expect(planPasses(second).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    const replay = queued('first', 4);
    expect(views(replay)).toEqual(views(first));
    feature.onFrameAborted?.({ ...next, frameNumber: 2 });
    feature.onFrameAborted?.({ ...next, frameNumber: 3 });
    feature.onFrameAborted?.({ ...next, frameNumber: 4 });
  });

  it('retains committed particles for render frames without a fixed tick', async () => {
    const world = new World();
    const viewProjection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection,
    };
    const effect = {
      guid: 'retained-effect',
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: 'sha256:retained',
      emitters: [{ id: 'retained', capacity: 4 }],
      program: {
        format: 'forgeax-vfx-program-2',
        fingerprint: 'sha256:retained',
        emitters: [
          {
            id: 'retained',
            module: 'retained.vfx.wgsl',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            simulationWhenCulled: 'pause',
            schedule: { rate: 1, bursts: [] },
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 0.25 },
            wgsl: '// retained',
            reflection: {
              hooks: ['vfx_spawn', 'vfx_update'],
              imports: [],
              resources: [],
              entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_billboard_main'],
              bindings: [],
            },
            renderers: [{ kind: 'billboard', material: 'retained-material' }],
          },
        ],
      },
    } as unknown;
    const handle = world.allocSharedRef('ParticleEffectAsset', asV3Effect(effect));
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 7, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    const extract = (frameNumber: number) => {
      const result = feature.extract?.({ worlds: [world], frameNumber } as never);
      expect(result?.ok).toBe(true);
      if (result === undefined || !result.ok) throw new Error('VFX extraction failed');
      return result.value;
    };
    const plan = (frameNumber: number) =>
      feature.plan?.(extract(frameNumber), {
        targets: [],
        caps: {},
        frame: { frameNumber },
        generation: 1,
      } as never);
    const submit = (frameNumber: number) =>
      feature.onFrameSubmitted?.({ worlds: [], frameNumber } as never);

    world.update(1 / 60).unwrap();
    const first = plan(1);
    expect(first?.ok).toBe(true);
    if (first?.ok) {
      expect(planPasses(first.value).some((pass) => pass.name.endsWith('.raster'))).toBe(true);
      expect(planPasses(first.value).some((pass) => pass.name.endsWith('.simulate'))).toBe(true);
    }
    submit(1);
    expect(runtime.snapshot()).toHaveLength(0);

    // A render-only frame has no new FixedUpdate intent, but the committed
    // particle buffer must still be projected and drawn.
    const retained = plan(2);
    expect(retained?.ok).toBe(true);
    if (retained?.ok) {
      expect(planResources(retained.value).length).toBeGreaterThan(0);
      if (first?.ok)
        expect(
          resolveFeatureWorkResources(retained.value.work)
            .filter((row) => row.work.scope !== 'frame')
            .map((row) => renderFeaturePlanSignature(row.closure)),
        ).toEqual(
          resolveFeatureWorkResources(first.value.work)
            .filter((row) => row.work.scope !== 'frame')
            .map((row) => renderFeaturePlanSignature(row.closure)),
        );
      expect(
        retained.value.work
          .flatMap((work) => work.passes)
          .filter((pass) => pass.name.endsWith('.simulate')),
      ).toEqual([expect.objectContaining({ enabled: false })]);
      expect(planPasses(retained.value).some((pass) => pass.name.endsWith('.project'))).toBe(true);
      expect(planPasses(retained.value).some((pass) => pass.name.endsWith('.raster'))).toBe(true);
      expect(planPasses(retained.value).some((pass) => pass.name.endsWith('.simulate'))).toBe(
        false,
      );
    }
    submit(2);

    // Parking out of view for more than the old eight-frame owner window must
    // retain the buffers; re-entry can draw the same committed state.
    viewProjection[12] = -10;
    for (let frameNumber = 3; frameNumber <= 11; frameNumber += 1) {
      const hidden = plan(frameNumber);
      expect(hidden?.ok).toBe(true);
      if (hidden?.ok) {
        expect(planResources(hidden.value).length).toBeGreaterThan(0);
        if (retained?.ok)
          expect(
            resolveFeatureWorkResources(hidden.value.work)
              .filter((row) => row.work.scope !== 'frame')
              .map((row) => renderFeaturePlanSignature(row.closure)),
          ).toEqual(
            resolveFeatureWorkResources(retained.value.work)
              .filter((row) => row.work.scope !== 'frame')
              .map((row) => renderFeaturePlanSignature(row.closure)),
          );
        expect(
          hidden.value.work
            .flatMap((work) => work.passes)
            .find((pass) => pass.name.endsWith('.raster'))?.enabled,
        ).toBe(false);
        expect(planPasses(hidden.value).some((pass) => pass.name.endsWith('.raster'))).toBe(false);
      }
      submit(frameNumber);
    }
    viewProjection[12] = 0;
    const reentered = plan(12);
    expect(reentered?.ok).toBe(true);
    if (reentered?.ok)
      expect(planPasses(reentered.value).some((pass) => pass.name.endsWith('.raster'))).toBe(true);
  });

  it('acknowledges a healthy player while another player reset remains deferred', async () => {
    const world = new World();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    };
    const effect = {
      guid: 'cross-player-effect',
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: 'sha256:cross-player',
      emitters: [{ id: 'stream', capacity: 8 }],
      program: {
        format: 'forgeax-vfx-program-2',
        fingerprint: 'sha256:cross-player',
        emitters: [
          {
            id: 'stream',
            module: 'cross-player.vfx.wgsl',
            capacity: 8,
            backend: { required: 'gpu' },
            space: 'world',
            simulationWhenCulled: 'continue',
            schedule: { rate: 60, bursts: [{ time: 0, count: 1 }] },
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
            wgsl: '// cross-player',
            reflection: {
              hooks: ['vfx_spawn', 'vfx_update'],
              imports: [],
              resources: [],
              entryPoints: ['forgeax_vfx_spawn_main'],
              bindings: [],
            },
            renderers: [],
          },
        ],
      },
    } as unknown;
    const handle = world.allocSharedRef('ParticleEffectAsset', asV3Effect(effect));
    const pausedPlayer = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    const healthyPlayer = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 2, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const feature = gpuParticleRenderFeature({
      camera: { read: () => camera },
      playerConsumption: { isEnabled: (_currentWorld, player) => player !== pausedPlayer },
    });
    const frame = (frameNumber: number) => {
      const extracted = feature.extract?.({ worlds: [world], frameNumber } as never);
      expect(extracted?.ok).toBe(true);
      if (extracted === undefined || !extracted.ok) throw new Error('VFX extraction failed');
      const planned = feature.plan?.(extracted.value, {
        targets: [],
        caps: {},
        frame: { frameNumber },
        generation: 1,
      } as never);
      expect(planned?.ok).toBe(true);
      feature.onFrameSubmitted?.({ worlds: [], frameNumber } as never);
    };

    // The paused player's first reset is a real deferred intent.  Keep
    // producing both streams beyond the queue bound while the healthy stream
    // must continue to submit and be selectively acknowledged.
    const healthyTicks: number[] = [];
    for (let frameNumber = 1; frameNumber <= 12; frameNumber += 1) {
      world.update(1 / 60).unwrap();
      frame(frameNumber);
      const healthySnapshot = runtime.inspectPlayer(healthyPlayer);
      expect(healthySnapshot?.queuedIntents).toBe(0);
      const committedTick = healthySnapshot?.lastCommitted?.tick;
      if (committedTick !== undefined) healthyTicks.push(committedTick);
    }

    const paused = runtime.inspectPlayer(pausedPlayer);
    const healthy = runtime.inspectPlayer(healthyPlayer);
    expect(paused?.queuedIntents).toBeGreaterThan(0);
    expect(healthy?.queuedIntents).toBe(0);
    expect(healthyTicks).toHaveLength(12);
    expect(
      healthyTicks.every((tick, index) => {
        const prior = healthyTicks[index - 1];
        return index === 0 || (prior !== undefined && tick > prior);
      }),
    ).toBe(true);
    expect(
      healthy?.diagnostics.some((diagnostic) => diagnostic.code === 'vfx-intent-queue-overflow'),
    ).toBe(false);
  });

  it('returns an empty keyed inspection aggregate before a player is present', async () => {
    const world = new World();
    const assets = {
      loaders: { registerPackLoader: () => {} },
      lookup: () => undefined,
    };
    const host = createVfxRuntimeHost({ camera: { read: () => undefined } });
    await host.attachWorld({ world, assets: assets as never });

    expect(host.inspect(world)).toEqual({
      generation: 1,
      renderGeneration: 0,
      players: [],
      diagnostics: [],
    });
  });
});
