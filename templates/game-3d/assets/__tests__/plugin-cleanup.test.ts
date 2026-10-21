import { AnimationPlayer } from '@forgeax/engine/animation';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import {
  disposePluginFiber,
  startNativePlugin,
  type Plugin,
  type PluginPrograms,
} from '@forgeax/engine/plugin';
import { Transform, worldInstantiateSceneAsset } from '@forgeax/engine/scene';
import { defineToolCommandContract } from '@forgeax/engine/tool-runtime';
import {
  ok,
  type AnimationClip,
  type PluginAssetDefinition,
  type PluginConfigValue,
} from '@forgeax/engine/types';
import { expect, it } from 'vitest';
import { game } from '../game.pack.ts';
import player from '../player/player.ts';
import { sceneWorldFixture } from '../shared/__tests__/plugin-fixture.ts';
import { resolveGameEntity } from '../shared/scene-refs.ts';
import { scene } from '../world/world.pack.ts';

const physicsGuid = '00000000-0000-4000-8000-000000000001';
const sceneGuid = '00000000-0000-4000-8000-000000000002';
const playerGuid = '00000000-0000-4000-8000-000000000003';
const failureGuid = '00000000-0000-4000-8000-000000000004';
const sceneAssetGuid = '00000000-0000-4000-8000-000000000005';
const clipGuid = '00000000-0000-4000-8000-000000000006';

for (const outcome of ['dispose', 'failed', 'timeout'] as const) {
  it(`joins player cleanup before scene and physics on ${outcome}`, async () => {
    const { ctx, world, asset, assets } = await sceneWorldFixture();
    const events: string[] = [];
    let playerEntity: EntityHandle | undefined;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const physics: Plugin.Object = {
      name: 'fixture-physics',
      apply(ctx) {
        ctx.provide('physics', {} as never);
        ctx.effect(() => () => {
          events.push('physics');
        });
      },
    };
    const failure: Plugin.Object =
      outcome === 'timeout'
        ? {
            name: 'fixture-pending',
            inject: ['game3dPlayer', 'missing-template-startup-service'],
            apply() {},
          }
        : {
            name: 'fixture-failure',
            inject: ['game3dPlayer'],
            apply() {
              throw new Error('template activation failure');
            },
          };
    const definitions = new Map<string, PluginAssetDefinition>();
    const evidenceByGuid = new Map<string, PluginAssetDefinition['evidence']>();
    const programEntries = new Map<string, { load: () => Promise<Plugin> }>();
    const toolEntries = new Map<string, ReturnType<typeof defineToolCommandContract>>();
    const programs: PluginPrograms = {
      sessionId: 'template-cleanup',
      contextId: 'engine',
      sessionGeneration: 1,
      target: 'engine',
      tools: toolEntries,
      definitions: evidenceByGuid,
      programs: programEntries,
    };
    const entries: [string, Plugin, PluginConfigValue][] = [
      [physicsGuid, physics, {}],
      [
        sceneGuid,
        scene,
        {
          scene: sceneAssetGuid,
          children: [playerGuid, ...(outcome === 'dispose' ? [] : [failureGuid])],
        },
      ],
      [playerGuid, player, { speed: 5.5, jumpSpeed: 6, gravity: 18, walk: clipGuid }],
      [failureGuid, failure, {}],
    ];
    for (const [guid, plugin, config] of entries) {
      const program = `fixture:${guid}`;
      const evidence = { kind: 'source', revision: '1', digest: guid } as const;
      definitions.set(guid, { guid, asset: { kind: 'plugin', program, config }, evidence });
      evidenceByGuid.set(guid, evidence);
      programEntries.set(program, { load: async () => plugin });
      toolEntries.set(guid, defineToolCommandContract([]));
    }
    ctx.provide('pluginPrograms', programs);
    ctx.provide('assets', {
      parseGuid: (guid: string) => AssetGuid.parse(guid),
      readPluginDefinition: async (guid: string) => ok(definitions.get(guid)!),
      load: async () => assets.create(asset),
      release: (handle: number) => assets.release(handle),
      instantiate: (handle: Parameters<typeof worldInstantiateSceneAsset>[1]) =>
        worldInstantiateSceneAsset(
          world,
          handle,
          asset,
          undefined,
          new Set(),
          undefined,
          'scene/showcase',
        ),
    } as never);
    const clip: AnimationClip = { kind: 'animation-clip', duration: 1, channels: [] };
    ctx.provide('gameHost', {
      assets: { load: async () => assets.create(clip), release: (handle: number) => assets.release(handle) },
      gameProjection: {
        registerRead: () => {
          playerEntity = resolveGameEntity(world, ctx.gameScene, 'player');
          return async () => {
            events.push('player-start');
            cleanupStarted();
            await cleanupGate;
            events.push('player-finish');
          };
        },
      },
    } as never);
    try {
      const startup = startNativePlugin(
        ctx,
        game,
        { children: [physicsGuid, sceneGuid] },
        { timeoutMs: 500 },
      );
      const finished =
        outcome === 'dispose' ? disposePluginFiber((await startup).unwrap()) : startup;
      await Promise.race([
        cleaning,
        finished.then((result) => {
          throw new Error(`cleanup never started: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(playerEntity).toBeDefined();
      expect(world.get(playerEntity!, Transform).ok).toBe(true);
      expect(world.get(playerEntity!, AnimationPlayer).ok).toBe(true);
      expect([...events]).toEqual(['player-start']);
      releaseCleanup();
      const result = await finished;
      expect(result).toMatchObject(
        outcome === 'dispose'
          ? { cleanup: 'completed' }
          : { ok: false, error: { detail: { reason: outcome, cleanup: 'completed' } } },
      );
      expect(events).toEqual(['player-start', 'player-finish', 'physics']);
      expect(world.get(playerEntity!, Transform).ok).toBe(false);
      expect(world.sharedRefs._liveCount()).toBe(0);
    } finally {
      releaseCleanup();
      await ctx.fiber.dispose();
    }
  });
}
