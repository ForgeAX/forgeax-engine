import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build as viteBuild } from 'vite';
import { createViteConfig } from './host.js';
import { commandError, readProjectFacts } from './project.js';
import type { CommandResult, ShaderCheckOptions } from './types.js';

export async function shaderCheckCommand(
  options: ShaderCheckOptions = {},
): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const target = options.path === undefined ? undefined : resolve(facts.value.root, options.path);
  if (target !== undefined) {
    try {
      await readFile(target);
    } catch (cause) {
      return { ok: false, error: commandError(cause, 'shader-source-unreadable') };
    }
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-shader-check-'));
  const previous = process.cwd();
  try {
    process.chdir(facts.value.root);
    const config = await createViteConfig(facts.value, 'build');
    // The project build compiles only reachable shaders; the named file joins
    // as an extra entry so an unreferenced module still reaches the compiler.
    const input = config.build?.rollupOptions?.input;
    await viteBuild({
      ...config,
      build: {
        ...config.build,
        outDir: temporary,
        emptyOutDir: true,
        write: true,
        ...(target === undefined || typeof input !== 'object' || Array.isArray(input)
          ? {}
          : {
              rollupOptions: {
                ...config.build?.rollupOptions,
                input: { ...input, 'shader-check': target },
              },
            }),
      },
    });
    return { ok: true, value: { root: facts.value.root, path: target ?? null } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'shader-check-failed') };
  } finally {
    process.chdir(previous);
    await rm(temporary, { recursive: true, force: true });
  }
}
