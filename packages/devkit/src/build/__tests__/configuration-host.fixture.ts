import {
  createEngineConfigurationControl,
  createEngineConfigurationStore,
  type EngineConfigurationDefinition,
  EngineConfigurationError,
  type EngineConfigurationHost,
  prepareEngineStartup,
  projectEngineStartup,
  resolveEngineStartup,
} from '@forgeax/engine-app';
import { PHYSICS_STARTUP_OPTIONS } from '@forgeax/engine-physics';
import { err, ok } from '@forgeax/engine-types';

/** VM harnesses clone parameters across their synthetic realm boundary, as Workers do. */
export const configurationHostScope = {
  createEngineConfigurationControl,
  createEngineConfigurationStore,
  EngineConfigurationError,
  projectEngineStartup,
  PHYSICS_STARTUP_OPTIONS,
  ok,
  err,
  prepareEngineStartup: (
    definition: EngineConfigurationDefinition,
    host: EngineConfigurationHost,
  ) =>
    prepareEngineStartup(structuredClone(definition), {
      ...host,
      readDeviceFacts: async () => structuredClone(await host.readDeviceFacts()),
    }),
};

export function generatedWechatConfiguration(source: string) {
  const data = source.match(/const configurationDefinition = (.*);/)?.[1];
  if (data === undefined) throw new Error('Generated configuration is absent');
  const plan = resolveEngineStartup(JSON.parse(data), {
    platform: 'unknown',
    runtime: 'wechat',
  }).unwrap();
  return { plan, configured: projectEngineStartup(plan) };
}
