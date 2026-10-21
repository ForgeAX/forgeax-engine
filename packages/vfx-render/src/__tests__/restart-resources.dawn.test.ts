import { AssetRegistry } from '@forgeax/engine-assets-runtime';
/// <reference types="@webgpu/types" />
import { type AssetVersion, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiComputePassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAssetAny,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../../../render/src/features/frame-execution';
import type { RenderFeaturePlanExecutionPass } from '../../../render/src/features/host';
import {
  freezeRenderFeaturePlan,
  renderFeaturePlanSignature,
} from '../../../render/src/features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBindingsRef,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuProgramRef,
} from '../../../render/src/features/prepared-gpu-work';
import { projectRenderFeaturePlans } from '../../../render/src/features/render-graph-contribution';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { singleViewContext } from './vfx-frame-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing native restart fixture value');
  return value;
}
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('reuses native storage across transactional restarts, ordered resets and recovery', async () => {
  const cook = async (capacity: number) =>
    (
      await cookParticleCodeProgram(
        {
          schemaVersion: 3,
          emitters: [
            {
              id: 'restart',
              capacity,
              backend: { required: 'gpu' },
              space: 'world',
              bounds: { kind: 'sphere', center: [1000, 0, 0], radius: 1 },
              simulationWhenCulled: 'continue',
              schedule: { rate: 0, bursts: [{ time: 0, count: 2 }] },
              program: { module: 'restart.wgsl' },
              renderers: [{ kind: 'trail', material: 'material', capacity, historyLength: 4 }],
            },
          ],
        },
        {
          'restart.wgsl': {
            entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
struct VfxParameters { scale: f32, }
struct VfxCustom { heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>, c: ptr<function,VfxCustom>) {
  (*p).lifetime = 4.0;
  (*p).position.x = f32(ctx.seed) * forgeax_vfx_parameters.scale;
}
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>, c: ptr<function,VfxCustom>) {
  (*p).position.y += ctx.delta;
  (*c).heat += ctx.delta;
}`,
          },
        },
      )
    ).unwrap();
  const cooked = await cook(8);
  const incompatible = await cook(16);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  native.pushErrorScope('validation');
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const player = world.spawn().unwrap();
  const fixedVersions: AssetVersion<unknown>[] = [];
  const reference = (program: typeof cooked) => {
    const effect = assets
      .create(
        runtimeEffectFixture(world, {
          kind: 'particle-effect',
          schemaVersion: 3,
          guid: `restart-${program.fingerprint}`,
          programFingerprint: program.fingerprint,
          emitters: program.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
          program: { ...program.program, fingerprint: program.fingerprint },
        } satisfies VfxGpuEffectAssetAny),
      )
      .unwrap();
    const version = runtimeAssets(assets).pin(effect).unwrap();
    fixedVersions.push(version);
    return {
      id: required(program.program.emitters[0]).id,
      effect,
      revision: version.revision,
      fingerprint: (version.value as VfxGpuEffectAssetAny).program.fingerprint,
    };
  };
  const references = new Map([
    [cooked, reference(cooked)],
    [incompatible, reference(incompatible)],
  ]);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: identity(),
  };
  type Frame = Parameters<ReturnType<typeof gpuParticleRenderFeature>['plan']>[0];
  type Intent = Frame['worlds'][number]['intents'][number];
  let sequence = 0;
  const intent = (
    seed: number,
    phaseTick = 0,
    spawnCount = phaseTick === 0 ? 2 : 0,
    program = cooked,
  ): Intent => ({
    sequence: ++sequence,
    player,
    emitter: required(references.get(program)),
    programFingerprint: required(references.get(program)).fingerprint,
    reset: phaseTick === 0,
    fixedDelta: 1 / 60,
    initialFixedDelta: 1 / 60,
    phaseTick,
    tick: phaseTick,
    seed,
    playCycle: seed,
    spawnCount,
    firstParticleId: phaseTick === 0 ? 0 : 2,
    instanceGeneration: 0,
    instancePatchCount: 0,
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
    parameterBlock: new Uint8Array(new Float32Array([seed]).buffer),
    canonicalPayload: new Uint8Array(),
    replayInput: {
      seed,
      tick: phaseTick,
      generation: 0,
      sequence,
      fingerprint: program.fingerprint,
      payload: new Uint8Array(),
      values: {},
      channelInputs: [],
      droppedCount: 0,
    },
  });
  let frameNumber = 0;
  const frame = (intents: Intent[], retained: Intent[] = []): Frame => ({
    frameNumber: ++frameNumber,
    worlds: [
      {
        sourceWorldIndex: 0,
        worldId: 0,
        runtimeId: 0,
        renderGeneration: 0,
        camera,
        views: [{ identity: 'main', camera }],
        emitterState: new Map([
          [
            `${Number(player)}:restart`,
            {
              enabled: true,
              localToWorld: identity(),
              player,
              emitter: required(references.get(cooked)),
            },
          ],
        ]),
        materials: new Map(),
        meshes: new Map(),
        intents,
        retained: retained.map((intent) => ({
          player,
          emitter: intent.emitter,
          intent,
          localToWorld: identity(),
          visible: false,
        })),
      },
    ],
  });
  const makeOwner = () =>
    createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({
        createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
      }),
    });
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const freshFeature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const owner = makeOwner(),
    freshOwner = makeOwner(),
    recoveredOwner = makeOwner();
  const prepare = (input: Frame, current = feature, gpu = owner, generation = 0) => {
    const plan = current
      .plan(
        input,
        singleViewContext({
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
          targets: [],
          caps: device.caps,
          generation,
          frame: { frameNumber: input.frameNumber },
          sceneData: {} as never,
        }),
      )
      .unwrap();
    const work = required(plan.work.find((work) => work.scope === 'frame'));
    freezeRenderFeaturePlan(current.identity, work, []).unwrap();
    const session = gpu.beginFeature(current.identity, generation);
    const programs = new Map<string, RenderFeatureGpuProgramRef>();
    const buffers = new Map<
      string,
      NonNullable<ReturnType<typeof session.resolveBuffer>> & {
        reference: RenderFeatureGpuBufferRef;
      }
    >();
    const bindings = new Map<string, RenderFeatureGpuBindingsRef>();
    for (const resource of work.resources) {
      if (resource.kind === 'compute-program')
        programs.set(
          resource.name,
          session.prepareProgram(resource.name, resource.program).unwrap(),
        );
      else if (resource.kind === 'buffer') {
        // COPY_SRC enables observation of authoritative native state only.
        const reference = session
          .prepareBuffer(resource.name, { ...resource, usage: [...resource.usage, 'copy-src'] })
          .unwrap();
        buffers.set(resource.name, { reference, ...required(session.resolveBuffer(reference)) });
      }
    }
    for (const resource of work.resources) {
      if (resource.kind !== 'compute-bindings') continue;
      bindings.set(
        resource.name,
        session
          .prepareBindings(resource.name, {
            program: required(programs.get(resource.program)),
            entries: resource.entries.map((entry) => ({
              binding: entry.binding,
              buffer: required(buffers.get(entry.resource)).reference,
            })),
          })
          .unwrap(),
      );
    }
    const passes = work.passes.map((pass): RenderFeaturePlanExecutionPass => {
      const common = {
        featureIdentity: current.identity,
        order: 0,
        name: pass.name,
        enabled: pass.enabled,
      };
      if (pass.kind === 'copy')
        return {
          ...common,
          resolvedGpuCopies: pass.copies
            .filter((copy) => copy.enabled !== false)
            .map((copy) => ({
              source: required(buffers.get(copy.source)),
              destination: required(buffers.get(copy.destination)),
              size: copy.size,
              sourceOffset: copy.sourceOffset ?? 0,
              destinationOffset: copy.destinationOffset ?? 0,
            })),
        };
      if (pass.kind !== 'compute') throw new Error(`Unexpected simulation pass ${pass.kind}`);
      const gpuCompute = {
        program: required(programs.get(pass.program)),
        bindings: required(bindings.get(pass.bindings)),
        dispatches: pass.dispatches.map((dispatch) => {
          if (dispatch.kind !== 'direct') throw new Error('Unexpected indirect simulation');
          return {
            entryPoint: dispatch.entryPoint,
            workgroups: dispatch.workgroups,
            ...(dispatch.bindings === undefined
              ? {}
              : { bindings: required(bindings.get(dispatch.bindings)) }),
          };
        }),
      };
      return {
        ...common,
        gpuCompute,
        resolvedGpuCompute: session.resolveComputePass(current.identity, gpuCompute).unwrap(),
      };
    });
    return { input, current, session, plan, work, buffers, programs, bindings, passes };
  };
  type Prepared = ReturnType<typeof prepare>;
  const simulations = (prepared: Prepared) =>
    prepared.work.passes.flatMap((pass) =>
      pass.kind === 'compute' && pass.enabled !== false
        ? pass.dispatches
            .filter(
              (dispatch) =>
                /^forgeax_vfx_update(?:_compact)?_main$/.test(dispatch.entryPoint) &&
                dispatch.kind === 'direct' &&
                dispatch.workgroups[0] > 0,
            )
            .map((dispatch) => ({
              program: pass.program,
              bindings: dispatch.bindings ?? pass.bindings,
            }))
        : [],
    );
  const finalStoragePrefix = (prepared: Prepared) => {
    const binding = required(simulations(prepared).at(-1)).bindings;
    const resource = prepared.work.resources.find((resource) => resource.name === binding);
    if (resource?.kind !== 'compute-bindings') throw new Error('Missing final simulation bindings');
    return required(resource.entries.find((entry) => entry.binding === 0)).resource.replace(
      /particles$/,
      '',
    );
  };
  const stateName = /\.(particles|custom|alive-indices|counters|scratch|indirect|history)$/;
  const read = async (prepared: Prepared) => {
    const buffers = [...prepared.buffers].filter(([name]) => stateName.test(name));
    const size = buffers.reduce((sum, [, buffer]) => sum + buffer.size, 0);
    const staging = device.createBuffer({ size, usage: 1 | 8 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      let offset = 0;
      for (const [, buffer] of buffers) {
        encoder.copyBufferToBuffer(buffer.buffer, 0, staging, offset, buffer.size);
        offset += buffer.size;
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await staging.mapAsync(1)).unwrap();
      const bytes = mapped.getMappedRange().unwrap().slice(0);
      mapped.unmap();
      offset = 0;
      return new Map(
        buffers.map(([name, buffer]) => {
          const value = new Uint8Array(bytes.slice(offset, offset + buffer.size));
          offset += buffer.size;
          return [name, value];
        }),
      );
    } finally {
      device.destroyBuffer(staging).unwrap();
    }
  };
  const abort = (prepared: Prepared) => {
    prepared.current.onFrameAborted?.(prepared.input);
    prepared.session.abortFrame().unwrap();
  };
  const execute = async (prepared: Prepared, fail = false) => {
    const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
    projectRenderFeaturePlans(
      builder,
      [{ featureIdentity: prepared.current.identity, order: 0, passes: prepared.passes }],
      { resolveTarget: () => undefined },
    ).unwrap();
    const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      let begins = 0;
      const encodedBindings: unknown[] = [];
      const observed = new Proxy(encoder, {
        get(target, key) {
          if (key === 'beginComputePass')
            return (...args: Parameters<typeof encoder.beginComputePass>) => {
              begins++;
              const pass = target.beginComputePass(...args);
              return new Proxy(pass, {
                get(target, key) {
                  if (key === 'setBindGroup')
                    return (...args: Parameters<typeof target.setBindGroup>) => {
                      if (fail) throw new Error('Reject after encoded reset');
                      encodedBindings.push(args[1]);
                      return target.setBindGroup(...args);
                    };
                  const value = Reflect.get(target, key);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }) as RhiComputePassEncoder;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const result = graph.execute({
        encoder: observed,
        featureExecutions: [
          { featureIdentity: prepared.current.identity, order: 0, passes: prepared.passes },
        ],
      });
      if (fail) {
        expect(result.ok).toBe(false);
        return begins;
      }
      result.unwrap();
      expect(encodedBindings).toEqual(
        prepared.passes
          .filter((pass) => pass.enabled !== false)
          .flatMap(
            (pass) =>
              pass.resolvedGpuCompute?.dispatches.map((dispatch) => dispatch.bindGroup) ?? [],
          ),
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      prepared.current.onFrameSubmitted?.(prepared.input, {
        works: [
          { scope: 'frame', passes: prepared.passes.filter((pass) => pass.enabled !== false) },
        ],
      });
      for (const lease of prepared.session.commitFrame()) lease.release().unwrap();
      return begins;
    } finally {
      await graph.retire();
    }
  };
  const buffer = (prepared: Prepared, suffix: string) =>
    required([...prepared.buffers].find(([name]) => name.endsWith(suffix)))[1].buffer;
  try {
    const initial = prepare(frame([intent(7, 0, 6)]));
    await execute(initial);
    const advanced = prepare(frame([intent(7, 1)]));
    await execute(advanced);
    const oldBytes = await read(advanced);
    const reset = intent(8);
    const resetFrame = frame([reset]);
    let candidate = prepare(resetFrame);
    expect(buffer(candidate, '.particles')).toBe(buffer(initial, '.particles'));
    expect(renderFeaturePlanSignature(candidate.work)).toBe(
      renderFeaturePlanSignature(initial.work),
    );
    expect([...candidate.programs.values()]).toEqual([...initial.programs.values()]);
    expect([...candidate.bindings.values()]).toEqual([...initial.bindings.values()]);
    // Authoritative simulation buffers only; preparation still writes tick and parameter inputs.
    expect(await read(candidate)).toEqual(oldBytes);
    abort(candidate); // Cancellation before encoding has no effect either.
    candidate = prepare(resetFrame);
    await execute(candidate, true); // Copies encoded, then compute encoding fails.
    expect(await read(candidate)).toEqual(oldBytes);
    abort(candidate);
    candidate = prepare(resetFrame);
    expect(await execute(candidate)).toBe(1);
    const resetBytes = await read(candidate);
    expect(resetBytes).not.toEqual(oldBytes);
    const fresh = prepare(frame([reset]), freshFeature, freshOwner);
    await execute(fresh);
    expect(resetBytes).toEqual(await read(fresh)); // Includes particles, custom state and trail history.

    const finalReset = intent(10),
      finalTick = intent(10, 1);
    const batch = prepare(frame([intent(9, 0, 5), intent(9, 1), finalReset, finalTick]));
    expect(buffer(batch, '.particles')).toBe(buffer(initial, '.particles'));
    const projectionParameters = batch.work.resources.find(
      (resource) =>
        resource.kind === 'buffer' &&
        resource.name.endsWith('.parameters') &&
        !resource.name.includes('.tick-'),
    );
    expect(projectionParameters).toMatchObject({ data: finalTick.parameterBlock });
    expect(await execute(batch)).toBe(2); // Only the actual mid-batch reset splits compute.
    const freshBatch = prepare(frame([finalReset, finalTick]), freshFeature, freshOwner);
    expect(await execute(freshBatch)).toBe(1);
    expect(await read(batch)).toEqual(await read(freshBatch));
    const stable = prepare(frame([intent(10, 2), intent(10, 3), intent(10, 4)]));
    expect(await execute(stable)).toBe(1); // Three ordinary ticks keep one native compute pass.

    const recoveryFrame = frame([], [intent(11, 2)]);
    const rejectedRecovery = prepare(recoveryFrame, feature, recoveredOwner, 1);
    await execute(rejectedRecovery, true);
    abort(rejectedRecovery);
    const recovered = prepare(recoveryFrame, feature, recoveredOwner, 1);
    await execute(recovered);
    const freshRecovery = prepare(
      frame([intent(11), intent(11, 1), intent(11, 2)]),
      freshFeature,
      freshOwner,
    );
    await execute(freshRecovery);
    expect(await read(recovered)).toEqual(await read(freshRecovery));
    const retained = prepare(frame([], [intent(11, 2)]), feature, recoveredOwner, 1);
    expect(retained.passes.every((pass) => pass.enabled === false)).toBe(true);
    abort(retained);

    // Real World edits can queue A -> B -> A before Render consumes a frame.
    world
      .addComponent(player, {
        component: ParticleEffectPlayer,
        data: {
          effect: required(references.get(cooked)).effect,
          playing: true,
          seed: 21,
          timeScale: 1,
        },
      })
      .unwrap();
    const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    try {
      world.update(1 / 60).unwrap();
      world
        .set(player, ParticleEffectPlayer, {
          effect: required(references.get(incompatible)).effect,
          seed: 22,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      world
        .set(player, ParticleEffectPlayer, {
          effect: required(references.get(cooked)).effect,
          seed: 23,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
      expect(runtime.snapshot().map((intent) => intent.programFingerprint)).toEqual([
        required(references.get(cooked)).fingerprint,
        required(references.get(incompatible)).fingerprint,
        required(references.get(cooked)).fingerprint,
      ]);
      const source = gpuParticleRenderFeature({ camera: { read: () => camera } });
      const published = source
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber: ++frameNumber,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
      const interleaved = prepare(published);
      const programs = simulations(interleaved).map((dispatch) => dispatch.program);
      expect(programs).toHaveLength(3);
      expect(programs[0]).toBe(programs[2]);
      expect(programs[0]).not.toBe(programs[1]);
      expect(
        interleaved.plan.work
          .filter((work) => work.scope !== 'frame')
          .flatMap((work) => work.resources)
          .filter((resource) => resource.name.endsWith('.instances')),
      ).toHaveLength(1);
      await execute(interleaved);
      source.onSourceFrameSubmitted?.(published, structuredClone(interleaved.plan.sourceFeedback));
      expect(runtime.snapshot()).toHaveLength(0);

      // A live continuation needs retained replay even if a later A reset shares
      // the group. Recovery ties retain phase order ahead of real source ticks.
      world.update(1 / 60).unwrap();
      world
        .set(player, ParticleEffectPlayer, {
          effect: required(references.get(incompatible)).effect,
          seed: 24,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      world
        .set(player, ParticleEffectPlayer, {
          effect: required(references.get(cooked)).effect,
          seed: 25,
        })
        .unwrap();
      world.update(1 / 60).unwrap();
      const recovery = source
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber: ++frameNumber,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
      expect(runtime.snapshot().map((intent) => intent.reset)).toEqual([false, true, true]);
      let replayed = prepare(recovery, feature, recoveredOwner, 2);
      const submittedPrograms = (prepared: Prepared) =>
        simulations(prepared).map((dispatch) => dispatch.program);
      const expected = [programs[0], programs[0], programs[1], programs[0]];
      expect(submittedPrograms(replayed)).toEqual(expected);
      const previous = await read(replayed);
      await execute(replayed, true);
      expect(await read(replayed)).toEqual(previous);
      abort(replayed);
      replayed = prepare(recovery, feature, recoveredOwner, 2);
      expect(submittedPrograms(replayed)).toEqual(expected);
      await execute(replayed);
      const finalIntent = required(required(recovery.worlds[0]).intents.at(-1));
      const standalone = prepare(frame([finalIntent]), freshFeature, freshOwner);
      await execute(standalone);
      const finalPrefix = finalStoragePrefix(replayed);
      expect(
        await read({
          ...replayed,
          buffers: new Map([...replayed.buffers].filter(([name]) => name.startsWith(finalPrefix))),
        }),
      ).toEqual(await read(standalone));
      source.onSourceFrameSubmitted?.(recovery, structuredClone(replayed.plan.sourceFeedback));
      expect(runtime.snapshot()).toHaveLength(0);
      expect(runtime.lastCommittedEmitter(player, 'restart')?.seed).toBe(25);

      const editedHandle = required(references.get(cooked)).effect;
      const originalDefinition = assets.read(editedHandle).unwrap();
      const replacementDefinition = assets
        .read(required(references.get(incompatible)).effect)
        .unwrap();
      assets.replace(editedHandle, replacementDefinition).unwrap();
      world.update(1 / 60).unwrap();
      assets.replace(editedHandle, originalDefinition).unwrap();
      world.update(1 / 60).unwrap();
      expect(world.get(player, ParticleEffectPlayer).unwrap().effect).toBe(editedHandle);
      expect(runtime.snapshot().map((intent) => intent.emitter.capacity)).toEqual([16, 8]);
      expect(runtime.snapshot().map((intent) => intent.reset)).toEqual([true, true]);
      const editedFrame = source
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber: ++frameNumber,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
      const editedIntents = required(editedFrame.worlds[0]).intents;
      expect(editedIntents.map((intent) => intent.emitter.effect)).toEqual([
        editedHandle,
        editedHandle,
      ]);
      expect(new Set(editedIntents.map((intent) => intent.emitter.revision)).size).toBe(2);
      const editedWork = prepare(editedFrame, feature, recoveredOwner, 2);
      expect(simulations(editedWork)).toHaveLength(2);
      await execute(editedWork);
      const editedFinal = required(editedIntents.at(-1));
      const editedControl = prepare(frame([editedFinal]), freshFeature, freshOwner);
      await execute(editedControl);
      const editedPrefix = finalStoragePrefix(editedWork);
      expect(
        await read({
          ...editedWork,
          buffers: new Map(
            [...editedWork.buffers].filter(([name]) => name.startsWith(editedPrefix)),
          ),
        }),
      ).toEqual(await read(editedControl));
      source.onSourceFrameSubmitted?.(editedFrame, structuredClone(editedWork.plan.sourceFeedback));
      expect(runtime.snapshot()).toHaveLength(0);
    } finally {
      await context.fiber.dispose();
    }

    const changed = prepare(frame([intent(12, 0, 2, incompatible)]));
    expect(buffer(changed, '.particles')).not.toBe(buffer(initial, '.particles'));
    expect(renderFeaturePlanSignature(changed.work)).not.toBe(
      renderFeaturePlanSignature(initial.work),
    );
    await execute(changed);
    expect(await native.popErrorScope()).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    owner.dispose().unwrap();
    freshOwner.dispose().unwrap();
    recoveredOwner.dispose().unwrap();
    for (const version of fixedVersions) {
      version.dispose();
      assets.release(version.handle).unwrap();
    }
  }
});
