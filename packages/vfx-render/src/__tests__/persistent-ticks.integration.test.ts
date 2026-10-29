import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import {
  buildVfxRecoveryIntents,
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import {
  cloneRenderFeaturePlanSignatureSnapshot,
  type RenderFeaturePlanSignatureSnapshot,
  renderFeaturePlanSignature,
  renderFeaturePlanSignatureSnapshotEquals,
} from '../../../render/src/features/plan';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import {
  planPasses,
  planResources,
  singleViewContext,
  freezeVfxPlan as validateRenderFeaturePlan,
} from './vfx-frame-fixture';

function activeUpdates(plan: Parameters<typeof planPasses>[0]) {
  return planPasses(plan).flatMap((pass) =>
    pass.kind === 'compute' && pass.enabled !== false
      ? pass.dispatches.filter(
          (dispatch) =>
            dispatch.entryPoint === 'forgeax_vfx_update_compact_main' &&
            (dispatch.kind !== 'direct' || dispatch.workgroups[0] > 0),
        )
      : [],
  );
}

it.each([
  false,
  true,
])('retains particles and acknowledges ordered work only after submission (events=%s)', async (events) => {
  const result = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'persistent',
          capacity: 4,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'persistent.wgsl' },
          renderers: [{ kind: 'billboard', material: 'material' }],
          ...(events
            ? {
                channels: [{ id: 'hit', capacity: 2, overflow: 'drop-newest' }],
                events: [
                  {
                    id: 'hit',
                    channel: 'hit',
                    subEmitter: 'persistent',
                    fanOut: 2,
                    recursionDepth: 1,
                  },
                ],
              }
            : {}),
        },
      ],
    },
    {
      'persistent.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) { (*particle).lifetime = 86400.0; }
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) { (*particle).position.x += ctx.delta; }`,
      },
    },
  );
  if (!result.ok) throw result.error;
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: result.value.fingerprint,
    emitters: [{ id: 'persistent', capacity: 4 }],
    program: { ...result.value.program, fingerprint: result.value.fingerprint },
  };
  const world = new World({ assets: new AssetRegistry() });
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, { ...asset, guid: 'effect' }))
    .unwrap();
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const targets = [
    {
      name: 'color',
      kind: 'color' as const,
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
    },
  ];
  const signatureSnapshots = new Map<string, RenderFeaturePlanSignatureSnapshot>();
  let frameNumber = 0;
  const frame = (worlds = [world], generation = 0) => {
    const extracted = feature
      .extract({
        worlds,
        owner: 0,
        views: [{ identity: 'main', render: true }],
        frameNumber: ++frameNumber,
      })
      .unwrap();
    const plan = consumer
      .plan(
        structuredClone(extracted),
        singleViewContext({
          targets,
          resolveAsset: (index, handle, revision) => {
            const source = worlds[index];
            if (source === undefined) throw new Error(`Missing fixture source World ${index}`);
            return runtimeAssets(source.assets).resolveAsset(handle, revision);
          },
          caps: {} as never,
          frame: { frameNumber },
          generation,
          sceneData: {} as never,
        }),
      )
      .unwrap();
    expect(validateRenderFeaturePlan(feature.identity, plan, targets).ok).toBe(true);
    for (const work of plan.work) {
      const scope = work.scope === 'frame' ? 'frame' : work.scope.view;
      const previous = signatureSnapshots.get(scope);
      const canonical = renderFeaturePlanSignature(work);
      const snapshot = cloneRenderFeaturePlanSignatureSnapshot(work, previous);
      expect(renderFeaturePlanSignatureSnapshotEquals(work, snapshot)).toBe(true);
      // Reconciliation must not mutate either the producer plan or its exact spelling.
      expect(renderFeaturePlanSignature(work)).toBe(canonical);
      signatureSnapshots.set(scope, snapshot);
    }
    return { extracted, plan };
  };
  const particleName = (plan: ReturnType<typeof frame>['plan']) =>
    planResources(plan).find((resource) => resource.name.endsWith('.particles'))?.name;
  try {
    world.update(1 / 60).unwrap();
    const first = frame();
    const entries = planPasses(first.plan).flatMap((pass) =>
      pass.kind === 'compute' ? pass.dispatches.map((dispatch) => dispatch.entryPoint) : [],
    );
    expect(entries).toEqual([
      'forgeax_vfx_spawn_main',
      'forgeax_vfx_update_compact_main',
      ...(events ? ['forgeax_vfx_event_main', 'forgeax_vfx_scan_compact_main'] : []),
      'forgeax_vfx_billboard_main',
    ]);
    expect(runtime.snapshot()).toHaveLength(1);
    const retry = frame();
    expect(particleName(retry.plan)).toBe(particleName(first.plan));
    // Seal the successor before the source observes the earlier submission.
    const sealed = structuredClone(
      feature
        .extract({
          worlds: [world],
          owner: 0,
          views: [{ identity: 'main', render: true }],
          frameNumber: ++frameNumber,
        })
        .unwrap(),
    );
    consumer.onFrameSubmitted?.(retry.extracted);
    // One-workgroup emitters fuse update/compaction and post-event scan/compaction.
    // The initial spawn, ordered event work and billboard projection still execute.
    expect(consumer.inspect().dispatches).toBe(events ? 5 : 3);
    const successor = consumer
      .plan(
        sealed,
        singleViewContext({
          targets,
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
          caps: {} as never,
          frame: { frameNumber },
          generation: 0,
          sceneData: {} as never,
        }),
      )
      .unwrap();
    expect(activeUpdates(successor)).toHaveLength(0);
    expect(planPasses(successor).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    expect(particleName(successor)).toBe(particleName(first.plan));
    consumer.onFrameSubmitted?.(sealed);
    expect(runtime.snapshot()).toHaveLength(1);
    feature.onSourceFrameSubmitted?.(retry.extracted, structuredClone(retry.plan.sourceFeedback));
    expect(runtime.snapshot()).toHaveLength(0);
    const presentation = frame([new World({ assets: new AssetRegistry() }), world]);
    // The receiver dispatched this tick as queued work, so the committed retained row
    // references it by sequence and still draws from the receiver's queued history.
    expect(presentation.extracted.worlds.at(-1)?.retained[0]).not.toHaveProperty('intent');
    expect(particleName(presentation.plan)).toBe(particleName(first.plan));
    expect(planPasses(presentation.plan).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    expect(
      planPasses(presentation.plan)
        .flatMap((pass) => (pass.kind === 'compute' ? pass.dispatches : []))
        .some((dispatch) => /spawn|update|history/.test(dispatch.entryPoint)),
    ).toBe(false);
    expect(
      planResources(presentation.plan).find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.indirect'),
      ),
    ).not.toHaveProperty('data');
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    const catchup = frame();
    expect(runtime.snapshot()).toHaveLength(2);
    const updates = planPasses(catchup.plan).flatMap((pass) =>
      pass.kind === 'compute'
        ? pass.dispatches
            .filter((dispatch) => dispatch.entryPoint === 'forgeax_vfx_update_compact_main')
            .map((dispatch) => dispatch.bindings ?? pass.bindings)
        : [],
    );
    expect(updates).toHaveLength(2);
    expect(new Set(updates).size).toBe(2);
    expect(planPasses(catchup.plan).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    expect(particleName(catchup.plan)).toBe(particleName(first.plan));
    expect(
      planResources(catchup.plan).find((resource) => resource.name.endsWith('.indirect')),
    ).not.toHaveProperty('data');
    consumer.onFrameSubmitted?.(catchup.extracted);
    // Both later ticks have zero scheduled spawns; their update/event work
    // remains active and neither empty spawn is counted as a GPU command.
    expect(consumer.inspect().dispatches).toBe(events ? 7 : 3);
    feature.onSourceFrameSubmitted?.(
      catchup.extracted,
      structuredClone(catchup.plan.sourceFeedback),
    );
    expect(runtime.snapshot()).toHaveLength(0);
    const frameSignature = (plan: typeof catchup.plan) => {
      const work = plan.work.find((work) => work.scope === 'frame');
      if (work === undefined) throw new Error('Missing simulation work');
      return renderFeaturePlanSignature(work);
    };
    const heldAfterCatchup = frame();
    expect(frameSignature(heldAfterCatchup.plan)).toBe(frameSignature(catchup.plan));
    expect(activeUpdates(heldAfterCatchup.plan).length > 0).toBe(false);
    world.update(1 / 60).unwrap();
    const singleTick = frame();
    expect(frameSignature(singleTick.plan)).toBe(frameSignature(catchup.plan));
    expect(activeUpdates(singleTick.plan)).toHaveLength(1);
    const queuedContinuation = runtime.snapshot()[0];
    expect(queuedContinuation).toMatchObject({ phaseTick: 3, reset: false });
    if (queuedContinuation === undefined) throw new Error('queued continuation unavailable');
    const beforeRecovery = runtime.inspectPlayer(player);
    const countersBeforeRecovery = runtime.eventCounters(player);
    expect(
      buildVfxRecoveryIntents(runtime.lastCommittedEmitter(player, 'persistent')).map((intent) => ({
        phaseTick: intent.phaseTick,
        reset: intent.reset,
        spawnCount: intent.spawnCount,
      })),
    ).toEqual([
      { phaseTick: 0, reset: true, spawnCount: 1 },
      { phaseTick: 1, reset: false, spawnCount: 0 },
      { phaseTick: 2, reset: false, spawnCount: 0 },
    ]);
    const rejectedCandidate = frame([world], 1);
    expect(activeUpdates(rejectedCandidate.plan)).toHaveLength(4);
    consumer.onFrameAborted?.(rejectedCandidate.extracted);
    expect(runtime.snapshot()).toEqual([queuedContinuation]);
    const replacementDevice = frame([world], 1);
    expect(activeUpdates(replacementDevice.plan)).toHaveLength(4);
    expect(
      planResources(replacementDevice.plan).find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
      ),
    ).not.toHaveProperty('data');
    expect(
      planPasses(replacementDevice.plan).filter((pass) => pass.name.endsWith('.reset')),
    ).toHaveLength(1);
    expect(runtime.inspectPlayer(player)).toEqual(beforeRecovery);
    consumer.onFrameSubmitted?.(replacementDevice.extracted);
    feature.onSourceFrameSubmitted?.(
      replacementDevice.extracted,
      structuredClone(replacementDevice.plan.sourceFeedback),
    );
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.lastCommittedEmitter(player, 'persistent')?.sequence).toBe(
      queuedContinuation.sequence,
    );
    expect(runtime.eventCounters(player)).toEqual(countersBeforeRecovery);
    const recoveredPresentation = frame([world], 1);
    expect(activeUpdates(recoveredPresentation.plan)).toHaveLength(0);
    expect(
      planResources(recoveredPresentation.plan).find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
      ),
    ).not.toHaveProperty('data');

    const emptyQueueReplacement = frame([world], 2);
    expect(activeUpdates(emptyQueueReplacement.plan)).toHaveLength(4);
    expect(
      planResources(emptyQueueReplacement.plan).find(
        (resource) => resource.kind === 'buffer' && resource.name.endsWith('.particles'),
      ),
    ).not.toHaveProperty('data');
    expect(
      planPasses(emptyQueueReplacement.plan).filter((pass) => pass.name.endsWith('.reset')),
    ).toHaveLength(1);
    consumer.onFrameSubmitted?.(emptyQueueReplacement.extracted);
    feature.onSourceFrameSubmitted?.(
      emptyQueueReplacement.extracted,
      structuredClone(emptyQueueReplacement.plan.sourceFeedback),
    );
    expect(activeUpdates(frame([world], 2).plan)).toHaveLength(0);

    const priorPlayCycle = runtime.lastCommittedEmitter(player, 'persistent')?.playCycle;
    runtime.replay(player);
    world.update(1 / 60).unwrap();
    const replayIntent = runtime.snapshot()[0];
    expect(replayIntent).toMatchObject({ phaseTick: 0, reset: true });
    expect(replayIntent?.playCycle).not.toBe(priorPlayCycle);
    const replayOnReplacement = frame([world], 3);
    expect(activeUpdates(replayOnReplacement.plan)).toHaveLength(1);
    expect(particleName(replayOnReplacement.plan)).toBe(particleName(first.plan));
    consumer.onFrameSubmitted?.(replayOnReplacement.extracted);
    feature.onSourceFrameSubmitted?.(
      replayOnReplacement.extracted,
      structuredClone(replayOnReplacement.plan.sourceFeedback),
    );
    expect(runtime.lastCommittedEmitter(player, 'persistent')?.playCycle).toBe(
      replayIntent?.playCycle,
    );
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(1);
    world.despawn(player).unwrap();
    runtimeAssetRegistry(world.assets).release(handle).unwrap();
    world.update(0).unwrap();
    const removed = frame([world], 3);
    expect(removed.extracted.worlds[0]?.intents).toEqual([]);
    expect(removed.extracted.worlds[0]?.retained).toEqual([]);
    expect(planResources(removed.plan)).toEqual([]);
    expect(runtime.inspectPlayers()).toEqual([]);
    const replacementHandle = runtimeAssetRegistry(world.assets)
      .create(
        runtimeEffectFixture(world, {
          ...asset,
          guid: 'effect',
        }),
      )
      .unwrap();
    const replacement = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: replacementHandle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(1);
    world.removeComponent(replacement, ParticleEffectPlayer).unwrap();
    runtimeAssetRegistry(world.assets).release(replacementHandle).unwrap();
    world.update(0).unwrap();
    const removedComponent = frame([world], 3);
    expect(removedComponent.extracted.worlds[0]?.intents).toEqual([]);
    expect(removedComponent.extracted.worlds[0]?.retained).toEqual([]);
    expect(planResources(removedComponent.plan)).toEqual([]);
    expect(runtime.inspectPlayers()).toEqual([]);
    expect(planResources(frame([], 3).plan)).toEqual([]);
    const initialHandle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, { ...asset, guid: 'effect' }))
      .unwrap();
    const initialPlayer = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: initialHandle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    world.update(0).unwrap();
    const initialFrame = frame([world], 3);
    expect(initialFrame.extracted.worlds[0]?.intents).toHaveLength(1);
    expect(initialFrame.extracted.worlds[0]?.intents[0]).toMatchObject({
      player: initialPlayer,
      reset: true,
      delta: 0,
      spawnCount: 1,
      phaseTick: 0,
    });
    expect(activeUpdates(initialFrame.plan)).toHaveLength(1);
    // The still-queued tick is republished as a payload-free reference to the
    // receiver's cached copy; it still plans the same update.
    const republished = frame([world], 3);
    const {
      parameterBlock: _parameterBlock,
      canonicalPayload: _canonicalPayload,
      replayInput: _replayInput,
      channelInputs: _channelInputs,
      ...scalars
    } = initialFrame.extracted.worlds[0]?.intents[0] as never as Record<string, unknown>;
    expect(republished.extracted.worlds[0]?.intents).toEqual([{ ...scalars, payload: 'cached' }]);
    expect(activeUpdates(republished.plan)).toHaveLength(1);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(2);
    expect(runtime.snapshot()[1]).toMatchObject({
      reset: false,
      delta: 1 / 60,
      spawnCount: 0,
      phaseTick: 1,
    });
    world.despawn(initialPlayer).unwrap();
    runtimeAssetRegistry(world.assets).release(initialHandle).unwrap();
    expect(frame([world], 3).extracted.worlds[0]?.intents).toEqual([]);
  } finally {
    await context.fiber.dispose();
  }
});

it('resends a queued tick payload after a receiver miss or a discarded source publication', async () => {
  const { createVfxIntentPublication, createVfxIntentPayloads, isVfxIntentReference } =
    await import('../feature/intent-publication.js');
  const ledger = createVfxIntentPublication();
  const tick = (sequence: number) => ({
    sequence,
    player: 1,
    emitter: { id: 'e' },
    parameterBlock: new Uint8Array([sequence]),
    canonicalPayload: new Uint8Array(),
    replayInput: {},
    channelInputs: [],
  });
  const session = '0:0';
  expect(isVfxIntentReference(ledger.publish(session, tick(1), true, 10))).toBe(false);
  expect(isVfxIntentReference(ledger.publish(session, tick(1), true, 11))).toBe(true);
  // Field ticks are never referenced.
  expect(isVfxIntentReference(ledger.publish(session, tick(2), false, 11))).toBe(false);
  expect(isVfxIntentReference(ledger.publish(session, tick(2), false, 12))).toBe(false);
  // A discarded publication that first carried a payload makes it unsent again.
  expect(isVfxIntentReference(ledger.publish(session, tick(3), true, 12))).toBe(false);
  ledger.discard(12);
  expect(isVfxIntentReference(ledger.publish(session, tick(3), true, 13))).toBe(false);
  // A receiver miss resends the payload.
  ledger.forget(session, [1]);
  expect(isVfxIntentReference(ledger.publish(session, tick(1), true, 14))).toBe(false);
  // Ticks no longer queued and absent sessions are dropped.
  ledger.retain(new Map([[session, new Set(['1:e:3'])]]));
  expect(isVfxIntentReference(ledger.publish(session, tick(1), true, 15))).toBe(false);
  expect(isVfxIntentReference(ledger.publish(session, tick(3), true, 15))).toBe(true);

  // The receiver restores a reference from its session store, which survives device
  // replacement but not a new render generation.
  const payloads = createVfxIntentPayloads();
  const full = tick(5);
  payloads.begin(0, 0, [full]);
  expect(payloads.resolve(0, full)).toBe(full);
  const reference = ledger.publish(session, full, true, 16) && {
    ...full,
    payload: 'cached' as const,
  };
  payloads.begin(0, 0, [full]);
  expect(payloads.resolve(0, reference)).toMatchObject({
    sequence: 5,
    parameterBlock: full.parameterBlock,
  });
  payloads.begin(0, 1, [full]);
  expect(payloads.resolve(0, reference)).toBeUndefined();
});
