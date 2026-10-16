// @forgeax/engine-net -- session plugin (host-neutral World integration).
// (requirements AC-04, plan-strategy D-1/D-3)

import { FixedUpdate, Update } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import type { NetEndpoint, NetEndpointConnector } from '../endpoint/endpoint';
import { NetSession, type NetSessionClock } from './net-session';
import type { NetRecoveryPolicy } from './recovery';

export interface NetPluginConfig {
  readonly endpoint?: NetEndpoint;
  readonly connector?: NetEndpointConnector;
  readonly sessionId?: number;
  readonly recovery?: Partial<NetRecoveryPolicy>;
  readonly clock?: NetSessionClock;
  readonly maxRawMessages?: number;
}

export function netPlugin(config: NetPluginConfig): Plugin {
  return {
    name: 'net-session',
    inject: ['world'],
    apply(ctx) {
      const world = ctx.world;
      const session = new NetSession({
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        ...(config.connector === undefined ? {} : { connector: config.connector }),
        ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
        ...(config.recovery === undefined ? {} : { recovery: config.recovery }),
        ...(config.clock === undefined ? {} : { clock: config.clock }),
        maxRawMessages: config.maxRawMessages ?? 256,
      });
      ctx.effect(() => {
        world.insertResource('net-session', session);
        if (config.connector !== undefined && config.endpoint === undefined) {
          session.recover();
          session.advanceRecovery();
        }
        return () => {
          session.dispose();
          world.removeResource('net-session');
        };
      }, 'net/session-resource');
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: 'net-receive',
            queries: [],
            before: [FixedUpdate],
            fn: (world) => world.getResource<NetSession>('net-session').receiveEvents(),
          })
          .unwrap();
        return () => world.removeSystem(Update, 'net-receive');
      }, 'net/receive');
      ctx.effect(() => {
        world
          .addSystem(Update, {
            name: 'net-publish',
            queries: [],
            after: [FixedUpdate],
            fn: (world) => {
              const published = world.getResource<NetSession>('net-session').publish();
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
          })
          .unwrap();
        return () => world.removeSystem(Update, 'net-publish');
      }, 'net/publish');
    },
  };
}
