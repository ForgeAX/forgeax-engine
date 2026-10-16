interface PlaybackErrorDetails {
  readonly 'animation-playback-invalid': { readonly reason: string; readonly slot?: number };
  readonly 'animation-timeline-invalid': { readonly reason: string; readonly key?: number };
  readonly 'animation-timeline-overflow': { readonly player: number; readonly limit: number };
  readonly 'animation-root-motion-invalid': { readonly reason: string; readonly targetId: string };
}
export type AnimationPlaybackErrorCode = keyof PlaybackErrorDetails;
export type AnimationPlaybackFailure = {
  [Code in AnimationPlaybackErrorCode]: AnimationPlaybackError<Code>;
}[AnimationPlaybackErrorCode];
export class AnimationPlaybackError<
  Code extends AnimationPlaybackErrorCode = AnimationPlaybackErrorCode,
> extends Error {
  override readonly name = 'AnimationPlaybackError';
  readonly expected = 'finite playback intervals, valid timeline keys and bounded effects';
  readonly hint =
    'inspect detail; repair authored keys or reduce the playback step before retrying';
  constructor(
    readonly code: Code,
    readonly detail: PlaybackErrorDetails[Code],
  ) {
    super(`[${code}] inspect detail and repair playback input`);
  }
}
