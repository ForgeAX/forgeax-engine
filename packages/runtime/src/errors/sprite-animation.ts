export class SpriteAnimationInvalidError extends Error {
  override readonly name = 'SpriteAnimationInvalidError';
  readonly code = 'sprite-animation-invalid' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail:
    | {
        readonly field: 'regions-length';
        readonly regionsLength: number;
        readonly frameCount: number;
      }
    | {
        readonly field: 'frame-duration';
        readonly frameDuration: number;
      };

  private static resolvePolicy(detail: SpriteAnimationInvalidError['detail']): {
    readonly expected: string;
    readonly hint: string;
  } {
    switch (detail.field) {
      case 'regions-length':
        return {
          expected: 'SpriteAnimation.regions.length === frameCount * 4',
          hint: `SpriteAnimation.regions.length = ${detail.regionsLength} does not match frameCount * 4 = ${detail.frameCount * 4}; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)`,
        };
      case 'frame-duration':
        return {
          expected: 'SpriteAnimation.frameDuration > 0',
          hint: `SpriteAnimation.frameDuration = ${detail.frameDuration} is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)`,
        };
    }
  }

  constructor(detail: SpriteAnimationInvalidError['detail']) {
    const policy = SpriteAnimationInvalidError.resolvePolicy(detail);
    super(
      `SpriteAnimation: invariant violated.\n` +
        `  code: sprite-animation-invalid\n` +
        `  field: ${detail.field}\n` +
        `  expected: ${policy.expected}\n` +
        `  hint: ${policy.hint}`,
    );
    this.hint = policy.hint;
    this.expected = policy.expected;
    this.detail = detail;
  }
}
