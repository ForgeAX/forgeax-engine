import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getCompilerFingerprint } from '@forgeax/engine-naga';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import {
  TEXTURE_GENERATOR_VERTEX_ENTRY,
  TEXTURE_GENERATOR_VERTEX_SOURCE,
} from '@forgeax/engine-shader';
import {
  canonicalJson,
  type ManifestEntry,
  sha256,
  validateTextureGenerator,
} from '@forgeax/engine-types';
import { compileShader, reachableShaderImportIds } from './compile.js';
import {
  collectMaterialSources,
  type MaterialSourceSnapshot,
  materialShaderSourceRoots,
} from './material/pack-cooker.js';
import { buildMaterialSourceCatalog } from './material/source-catalog.js';

/** Prepare finite GPU programs only. This cooker never creates pixels or a GPU device. */
export function createTextureGeneratorPackCooker(
  roots: readonly string[] = [],
  options: { readonly sourceSnapshot?: MaterialSourceSnapshot } = {},
): NativeCooker {
  const sources = async () => {
    const engineRoots = materialShaderSourceRoots();
    return (
      options.sourceSnapshot ?? collectMaterialSources([...roots, ...engineRoots], engineRoots)
    );
  };
  return {
    key: 'texture-generator',
    concurrency: 'parallel',
    async cacheIdentity() {
      const snapshot = await sources();
      const native = (await getCompilerFingerprint()).unwrap();
      const implementation = await Promise.all(
        [
          import.meta.url,
          import.meta.resolve('@forgeax/engine-naga'),
          import.meta.resolve('@forgeax/engine-shader'),
          import.meta.resolve('@forgeax/engine-types'),
        ].map(async (url) =>
          createHash('sha256')
            .update(await readFile(fileURLToPath(url)))
            .digest('hex'),
        ),
      );
      return `sha256:${sha256(
        canonicalJson({
          implementation,
          format: 'texture-generator-programs/1',
          native,
          vertex: TEXTURE_GENERATOR_VERTEX_SOURCE,
          sources: [...snapshot.engine, ...snapshot.project]
            .map((row) => ({ module: row.moduleId, source: row.source }))
            .sort((a, b) => a.module.localeCompare(b.module)),
        }),
      )}`;
    },
    async cook(raw) {
      const input = raw as { readonly guid: string; readonly source: unknown };
      const recipe = validateTextureGenerator(input.source).unwrap();
      const snapshot = await sources();
      const catalog = buildMaterialSourceCatalog({
        roots,
        engine: snapshot.engine,
        project: snapshot.project,
      }).unwrap();
      const compilerFingerprint = (await getCompilerFingerprint()).unwrap();
      const colorFormats = (writes: readonly string[]) =>
        writes.map((name) => {
          const descriptor = Object.hasOwn(recipe.outputs, name)
            ? recipe.outputs[name]
            : recipe.transient[name];
          if (descriptor === undefined) throw new Error('Generation target descriptor missing');
          return descriptor.format;
        });
      const entries = new Map<string, ManifestEntry>();
      const dependencies = new Set<string>();
      for (const pass of recipe.passes) {
        const source = catalog.get(pass.program.module).unwrap();
        const available = Object.fromEntries(
          catalog
            .entries()
            .filter((row) => row.moduleId !== source.moduleId)
            .map((row) => [row.moduleId, row.source]),
        );
        const imports = Object.fromEntries(
          [...reachableShaderImportIds(source.source, available)].map((module) => [
            module,
            catalog.get(module).unwrap().source,
          ]),
        );
        const compiled = (
          await compileShader(`${source.source}\n${TEXTURE_GENERATOR_VERTEX_SOURCE}`, {
            id: source.moduleId,
            imports,
            renderEntries: {
              vertex: TEXTURE_GENERATOR_VERTEX_ENTRY,
              fragment: pass.program.fragmentEntry,
              colorFormats: colorFormats(pass.writes),
            },
          })
        ).unwrap();
        entries.set(source.moduleId, {
          ...compiled.manifestEntry,
          glsl: '',
          identifier: source.moduleId,
          sourceDigest: sha256(compiled.wgsl),
        });
        dependencies.add(source.path);
        for (const module of compiled.deps) dependencies.add(catalog.get(module).unwrap().path);
      }
      const payload = {
        ...recipe,
        programs: {
          compilerFingerprint,
          entries: [...entries.values()],
          passes: recipe.passes.map((pass) => ({
            module: pass.program.module,
            fragmentEntry: pass.program.fragmentEntry,
            colorFormats: colorFormats(pass.writes),
          })),
        },
      };
      validateTextureGenerator(payload, true).unwrap();
      return {
        guid: input.guid,
        payload,
        refs: [...new Set(Object.values(recipe.inputs))],
        artifacts: {},
        inputFingerprint: `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`,
        sourceDependencies: [...dependencies].sort(),
      };
    },
  };
}
