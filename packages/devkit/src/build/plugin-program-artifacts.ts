import {
  type PackProgram,
  type PackProgramImport,
  preparePackProgram,
} from '@forgeax/engine-pack/runtime';

export function packProgramImportIdentities(imports: Readonly<Record<string, PackProgramImport>>) {
  return Object.fromEntries(
    Object.entries(imports).map(([name, binding]) => [name, binding.identity]),
  );
}

/** A delivery sidecar stores one sealed graph with a digest for each selected entry. */
export function sealPluginProgramGraph(
  modules: Readonly<Record<string, string>>,
  imports: Readonly<Record<string, string>>,
  selections: Iterable<readonly [key: string, entry: string]>,
) {
  type Graph = Pick<PackProgram, 'modules' | 'imports'>;
  type Selection = Pick<PackProgram, 'entry' | 'export' | 'digest'>;
  const programs: [string, Selection][] = [];
  let graph: Graph | undefined;
  for (const [key, entry] of selections) {
    const program = preparePackProgram({ modules, imports, entry, export: 'default' }).unwrap();
    const { entry: path, export: name, digest, ...closure } = program;
    graph ??= closure;
    programs.push([key, { entry: path, export: name, digest }]);
  }
  return { graph: graph ?? { modules, imports }, programs };
}
