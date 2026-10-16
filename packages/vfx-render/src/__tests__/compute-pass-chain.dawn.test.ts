/// <reference types="@webgpu/types" />
import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiComputePassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import type { VfxGpuEffectAssetAny, VfxGpuTickIntent } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../../../render/src/features/frame-execution';
import type { RenderFeaturePlanExecutionPass } from '../../../render/src/features/host';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  freezeRenderFeaturePlan,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../../../render/src/features/plan';
import {
  createRenderFeatureGpuWorkOwner,
  type RenderFeatureGpuBindingsRef,
  type RenderFeatureGpuBufferRef,
  type RenderFeatureGpuProgramRef,
} from '../../../render/src/features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../../../render/src/features/render-graph-compute';
import { projectRenderFeaturePlans } from '../../../render/src/features/render-graph-contribution';
import { projectRenderFeatureCopies } from '../../../render/src/features/render-graph-copy';
import { createRenderFeatureGraphBufferState } from '../../../render/src/features/render-graph-resources';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { singleViewContext } from './vfx-frame-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing cooked compute chain fixture value');
  return value;
}

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('coalesces real cooked event/trail ticks with identical GPU bytes, commands and submission receipts', async () => {
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: ['left', 'right'].map((id) => ({
          id,
          capacity: 8,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [1000, 0, 0], radius: 1 },
          simulationWhenCulled: 'continue',
          schedule: { rate: 0 },
          program: { module: 'chain.wgsl' },
          renderers: [{ kind: 'trail', material: 'material', capacity: 8, historyLength: 4 }],
          channels: [{ id: 'hit', capacity: 2, overflow: 'drop-newest' }],
          events: [{ id: 'hit', channel: 'hit', subEmitter: id, fanOut: 1, recursionDepth: 1 }],
        })),
      },
      {
        'chain.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
struct VfxCustom { heat: f32, }
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>, c: ptr<function,VfxCustom>) {
  (*p).lifetime = 4.0;
}
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>, c: ptr<function,VfxCustom>) {
  (*p).position.x += ctx.delta;
  (*c).heat += ctx.delta;
}`,
        },
      },
    )
  ).unwrap();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap();
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  native.pushErrorScope('validation');
  const feature = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const featureIdentity = feature.identity;
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: (descriptor) => createShaderModuleImmediate(device, descriptor),
    }),
  });
  const world = new World();
  const player = world.spawn().unwrap();
  const effect = {
    kind: 'particle-effect',
    schemaVersion: 3,
    guid: 'cooked-compute-chain',
    programFingerprint: cooked.fingerprint,
    emitters: cooked.program.emitters.map(({ id, capacity }) => ({ id, capacity })),
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  } satisfies VfxGpuEffectAssetAny;
  const effectHandle = world.internSharedRef('ParticleEffectAsset', effect);
  const reference = (emitter: VfxGpuTickIntent['emitter']) => ({
    effect: effectHandle,
    id: emitter.id,
  });
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: identity(),
  };
  type PublishedIntent = Parameters<typeof feature.plan>[0]['worlds'][number]['intents'][number];
  const accepted = new Map<string, PublishedIntent>();
  let frameNumber = 0;
  let tick = 0;
  let sequence = 0;
  const makeFrame = (ticks: number) => {
    const intents: PublishedIntent[] = [];
    for (let slot = 0; slot < ticks; slot++) {
      const currentTick = tick + slot;
      for (const emitter of cooked.program.emitters) {
        const payload = new Uint8Array();
        const channelInputs: VfxGpuTickIntent['channelInputs'] =
          currentTick === 1
            ? [
                {
                  channel: 'hit',
                  payload: { position: [3, 0, 0], strength: 1 },
                  sequence: currentTick,
                },
              ]
            : [];
        intents.push({
          sequence: ++sequence,
          player,
          emitter: reference(emitter),
          programFingerprint: cooked.fingerprint,
          reset: currentTick === 0,
          fixedDelta: (currentTick + 1) / 100,
          initialFixedDelta: 0.01,
          phaseTick: currentTick,
          tick: currentTick,
          seed: 7,
          playCycle: 0,
          spawnCount: currentTick === 0 ? 2 : 0,
          firstParticleId: 100 + currentTick * 8,
          instanceGeneration: 0,
          instancePatchCount: 0,
          parameterBlock: payload,
          canonicalPayload: payload,
          replayInput: {
            seed: 7,
            tick: currentTick,
            generation: 0,
            sequence,
            fingerprint: cooked.fingerprint,
            payload,
            values: {},
            channelInputs,
            droppedCount: 0,
          },
          channelInputs,
          eventCounters: {
            queued: channelInputs.length,
            produced: 0,
            consumed: 0,
            dropped: 0,
            overflow: 0,
            fanOut: 0,
            recursionDepth: 0,
            lastSequence: currentTick,
          },
        });
      }
    }
    const frame: Parameters<typeof feature.plan>[0] = {
      frameNumber: ++frameNumber,
      worlds: [
        {
          sourceWorldIndex: 0,
          worldId: 0,
          runtimeId: 0,
          renderGeneration: 0,
          emitterState: new Map(
            cooked.program.emitters.map((emitter) => [
              `${Number(player)}:${emitter.id}`,
              { enabled: true, localToWorld: identity(), player, emitter: reference(emitter) },
            ]),
          ),
          materials: new Map(),
          meshes: new Map(),
          forceFields: new Map(),
          textureGuids: [],
          camera,
          views: [{ identity: 'main', camera }],
          intents,
          retained: [...accepted.values()].map((intent) => ({
            player,
            emitter: intent.emitter,
            intent,
            localToWorld: identity(),
            visible: false,
          })),
        },
      ],
    };
    return frame;
  };
  const prepare = (frame: Parameters<typeof feature.plan>[0]) => {
    const session = owner.beginFeature(featureIdentity, 0);
    const plan = feature
      .plan(
        frame,
        singleViewContext({
          resolveAsset: (sourceIndex, handle) => {
            expect(sourceIndex).toBe(0);
            return resolveAssetHandle(world, handle);
          },
          targets: [],
          caps: device.caps,
          generation: 0,
          frame: { frameNumber: frame.frameNumber },
          sceneData: {} as never,
        }),
      )
      .unwrap();
    const work = required(plan.work.find((work) => work.scope === 'frame'));
    // Out-of-frustum display still runs the actual simulation and trail history.
    expect(
      plan.work
        .filter((work) => work.scope !== 'frame')
        .flatMap((work) => work.passes)
        .every((pass) => pass.enabled === false),
    ).toBe(true);
    freezeRenderFeaturePlan(featureIdentity, work, []).unwrap();
    const programs = new Map<string, RenderFeatureGpuProgramRef>();
    const buffers = new Map<
      string,
      NonNullable<ReturnType<typeof session.resolveBuffer>> & {
        reference: RenderFeatureGpuBufferRef;
      }
    >();
    const bindings = new Map<string, RenderFeatureGpuBindingsRef>();
    for (const resource of work.resources) {
      if (resource.kind === 'compute-program') {
        programs.set(
          resource.name,
          session.prepareProgram(resource.name, resource.program).unwrap(),
        );
      } else if (resource.kind === 'buffer') {
        // COPY_SRC admits test observation only; producer declarations and kernels are unchanged.
        const reference = session
          .prepareBuffer(resource.name, {
            size: resource.size,
            usage: [...resource.usage, 'copy-src'],
            ...(resource.data === undefined ? {} : { data: resource.data }),
          })
          .unwrap();
        buffers.set(resource.name, { reference, ...required(session.resolveBuffer(reference)) });
      } else if (resource.kind !== 'compute-bindings') {
        throw new Error(`Unexpected cooked simulation resource: ${resource.kind}`);
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
      if (pass.kind === 'copy')
        return {
          featureIdentity,
          order: 0,
          name: pass.name,
          enabled: pass.enabled,
          resolvedGpuCopies: pass.copies.map((copy) => ({
            source: required(buffers.get(copy.source)),
            destination: required(buffers.get(copy.destination)),
            size: copy.size,
            sourceOffset: copy.sourceOffset ?? 0,
            destinationOffset: copy.destinationOffset ?? 0,
          })),
        };
      if (pass.kind !== 'compute') throw new Error(`Unexpected simulation pass: ${pass.kind}`);
      const gpuCompute = {
        program: required(programs.get(pass.program)),
        bindings: required(bindings.get(pass.bindings)),
        dispatches: pass.dispatches.map((dispatch) => {
          if (dispatch.kind !== 'direct')
            throw new Error('Unexpected indirect simulation dispatch');
          return { entryPoint: dispatch.entryPoint, workgroups: dispatch.workgroups };
        }),
      };
      return {
        featureIdentity,
        order: 0,
        name: pass.name,
        ...(pass.enabled === undefined ? {} : { enabled: pass.enabled }),
        gpuCompute,
        resolvedGpuCompute: session.resolveComputePass(featureIdentity, gpuCompute).unwrap(),
      };
    });
    return { work, buffers, passes, session };
  };
  type Prepared = ReturnType<typeof prepare>;
  const compile = (prepared: Prepared, coalesce: boolean) => {
    const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
    if (coalesce)
      projectRenderFeaturePlans(builder, [{ featureIdentity, order: 0, passes: prepared.passes }], {
        resolveTarget: () => undefined,
      }).unwrap();
    else {
      const buffers = createRenderFeatureGraphBufferState();
      const projection = new RenderFeatureComputeGraphProjection(builder, buffers);
      for (const pass of prepared.passes) {
        if (pass.resolvedGpuCopies !== undefined)
          projectRenderFeatureCopies(builder, buffers, pass).unwrap();
        else projection.addPasses([pass]).unwrap();
      }
    }
    return builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  };
  const read = async (prepared: Prepared) => {
    const size = [...prepared.buffers.values()].reduce((total, buffer) => total + buffer.size, 0);
    const staging = device.createBuffer({ size, usage: 1 | 8 }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      let offset = 0;
      for (const buffer of prepared.buffers.values()) {
        encoder.copyBufferToBuffer(buffer.buffer, 0, staging, offset, buffer.size);
        offset += buffer.size;
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await staging.mapAsync(1)).unwrap();
      const bytes = mapped.getMappedRange().unwrap().slice(0);
      mapped.unmap();
      const result = new Map<string, Uint8Array>();
      offset = 0;
      for (const [name, buffer] of prepared.buffers) {
        result.set(name, new Uint8Array(bytes.slice(offset, offset + buffer.size)));
        offset += buffer.size;
      }
      return result;
    } finally {
      device.destroyBuffer(staging).unwrap();
    }
  };
  const restore = (prepared: Prepared, bytes: Awaited<ReturnType<typeof read>>) => {
    for (const [name, data] of bytes)
      device.queue.writeBuffer(required(prepared.buffers.get(name)).buffer, 0, data).unwrap();
  };
  const run = async (graph: ReturnType<typeof compile>, prepared: Prepared, failAt?: string) => {
    let begins = 0;
    const trace: unknown[][] = [];
    const encoder = device.createCommandEncoder().unwrap();
    const failingGroup = prepared.passes.find((pass) => pass.name === failAt)?.resolvedGpuCompute
      ?.dispatches[0]?.bindGroup;
    const observed = new Proxy(encoder, {
      get(target, key) {
        if (key === 'beginComputePass')
          return (...args: Parameters<typeof encoder.beginComputePass>) => {
            begins++;
            const nativePass = target.beginComputePass(...args);
            return new Proxy(nativePass, {
              get(pass, key) {
                const value = Reflect.get(pass, key);
                if (key === 'setPipeline' || key === 'setBindGroup' || key === 'dispatchWorkgroups')
                  return (...args: unknown[]) => {
                    if (
                      key === 'setBindGroup' &&
                      failingGroup !== undefined &&
                      args[1] === failingGroup
                    )
                      throw new Error('Injected cooked tick binding failure');
                    trace.push([key, ...args]);
                    return Reflect.apply(value, pass, args);
                  };
                return typeof value === 'function' ? value.bind(pass) : value;
              },
            }) as RhiComputePassEncoder;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = graph.execute({
      encoder: observed,
      featureExecutions: [{ featureIdentity, order: 0, passes: prepared.passes }],
    });
    if (!result.ok) return { result, trace, begins };
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    return { result, trace, begins, bytes: await read(prepared) };
  };
  let baseline: ReturnType<typeof compile> | undefined;
  let chain: ReturnType<typeof compile> | undefined;
  try {
    let signature: ReturnType<typeof cloneRenderFeaturePlanSignatureSnapshot> | undefined;
    let originalBuffers: Prepared['buffers'] | undefined;
    for (const ticks of [4, 1, 0, 3]) {
      const frame = makeFrame(ticks);
      let prepared = prepare(frame);
      if (signature === undefined) {
        signature = cloneRenderFeaturePlanSignatureSnapshot(prepared.work);
        originalBuffers = prepared.buffers;
        baseline = compile(prepared, false);
        chain = compile(prepared, true);
        expect(baseline.inspect().passes).toHaveLength(18);
        // Disjoint emitter programs now share their native compute pass.
        expect(chain.inspect().passes).toHaveLength(3);
      } else {
        expect(renderFeaturePlanSignatureSnapshotEquals(prepared.work, signature)).toBe(true);
        for (const [name, buffer] of prepared.buffers)
          expect(buffer.buffer).toBe(required(originalBuffers?.get(name)).buffer);
      }
      const initial = await read(prepared);
      if (ticks === 3) {
        const failed = await run(required(chain), prepared, required(prepared.passes[2]).name);
        expect(failed.result.ok).toBe(false);
        expect(await read(prepared)).toEqual(initial);
        feature.onFrameAborted?.(frame);
        prepared.session.abortFrame().unwrap();
        prepared = prepare(frame);
      }
      const left = await run(required(baseline), prepared);
      restore(prepared, initial);
      const right = await run(required(chain), prepared);
      expect(left.result.ok).toBe(true);
      expect(right.result.ok).toBe(true);
      expect(right.bytes).toEqual(left.bytes);
      expect(right.trace).toEqual(left.trace);
      expect(left.begins).toBe(ticks * 4);
      expect(right.begins).toBe(ticks === 0 ? 0 : 1);
      if (ticks === 4) {
        for (const [name, bytes] of required(right.bytes)) {
          const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
          if (name.endsWith('.renderer-0.history')) {
            expect(words[8 * 4 * 4]).toBe(4);
            const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
            expect([values[0], values[4], values[8], values[12]]).toEqual([
              expect.closeTo(0.01, 6),
              expect.closeTo(0.03, 6),
              expect.closeTo(0.06, 6),
              expect.closeTo(0.1, 6),
            ]);
          }
          if (name.endsWith('.counters')) {
            expect(words[0]).toBe(3); // Two scheduled births and one actual event birth.
            expect(words[2]).toBeGreaterThan(0);
          }
        }
        // Falsify a tempting collapse that reuses the final tick's uniform/bindings.
        restore(prepared, initial);
        const broken = {
          ...prepared,
          passes: prepared.passes.map((pass, _index, passes) =>
            pass.resolvedGpuCompute === undefined
              ? pass
              : {
                  ...pass,
                  resolvedGpuCompute: required(
                    required(
                      passes.find(
                        (candidate) => candidate.name === pass.name.replace(/tick-\d+/, 'tick-3'),
                      ),
                    ).resolvedGpuCompute,
                  ),
                },
          ),
        };
        expect((await run(required(chain), broken)).bytes).not.toEqual(right.bytes);
        restore(prepared, required(right.bytes));
      }
      feature.onFrameSubmitted?.(frame, {
        works: [
          { scope: 'frame', passes: prepared.passes.filter((pass) => pass.enabled !== false) },
        ],
      });
      expect(feature.inspect().dispatches).toBe(
        right.trace.filter((command) => command[0] === 'dispatchWorkgroups').length,
      );
      for (const lease of prepared.session.commitFrame()) lease.release().unwrap();
      for (const intent of required(frame.worlds[0]).intents)
        accepted.set(intent.emitter.id, intent);
      tick += ticks;
    }
    expect(await native.popErrorScope()).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await baseline?.retire();
    await chain?.retire();
    owner.dispose().unwrap();
  }
});
