export type TextureResidencyFailure =
  | { readonly reason: 'world-not-attached' | 'renderer-not-alive'; readonly textureHandle: number }
  | {
      readonly reason: 'invalid-texture' | 'upload-failed';
      readonly textureHandle: number;
      readonly cause: unknown;
    };

/** Expected failure of explicit residency preparation; no frame has been submitted. */
export class TextureResidencyError extends Error {
  readonly code = 'texture-residency-failed' as const;
  readonly expected = 'a live TextureAsset in an attached World on the active device';
  readonly hint = 'Attach the World, repair the texture or device, then retry preparation.';
  constructor(readonly detail: TextureResidencyFailure) {
    super(`texture-residency-failed: ${detail.reason} (${detail.textureHandle})`);
    this.name = 'TextureResidencyError';
  }
}
