import { defineResource } from '@forgeax/engine-ecs';
// @forgeax/engine-net -- session plugin (host-neutral World integration).
// (requirements AC-04, plan-strategy D-1/D-3)

import { defineSystem, FixedUpdate, Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import { NetSession, type NetSessionConfig } from './net-session';

export const NetSessionResource = defineResource<NetSession>('net-session');

export type NetPluginConfig = Omit<NetSessionConfig, 'maxRawMessages'> & {
  readonly maxRawMessages?: NetSessionConfig['maxRawMessages'];
};

export function netPlugin(config: NetPluginConfig): Plugin {
  return {
    name: 'net-session',
    inject: ['world'],
    apply(ctx) {
      const world = ctx.world;
      const session = new NetSession({
        ...config,
        maxRawMessages: config.maxRawMessages ?? 256,
      });
      ctx.effect(() => {
        world.insertResource(NetSessionResource, session);
        if (config.connector !== undefined && config.endpoint === undefined) {
          session.recover();
          session.advanceRecovery();
        }
        return () => {
          session.dispose();
          world.removeResource(NetSessionResource);
        };
      }, 'net/session-resource');
      ctx.effect(() => {
        const systemToken1 = defineSystem({
          name: 'net-receive',
          queries: [],
          before: [FixedUpdate],
          fn: (world) => world.getResource(NetSessionResource).receiveEvents(),
        });
        world.addSystem(Update, systemToken1).unwrap();
        return () => world.removeSystem(Update, systemToken1);
      }, 'net/receive');
      ctx.effect(() => {
        const systemToken2 = defineSystem({
          name: 'net-publish',
          queries: [],
          after: [FixedUpdate],
          fn: (world) => {
            const published = world.getResource(NetSessionResource).publish();
            // An authority can temporarily outrun a replica while its
            // bounded ACK ledger is full. That is transport backpressure,
            // not a World fault: keep the simulation healthy and retry on
            // the next frame after the replica acknowledges a packet.
            if (
              !published.ok &&
              published.error.code === 'recovery-rejected' &&
              published.error.detail.reason === 'ACK ledger bound reached'
            )
              return;
            return published;
          },
        });
        world.addSystem(Update, systemToken2).unwrap();
        return () => world.removeSystem(Update, systemToken2);
      }, 'net/publish');
    },
  };
}
