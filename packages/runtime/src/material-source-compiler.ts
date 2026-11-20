import type { PrepareMaterialSourceProgram } from '@forgeax/engine-assets-runtime/internal';
import { ShaderError, type ShaderRegistry } from '@forgeax/engine-shader';
import {
  err,
  type MaterialRasterSourceInputs,
  type MaterialRasterSourceSelection,
  ok,
  type TaskExecutor,
} from '@forgeax/engine-types';
import { taskCompileMaterialSourcePrograms } from './tasks';

/** Request only variants selected together by the current frame preparation. */
export function createMaterialSourceCompiler(
  shaders: ShaderRegistry,
  tasks: TaskExecutor | undefined,
): PrepareMaterialSourceProgram {
  const encoder = new TextEncoder();
  const batches = new WeakMap<MaterialRasterSourceInputs, ReturnType<typeof createBatch>>();
  let inlineCompiler:
    | ReturnType<typeof import('@forgeax/engine-shader-compiler/program').prepareShaderCompiler>
    | undefined;

  async function compile(
    source: MaterialRasterSourceInputs,
    selections: readonly MaterialRasterSourceSelection[],
  ) {
    // Only send this material's actual dependencies to the compiler realm.
    const available = shaders.shaderTemplateSources();
    const modules = source.modules;
    const sources: Record<string, string> = Object.create(null);
    for (const reference of modules.modules) {
      if (reference.kind === 'engine') {
        const text = available?.[reference.digest];
        if (text !== undefined) sources[reference.digest] = text;
      }
    }
    const request = {
      modules,
      engine: { sources },
      materials: source.materials,
      selections,
    };
    if (tasks !== undefined) {
      const rebuilt = await taskCompileMaterialSourcePrograms(tasks, request);
      return rebuilt.ok ? ok(rebuilt.value.map(({ bytes }) => bytes)) : rebuilt;
    }

    const compiler = await import('@forgeax/engine-shader-compiler/program');
    inlineCompiler ??= compiler.prepareShaderCompiler();
    const prepared = await inlineCompiler;
    if (!prepared.ok) return prepared;
    const rebuilt = compiler.rebuildMaterialSourcePrograms(prepared.value, request);
    return rebuilt.ok ? ok(rebuilt.value.map(({ wgsl }) => encoder.encode(wgsl))) : rebuilt;
  }

  function createBatch(source: MaterialRasterSourceInputs) {
    const selections: MaterialRasterSourceSelection[] = [];
    const ready = Promise.resolve().then(() => {
      batches.delete(source);
      return compile(source, selections);
    });
    return { selections, ready };
  }

  return async ({ inputs, selection }) => {
    let batch = batches.get(inputs);
    if (batch === undefined) {
      batch = createBatch(inputs);
      batches.set(inputs, batch);
    }
    const index = batch.selections.push(selection) - 1;
    const rebuilt = await batch.ready;
    if (!rebuilt.ok) {
      const error = rebuilt.error;
      return err(
        error instanceof ShaderError
          ? error
          : new ShaderError({
              code: 'shader-compile-failed',
              expected: error.expected,
              hint: error.hint,
              message: error.message,
            }),
      );
    }
    const bytes = rebuilt.value[index];
    if (bytes === undefined)
      throw new Error(`Material source compiler omitted '${selection.artifactDigest}'`);
    return ok(bytes);
  };
}
