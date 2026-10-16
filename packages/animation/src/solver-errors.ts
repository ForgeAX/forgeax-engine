interface PropertyBindingDetail {
  readonly player: number;
  readonly target: string;
  readonly name: string;
  readonly entity?: number;
  readonly field?: string;
  readonly cause?: string;
}

interface AnimationErrorDetails {
  readonly 'animation-retarget-clip-invalid': { readonly reason: string };
  readonly 'animation-property-binding-invalid': PropertyBindingDetail;
  readonly 'animation-property-binding-conflict': PropertyBindingDetail;
  readonly 'animation-property-binding-missing': PropertyBindingDetail;
  readonly 'animation-property-target-stale': PropertyBindingDetail;
  readonly 'animation-property-sampler-invalid': PropertyBindingDetail;
  readonly 'animation-skeleton-invalid': {
    readonly reason: string;
    readonly entity?: number;
    readonly joint?: number;
  };
  readonly 'animation-skeleton-stale': {
    readonly entity: number;
    readonly reason?: string;
    readonly field?: string;
  };
  readonly 'animation-solver-options-invalid': {
    readonly reason?: string;
    readonly weight?: number;
    readonly rootScale?: number;
    readonly iterations?: number;
    readonly tolerance?: number;
    readonly maxAngle?: number;
  };
  readonly 'animation-solver-write-failed': { readonly entity: number; readonly cause: string };
}

export type AnimationBindingErrorCode = keyof AnimationErrorDetails;

/** Discriminated public failure union; detail narrows with code. */
export type AnimationError = {
  [Code in AnimationBindingErrorCode]: AnimationBindingError<Code>;
}[AnimationBindingErrorCode];

export class AnimationBindingError<
  Code extends AnimationBindingErrorCode = AnimationBindingErrorCode,
> extends Error {
  override readonly name = 'AnimationBindingError';
  readonly expected =
    'live explicit animation bindings, finite normalized TRS, and bounded solver inputs';
  readonly hint =
    'inspect detail; repair the authored binding or recapture the reference pose before retrying';
  constructor(
    readonly code: Code,
    readonly detail: AnimationErrorDetails[Code],
  ) {
    super(`[${code}] inspect detail and rebuild the animation binding`);
  }
}
