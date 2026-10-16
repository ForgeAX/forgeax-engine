import type { ShaderError } from '@forgeax/engine-shader-compiler';
import {
  type CompileOptions,
  type CompileResult,
  compileShader,
} from '@forgeax/engine-shader-compiler';
import type { Result } from '@forgeax/engine-types';

export type MaterialCookResult = Result<CompileResult, ShaderError>;

export function cookMaterialSource(
  source: string,
  options: CompileOptions,
): Promise<MaterialCookResult> {
  return compileShader(source, options);
}
