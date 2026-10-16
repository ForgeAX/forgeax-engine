// Happy-path fixture: shader-compiler depends only on @forgeax/engine-naga +
// @forgeax/engine-types (legal forward direction). No @forgeax/engine-rhi-wgpu import.
import { parse } from '@forgeax/engine-naga';
import type { ShaderError } from '@forgeax/engine-types';

export const compileShader = async (src: string): Promise<ShaderError | string> => {
  await parse(src);
  return src;
};
