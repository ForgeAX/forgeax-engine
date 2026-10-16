// @forgeax/engine-audio-webaudio -- public barrel (feat-20260527-audio-system M2 / w17+w19)
//
// Single-entry surface: AI users import `@forgeax/engine-audio-webaudio` for
// the Web Audio API backend (charter P1 progressive disclosure).
//
// Exports:
//   - createWebAudioBackend() factory (w17)
//   - WebAudioEngine class (w16)
//
// Placeholder exports (M3 impl):
//   - audioTickSystem (M3)
//   - audioListenerSyncSystem (M3)
//
// Re-exports from @forgeax/engine-audio:
//   - AudioBackend, AUDIO_ENGINE_RESOURCE_KEY

// Re-exports from engine-audio for convenience
export { AUDIO_ENGINE_RESOURCE_KEY, type AudioBackend } from '@forgeax/engine-audio';
// audio listener sync system (GlobalTransform.world mat4 -> Web Audio listener)
export {
  audioListenerSyncSystem,
  syncListenerFromWorldMatrix,
} from './audio-listener-sync-system';
export { audioLoader } from './audio-loader';
export {
  createHostAudioConsumer,
  createWebAudioBackend,
  type HostAudioConsumer,
  type HostAudioConsumerOptions,
} from './host-audio-consumer';
export type { AudioStreamState } from './pcm-stream-player';
export { webAudioPlugin } from './plugin';
export { WebAudioEngine } from './web-audio-engine';
