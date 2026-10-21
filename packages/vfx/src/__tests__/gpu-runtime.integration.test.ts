import { readFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, FixedTime, World } from '@forgeax/engine-ecs';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { describe, expect, it, vi } from 'vitest';
import { createVfxEffectContract } from '../effect-contract.js';
import type { VfxGpuEffectAsset } from '../gpu-program.js';
import {
  buildVfxRecoveryIntents,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '../gpu-runtime.js';
import { ParticleEffectInstance } from '../instance.js';
import { VFX_PARTICLE_CORE_LAYOUT } from '../particle-layout.js';
import { ParticleEffectPlayer } from '../player.js';
import { runtimeEffectFixture } from './runtime-effect-fixture';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing VFX fixture input');
  return value;
}

function commitSnapshot(runtime: VfxGpuRuntime, count = Number.POSITIVE_INFINITY): void {
  runtime.commit(
    runtime
      .snapshot()
      .slice(0, count)
      .map((intent) => intent.sequence),
  );
}

const cookedFixture = (
  await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'sparks',
          capacity: 100_000,
          backend: { required: 'gpu' },
          space: 'world',
          schedule: { rate: 60, bursts: [{ time: 0, count: 7 }], loopDuration: 1 },
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          program: { module: 'sparks.vfx.wgsl' },
          renderers: [{ kind: 'billboard', material: 'material-guid' }],
          simulationWhenCulled: 'continue',
        },
      ],
    },
    {
      'sparks.vfx.wgsl': {
        entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>) { (*p).lifetime = 2.0; }
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>) { (*p).age += ctx.delta; }
`,
      },
    },
  )
).unwrap();
const effect: VfxGpuEffectAsset = {
  guid: 'effect-guid',
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: cookedFixture.fingerprint,
  emitters: [{ id: 'sparks', capacity: 100_000 }],
  program: { ...cookedFixture.program, fingerprint: cookedFixture.fingerprint },
};

async function recookEmitter(emitter: VfxGpuEffectAsset['program']['emitters'][number]) {
  const { wgsl: _wgsl, reflection: _reflection, module, channels, events, ...metadata } = emitter;
  return required(
    (
      await cookParticleCodeProgram(
        {
          schemaVersion: 3,
          emitters: [
            {
              ...metadata,
              program: { module },
              ...(channels?.length ? { channels } : {}),
              ...(events?.length ? { events } : {}),
            },
          ],
        },
        {
          [module]: {
            entry: `
