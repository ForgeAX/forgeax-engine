/** One native VFX assembly is constructed independently in each execution realm. */
export const gameVfxSource = `import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
export function createGameVfx() {
  const host = createVfxRuntimeHost({
    camera: { read: (_world, views) => views[0]?.selectedView },
  });
  return {
    feature: host.feature,
    plugin: {
      name: 'forgeax:game-vfx',
      inject: ['world', 'assets'],
      async apply(ctx) {
        const attached = await host.attachWorld({ world: ctx.world, assets: ctx.assets });
        if (!attached.ok) throw attached.error;
        ctx.effect(() => async () => {
          const detached = await host.detachWorld({ world: ctx.world });
          if (!detached.ok) throw detached.error;
        }, 'devkit/game-vfx');
      },
    },
  };
}
`;
