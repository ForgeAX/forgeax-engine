import type {
  MaterialShaderTemplate,
  ShaderProgramCompiler,
  ShaderProgramTemplate,
} from '@forgeax/engine-shader';
import { err, ok, type Result } from '@forgeax/engine-types';
import { prepareShaderCompiler, shaderImportClosure } from './compile.js';
import {
  engineMaterialArtifactReceipt,
  engineMaterialForwardFog,
  engineShaderDefines,
  prepareEngineShaderImportScanner,
  prepareEngineShaderSource,
} from './engine-program.js';
import { ShaderError } from './errors.js';
import { MATERIAL_WGSL_PROFILE } from './material/profile.js';
import { prepareMaterialShaderTemplate } from './material/template-compiler.js';

/** One initialized compiler service; source/reflection cache and GPU lifetime remain Registry-owned. */
export async function prepareShaderProgramCompiler(): Promise<
  Result<ShaderProgramCompiler, ShaderError>
> {
  const prepared = await prepareShaderCompiler();
  if (!prepared.ok) return prepared;
  const compiler = prepared.value;
  const importScanners = new WeakMap<
    ShaderProgramTemplate,
    ReturnType<typeof prepareEngineShaderImportScanner>
  >();
  const profile = Object.freeze({ ...MATERIAL_WGSL_PROFILE });
  return ok(
    Object.freeze({
      profile,
      prepareMaterial: (template: MaterialShaderTemplate) =>
        prepareMaterialShaderTemplate(compiler, template),
      compile(template: ShaderProgramTemplate, defines: Readonly<Record<string, boolean>>) {
        const engine = template.engine;
        const effectiveDefines =
          engine === undefined
            ? defines
            : engineShaderDefines(
                engine.identifier ?? '',
                template.options?.defines,
                defines,
                engine.pointShadows,
                engine.paramSchema,
              );
        const file = {
          id: engine?.identifier ?? '<shader-template>',
          source: template.source,
          ...(engine === undefined ? {} : { paramSchema: engine.paramSchema }),
          ...(engine?.identifier === undefined ? {} : { reservedIdentifier: engine.identifier }),
          ...(engine?.surfaceModule === undefined ? {} : { surfaceModule: engine.surfaceModule }),
          ...(engine?.program === undefined ? {} : { program: engine.program }),
        };
        let readImports = importScanners.get(template);
        if (engine !== undefined && readImports === undefined) {
          readImports = prepareEngineShaderImportScanner(template.imports);
          importScanners.set(template, readImports);
        }
        const lowered =
          engine === undefined
            ? ok({ source: template.source, imports: template.imports })
            : prepareEngineShaderSource(
                file,
                template.imports,
                template.imports,
                effectiveDefines,
                readImports,
              );
        if (!lowered.ok)
          return err(
            new ShaderError({
              code: 'shader-compile-failed',
              expected: 'a valid Engine Surface and parameter source contract',
              message: lowered.error.message,
              hint: 'repair the authored source contract before selecting this program',
            }),
          );
        const compiled = compiler.compile(lowered.value.source, {
          ...template.options,
          id: file.id,
          imports: shaderImportClosure(lowered.value.source, lowered.value.imports),
          defines: { ...effectiveDefines },
        });
        if (!compiled.ok) return compiled;
        const receipt =
          engine === undefined
            ? ok(undefined)
            : engineMaterialArtifactReceipt(file, compiled.value, effectiveDefines);
        if (!receipt.ok) return receipt;
        const forwardFog = engineMaterialForwardFog(file);
        return ok({
          ...(forwardFog === undefined ? {} : { forwardFog }),
          manifestEntry: {
            ...compiled.value.manifestEntry,
            compilerProfile: MATERIAL_WGSL_PROFILE,
          },
          uvSetCount: compiled.value.uvSetCount,
          ...(receipt.value === undefined ? {} : { receipt: receipt.value }),
        });
      },
    }),
  );
}
