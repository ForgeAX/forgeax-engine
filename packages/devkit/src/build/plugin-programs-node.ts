import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PackProgramImport } from '@forgeax/engine-pack/runtime';
import { sha256 } from '@forgeax/engine-types';
import { resolve as resolveImport } from 'import-meta-resolve';
import { build, type InlineConfig } from 'vite';
import { projectToolProjection } from '../tools/project-tools.js';
import type { ProjectFacts } from '../types.js';
import { rewriteModuleSpecifiers } from './module-specifiers.js';
import { nativeModuleIdentity, nativeModuleKey } from './native-module-identity.js';
import { createNodePackProgramResolver } from './pack-program-imports.js';
import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  type PluginSourceInventory,
  pluginAssetClosure,
} from './plugin-assets.js';
import { packProgramImportIdentities, sealPluginProgramGraph } from './plugin-program-artifacts.js';
import {
  assertPluginProgramGraphInputs,
  exportModule,
  pluginRuntimeProjection,
  projectPluginPrograms,
} from './plugin-programs.js';

/** Build and resident Node realms share one compiler, portable graph and native module identity. */
export async function openNodePluginStage(root: string, realm: 'build' | 'host') {
  const directory = resolve(root, '.forgeax', realm);
  await mkdir(directory, { recursive: true });
  const path = await mkdtemp(resolve(directory, 'session-'));
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}

