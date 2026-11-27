import { builtinTaskKinds } from '@forgeax/engine-render/tasks';
import {
  manifestMalformed,
  ShaderError,
  type ShaderProgramCompilation,
  type ShaderProgramCompiler,
  type ShaderProgramTemplate,
  shaderCompilerProfilesEqual,
} from '@forgeax/engine-shader';
import type {
  CompileResult,
  MaterialCookError,
  MaterialSourceProgramRequest,
} from '@forgeax/engine-shader-compiler/program';
import {
  err,
  type MaterialError,
  ok,
  type Result,
  type TaskExecutor,
  type TaskModule,
  type TaskRegistry,
} from '@forgeax/engine-types';

const TEMPLATE_PROGRAM_TASK = 'shader.compile-template';
const MATERIAL_SOURCE_TASK = 'shader.compile-material-sources';

function shaderErrorFields(error: ShaderError): ConstructorParameters<typeof ShaderError>[0] {
  const { code, expected, hint, message, lineNum, linePos, detail } = error;
  return { code, expected, hint, message, lineNum, linePos, detail };
}

interface TemplateProgramRequest {
  readonly template: ShaderProgramTemplate;
  readonly defines: Readonly<Record<string, boolean>>;
}

type TemplateProgramReply =
  | {
      readonly ok: true;
      readonly wgsl: Uint8Array<ArrayBuffer>;
      readonly compilation: Omit<ShaderProgramCompilation, 'manifestEntry'> & {
        readonly manifestEntry: Omit<ShaderProgramCompilation['manifestEntry'], 'wgsl'>;
      };
    }
  | { readonly ok: false; readonly error: ConstructorParameters<typeof ShaderError>[0] };

function loadTemplateProgramTask(): TaskModule<TemplateProgramRequest, TemplateProgramReply> {
  // The dispatcher may load the task definition. Only the executing realm
  // initializes the compiler, on its first actual request.
  let compiler:
    | ReturnType<
        typeof import('@forgeax/engine-shader-compiler/program').prepareShaderProgramCompiler
      >
    | undefined;
  const encoder = new TextEncoder();
  return {
    async run({ template, defines }) {
      compiler ??= import('@forgeax/engine-shader-compiler/program').then(
        ({ prepareShaderProgramCompiler }) => prepareShaderProgramCompiler(),
      );
      const prepared = await compiler;
      const result = !prepared.ok
        ? prepared
        : shaderCompilerProfilesEqual(prepared.value.profile, template.compilerProfile)
          ? prepared.value.compile(template, defines)
          : err(
              manifestMalformed({
                message: 'Task Worker shader compiler profile does not match the selected template',
                hint: 'load the task Worker and shader publication from the same build',
              }),
            );
      if (!result.ok) return { value: { ok: false, error: shaderErrorFields(result.error) } };
      const { manifestEntry, ...compilation } = result.value;
      const { wgsl, ...facts } = manifestEntry;
      const bytes = encoder.encode(wgsl);
      return {
        value: { ok: true, wgsl: bytes, compilation: { ...compilation, manifestEntry: facts } },
        transfer: [bytes.buffer],
      };
    },
  };
}

export interface MaterialSourceProgramBytes {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly bindings: CompileResult['bindings'];
  readonly reflection: CompileResult['reflection'];
  readonly uvSetCount: number;
}

type MaterialSourceProgramReply =
  | { readonly kind: 'ready'; readonly programs: readonly MaterialSourceProgramBytes[] }
  | { readonly kind: 'shader-error'; readonly error: ConstructorParameters<typeof ShaderError>[0] }
  | { readonly kind: 'material-error'; readonly error: MaterialError };

function loadMaterialSourceProgramTask(): TaskModule<
  MaterialSourceProgramRequest,
  MaterialSourceProgramReply
> {
  const encoder = new TextEncoder();
  const initialize = async () => {
    const { prepareShaderCompiler, rebuildMaterialSourcePrograms } = await import(
      '@forgeax/engine-shader-compiler/program'
    );
    return { prepared: await prepareShaderCompiler(), rebuild: rebuildMaterialSourcePrograms };
  };
  let compiler: ReturnType<typeof initialize> | undefined;
  return {
    async run(request) {
      compiler ??= initialize();
      const { prepared, rebuild } = await compiler;
      const result = prepared.ok ? rebuild(prepared.value, request) : prepared;
      if (!result.ok) {
        const error = result.error;
        return {
          value:
            error instanceof ShaderError
              ? { kind: 'shader-error', error: shaderErrorFields(error) }
              : { kind: 'material-error', error },
        };
      }
      const programs = result.value.map(({ wgsl, bindings, reflection, uvSetCount }) => ({
        bytes: encoder.encode(wgsl),
        bindings,
        reflection,
        uvSetCount,
      }));
      return {
        value: { kind: 'ready', programs },
        transfer: programs.map(({ bytes }) => bytes.buffer),
      };
    },
  };
}

/** Send a source closure once for the exact programs demanded by one consumer. */
export async function taskCompileMaterialSourcePrograms(
  tasks: TaskExecutor,
  request: MaterialSourceProgramRequest,
): Promise<Result<readonly MaterialSourceProgramBytes[], MaterialCookError>> {
  if (request.selections.length === 0) return ok([]);
  const result = await tasks.submit<MaterialSourceProgramRequest, MaterialSourceProgramReply>(
    MATERIAL_SOURCE_TASK,
    request,
    { priority: 'critical' },
  ).result;
  switch (result.kind) {
    case 'ready':
      return ok(result.programs);
    case 'shader-error':
      return err(new ShaderError(result.error));
    case 'material-error':
      return err(result.error);
  }
}

/** Use the same registry at the pool dispatcher and in its executing Workers. */
export const runtimeTaskKinds: TaskRegistry = {
  ...builtinTaskKinds,
  [TEMPLATE_PROGRAM_TASK]: { load: loadTemplateProgramTask },
  [MATERIAL_SOURCE_TASK]: { load: loadMaterialSourceProgramTask },
};

export function taskShaderProgramCompiler(
  compiler: ShaderProgramCompiler,
  tasks: TaskExecutor,
): ShaderProgramCompiler {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return {
    profile: compiler.profile,
    compile: compiler.compile.bind(compiler),
    ...(compiler.prepareMaterial === undefined
      ? {}
      : { prepareMaterial: compiler.prepareMaterial.bind(compiler) }),
    async compileAsync(template, defines) {
      const result = await tasks.submit<TemplateProgramRequest, TemplateProgramReply>(
        TEMPLATE_PROGRAM_TASK,
        { template, defines },
        { priority: 'critical' },
      ).result;
      if (!result.ok) return err(new ShaderError(result.error));
      return ok({
        ...result.compilation,
        manifestEntry: {
          ...result.compilation.manifestEntry,
          wgsl: decoder.decode(result.wgsl),
        },
      });
    },
  };
}
