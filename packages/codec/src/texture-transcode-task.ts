/**
 * Texture transcode as an engine task: the request carries only encoded bytes
 * and the target format, and the result returns every level in one buffer whose
 * ownership moves back to the submitting realm.
 */

import type { TaskModule } from '@forgeax/engine-types';
import {
  compileBasisTranscoderWasm,
  compiledBasisHost,
  initBasisTranscoder,
  type PackedTranscodedTexture,
  packTranscodedTexture,
  type TranscodeCheckpoint,
  transcodeBasis,
  transcodeKtx2Packed,
} from './basis-transcoder.js';
import type { CodecResult } from './errors.js';
import { ktx2IsNative, ktx2NativeTexture, parseKtx2 } from './ktx2.js';

export interface TextureTranscodeRequest {
  readonly encoding: 'basis' | 'ktx2';
  readonly data: Uint8Array;
  readonly target: GPUTextureFormat;
}

/** Derive `request.target` from encoded Basis or KTX2 bytes, levels packed base first. */
export async function transcodeTexturePacked(
  request: TextureTranscodeRequest,
  checkpoint?: TranscodeCheckpoint,
): Promise<CodecResult<PackedTranscodedTexture>> {
  if (request.encoding === 'basis') {
    const result = await transcodeBasis(request.data, request.target);
    return result.ok ? { ok: true, value: packTranscodedTexture(result.value) } : result;
  }
  const parsed = parseKtx2(request.data);
  if (!parsed.ok) return parsed;
  if (!ktx2IsNative(parsed.value))
    return transcodeKtx2Packed(parsed.value, request.target, checkpoint);
  const result = await ktx2NativeTexture(parsed.value, request.target);
  return result.ok ? { ok: true, value: packTranscodedTexture(result.value) } : result;
}

/**
 * Task module for `transcodeTexturePacked`. The dispatching realm compiles the
 * transcoder once; each executing realm instantiates that module. Codec
 * failures are values, so the submitter maps them exactly as it would inline.
 */
export const textureTranscodeTask: TaskModule<
  TextureTranscodeRequest,
  CodecResult<PackedTranscodedTexture>,
  WebAssembly.Module
> = {
  shared: () => compileBasisTranscoderWasm(),
  async init({ shared }) {
    // A failed start is retried and reported by the first transcode.
    await initBasisTranscoder(shared === undefined ? undefined : compiledBasisHost(shared)).catch(
      () => undefined,
    );
  },
  async run(request, context) {
    const result = await transcodeTexturePacked(request, context);
    return result.ok ? { value: result, transfer: [result.value.data.buffer] } : { value: result };
  },
};
