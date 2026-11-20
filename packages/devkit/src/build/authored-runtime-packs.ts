import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import { PackageId, projectScriptablePackMeta } from '@forgeax/engine-pack/source';
import type { ScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { normalizePath } from 'vite';
import type { BuildOptions } from '../types.js';
import { preparePackProgramSource } from './pack-program.js';
import {
  createNodePackProgramResolver,
  PACK_PROGRAM_ENGINE_IMPORTS,
} from './pack-program-imports.js';

/** Keep the host and Task Worker bound to the same Engine module identities. */
export function authoredRuntimePackImports(
  packs: readonly AuthoredRuntimePack[],
): readonly string[] {
  return [
    ...new Set([
      ...PACK_PROGRAM_ENGINE_IMPORTS,
      ...packs.flatMap(({ program }) => Object.keys(program.imports ?? {})),
    ]),
  ];
}

/** Prepare the named generator from the same immutable source scan as the built outputs. */
export async function prepareAuthoredRuntimePacks(
  projectRoot: string,
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  snapshot: ScriptablePackSourceSnapshot,
  target?: BuildOptions['target'],
): Promise<{
  readonly packs: readonly AuthoredRuntimePack[];
  readonly cooked: ReadonlySet<string>;
}> {
  const resolveImport = createNodePackProgramResolver(projectRoot);
  const identities = new Map<string, Promise<string>>();
  const programIdentity = (specifier: string) => {
    if (!/^@forgeax\/engine(?:[/-]|$)/.test(specifier))
      throw new TypeError(`Runtime Pack requires a portable Engine module import: ${specifier}`);
    let bound = identities.get(specifier);
    if (!bound) {
      bound = resolveImport(specifier).then(({ identity }) => identity);
      identities.set(specifier, bound);
    }
    return bound;
  };
  const prepared: AuthoredRuntimePack[] = [];
  const cooked = new Set<string>();
  for (const declaration of declarations.values()) {
    if (declaration.format !== 'pack.ts') continue;
    const { definition, sourcePath } = declaration;
    const runtime = definition.runtime;
    if (runtime?.export === undefined) continue;
    if (target === 'wechat') {
      if (runtime.fallback !== 'build') {
        throw Object.assign(
          new TypeError(`Runtime Pack has no Task Worker carrier: ${sourcePath}`),
          {
            code: 'runtime-pack-task-worker-unavailable',
            expected: 'a Task Worker carrier or explicit offline generation',
            hint: 'choose a Worker-capable target or declare runtime.fallback: build',
            detail: { sourcePath },
          },
        );
      }
      cooked.add(PackageId.format(definition.packageId));
      continue;
    }
    const { entry, sources } = await snapshot.moduleSources(sourcePath);
    const projectPath = (path: string) => normalizePath(relative(projectRoot, path));
    const displayPath = projectPath(entry);
    const modules = Object.fromEntries(
      Object.entries(sources).map(([path, text]) => [projectPath(path), text]),
    );
    const imports = new Set<string>();
    for (const path of Object.keys(sources)) {
      if (path.endsWith('?bytes'))
        throw new TypeError(`Runtime Pack cannot deliver file bytes: ${path}`);
      for (const specifier of await snapshot.imports(path)) {
        if (!specifier.startsWith('.')) imports.add(specifier);
      }
    }
    const program = preparePackProgramSource({
      entry: displayPath,
      export: runtime.export,
      modules,
      imports: Object.fromEntries(
        await Promise.all(
          [...imports].map(async (specifier) => [specifier, await programIdentity(specifier)]),
        ),
      ),
    });
    if (!program.ok) {
      throw new TypeError(`Runtime Pack ${displayPath}: ${JSON.stringify(program.error)}`);
    }
    const { plugins: _plugins, ...metadata } = projectScriptablePackMeta(definition, displayPath);
    prepared.push({
      source: {
        ...metadata,
        program: program.value.digest,
        ...(definition.sceneComponents === undefined
          ? {}
          : { sceneComponents: definition.sceneComponents }),
      },
      program: program.value,
    });
  }
  return { packs: prepared, cooked };
}

export function authoredRuntimePackDeclarations(packs: readonly AuthoredRuntimePack[]): string {
  return `export const authored = ${JSON.stringify(packs)};\n`;
}

export interface StaticProgramEntry extends Pick<PackProgramSource, 'entry' | 'modules'> {
  readonly path: string;
}

/** Static carriers compile the verified generator bytes into their native task module graph. */
export async function authoredStaticPackPrograms(
  packs: readonly AuthoredRuntimePack[],
  generatedRoot: string,
): Promise<readonly StaticProgramEntry[]> {
  return Promise.all(
    packs.map(async ({ program }) => {
      const root = resolve(generatedRoot, 'authored-runtime-programs', program.digest.slice(7));
      await Promise.all(
        Object.entries(program.modules).map(async ([path, source]) => {
          const filename = resolve(root, path);
          await mkdir(dirname(filename), { recursive: true });
          await writeFile(filename, source);
        }),
      );
      return { path: resolve(root, program.entry), entry: program.entry, modules: program.modules };
    }),
  );
}
