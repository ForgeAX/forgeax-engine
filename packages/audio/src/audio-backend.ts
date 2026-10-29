// Realm-neutral controls and observations; native playback belongs to the Host.

import type { AssetHandle, AssetReferenceOwner, AudioError } from '@forgeax/engine-types';
import type { AcousticEnvironment, AcousticRoutes } from './acoustic-controls';
import type { AudioBus } from './audio-buses';
import type { MusicCommand, MusicState } from './music';

export type BusName = string;

export const AUDIO_ENGINE_RESOURCE_KEY = 'AudioEngine' as const;

export interface AudioPlayOptions {
  readonly acousticRoutes?: AcousticRoutes;
  /** Initial decoded clip seconds; finite and non-negative. Defaults to zero. */
  readonly fromPosition?: number;
  /** Positive sample advance multiplier; pitch changes with speed. */
  readonly playbackRate?: number;
  readonly paused?: boolean;
  readonly loop: boolean;
  readonly volume: number;
  readonly spatialBlend: number;
  readonly bus: BusName;
  /** World position and normalized local -Z forward; origin/-Z when omitted. */
  readonly sourcePose?: AudioSourcePose;
  /** Degrees; configured when playback starts, omnidirectional by default. */
  readonly coneInnerAngle?: number;
  readonly coneOuterAngle?: number;
  readonly coneOuterGain?: number;
}

export interface AudioSourcePose {
  readonly positionX: number;
  readonly positionY: number;
  readonly positionZ: number;
  readonly forwardX: number;
  readonly forwardY: number;
  readonly forwardZ: number;
}

export interface AudioListenerPose extends AudioSourcePose {
  readonly upX: number;
  readonly upY: number;
  readonly upZ: number;
}

/** Caller generates a fresh request ID for each preparation, including rebuilds. */
export interface AudioPreparationReceipt {
  readonly requestId: string;
  readonly status: 'pending' | 'ready' | 'rejected';
  readonly sourceCount: number;
  readonly failure?: Pick<AudioError, 'code' | 'expected' | 'hint' | 'detail'>;
}

export interface AudioState {
  readonly preparation?: AudioPreparationReceipt;
  readonly cache?: {
    readonly sources: number;
    readonly encodedBytes: number;
    readonly decodedBytes: number;
    readonly bytesHighWater: number;
    readonly pendingPlays: number;
  };
  readonly music?: MusicState;
  readonly streaming?: {
    readonly encodedBytes: number;
    readonly pcmBytes: number;
    readonly pendingBytes: number;
    readonly pendingReads: number;
    readonly underruns: number;
  };
  readonly contextState: 'running' | 'suspended' | 'closed' | 'unavailable';
  readonly activeSourceCount: number | null;
  readonly lastError: AudioError | null;
}

export interface AudioBackend {
  /** Decode buffered clips without creating or playing voices. Request IDs must be fresh. */
  prepareClips?(
    requestId: string,
    assets: AssetReferenceOwner,
    clips: readonly AssetHandle<'audio'>[],
  ): () => void;
  /** prepare is Host-only; Worker intent backends reject it before publication. */
  music(command: MusicCommand): void;
  setAcousticRoutes(entityId: number, routes: AcousticRoutes): void;
  setAcousticEnvironment(environment: readonly AcousticEnvironment[]): void;
  reportError(error: AudioError): void;
  play(
    entityId: number,
    assets: AssetReferenceOwner,
    clip: AssetHandle<'audio'>,
    opts: AudioPlayOptions,
  ): void;
  stop(entityId: number): void;
  setVolume(entityId: number, volume: number): void;
  setPlaybackRate(entityId: number, playbackRate: number): void;
  setPaused(entityId: number, paused: boolean): void;
  /** Seek an admitted or decoding source; does not start a stopped source. */
  seek(entityId: number, position: number): void;
  configureBuses(buses: readonly AudioBus[]): void;
  setBus(entityId: number, bus: BusName): void;
  setBusWet(bus: BusName, wet: number): void;
  setBusSendGain(bus: BusName, target: BusName, gain: number): void;
  setBusVolume(busName: BusName, volume: number): void;
  setBusMute(busName: BusName, muted: boolean): void;
  setSourcePose(entityId: number, pose: AudioSourcePose): void;
  setListenerPose(pose: AudioListenerPose): void;
  getState(): AudioState;
  getActiveSourceCount(): number | null;
  destroy(): void;
}
