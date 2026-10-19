import type { WgpuWasm } from '@forgeax/engine-wgpu-wasm';
import { it } from 'vitest';
import type { RawCommandEncoderLike, RawComputePassLike } from '../command-encoder';
import type { RawRenderBundleLike, RawRenderPassLike } from '../render-pass-encoder';

declare const nativeCommand: WgpuWasm['RhiWgpuCommandEncoder']['prototype'];
declare const nativeCompute: WgpuWasm['RhiWgpuComputePass']['prototype'];
declare const nativePass: WgpuWasm['RhiWgpuRenderPass']['prototype'];
declare const nativeBundle: WgpuWasm['RhiWgpuRenderBundleEncoder']['prototype'];

it('accepts the generated command, compute, pass and bundle artifact contracts', () => {
  const command: RawCommandEncoderLike = nativeCommand;
  const compute: RawComputePassLike = nativeCompute;
  const pass: RawRenderPassLike = nativePass;
  const bundle: RawRenderBundleLike = nativeBundle;
  void command;
  void compute;
  void pass;
  void bundle;
});
