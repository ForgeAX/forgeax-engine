import { defineResource } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';

export const runtimePackTestResources = {
  PluginInstallations: defineResource<Set<number>>('plugin-installations'),
  GameReady: defineResource<boolean>('game-ready'),
  RuntimePluginActive: defineResource<boolean>('runtime-plugin-active'),
  RemoteBehavior: defineResource<number>('remote-behavior'),
};

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    runtimePackTestResources?: typeof runtimePackTestResources;
  }
}

// Authored plugins receive these actual identities through the ordinary Context capability.
export function provideRuntimePackTestResources(context: Context): void {
  context.provide('runtimePackTestResources', runtimePackTestResources);
}
