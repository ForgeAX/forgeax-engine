import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACK_PROGRAM_WORKER_SOURCE } from '@forgeax/engine-pack/runtime-browser';
import { moduleResolve } from 'import-meta-resolve';
import MagicString from 'magic-string';
import ts from 'typescript';
import { normalizePath, type Plugin, type Rollup, searchForWorkspaceRoot } from 'vite';
import { moduleSpecifierEdits } from './module-specifiers.js';
import { PACK_PROGRAM_ENGINE_IMPORTS, runtimeProgramIdentity } from './pack-program-imports.js';

const require = createRequire(import.meta.url);
async function canonicalModuleId(id: string): Promise<string> {
  const file = id.split('?')[0] ?? id;
  return isAbsolute(file) ? normalizePath(await realpath(file)) + id.slice(file.length) : id;
}
function moduleIdentity(id: string): string {
  const file = id.split('?')[0] ?? id;
  if (!isAbsolute(file)) return id;
  // Compare identity without cache versions; preserve them on the actual Vite load URL.
  const query = id
    .slice(file.length + 1)
    .split('&')
    .filter((part) => !/^v(?:=|$)/.test(part))
    .join('&');
  return file + (query ? `?${query}` : '');
}

export const engineCapabilityMeta = 'forgeax.engineCapability';
export interface EngineCapabilityMeta {
  readonly specifier: string;
  readonly reference?: string;
}

