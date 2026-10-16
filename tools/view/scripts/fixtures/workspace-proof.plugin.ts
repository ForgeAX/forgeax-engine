import { defineComponent, Update } from '@forgeax/engine/ecs';
import type { Plugin } from '@forgeax/engine/plugin';
import { ChildOf, Name, Transform, worldDespawnScene } from '@forgeax/engine/scene';
import type { SceneAsset } from '@forgeax/engine/types';

const ProofClock = defineComponent('ProofClock', { frames: 'u32' });

/** Ordinary game-owned ECS activity: the tools receive no game-specific callback. */
const plugin: Plugin.Object<{ readonly scene: string }> = {
  name: 'workspace-proof-game',
  inject: ['world', 'gameHost', 'assets'],
  async apply(ctx, config) {
    const world = ctx.world;
    const assets = ctx.assets;
    if (!assets) throw new Error('workspace proof game requires assets');
    const loaded = await assets.loadByGuid<SceneAsset>(assets.parseGuid(config.scene));
    if (!loaded.ok) throw loaded.error;
    await ctx.effect(async function* () {
      const handle = world.allocSharedRef('SceneAsset', loaded.value);
      yield () => world.sharedRefs.release(handle).unwrap();
      const root = assets.instantiate<SceneAsset>(handle, world).unwrap();
      yield () => worldDespawnScene(world, root).unwrap();
    });
    let fail = false;
    const controlChannel = `workspace-proof-${crypto.randomUUID()}`;
    const control = new BroadcastChannel(controlChannel);
    ctx.effect(() => {
      control.onmessage = (event) => { if (event.data?.type === 'fail') fail = true; };
      const unregister = ctx.gameHost.gameProjection?.registerRead({
        id: 'workspace-proof.control',
        title: 'Workspace proof control channel',
        description: 'Target-local test channel for the runtime failure proof.',
        read: () => ({ channel: controlChannel }),
      });
      return () => { unregister?.(); control.close(); };
    });
    const component = world.components.register(ProofClock).unwrap();
    const clock = world.spawn(
      { component: Name, data: { value: 'Runtime clock' } },
      { component: ProofClock, data: { frames: 0 } },
      { component: Transform, data: {} },
    ).unwrap();
    const branch = world.spawn({ component: Name, data: { value: 'Runtime branch' } }, { component: Transform, data: {} }).unwrap();
    let transient: typeof clock | undefined;
    let frame = 0;
    world.addSystem(Update, {
      name: 'workspace-proof-clock', queries: [],
      fn() {
        if (fail) throw new Error('workspace-proof-intentional-system-failure');
        frame++;
        world.set(clock, ProofClock, { frames: frame }).unwrap();
        if (frame % 60 === 1) {
          transient = world.spawn(
            { component: Name, data: { value: 'Runtime transient' } },
            { component: ChildOf, data: { parent: clock } },
          ).unwrap();
        }
        if (frame % 60 === 15 && transient !== undefined) world.set(transient, ChildOf, { parent: branch }).unwrap();
        if (frame % 60 === 31 && transient !== undefined) {
          world.despawn(transient).unwrap();
          transient = undefined;
        }
      },
    }).unwrap();
    ctx.effect(() => () => {
      world.removeSystem(Update, 'workspace-proof-clock').unwrap();
      if (transient !== undefined) world.despawn(transient).unwrap();
      world.despawn(clock).unwrap();
      world.despawn(branch).unwrap();
      component.dispose().unwrap();
    });
  },
};
export default plugin;
