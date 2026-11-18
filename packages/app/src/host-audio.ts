import { createHostAudioConsumer, type HostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { EngineConfigurationError } from './configuration-error';
import type { ConfiguredAppOptions } from './configuration-host';
import type { AppHostAdapter, CreateAppOptions } from './types';

/** The legacy execution binding may supply the same Host capability until 0.7. */
export function hostAudioBindingError(
  options: CreateAppOptions | undefined,
  adapter: AppHostAdapter | undefined,
): EngineConfigurationError | undefined {
  if (adapter?.createHostAudio === undefined || options?.execution?.createHostAudio === undefined)
    return undefined;
  return new EngineConfigurationError('configuration-invalid', {
    path: 'hostAdapter.createHostAudio',
    reason:
      'supply one Host audio factory through the adapter; remove the legacy execution factory',
  });
}

/** Create one consumer from the resolved plan, including each replacement generation. */
export function createAppHostAudio(
  options: ConfiguredAppOptions | undefined,
  adapter: AppHostAdapter | undefined,
): HostAudioConsumer {
  const failure = hostAudioBindingError(options, adapter);
  if (failure !== undefined) throw failure;
  const factory = adapter?.createHostAudio ?? options?.execution?.createHostAudio;
  const budget = options?.startup?.settings.audio?.host;
  return factory === undefined ? createHostAudioConsumer(undefined, budget) : factory(budget);
}
