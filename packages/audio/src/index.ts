// @forgeax/engine-audio -- public barrel (feat-20260527-audio-system M1 / w10)
//
// Single-entry surface: AI users import `@forgeax/engine-audio` and discover
// the full audio subsystem surface in one go (charter P1 progressive disclosure).
//
// Re-exports from @forgeax/engine-types (error model SSOT):
//   AudioError, AudioErrorCode, AudioErrorDetail, AUDIO_ERROR_HINTS
//
// Package-internal exports:
//   AudioBackend interface, BusName, AudioPlayOptions, AudioSourcePose, AudioState,
//   AUDIO_ENGINE_RESOURCE_KEY
//   AudioSource component, AudioListener component

export {
  AUDIO_ERROR_HINTS,
  type AudioClipAsset,
  AudioError,
  type AudioErrorCode,
  type AudioErrorDetail,
} from '@forgeax/engine-types';
export {
  type AcousticEnvironment,
  type AcousticParameter,
  type AcousticRoutes,
  acousticFailure,
  validateAcousticEnvironment,
  validateAcousticRoutes,
} from './acoustic-controls';
export { AcousticRegion, AcousticShapeValue, createAcousticRegionSystem } from './acoustic-regions';
export { audioContribution } from './assets/audio-decoder';
export type {
  AudioListenerPose,
  AudioPlayOptions,
  AudioPreparationReceipt,
  AudioSourcePose,
  AudioState,
} from './audio-backend';
export {
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioBackend,
  type BusName,
} from './audio-backend';
export {
  type AudioBus,
  type AudioBusSend,
  DEFAULT_AUDIO_BUSES,
  validateAudioBuses,
} from './audio-buses';
export {
  type AudioIntent,
  type AudioIntentBackendOptions,
  audioIntentErrorState,
  createAudioIntentBackend,
} from './audio-intent';
export { admitAudioStream, validAudioStream } from './audio-stream';
export {
  audioTickSystem,
  createClipResolver,
  detectEdge,
  detectRemovedEntities,
  type EdgeAction,
  listenerPoseFromWorldMatrix,
  sourcePoseFromWorldMatrix,
} from './audio-tick-system';
export { AudioListener, AudioSource } from './components';
export {
  isMusicState,
  loadMusicScore,
  type MusicCommand,
  type MusicFailure,
  type MusicFailureCode,
  type MusicPreparation,
  type MusicReceipt,
  type MusicScore,
  type MusicState,
  musicFailure,
  validMusicTiming,
} from './music';
export { AUDIO_TICK_SYSTEM_NAME, audioPlugin } from './plugin-factory';
export { audioBackendPlugin } from './plugin-service';