#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
${emitter.forceFields === undefined ? '' : '#import forgeax_vfx::data::force_fields'}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function,VfxParticle>) { (*p).lifetime = 2.0; }
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function,VfxParticle>) { (*p).age += ctx.delta; }
`,
          },
        },
      )
    ).unwrap().program.emitters[0],
  );
}

describe('GPU VFX fixed-tick intents', () => {
  it('does no player discovery or asset polling during unchanged paused ticks', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const handle = assets.create(runtimeEffectFixture(world, effect)).unwrap();
    const players = Array.from({ length: 1000 }, () =>
      world
        .spawn({ component: ParticleEffectPlayer, data: { effect: handle, playing: false } })
        .unwrap(),
    );
    const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    try {
      world.update(1 / 60).unwrap();
      const query = vi.spyOn(world, 'query');
      const read = vi.spyOn(world, 'get');
      const version = vi.spyOn(runtimeAssets(assets), 'version');
      try {
        for (let tick = 0; tick < 60; tick++) world.update(1 / 60).unwrap();
        expect(query).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(version).not.toHaveBeenCalled();
        expect(runtime.snapshot()).toHaveLength(0);
        // A source edit cannot awaken or walk paused consumers.
        assets
          .update(handle, {
            program: {
              ...runtimeEffectFixture(world, effect).program,
              emitters: runtimeEffectFixture(world, effect).program.emitters.map((emitter) => ({
                ...emitter,
                schedule: { ...emitter.schedule, rate: 0 },
              })),
            },
          })
          .unwrap();
        version.mockClear();
        world.update(1 / 60).unwrap();
        expect(version).not.toHaveBeenCalled();
        expect(runtime.snapshot()).toHaveLength(0);
      } finally {
        query.mockRestore();
        read.mockRestore();
        version.mockRestore();
      }
      const removed = required(players[500]);
      world.despawn(removed).unwrap();
      const visited: number[] = [];
      runtime.forEachEmitterSource(world, (source) => visited.push(source.player));
      expect(visited).toHaveLength(999);
      expect(visited).not.toContain(removed);
      const replacement = world
        .spawn({ component: ParticleEffectPlayer, data: { effect: handle, playing: false } })
        .unwrap();
      const current: number[] = [];
      runtime.forEachEmitterSource(world, (source) => current.push(source.player));
      expect(current).toHaveLength(1000);
      expect(current).toContain(replacement);
      expect(current).not.toContain(removed);
    } finally {
      await ctx.fiber.dispose();
      assets.dispose();
    }
  });

  it('captures anonymous force-field content at each tick without changing earlier queued inputs', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const samples = new Float32Array(2 * 2 * 2 * 4).fill(1);
    const texture = assets
      .create({
        kind: 'texture',
        shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
        format: 'rgba32float',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: new Uint8Array(samples.buffer),
      })
      .unwrap();
    const emitter = await recookEmitter({
      ...required(effect.program.emitters[0]),
      forceFields: [
        {
          kind: 'vector',
          texture: '01a11250-0000-7000-8000-000000000001',
          sampling: 'nearest',
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          strength: 1,
          attenuation: 0,
        },
      ],
    });
    const handle = assets
      .create(
        runtimeEffectFixture(world, {
          ...effect,
          program: {
            ...effect.program,
            emitters: [
              {
                ...emitter,
                forceFields: (emitter.forceFields ?? []).map((field) =>
                  field.kind === 'vector' ? { ...field, texture } : field,
                ),
              },
            ],
          },
        }),
      )
      .unwrap();
    const player = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle } })
      .unwrap();
    const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    const fieldValue = (intent: import('../gpu-runtime').VfxGpuTickIntent) => {
      const bytes = required(runtime.fieldTextureVersions(required(intent.forceFields).unwrap())[0])
        .value.data;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
    };
    try {
      assets.release(texture).unwrap();
      expect(assets.validate(texture, 'texture').ok).toBe(true);
      world.update(1 / 60).unwrap();
      const first = required(runtime.snapshot()[0]);
      expect(fieldValue(first)).toBe(1);
      const changed = new Float32Array(samples.length).fill(2);
      assets.update(texture, { data: new Uint8Array(changed.buffer) }).unwrap();
      expect(fieldValue(first)).toBe(1);
      world.update(1 / 60).unwrap();
      const second = required(runtime.snapshot().at(-1));
      expect(fieldValue(second)).toBe(2);
      expect(second.reset).toBe(false);
      expect(second.forceFields?.unwrap()).not.toBe(first.forceFields?.unwrap());
      world.update(1 / 60).unwrap();
      expect(runtime.snapshot().at(-1)?.forceFields?.unwrap()).toBe(second.forceFields?.unwrap());
      runtime.commit(first.sequence);
      expect(fieldValue(required(runtime.lastCommitted(player)))).toBe(1);
    } finally {
      await ctx.fiber.dispose();
      world.despawn(player).unwrap();
      assets.release(handle).unwrap();
      expect(assets.validate(texture).ok).toBe(false);
      assets.dispose();
    }
  });
  it('adopts an edited definition on FixedUpdate while queued ticks retain their exact version', async () => {
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const handle = assets.create(runtimeEffectFixture(world, effect)).unwrap();
    const material = required(
      assets.read(handle).unwrap().program.emitters[0]?.renderers[0],
    ).material;
    assets.release(material as import('@forgeax/engine-types').AssetHandle<'material'>).unwrap();
    const player = world
      .spawn({ component: ParticleEffectPlayer, data: { effect: handle } })
      .unwrap();
    const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    try {
      world.update(1 / 60).unwrap();
      const old = runtime.snapshot()[0];
      if (old === undefined) throw new Error('missing initial intent');
      const updated = runtimeEffectFixture(world, structuredClone(effect));
      const emitter = updated.program.emitters[0];
      if (emitter === undefined) throw new Error('missing emitter');
      assets
        .update(handle, {
          program: { ...updated.program, emitters: [{ ...emitter, schedule: { rate: 600 } }] },
        })
        .unwrap();
      expect(old.emitter.schedule.rate).toBe(60);
      expect(runtime.effectVersion(old.effect).handle).toBe(handle);
      world.update(1 / 60).unwrap();
      const next = runtime.snapshot().at(-1);
      if (next === undefined) throw new Error('missing edited intent');
      expect(next.emitter.schedule.rate).toBe(600);
      expect(next.spawnCount).toBe(10);
      expect(next.reset).toBe(true);
      expect(next.playCycle).toBe(old.playCycle + 1);
      expect(next.phaseTick).toBe(0);
      expect(runtime.effectVersion(next.effect).handle).toBe(handle);
      expect(runtime.effectVersion(next.effect).revision).toBeGreaterThan(
        runtime.effectVersion(old.effect).revision,
      );
      expect(runtimeAssets(assets).inspect().snapshots).toBe(2);
      runtime.commit(old.sequence);
      expect(runtime.lastCommitted(player)?.emitter.schedule.rate).toBe(60);
      runtime.commit(next.sequence);
      expect(runtime.lastCommitted(player)?.emitter.schedule.rate).toBe(600);
      expect(runtimeAssets(assets).inspect().snapshots).toBe(1);
      world.despawn(player).unwrap();
      runtime.forEachEmitterSource(world, () => {});
      expect(runtimeAssets(assets).inspect().snapshots).toBe(0);
      assets.release(handle).unwrap();
      expect(runtimeAssets(assets).inspect().assets).toBe(0);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('uses the ordinary asset program as the playback source', () => {
    const asset: ParticleEffectAsset = effect;
    expect(asset.program.fingerprint).toBe(asset.programFingerprint);
    expect(asset.program.emitters).toHaveLength(1);
  });

  it('keeps skipped queue acknowledgements out of the retained GPU state', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    const first = runtime.snapshot()[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    runtime.commit(first.sequence);
    expect(runtime.lastCommittedEmitter(player, 'sparks')?.sequence).toBe(first.sequence);

    world.update(1 / 60).unwrap();
    const skipped = runtime.snapshot()[0];
    expect(skipped).toBeDefined();
    if (skipped === undefined) return;
    // Queue acknowledgement alone must not publish a state whose GPU
    // simulation/history was never submitted.
    runtime.commit(skipped.sequence, []);
    expect(runtime.lastCommittedEmitter(player, 'sparks')?.sequence).toBe(first.sequence);

    world.update(1 / 60).unwrap();
    const dispatched = runtime.snapshot()[0];
    expect(dispatched).toBeDefined();
    if (dispatched === undefined) return;
    runtime.commit(dispatched.sequence, [dispatched.sequence]);
    expect(runtime.lastCommittedEmitter(player, 'sparks')?.sequence).toBe(dispatched.sequence);
  });

  it('restarts same-seed playback after source observes paused preparation', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: handle,
          playing: true,
          preparePipelines: true,
          seed: 9,
          timeScale: 1,
        },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    world.update(1 / 60).unwrap();
    const queued = runtime.snapshot()[0];
    expect(queued?.reset).toBe(true);
    if (queued === undefined) throw new Error('missing initial reset');
    // Park and resume between fixed ticks. The first render acknowledgement
    // can still be in flight when the next actual playback tick is queued.
    world.set(player, ParticleEffectPlayer, { playing: false }).unwrap();
    runtime.forEachEmitterSource(world, () => {});
    world.set(player, ParticleEffectPlayer, { playing: true }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(2);
    expect(runtime.snapshot()[1]?.reset).toBe(true);
    expect(runtime.snapshot()[1]?.playCycle).toBeGreaterThan(queued.playCycle);
    runtime.commit([queued.sequence], []);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]?.reset).toBe(true);
    expect(runtime.lastCommittedEmitter(player, 'sparks')).toBeUndefined();
  });

  it('defers a seed reset until a session-disabled emitter can submit', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 30).unwrap();
    const firstIntents = [...runtime.snapshot()];
    const first = firstIntents.find((intent) => intent.reset);
    expect(first).toMatchObject({ reset: true, seed: 1, phaseTick: 0 });
    if (first === undefined) return;
    const firstTerminal = firstIntents.at(-1);
    if (firstTerminal === undefined) return;
    runtime.commit(
      firstTerminal.sequence,
      firstIntents.map((intent) => intent.sequence),
    );
    expect(runtime.lastCommittedEmitter(player, 'sparks')).toMatchObject({ seed: 1 });

    runtime.setEmitterSessionEnabled(player, 'sparks', false);
    world.set(player, ParticleEffectPlayer, { seed: 2 }).unwrap();
    world.update(0).unwrap();
    world.update(1 / 30).unwrap();
    world.update(1 / 30).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.inspectPlayer(player)?.lastCommitted?.sequence).toBe(firstTerminal.sequence);
    expect(runtime.lastCommittedEmitter(player, 'sparks')?.seed).toBe(1);

    runtime.setEmitterSessionEnabled(player, 'sparks', true);
    world.update(1 / 30).unwrap();
    const resumed = runtime.snapshot().find((intent) => intent.reset);
    expect(resumed).toMatchObject({ reset: true, seed: 2, phaseTick: 0 });
    if (resumed === undefined) return;
    const resumedIntents = [...runtime.snapshot()];
    const resumedTerminal = resumedIntents.at(-1);
    if (resumedTerminal === undefined) return;
    runtime.commit(
      resumedTerminal.sequence,
      resumedIntents.map((intent) => intent.sequence),
    );
    expect(runtime.lastCommittedEmitter(player, 'sparks')).toMatchObject({ seed: 2 });
  });

  it('keeps a disabled emitter reset pending when a sibling emitter stays active', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const multiEmitterEffect = structuredClone(effect) as VfxGpuEffectAsset;
    const primary = multiEmitterEffect.program.emitters[0];
    if (primary === undefined) return;
    const emitters = multiEmitterEffect.program
      .emitters as unknown as VfxGpuEffectAsset['program']['emitters'][number][];
    emitters.splice(0, 1, primary, {
      ...primary,
      id: 'healthy',
      module: 'healthy.vfx.wgsl',
    });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, multiEmitterEffect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 30).unwrap();
    const firstIntents = [...runtime.snapshot()];
    const firstTerminal = firstIntents.at(-1);
    if (firstTerminal === undefined) return;
    runtime.commit(
      firstTerminal.sequence,
      firstIntents.map((intent) => intent.sequence),
    );
    expect(runtime.lastCommittedEmitter(player, 'sparks')?.seed).toBe(1);
    expect(runtime.lastCommittedEmitter(player, 'healthy')?.seed).toBe(1);

    runtime.setEmitterSessionEnabled(player, 'sparks', false);
    world.set(player, ParticleEffectPlayer, { seed: 2 }).unwrap();
    world.update(0).unwrap();
    world.update(1 / 30).unwrap();
    const healthyDuringPause = runtime
      .snapshot()
      .filter((intent) => intent.emitter.id === 'healthy');
    expect(healthyDuringPause.some((intent) => intent.reset && intent.seed === 2)).toBe(true);
    expect(runtime.snapshot().some((intent) => intent.emitter.id === 'sparks')).toBe(false);
    const healthyTerminal = runtime.snapshot().at(-1);
    if (healthyTerminal === undefined) return;
    runtime.commit(
      healthyTerminal.sequence,
      runtime.snapshot().map((intent) => intent.sequence),
    );

    runtime.setEmitterSessionEnabled(player, 'sparks', true);
    world.update(1 / 30).unwrap();
    const resumed = runtime
      .snapshot()
      .find((intent) => intent.emitter.id === 'sparks' && intent.reset);
    expect(resumed).toMatchObject({ seed: 2, reset: true, phaseTick: 0, spawnCount: 8 });
  });

  it('keeps stage recovery scoped to the cooked generation', () => {
    const source = readFileSync(new URL('../gpu-runtime.ts', import.meta.url), 'utf8');
    expect(source).toContain('instanceGeneration');
    expect(source).not.toContain('runtimeCompiler');
  });

  it('uploads channel inputs with the fixed tick and isolates per-player overflow', async () => {
    const channelEffect = structuredClone(effect) as VfxGpuEffectAsset;
    const channelEmitters = channelEffect.program.emitters as unknown as Array<
      Record<string, unknown>
    >;
    channelEmitters[0] = {
      ...channelEmitters[0],
      channels: [{ id: 'impact', capacity: 1, overflow: 'drop-newest' }],
      events: [
        {
          id: 'impact-event',
          channel: 'impact',
          subEmitter: 'sparks',
          fanOut: 1,
          recursionDepth: 1,
        },
      ],
    };
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, channelEffect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 2 })]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    world.update(1 / 60).unwrap();
    const instance = runtime.getInstance(player);
    expect(instance).toBeDefined();
    if (instance === undefined) return;
    const first = (instance as unknown as { submit(input: unknown): { ok: boolean } }).submit({
      channel: 'impact',
      payload: { position: [0, 1, 0], strength: 1 },
      sequence: 1,
    });
    const second = (instance as unknown as { submit(input: unknown): { ok: boolean } }).submit({
      channel: 'impact',
      payload: { position: [0, 1, 0], strength: 1 },
      sequence: 2,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot().find((intent) => intent.channelInputs.length > 0)).toMatchObject({
      channelInputs: [{ channel: 'impact' }],
    });
  });

  it('publishes multiple same-tick patches as one atomic instance generation', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    const contract = createVfxEffectContract({
      version: 3,
      parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
      custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
      core: VFX_PARTICLE_CORE_LAYOUT,
      customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
      fingerprint: 'sha256:atomic-patch',
    });
    const instance = new ParticleEffectInstance(contract);
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    runtime.attachInstance(player, instance);
    expect(instance.patch({}).ok).toBe(true);
    expect(instance.patch({}).ok).toBe(true);

    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({
      tick: 1,
      instanceGeneration: 1,
      instancePatchCount: 2,
    });
    expect(runtime.snapshot()[0]?.canonicalPayload).toBeInstanceOf(Uint8Array);
  });

  it('drops stale instances at a new render generation and restarts from authored state', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    const stale = runtime.getInstance(player);
    expect(stale).toBeDefined();
    expect(runtime.renderGeneration).toBe(0);

    runtime.recover();

    expect(runtime.renderGeneration).toBe(1);
    expect(runtime.hasPlayer(player)).toBe(false);
    expect(runtime.getInstance(player)).toBeUndefined();
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.lastCommitted(player)).toBeUndefined();

    expect(stale?.patch({}).ok).toBe(true);
    world.update(1 / 60).unwrap();
    const restarted = runtime.getInstance(player);
    expect(restarted).toBeDefined();
    expect(restarted).not.toBe(stale);
    expect(runtime.inspectPlayer(player)?.values.generation).toBe(0);

    expect(restarted?.patch({}).ok).toBe(true);
    world.update(1 / 60).unwrap();
    expect(runtime.inspectPlayer(player)?.values.generation).toBe(1);
  });

  it('fires time-zero once and keeps tick commands bounded and ordered', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const spawned = world.spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
    });
    expect(spawned.ok).toBe(true);
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 2 })]);

    expect(world.update(1 / 60).ok).toBe(true);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({ reset: true, spawnCount: 8, firstParticleId: 0 });
    commitSnapshot(runtime, 1);

    expect(world.update(1 / 60).ok).toBe(true);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({
      reset: false,
      spawnCount: 1,
      firstParticleId: 8,
    });
  });

  it('replays an emitter time-zero schedule when a session mask enables it later', async () => {
    const delayedEffect = structuredClone(effect) as VfxGpuEffectAsset;
    const firstEmitter = delayedEffect.program.emitters[0];
    expect(firstEmitter).toBeDefined();
    if (firstEmitter === undefined) return;
    const delayedEmitter = {
      ...firstEmitter,
      id: 'delayed',
      capacity: 16,
      schedule: { rate: 0, bursts: [{ time: 0, count: 3 }] },
    };
    (delayedEffect.program.emitters as VfxGpuEffectAsset['program']['emitters'][number][]).push(
      delayedEmitter,
    );
    (delayedEffect.emitters as { id: string; capacity: number }[]).push({
      id: 'delayed',
      capacity: delayedEmitter.capacity,
    });

    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, delayedEffect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    runtime.setEmitterSessionEnabled(player, 'delayed', false);

    world.update(1 / 60).unwrap();
    expect(runtime.snapshot().some((intent) => intent.emitter.id === 'delayed')).toBe(false);
    commitSnapshot(runtime);

    runtime.setEmitterSessionEnabled(player, 'delayed', true);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot().find((intent) => intent.emitter.id === 'delayed')).toMatchObject({
      reset: true,
      phaseTick: 0,
      spawnCount: 3,
      firstParticleId: 0,
    });
  });

  it('replays an authored stopped player without mutating author intent', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: false, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(0);

    runtime.replay(player);
    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()[0]).toMatchObject({
      player,
      reset: true,
      phaseTick: 0,
      spawnCount: 8,
      firstParticleId: 0,
    });
    expect(world.get(player, ParticleEffectPlayer).unwrap().playing).toBe(false);

    commitSnapshot(runtime, 1);
    world.update(1 / 60).unwrap();

    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.inspectPlayer(player)?.playing).toBe(false);
  });

  it('holds time during cold GPU preparation, then diagnoses post-start backpressure', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.diagnostics()).toHaveLength(0);
    commitSnapshot(runtime, 1);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.diagnostics().at(-1)?.code).toBe('vfx-intent-queue-overflow');
    commitSnapshot(runtime);
    expect(runtime.diagnostics()).toEqual([]);
  });

  it('makes an explicit replay boundary discard an overflowing player queue', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    commitSnapshot(runtime, 1);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics()).toHaveLength(1);
    expect(runtime.diagnostics()[0]).toMatchObject({
      code: 'vfx-intent-queue-overflow',
      detail: { player, maxQueuedTicks: 1 },
    });
    expect(runtime.inspectPlayer(player)).toMatchObject({
      queuedIntents: 1,
      queuedTicks: 1,
      lastCommitted: {
        tick: 1,
        phaseTick: 0,
        playCycle: 0,
        firstParticleId: 0,
      },
    });

    runtime.replay(player);

    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.diagnostics()).toEqual([]);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({
      player,
      reset: true,
      phaseTick: 0,
      playCycle: 1,
      firstParticleId: 0,
    });
    expect(runtime.inspectPlayer(player)).toMatchObject({
      queuedIntents: 1,
      queuedTicks: 1,
      emitters: [{ phaseTick: 0, playCycle: 1, firstParticleId: 0, reset: true }],
      lastCommitted: {
        tick: 1,
        phaseTick: 0,
        playCycle: 0,
        firstParticleId: 0,
      },
    });
  });

  it('deduplicates active overflow diagnostics after another diagnostic interleaves', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    commitSnapshot(runtime, 1);
    world.update(1 / 60).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics()).toHaveLength(1);

    world.set(player, ParticleEffectPlayer, { timeScale: -1 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics()).toHaveLength(2);

    world.set(player, ParticleEffectPlayer, { timeScale: 1 }).unwrap();
    world.update(1 / 60).unwrap();

    expect(runtime.diagnostics()).toHaveLength(1);
    expect(runtime.diagnostics()[0]).toMatchObject({
      code: 'vfx-intent-queue-overflow',
      detail: { player, maxQueuedTicks: 1 },
    });
  });

  it('bounds each player independently', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const first = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 2, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin({ maxQueuedTicks: 1 })]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    expect(runtime.snapshot()).toHaveLength(2);
    expect(runtime.snapshot().map((intent) => intent.player)).toContain(first);
  });

  it('inspects every player and emitter by stable runtime identity', async () => {
    const multiEmitter = structuredClone(effect) as VfxGpuEffectAsset;
    const firstEmitter = multiEmitter.program.emitters[0];
    expect(firstEmitter).toBeDefined();
    if (firstEmitter === undefined) return;
    const secondEmitter = await recookEmitter({
      ...firstEmitter,
      id: 'smoke',
      module: 'smoke.vfx.wgsl',
      capacity: 64,
      renderers: [
        { kind: 'trail' as const, material: 'smoke-material', historyLength: 4, capacity: 64 },
      ],
    });
    (multiEmitter.program.emitters as VfxGpuEffectAsset['program']['emitters'][number][]).push(
      secondEmitter,
    );
    (multiEmitter.emitters as { id: string; capacity: number }[]).push({
      id: 'smoke',
      capacity: 64,
    });
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, multiEmitter))
      .unwrap();
    const first = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
      })
      .unwrap();
    const second = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 2, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    expect(runtime.inspectPlayers()).toEqual([
      expect.objectContaining({
        player: first,
        assetGuid: 'effect-guid',
        programFingerprint: runtimeAssetRegistry(world.assets).read(handle).unwrap().program
          .fingerprint,
        seed: 1,
        fixedDelta: 1 / 60,
        emitters: [
          expect.objectContaining({
            id: 'sparks',
            module: 'sparks.vfx.wgsl',
            cameraVisible: true,
            sessionEnabled: true,
            phaseTick: 0,
          }),
          expect.objectContaining({
            id: 'smoke',
            module: 'smoke.vfx.wgsl',
            cameraVisible: true,
            sessionEnabled: true,
            phaseTick: 0,
          }),
        ],
      }),
      expect.objectContaining({ player: second }),
    ]);

    runtime.setEmitterCameraVisibility(first, 'smoke', false);
    expect(runtime.inspectPlayer(first)?.emitters[1]).toMatchObject({
      id: 'smoke',
      cameraVisible: false,
      sessionEnabled: true,
    });
    expect(runtime.inspectPlayer(999 as never)).toBeUndefined();
  });

  it('rejects obsolete effects at admission and clears invalid player diagnostics', async () => {
    const world = new World({ assets: new AssetRegistry() });
    expect(
      runtimeAssetRegistry(world.assets).create({ ...effect, schemaVersion: 1 } as never).ok,
    ).toBe(false);
    const available = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: available, playing: true, seed: 3, timeScale: -1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);

    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics().map((diagnostic) => diagnostic.code)).toEqual([
      'vfx-player-invalid',
    ]);

    world.set(player, ParticleEffectPlayer, { timeScale: 1 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.diagnostics()).toEqual([]);
  });

  it.each([
    ['pause', false, 8],
    ['restart-on-visible', true, 0],
  ] as const)('%s applies culling lifecycle at fixed-tick boundaries', async (policy, reset, firstParticleId) => {
    const world = new World({ assets: new AssetRegistry() });
    const policyEffect = structuredClone(effect) as VfxGpuEffectAsset;
    (policyEffect.program.emitters[0] as { simulationWhenCulled: string }).simulationWhenCulled =
      policy;
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, policyEffect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 9, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    commitSnapshot(runtime, 1);

    runtime.setEmitterCameraVisibility(player, 'sparks', false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);

    runtime.setEmitterCameraVisibility(player, 'sparks', true);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({
      reset,
      firstParticleId,
      phaseTick: reset ? 0 : 1,
    });
  });

  it('keeps editor session masks independent from camera culling and authored enablement', async () => {
    const world = new World({ assets: new AssetRegistry() });
    const handle = runtimeAssetRegistry(world.assets)
      .create(runtimeEffectFixture(world, effect))
      .unwrap();
    const player = world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect: handle, playing: true, seed: 4, timeScale: 1 },
      })
      .unwrap();
    await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    world.update(1 / 60).unwrap();
    const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    commitSnapshot(runtime, 1);

    runtime.setEmitterSessionEnabled(player, 'sparks', false);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({
      cameraVisible: true,
      sessionEnabled: false,
      phaseTick: 0,
    });

    runtime.setEmitterCameraVisibility(player, 'sparks', false);
    runtime.setEmitterSessionEnabled(player, 'sparks', true);
    expect(runtime.isEmitterSessionEnabled(player, 'sparks')).toBe(true);
    expect(runtime.inspectPlayer(player)?.emitters[0]).toMatchObject({
      cameraVisible: false,
      sessionEnabled: true,
    });

    runtime.setEmitterCameraVisibility(player, 'sparks', true);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({ reset: false, phaseTick: 1 });
  });
});

it('keeps paused stable frames idle but executes zero-time reset and replay', async () => {
  const world = new World({ assets: new AssetRegistry() });
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, effect))
    .unwrap();
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 0 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  try {
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({ reset: true, fixedDelta: 0, phaseTick: 0 });
    commitSnapshot(runtime);
    for (let index = 0; index < 10; index += 1) world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    const instance = runtime.getInstance(player);
    if (instance === undefined) throw new Error('Missing paused instance');
    instance.patch({}).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({
      reset: false,
      fixedDelta: 0,
      instancePatchCount: 1,
    });
    commitSnapshot(runtime);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(0);
    runtime.replay(player);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({ reset: true, fixedDelta: 0, phaseTick: 0 });
    commitSnapshot(runtime);
    world.set(player, ParticleEffectPlayer, { timeScale: 1 }).unwrap();
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({ reset: false, fixedDelta: 1 / 60, phaseTick: 1 });
  } finally {
    await context.fiber.dispose();
  }
});

it('admits a new player without consuming later fixed-time patches or replay', async () => {
  const world = new World({ assets: new AssetRegistry() });
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, effect))
    .unwrap();
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  try {
    const tick = world.getResource(FixedTime).tick;
    runtime.forEachEmitterSource(world, () => {});
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]).toMatchObject({
      reset: true,
      fixedDelta: 0,
      spawnCount: 7,
      phaseTick: 0,
    });
    const initialSequence = runtime.snapshot()[0]?.sequence;
    expect(world.getResource(FixedTime).tick).toBe(tick);
    const instance = runtime.getInstance(player);
    if (instance === undefined) throw new Error('Missing initialized instance');
    instance.patch({}).unwrap();
    world.update(1 / 120).unwrap();
    runtime.forEachEmitterSource(world, () => {});
    expect(runtime.snapshot()).toHaveLength(1);
    expect(runtime.snapshot()[0]?.sequence).toBe(initialSequence);
    expect(instance.pendingPatchCount).toBe(1);
    world.update(1 / 120).unwrap();
    expect(runtime.snapshot()[1]).toMatchObject({
      reset: false,
      fixedDelta: 1 / 60,
      spawnCount: 1,
      phaseTick: 1,
      instancePatchCount: 1,
    });
    expect(
      buildVfxRecoveryIntents(runtime.snapshot()[1]).map((intent) => ({
        fixedDelta: intent.fixedDelta,
        tick: intent.tick,
        spawnCount: intent.spawnCount,
      })),
    ).toEqual([
      { fixedDelta: 0, tick, spawnCount: 7 },
      { fixedDelta: 1 / 60, tick: tick + 1, spawnCount: 1 },
    ]);
    runtime.replay(player);
    runtime.forEachEmitterSource(world, () => {});
    expect(runtime.snapshot()).toHaveLength(0);
    world.update(1 / 60).unwrap();
    expect(runtime.snapshot()[0]).toMatchObject({
      reset: true,
      fixedDelta: 1 / 60,
      spawnCount: 8,
      phaseTick: 0,
    });
  } finally {
    world.despawn(player).unwrap();
    runtimeAssetRegistry(world.assets).release(handle).unwrap();
    await context.fiber.dispose();
  }
});
