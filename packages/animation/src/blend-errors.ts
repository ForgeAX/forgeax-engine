interface AnimationBlendErrorDetails {
  readonly 'animation-blend-space-invalid': {
    readonly field: 'samples' | 'triangles' | 'position' | 'weights';
    readonly reason: string;
    readonly index?: number;
  };
  readonly 'animation-mask-invalid': {
    readonly reason: string;
    readonly index?: number;
  };
  readonly 'animation-player-mask-length-mismatch': {
    readonly entity: number;
    readonly field: 'masks' | 'nodeMasks';
    readonly expectedLength: number;
    readonly actualLength: number;
  };
}

export type AnimationBlendErrorCode = keyof AnimationBlendErrorDetails;
export type AnimationBlendFailure = {
  [Code in AnimationBlendErrorCode]: AnimationBlendError<Code>;
}[AnimationBlendErrorCode];

/** Input failures leave the caller's weights, player clocks and pose untouched. */
export class AnimationBlendError<Code extends AnimationBlendErrorCode> extends Error {
  override readonly name = 'AnimationBlendError';
  readonly expected = 'finite sample spaces, valid target masks and aligned player mask columns';
  readonly hint =
    'repair the input identified by detail before sampling or rebuilding a failed World';
  constructor(
    readonly code: Code,
    readonly detail: AnimationBlendErrorDetails[Code],
  ) {
    super(`[${code}] inspect detail and repair the animation blending input`);
  }
}
