import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  collectMaterialSources,
  compileShader,
  materialShaderSourceRoots,
  reachableShaderImportIds,
} from '@forgeax/engine-shader-compiler';
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
      const source = await readFile(target, 'utf8');
      const engineRoots = materialShaderSourceRoots();
      const sources = await collectMaterialSources(
        [
          ...facts.value.assetRoots.map((root) => resolve(facts.value.root, root)),
          dirname(target),
          ...engineRoots,
        ],
        engineRoots,
      );
      const records = [...sources.engine, ...sources.project].filter(
        (record) => record.path !== target,
      );
      const imports = Object.fromEntries(records.map((record) => [record.moduleId, record.source]));
      const reachable = reachableShaderImportIds(source, imports);
      const dependencies = records.filter((record) => reachable.has(record.moduleId));
      for (const moduleId of reachable) {
        const matches = dependencies.filter((record) => record.moduleId === moduleId);
        if (matches.length > 1)
          return {
            ok: false,
            error: {
              code: 'shader-module-id-duplicate',
              expected: 'one source per imported module identity',
              hint: 'Remove the duplicate source from the selected dependency closure.',
              detail: { moduleId, paths: matches.map((record) => record.path) },
            },
          };
      }
      const compiled = await compileShader(source, {
        id: target,
        imports: Object.fromEntries(dependencies.map((record) => [record.moduleId, record.source])),
      });
      if (!compiled.ok)
        return { ok: false, error: commandError(compiled.error, 'shader-check-failed') };
      return {
        ok: true,
        value: {
          root: facts.value.root,
          path: target,
          scope: 'source',
          sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          dependencies: dependencies.map((record) => record.path).sort(),
        },
      };
    } catch (cause) {
      return { ok: false, error: commandError(cause, 'shader-check-failed') };
    }
  }
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-shader-check-'));
  const previous = process.cwd();
  try {
    process.chdir(facts.value.root);
    const config = await createViteConfig(facts.value, 'build');
    await viteBuild({
      ...config,
      build: {
        ...config.build,
        outDir: temporary,
        emptyOutDir: true,
        write: true,
      },
    });
    return { ok: true, value: { root: facts.value.root, path: null, scope: 'project' } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'shader-check-failed') };
  } finally {
    process.chdir(previous);
    await rm(temporary, { recursive: true, force: true });
  }
}
