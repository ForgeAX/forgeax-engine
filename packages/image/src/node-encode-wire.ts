import type { BasisEncodeOptions, basisEncode } from '@forgeax/engine-codec/encode';

export type ImageEncodeResult = Awaited<ReturnType<typeof basisEncode>>;
export interface ImageEncodeRequest {
  readonly id: number;
  readonly pixels: Uint8Array;
  readonly options: BasisEncodeOptions;
}
export interface ImageEncodeResponse {
  readonly id: number;
  readonly heapLimitBytes: number;
  readonly result: ImageEncodeResult;
}
export function imageEncodeFailure(mode: string, reason: string): ImageEncodeResult {
  return {
    ok: false,
    error: {
      code: 'ktx2-encode-failed',
      expected: 'the native image encoder to finish the complete input',
      hint: 'inspect the producer lifecycle and input budget, then retry the image import',
      detail: { mode, reason },
    },
  };
}