/** Browser entrypoints of the Engine closure; Node-only exports never enter Vite's scan. */
export async function runtimeDependencyEntries(
  manifest: string,
  entries = new Map<string, string | undefined>(),
): Promise<string[]> {
  if (entries.has(manifest)) return [...entries.values()].filter((entry) => entry !== undefined);
  entries.set(manifest, undefined);
  const { name, dependencies = {} } = JSON.parse(await readFile(manifest, 'utf8')) as {
    readonly name: string;
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  try {
    const entry = moduleResolve(
      name,
      pathToFileURL(manifest),
      new Set(['browser', 'import', 'default']),
    );
    entries.set(manifest, normalizePath(fileURLToPath(entry)));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw cause;
  }
  for (const dependency of Object.keys(dependencies)) {
    if (!dependency.startsWith('@forgeax/engine-')) continue;
    await runtimeDependencyEntries(
      require.resolve(`${dependency}/package.json`, { paths: [dirname(manifest)] }),
      entries,
    );
  }
  return [...entries.values()].filter((entry) => entry !== undefined);
}

/** Keep runtime entries and URL-loaded project plugins in one module graph. */
export function executionWorkerEntries(
  runtimeImports: readonly string[] = PACK_PROGRAM_ENGINE_IMPORTS,
  delivery: 'browser' | 'native' = 'browser',
): Plugin {
  let building = false;
  let base = '/';
  let root = '';
  let allowedFiles: string[] | undefined;
  const virtual = 'virtual:forgeax/pack-program-imports';
  const importTableMarker = '__forgeax_delivered_program_imports__';
  let runtimeIdentity = '';
  const prepareIdentity = async (
    engineManifest: Rollup.PartialResolvedId | null,
  ): Promise<string> => {
    if (!engineManifest || engineManifest.external)
      throw new Error('Engine manifest unavailable from the Vite host');
    runtimeIdentity = await runtimeProgramIdentity(engineManifest.id);
    return runtimeIdentity;
  };
  const externalPrefix = 'forgeax-host-import:';
  const facades = new Map<string, string>();
  const imports = new Map<string, string>();
  const admitDevelopmentModule = (id: string): void => {
    const file = id.split('?')[0];
    // URL-only runtime imports do not pass through Vite's static import
    // analysis. Admit only their resolved entry files, including installed
    // package realpaths outside the project; Vite owns subsequent imports.
    if (allowedFiles && file && isAbsolute(file) && !allowedFiles.includes(normalizePath(file))) {
      allowedFiles.push(normalizePath(file));
    }
  };
  const developmentModule = (specifier: string, id: string): string => {
    const key = externalPrefix + encodeURIComponent(specifier);
    const previous = imports.get(key);
    if (previous && moduleIdentity(previous) !== moduleIdentity(id))
      throw new Error(`Engine capability resolves to multiple modules in one player: ${specifier}`);
    // Pin one actual URL, including its first transport version, for this player.
    const selected = previous ?? id;
    imports.set(key, selected);
    admitDevelopmentModule(selected);
    return selected;
  };
  const linkedEdges = new Map<string, { imports: string[]; dynamicImports: string[] }>();
  const owners = new Map<string, Promise<boolean>>();
  const engineOwner = (directory: string): Promise<boolean> => {
    const known = owners.get(directory);
    if (known) return known;
    const pending = (async () => {
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string')
          return (
            manifest.name === '@forgeax/engine' || manifest.name.startsWith('@forgeax/engine-')
          );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
      return dirname(directory) !== directory && engineOwner(dirname(directory));
    })();
    owners.set(directory, pending);
    return pending;
  };
  return {
    name: 'forgeax:execution-worker-entries',
    enforce: 'pre',
    configResolved(config) {
      base = config.base;
      root = normalizePath(config.root);
      allowedFiles = config.command === 'serve' ? config.server.fs.allow : undefined;
    },
    async resolveId(id, importer, options) {
      if (id === virtual) return `\0${virtual}`;
      if (delivery === 'native') return null;
      if (id.startsWith(externalPrefix)) return { id, external: true };
      if (!importer || !/^@forgeax\/engine(?:$|[/-])/.test(id)) return null;
      const filename = importer.split('?')[0] ?? importer;
      if (isAbsolute(filename) && (await engineOwner(dirname(filename)))) return null;
      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) this.error(`Engine capability unavailable: ${id}`);
      resolved.id = await canonicalModuleId(resolved.id);
      const identity = moduleIdentity(resolved.id);
      if (!building) {
        resolved.id = developmentModule(id, resolved.id);
        return {
          ...resolved,
          meta: {
            ...resolved.meta,
            [engineCapabilityMeta]: { specifier: id } satisfies EngineCapabilityMeta,
          },
        };
      }
      let reference = facades.get(identity);
      if (!reference) {
        reference = this.emitFile({ type: 'chunk', id: resolved.id, preserveSignature: 'strict' });
        facades.set(identity, reference);
      }
      const external = externalPrefix + encodeURIComponent(id);
      const previous = imports.get(external);
      if (previous && previous !== reference)
        this.error(
          `Engine capability resolves to multiple modules in one player: ${id}; previous=${[...facades].find(([, value]) => value === previous)?.[0]}; current=${resolved.id}`,
        );
      imports.set(external, reference);
      return {
        id: external,
        external: true,
        meta: {
          [engineCapabilityMeta]: { specifier: id, reference } satisfies EngineCapabilityMeta,
        },
      };
    },
    async load(id) {
      if (id !== `\0${virtual}`) return null;
      const identity =
        runtimeIdentity ||
        (await prepareIdentity(
          await this.resolve('@forgeax/engine/package.json', undefined, { skipSelf: true }),
        ));
      if (delivery === 'native')
        return `export default ${JSON.stringify(Object.fromEntries(runtimeImports.map((specifier) => [specifier, { identity, url: `https://forgeax.package/modules/${encodeURIComponent(specifier)}` }])))};`;
      for (const specifier of runtimeImports) {
        const resolved = await this.resolve(specifier, undefined, { skipSelf: true });
        if (!resolved || resolved.external)
          this.error(`Runtime program import unavailable: ${specifier}`);
        resolved.id = await canonicalModuleId(resolved.id);
        const identity = moduleIdentity(resolved.id);
        let reference = facades.get(identity);
        if (building && !reference) {
          reference = this.emitFile({
            type: 'chunk',
            id: resolved.id,
            preserveSignature: 'strict',
          });
          facades.set(identity, reference);
        }
        if (building && reference) {
          const external = externalPrefix + encodeURIComponent(specifier);
          const previous = imports.get(external);
          if (previous && previous !== reference)
            this.error(
              `Engine capability resolves to multiple modules in one player: ${specifier}`,
            );
          imports.set(external, reference);
        }
        if (!building) resolved.id = developmentModule(specifier, resolved.id);
      }
      const table = building
        ? `export default Object.freeze(${JSON.stringify(importTableMarker)});`
        : `export default { ${[...imports]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, id]) => {
              const file = id.split('?')[0] ?? id;
              const query = id.slice(file.length);
              const pathname = pathToFileURL(file).pathname;
              const url = file.startsWith(`${root}/`)
                ? `${base}${pathname.slice(pathToFileURL(`${root}/`).pathname.length)}`
                : `${base}@fs${pathname}`;
              return `${JSON.stringify(decodeURIComponent(key.slice(externalPrefix.length)))}: { identity: ${JSON.stringify(identity)}, url: new URL(${JSON.stringify(`${url}${query}`)}, globalThis.location.origin).href }`;
            })
            .join(',')} };`;
      // Literal imports stay in the same native module graph as the game.
      // Embedded hosts receive these namespaces instead of bundled substitutes.
      return `${table}
const modules = { ${runtimeImports.map((specifier) => `${JSON.stringify(specifier)}: () => import(${JSON.stringify(specifier)})`).join(',')} };
export function loadImport(specifier) {
  const load = modules[specifier];
  if (!load) throw new TypeError('Runtime program import unavailable: ' + specifier);
  return load();
}`;
    },
    renderChunk(code, chunk) {
      const output = new MagicString(code);
      if (code.includes(importTableMarker)) {
        // At render time every project capability has resolved. The ordinary
        // runtime table can now include the exact delivered public facades.
        const fields = [...imports]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([external, reference]) => {
            const specifier = decodeURIComponent(external.slice(externalPrefix.length));
            const path = posix.relative(posix.dirname(chunk.fileName), this.getFileName(reference));
            return `${JSON.stringify(specifier)}: { identity: ${JSON.stringify(runtimeIdentity)}, url: new URL(${JSON.stringify(path.startsWith('./') || path.startsWith('../') ? path : `./${path}`)}, import.meta.url).href }`;
          });
        const file = ts.createSourceFile(
          chunk.fileName,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const edits: { start: number; end: number }[] = [];
        const visit = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node) && node.text === importTableMarker)
            edits.push({ start: node.getStart(file), end: node.end });
          ts.forEachChild(node, visit);
        };
        visit(file);
        for (const edit of edits) output.overwrite(edit.start, edit.end, `{ ${fields.join(',')} }`);
      }
      const edges = { imports: [] as string[], dynamicImports: [] as string[] };
      const edits = moduleSpecifierEdits(code, chunk.fileName, (specifier, kind) => {
        const reference = imports.get(specifier);
        if (!reference) return undefined;
        edges[kind === 'static' ? 'imports' : 'dynamicImports'].push(specifier);
        const relative = posix.relative(posix.dirname(chunk.fileName), this.getFileName(reference));
        return relative.startsWith('./') || relative.startsWith('../') ? relative : `./${relative}`;
      });
      for (const edit of edits) output.overwrite(edit.start, edit.end, edit.text);
      linkedEdges.set(chunk.fileName, edges);
      return output.hasChanged()
        ? { code: output.toString(), map: output.generateMap({ hires: true }) }
        : null;
    },
    async configureServer(server) {
      if (runtimeImports.length > 0) {
        try {
          const environment = server.environments.client;
          if (!environment)
            throw new TypeError('Runtime program imports require a client environment');
          await prepareIdentity(
            (await environment.pluginContainer.resolveId('@forgeax/engine/package.json')) ?? null,
          );
          if (environment.depsOptimizer) {
            // Runtime capabilities can expose subpaths absent from App's main
            // entry graph. Discover their dependencies before freezing programs.
            const runtimeEntries: string[] = [];
            for (const specifier of runtimeImports) {
              const resolved = await environment.pluginContainer.resolveId(specifier);
              if (!resolved || resolved.external)
                throw new TypeError(`Runtime program import unavailable: ${specifier}`);
              const file = resolved.id.split('?')[0];
              if (file && isAbsolute(file)) runtimeEntries.push(normalizePath(file));
            }
            const entries = environment.config.optimizeDeps.entries;
            environment.config.optimizeDeps.entries = [
              ...new Set([
                ...(typeof entries === 'string' ? [entries] : (entries ?? ['**/*.html'])),
                ...runtimeEntries,
              ]),
            ];
          }
        } catch (cause) {
          await server.close();
          throw cause;
        }
      }
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== `${base}forgeax-pack-program-worker.js`) return next();
        response.setHeader('content-type', 'text/javascript');
        response.end(PACK_PROGRAM_WORKER_SOURCE);
      });
    },
    generateBundle(_options, bundle) {
      if (delivery === 'native') return;
      // Rolldown's renderChunk view has getter-only metadata. Update that
      // projection here; JS locators were already linked before hash finalization.
      const target = (id: string) => {
        const reference = imports.get(id);
        return reference ? this.getFileName(reference) : id;
      };
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const edges = linkedEdges.get(chunk.preliminaryFileName);
        chunk.imports = [...new Set([...chunk.imports, ...(edges?.imports ?? [])].map(target))];
        chunk.dynamicImports = [
          ...new Set([...chunk.dynamicImports, ...(edges?.dynamicImports ?? [])].map(target)),
        ];
      }
      this.emitFile({
        type: 'asset',
        fileName: 'forgeax-pack-program-worker.js',
        source: PACK_PROGRAM_WORKER_SOURCE,
      });
    },
    async config(config, environment) {
      building = environment.command === 'build';
      // The shared graph also runs in Workers. Vite's dynamic-import preload
      // helper accesses document, so emitted Worker imports must stay native.
      if (building) return { build: { modulePreload: false } };
      const root = config.root ?? process.cwd();
      const exclude = ['@forgeax/engine'];
      let manifest: string;
      try {
        manifest = require.resolve('@forgeax/engine/package.json', {
          paths: [root],
        });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw cause;
        // Source-only configuration probes need not install the public facade.
        return { optimizeDeps: { exclude } };
      }
      const { dependencies } = JSON.parse(await readFile(manifest, 'utf8')) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };
      // Worker runtime entries are served as native modules. Prebundling the
      // same Engine dependencies behind public plugin imports would create a
      // second set of component tokens and Scene module state in that Worker.
      // The umbrella manifest owns this package roster for pnpm and npm alike.
      exclude.push(
        ...Object.keys(dependencies ?? {}).filter((name) => name.startsWith('@forgeax/engine-')),
      );
      if (!exclude.includes('@forgeax/engine-app')) return { optimizeDeps: { exclude } };
      const appManifest = require.resolve('@forgeax/engine-app/package.json', {
        paths: [dirname(manifest)],
      });
      // Independent runs snapshot dependencies outside the project. Worker
      // constructor URLs do not receive Vite's imported-module file admission.
      // Admit their App-owned output directory, not the surrounding snapshot.
      return {
        optimizeDeps: {
          exclude,
          // Excluded Engine modules keep their identity, but their dependencies
          // still need discovery before the first page starts using them.
          entries: [
            '**/*.html',
            'execution-bootstrap.ts',
            ...(await runtimeDependencyEntries(appManifest)),
          ],
        },
        server: {
          fs: {
            allow: [
              ...(config.server?.fs?.allow === undefined ? [searchForWorkspaceRoot(root)] : []),
              resolve(dirname(appManifest), 'dist'),
            ],
          },
        },
      };
    },
    async transform(code, id) {
      if (!building) return null;
      if (id === '\0vite/preload-helper.js') {
        // Vite owns DOM CSS loading, URL resolution, CSP and error events. The
        // same graph also runs without a document: there, keep native import
        // results and failures instead of entering Vite's Window-only handler.
        const source = ts.createSourceFile(
          id,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        for (const statement of source.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            const fn = declaration.initializer;
            if (
              !ts.isIdentifier(declaration.name) ||
              declaration.name.text !== '__vitePreload' ||
              !fn ||
              !ts.isFunctionExpression(fn) ||
              !fn.parameters[0] ||
              !ts.isIdentifier(fn.parameters[0].name)
            )
              continue;
            const offset = fn.body.getStart(source) + 1;
            return {
              code: `${code.slice(0, offset)}\nif (typeof document === 'undefined') return ${fn.parameters[0].name.text}();\n${code.slice(offset)}`,
              map: null,
            };
          }
        }
        return this.error('Vite preload helper no longer exposes its native import function');
      }
      // These are the three App-owned literal constructor sites. Let Rollup
      // emit ordinary entries before Vite creates isolated Worker bundles;
      // otherwise a later bootstrap import evaluates Engine singletons twice
      // in the same realm (components, schedules and scene instance state).
      const pattern =
        /new Worker\(\s*new URL\(\s*(['"])(\.\/(?:engine|render|kernel)-worker-runtime\.mjs)\1,\s*import\.meta\.url\s*\)/g;
      const matches = [...code.matchAll(pattern)];
      if (matches.length === 0) return null;
      const output = new MagicString(code);
      for (const match of matches.reverse()) {
        const source = match[2];
        if (source === undefined || match.index === undefined) continue;
        const resolved = await this.resolve(source, id, { skipSelf: true });
        if (resolved === null) this.error(`Cannot resolve execution Worker ${source} from ${id}`);
        const reference = this.emitFile({
          type: 'chunk',
          id: resolved.id,
          name: basename(source, '.mjs'),
          preserveSignature: 'strict',
        });
        output.overwrite(
          match.index,
          match.index + match[0].length,
          `new Worker(import.meta.ROLLUP_FILE_URL_${reference}`,
        );
      }
      return { code: output.toString(), map: output.generateMap({ hires: true }) };
    },
  };
}
