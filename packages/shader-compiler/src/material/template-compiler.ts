import type {
  MaterialShaderSelection,
  MaterialShaderSelectionResult,
  MaterialShaderTemplate,
  PreparedMaterialShaderTemplate,
} from '@forgeax/engine-shader';
import { err, type MaterialProgramAddress, ok, type Result } from '@forgeax/engine-types';
import type { PreparedShaderCompiler } from '../compile.js';
import { ShaderError } from '../errors.js';
import { compileMaterialAddressSelection, compileMaterialSelection, selectionAbi } from './cook.js';
import {
  supportsMaterialLodCoverage,
  supportsMaterialViewClipping,
} from './pack-material-contract.js';
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
  return ok<PreparedMaterialShaderTemplate>({
    selectAddress(request: MaterialShaderSelection, address: MaterialProgramAddress) {
      const { pass, context, vertexColorAvailable } = request;
      if (context.pipeline === 'ray') {
        if (address !== 'direct') return ok(undefined);
        const selected = this.select(request);
        if (!selected.ok) return selected;
        return ok(selected.value === undefined ? undefined : { program: selected.value.direct });
      }
      const compiled = compileMaterialAddressSelection(
        { ...material, context, vertexColorAvailable },
        compiler,
        { pass, address },
      );
      if (!compiled.ok) return materialCompileFailure(compiled.error);
      const result = compiled.value;
      if (result === undefined) return ok(undefined);
      const entry = address === 'scene-index' ? result.abi.sceneIndexEntry : result.abi.directEntry;
      return ok({
        program: {
          wgsl: result.compile.wgsl,
          ...(entry === undefined ? {} : { entry }),
          abi: selectionAbi(result.abi, result.compile),
        },
        ...(supportsMaterialViewClipping(result.module)
          ? {
              rasterCoverage: supportsMaterialLodCoverage(result, address === 'scene-index')
                ? 'clipping-and-lod'
                : 'clipping',
            }
          : {}),
      });
    },
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
