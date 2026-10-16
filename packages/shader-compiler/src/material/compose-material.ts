import { err, ok, type Result } from '@forgeax/engine-types';
import { type CompileResult, compileShader } from '../compile.js';
import type {
  ComposedMaterial,
  MaterialComposeCompiler,
  MaterialComposedSource,
  MaterialComposeRequest,
} from './compose.js';
import { lowerMaterialVariantContext } from './variant-context.js';

function isCompileResult(value: MaterialComposedSource | CompileResult): value is CompileResult {
  return 'manifestEntry' in value;
}

export async function composeMaterial(
  request: MaterialComposeRequest,
  compiler?: MaterialComposeCompiler,
): Promise<Result<ComposedMaterial, unknown>> {
  const compile =
    compiler ??
    (async (input) => {
      const options = {
        id: `${input.material}::${input.pass}`,
        ...(input.imports === undefined ? {} : { imports: { ...input.imports } }),
        ...(input.context === undefined
          ? {}
          : { defines: { ...lowerMaterialVariantContext(input.context) } }),
      };
      const result = await compileShader(input.source, options);
      if (!result.ok) return result as never;
      return result.value;
    });
  const result = await compile(request);
  if (!result || typeof result !== 'object') return err(result);
  if (isCompileResult(result)) {
    return ok({
      material: request.material,
      pass: request.pass,
      wgsl: result.wgsl,
      bindings: result.bindings,
      deps: result.deps,
      vertexInputs: [],
    });
  }
  return ok({
    material: request.material,
    pass: request.pass,
    wgsl: result.wgsl,
    bindings: result.bindings,
    deps: result.deps,
    vertexInputs: result.vertexInputs,
  });
}