export async function compileNodePluginPrograms(
  facts: ProjectFacts,
  target: 'build' | 'host',
  inventory: PluginSourceInventory,
  temporary: string,
  resolution: Pick<InlineConfig, 'resolve' | 'plugins'> = {},
  trace: <T>(stage: string, operation: () => Promise<T>) => Promise<T> = (_stage, operation) =>
    operation(),
): Promise<{
  readonly entry: string;
  readonly watchFiles: ReadonlySet<string>;
  readonly producerIdentity: string;
}> {
  // The selected realm root and its references own execution placement.
  // Sharing a Pack source does not make another realm's plugins executable here.
  const records = pluginAssetClosure(inventory, facts.roots[target]);
  const { tools } = await trace('host-compile-tools', () =>
    projectToolProjection(facts.root, inventory),
  );
  const projection = projectPluginPrograms(records, target, tools, facts.root);
  const entries = [...projection.programs];
  const watchFiles = new Set<string>();
  const resolveProgramImport = createNodePackProgramResolver(facts.root, trace);
  const bindings = new Map<string, { key: string; binding: PackProgramImport }>();
  const identities = new Map<string, Promise<string>>();
  const project = pathToFileURL(resolve(facts.root, 'package.json')).href;
  const recordExternal = async (url: string, key: string, supplied?: PackProgramImport) => {
    if (!bindings.has(url)) {
      let identity = identities.get(url);
      if (!identity) {
        identity = supplied ? Promise.resolve(supplied.identity) : nativeModuleIdentity(url);
        identities.set(url, identity);
      }
      bindings.set(url, { key, binding: { identity: await identity, url } });
    }
    return { id: url, external: true as const };
  };
  const output = entries.length
    ? await trace('host-compile-vite', () =>
        build({
          ...resolution,
          root: facts.root,
          configFile: false,
          logLevel: 'silent',
          plugins: [
            {
              name: 'forgeax:build-native-identity',
              enforce: 'pre',
              resolveId: {
                // Preserve native identities before Vite's own alias hook rewrites their IDs.
                order: 'pre',
                async handler(id, importer) {
                  if (
                    id.startsWith('virtual:') ||
                    id.startsWith('\0') ||
                    id.startsWith('.') ||
                    isAbsolute(id)
                  )
                    return undefined;
                  if (
                    isBuiltin(id) ||
                    id === '@deepseek-ai/cordis' ||
                    id === '@forgeax/engine' ||
                    id.startsWith('@forgeax/engine/') ||
                    id.startsWith('@forgeax/engine-')
                  ) {
                    const key =
                      isBuiltin(id) && !id.startsWith('node:')
                        ? `node:${id}`
                        : id === '@forgeax/engine-plugin'
                          ? '@forgeax/engine/plugin'
                          : id === '@forgeax/engine-tool-runtime'
                            ? '@forgeax/engine/tool-runtime'
                            : id;
                    const binding = await resolveProgramImport(key);
                    return recordExternal(binding.url, key, binding);
                  }
                  const resolved = await this.resolve(id, importer, { skipSelf: true });
                  if (!resolved?.external) return resolved;
                  const parent =
                    importer && isAbsolute(importer)
                      ? pathToFileURL(importer.split('?')[0] ?? importer).href
                      : project;
                  const url = resolveImport(resolved.id, parent);
                  return recordExternal(url, await nativeModuleKey(facts.root, url, importer));
                },
              },
            },
            ...(resolution.plugins ?? []),
            pluginRuntimeProjection(facts.root, inventory.sourceInputs),
            {
              name: 'forgeax:build-inputs',
              async buildStart() {
                for (const [, value] of entries)
                  await trace('host-compile-inputs', () =>
                    capturePluginProgramInputs(
                      facts.root,
                      inventory,
                      value.module,
                      async (specifier, importer) => (await this.resolve(specifier, importer))?.id,
                    ),
                  );
              },
              async buildEnd() {
                assertPluginProgramGraphInputs(facts.root, inventory, this.getModuleIds(), (id) =>
                  this.getModuleInfo(id),
                );
                await assertPluginSourceInputs(inventory, facts.root);
                inventory.sourceSnapshot.releaseResolvers();
                for (const id of this.getModuleIds())
                  if (id.startsWith('/')) watchFiles.add(id.split('?')[0] ?? id);
              },
            },
          ],
          build: {
            ssr: true,
            write: false,
            target: 'node22',
            minify: false,
            rollupOptions: {
              input: Object.fromEntries(
                entries.map(([, value], index) => [
                  `program-${index}`,
                  exportModule(value.module, value.export),
                ]),
              ),
              preserveEntrySignatures: 'strict',
              output: {
                format: 'es',
                entryFileNames: '[name].mjs',
                chunkFileNames: '[name]-[hash].mjs',
              },
            },
          },
        }),
      )
    : undefined;
  const chunks = output && !Array.isArray(output) && 'output' in output ? output.output : [];
  const modules: Record<string, string> = {};
  const entryFiles = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.type !== 'chunk')
      throw new TypeError(
        `plugin program resource requires a portable producer: ${chunk.fileName}`,
      );
    if (chunk.facadeModuleId !== null) entryFiles.set(chunk.facadeModuleId, chunk.fileName);
    modules[chunk.fileName] = rewriteModuleSpecifiers(
      chunk.code,
      chunk.fileName,
      (specifier) => bindings.get(specifier)?.key,
    );
  }
  const imports = Object.fromEntries(
    [...bindings.values()].map(({ key, binding }) => [key, binding]),
  );
  const selections = entries.map(([key, value]) => {
    const entry = entryFiles.get(`\0${exportModule(value.module, value.export)}`);
    if (entry === undefined) throw new TypeError(`missing compiled plugin export ${key}`);
    return [key, entry] as const;
  });
  const { graph, programs: artifacts } = sealPluginProgramGraph(
    modules,
    packProgramImportIdentities(imports),
    selections,
  );
  await trace('host-compile-fence', () => assertPluginSourceInputs(inventory, facts.root));
  const entry = resolve(temporary, 'compiled/entry.mjs');
  await mkdir(resolve(temporary, 'compiled'), { recursive: true });
  // These sealed compiler facts are data. Keeping them out of the executable
  // loader avoids compiling and caching the complete graph again as a JS literal.
  await writeFile(
    resolve(temporary, 'compiled/programs.json'),
    JSON.stringify({
      graph,
      imports,
      artifacts,
      definitions: records.map((record) => [record.definition.guid, record.definition.evidence]),
      tools: [...projection.tools],
    }),
  );
  // Generated native programs need only this filesystem/Pack owner. Importing
  // the DevKit facade here also activates unrelated browser/build dependencies.
  const bundledHost = new URL('./pack-program-host.mjs', import.meta.url);
  const programHost = existsSync(fileURLToPath(bundledHost))
    ? bundledHost
    : new URL('../../dist/pack-program-host.mjs', import.meta.url);
  await writeFile(
    entry,
    `import { readFile } from 'node:fs/promises';
import { loadPackProgram } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-pack/runtime'))};
import { createNodePackProgramHost } from ${JSON.stringify(programHost.href)};
const { graph, imports, artifacts, definitions: definitionRows, tools: toolRows } =
  JSON.parse(await readFile(new URL('./programs.json', import.meta.url), 'utf8'));
const programHost = createNodePackProgramHost(${JSON.stringify(resolve(temporary, 'programs'))});
const programs = new Map(artifacts.map(([key, selection]) => {
  const artifact = { ...graph, ...selection };
  return [key, { exportSource: async () => artifact, load: async () => (await loadPackProgram(artifact, imports, programHost)).unwrap() }];
}));
const definitions = new Map(definitionRows);
const tools = new Map(toolRows);
export function createPrograms(sessionId, contextId, sessionGeneration) {
  return Object.freeze({ sessionId, contextId, sessionGeneration, target: ${JSON.stringify(target)}, programs, definitions, tools, imports, programHost });
}
`,
  );
  return {
    entry,
    watchFiles,
    producerIdentity: `sha256:${sha256(
      JSON.stringify([
        target,
        facts.roots[target],
        artifacts,
        records.map(({ definition }) => [definition.guid, definition.asset]),
      ]),
    )}`,
  };
}
