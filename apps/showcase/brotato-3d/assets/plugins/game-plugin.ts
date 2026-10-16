import type { Plugin } from '@forgeax/engine-plugin';
import { BROTATO_COMPONENTS } from './components';
import { createBrotatoGame, type BrotatoGameOptions } from './gameplay';

export const gameplay: Plugin = {
  name: 'game-brotato-3d',
  inject: ['world', 'renderer', 'gameHost'],
  async apply(ctx) {
    const host = ctx.gameHost;
    if (host === undefined) throw new Error('Cordis activated game-brotato-3d without its Host provider');
    if (ctx.renderer === undefined) throw new Error('Cordis activated game-brotato-3d without its renderer provider');
    const leases = BROTATO_COMPONENTS.map((component) => ctx.world.components.register(component).unwrap());
    const query = typeof window === 'undefined' ? undefined : new URLSearchParams(window.location.search);
    const options: BrotatoGameOptions | undefined =
      query?.get('profile') === '1' || query?.get('survival') === '1'
        ? {
            survivalMode: true,
            ...(query?.get('profileNoPickups') === '1' ? { disablePickupDrops: true } : {}),
            ...(query?.get('profileNoParticles') === '1' ? { disableParticles: true } : {}),
          }
        : undefined;
    let game;
    try {
      game = await createBrotatoGame(ctx, ctx.world, host, host.assets, options);
    } catch (error) {
      console.error('[game-brotato-3d] create failed before runtime ownership was installed', error);
      for (const lease of leases) {
        const released = lease.dispose();
        if (!released.ok) console.error('[game-brotato-3d] component lease cleanup failed', released.error);
      }
      throw error;
    }
    ctx.effect(function* () {
      yield () => game.dispose();
      for (const lease of leases) yield () => lease.dispose().unwrap();
    }, 'game-brotato-3d/world-contributions');
  },
};
