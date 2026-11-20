import type {
  MaterialShaderSelection,
  MaterialShaderSelectionResult,
  MaterialShaderTemplate,
  PreparedMaterialShaderTemplate,
} from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { PreparedShaderCompiler } from '../compile.js';
import { ShaderError } from '../errors.js';
import { compileMaterialSelection } from './cook.js';
import {
  supportsMaterialLodCoverage,
  supportsMaterialViewClipping,
} from './pack-material-contract.js';
import { selectionAbi } from './publication.js';
import { compileRayMaterialSelection } from './ray-material.js';
import { buildMaterialSourceCatalog } from './source-catalog.js';

function materialCompileFailure(cause: { readonly message: string; readonly hint?: string }) {
  return err(
    new ShaderError({
      code: 'shader-compile-failed',
      expected: 'a valid material program for the selected pass and renderer context',
      message: cause.message,
      hint: cause.hint ?? 'repair the authored material source or selected pass contract',
    }),
  );
}

export function prepareMaterialShaderTemplate(
  compiler: PreparedShaderCompiler,
  template: MaterialShaderTemplate,
): Result<PreparedMaterialShaderTemplate, ShaderError> {
  const records = (modules: Readonly<Record<string, string>>) =>
    Object.entries(modules).map(([path, source]) => ({ path, source }));
  const catalog = buildMaterialSourceCatalog({
    engine: records(template.sources.engine),
    project: records(template.sources.project),
  });
  if (!catalog.ok) return materialCompileFailure(catalog.error);
  const material = {
    material: template.guid,
    table: { [template.guid]: template.material },
    sources: catalog.value,
  };
  return ok({
    select({
      pass,
      context,
      vertexColorAvailable,
    }: MaterialShaderSelection): Result<MaterialShaderSelectionResult | undefined, ShaderError> {
      if (context.pipeline === 'ray') {
        const result = compileRayMaterialSelection(
          { ...material, context: context.pass },
          compiler,
        );
        if (!result.ok)
          return result.error.code === 'ray-material-unsupported'
            ? ok(undefined)
            : materialCompileFailure(result.error);
        return ok({
          direct: {
            wgsl: result.value.program.wgsl,
            entry: context.pass === 'ray-hit' ? 'cs_surface' : 'vs_card',
          },
        });
      }
      const result = compileMaterialSelection(
        { ...material, context, vertexColorAvailable },
        compiler,
        [pass],
      );
      if (!result.ok) return materialCompileFailure(result.error);
      const program = result.value.passes[0];
      if (program === undefined) return ok(undefined);
      const direct = {
        wgsl: program.compile.wgsl,
        entry: program.abi.directEntry,
        abi: selectionAbi(program.abi, program.compile),
      };
      const sceneIndex =
        program.sceneCompile === undefined || program.abi.sceneIndexEntry === undefined
          ? undefined
          : {
              wgsl: program.sceneCompile.wgsl,
              entry: program.abi.sceneIndexEntry,
              abi: selectionAbi(program.abi, program.sceneCompile),
            };
      return ok({
        direct,
        ...(sceneIndex === undefined ? {} : { sceneIndex }),
        ...(supportsMaterialViewClipping(program.module)
          ? {
              rasterCoverage: supportsMaterialLodCoverage(program)
                ? 'clipping-and-lod'
                : 'clipping',
            }
          : {}),
      });
    },
  });
}
