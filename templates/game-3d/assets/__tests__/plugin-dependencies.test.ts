import { Context, inspectPluginFiber, type Plugin } from '@forgeax/engine/plugin';
import { describe, expect, it } from 'vitest';
import { camera } from '../camera/camera.pack.ts';
import { player } from '../player/player.pack.ts';
import { ui } from '../ui/ui.pack.ts';
import { scene } from '../world/world.pack.ts';

const asset = '00000000-0000-4000-8000-000000000001';
const cases: { name: string; plugin: Plugin; missing: string; config: unknown }[] = [
  {
    name: 'camera requires the instantiated scene',
    plugin: camera,
    missing: 'gameScene',
    config: undefined,
  },
  {
    name: 'player requires physics',
    plugin: player,
    missing: 'physics',
    config: { speed: 5, jumpSpeed: 5, gravity: 9.8, walk: asset },
  },
  {
    name: 'scene requires physics before spawning',
    plugin: scene,
    missing: 'physics',
    config: { scene: asset, children: [] },
  },
  {
    name: 'UI requires assets before touching the DOM',
    plugin: ui,
    missing: 'assets',
    config: { guide: asset },
  },
];

describe('template plugin activation prerequisites', () => {
  for (const { name, plugin, missing, config } of cases) {
    it(name, async () => {
      const ctx = new Context();
      // Unused sentinels: any eager apply would fail instead of silently
      // substituting a fake World, physics backend, asset loader, or DOM.
      for (const service of [
        'world',
        'gameHost',
        'game3dPlayer',
        'gameScene',
        'physics',
        'assets',
        'pluginPrograms',
      ]) {
        if (
          service === missing ||
          (plugin === player && service === 'game3dPlayer') ||
          (plugin === scene && service === 'gameScene')
        )
          continue;
        ctx.provide(service, Object.freeze({}));
      }
      try {
        const fork = ctx.plugin(plugin, config);
        await fork.await();
        expect(inspectPluginFiber(fork.ctx.fiber)).toMatchObject({
          state: 'pending',
          missingServices: [missing],
        });
        if (plugin === player) expect(ctx.get('game3dPlayer')).toBeUndefined();
        if (plugin === scene) expect(ctx.get('gameScene')).toBeUndefined();
        await fork.dispose();
        expect(inspectPluginFiber(fork.ctx.fiber).state).toBe('disposed');
        expect([...ctx.registry.values()].flatMap((runtime) => runtime.fibers)).toHaveLength(0);
      } finally {
        await ctx.fiber.dispose();
      }
    });
  }
});
