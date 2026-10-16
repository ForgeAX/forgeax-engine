import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import ts from 'typescript';
import type { PackAuthoringError } from './pack-authoring.js';
import { validatePluginAssetSource } from './plugin-asset.js';
import {
  relativeScriptableImportCandidates,
  SCRIPTABLE_SOURCE_EXTENSIONS,
} from './scriptable-pack-relative-import.js';
import {
  type SnapshotTranspileText,
  snapshotTranspileKey,
  snapshotTranspileText,
  transpileTextDigest,
  validSnapshotTranspileText,
} from './scriptable-pack-transpile-text.js';
import { isScriptablePackField, projectFailure } from './scriptable-pack-wire.js';

if (parentPort === null) throw new Error('ScriptablePack worker requires a parent port');

const { createRequire, isBuiltin } = nodeModule;
const flushCompileCache = (
  nodeModule as typeof nodeModule & { readonly flushCompileCache?: () => void }
).flushCompileCache;
const port = parentPort;
const workerMode = workerData as {
  readonly mode?: 'single' | 'reusable';
  readonly sourcePath?: string;
  readonly compileRoot?: string;
  sources?: Readonly<Record<string, string>>;
  transpiles?: readonly SnapshotTranspileText[];
};
const reusable = workerMode.mode === 'reusable';
let sourcePath = workerMode.sourcePath;
let compileRoot = workerMode.compileRoot;
let capturedSources = workerMode.sources;
let capturedTranspiles = workerMode.transpiles;
let completedTranspiles: SnapshotTranspileText[] = [];
let reliableTranspileRecipe: string | undefined;
function tryTranspileRecipe(): string | undefined {
  if (reliableTranspileRecipe !== undefined) return reliableTranspileRecipe;
  try {
    reliableTranspileRecipe = transpileTextDigest(
      JSON.stringify({
        version: 1,
        compilerVersion: ts.version,
        compilerBytes: createHash('sha256')
          .update(readFileSync(createRequire(import.meta.url).resolve('typescript')))
          .digest('hex'),
        workerBytes: createHash('sha256')
          .update(readFileSync(fileURLToPath(import.meta.url)))
          .digest('hex'),
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        isolatedModules: true,
        sourceMap: false,
        reportDiagnostics: true,
        imports: 'after-type-erasure-static-reexport-and-single-literal-dynamic-v1',
      }),
    );
    return reliableTranspileRecipe;
  } catch {
    // Missing optional cache identity never changes the original cold compiler path.
    return undefined;
  }
}

type LoadedDefinition = {
  readonly schemaVersion?: unknown;
  readonly packageId?: unknown;
  readonly name?: unknown;
  readonly parameters?: unknown;
  readonly sceneComponents?: unknown;
  readonly runtime?: unknown;
  readonly build?: unknown;
};
// Forward undeclared fields so the main-thread validator refuses them exactly
// as it refuses the same module loaded in-process; a value that cannot cross
// the port is replaced by its type name.
function undeclaredFields(value: object): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (isScriptablePackField(key)) continue;
    try {
      fields[key] = structuredClone(field);
    } catch {
      fields[key] = typeof field;
    }
  }
  return fields;
}
let definition: LoadedDefinition | undefined;
let nextReadId = 0;
const reads = new Map<number, (value: unknown) => void>();

function failure(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error;
  return projectFailure(error);
}

function serializableSceneComponents(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((component) => {
    const candidate = component as { readonly name?: unknown; readonly fields?: unknown };
    const fields =
      candidate.fields !== null &&
      typeof candidate.fields === 'object' &&
      !Array.isArray(candidate.fields)
        ? Object.fromEntries(
            Object.entries(candidate.fields as Record<string, unknown>).map(([name, field]) => [
              name,
              typeof field === 'string' ? field : (field as { readonly type?: unknown })?.type,
            ]),
          )
        : undefined;
    return { name: candidate.name, fields };
  });
}

function resolveRelativeImport(importer: string, specifier: string): string | undefined {
  return relativeScriptableImportCandidates(importer, specifier).find((candidate) =>
    capturedSources === undefined || !Object.hasOwn(capturedSources, importer)
      ? existsSync(candidate) && statSync(candidate).isFile()
      : Object.hasOwn(capturedSources, candidate),
  );
}

function outputName(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 20);
  return `${digest}.mjs`;
}

function resolveBareImport(importer: string, specifier: string): string | undefined {
  const resolver = (
    import.meta as ImportMeta & {
      readonly resolve?: (specifier: string, parent?: string) => string;
    }
  ).resolve;
  if (resolver === undefined) return undefined;
  // Resolve consumer dependencies from the source file first, then resolve
  // Engine self-references from this worker's package. A compiled source
  // closure lives in /tmp, so using only its path makes
  // @forgeax/engine-pack/source disappear from Node's lookup ancestry.
  for (const parent of [pathToFileURL(importer).href, import.meta.url]) {
    try {
      const resolved = resolver(specifier, parent);
      if (resolved.startsWith('file:')) return fileURLToPath(resolved);
    } catch {
      // Try the loader package before treating the import as unavailable.
    }
  }
  return undefined;
}

function resolvedModuleSpecifier(
  target: string,
  sources: ReadonlyMap<string, string>,
  loadId?: number,
): string {
  if (sources.has(target)) {
    return `./${outputName(target)}${loadId === undefined ? '' : `?load=${loadId}`}`;
  }
  return pathToFileURL(target).href;
}

/**
 * Node 22 does not execute `.ts` modules. Compile the trusted local module
 * closure into one disposable ESM directory before importing it. Bare package
 * imports are resolved by Node from the original source module and rewritten
 * to their canonical file URL; relative imports are rewritten to the compiled
 * closure by identity. This keeps unrelated nested node_modules directories
 * (for example Vite's cache) from changing package resolution.
 */
function compileModuleClosure(entryPath: string, outputRoot: string, loadId?: number): string {
  const pending = [resolve(entryPath)];
  const sources = new Map<string, string>();
  const imports = new Map<string, ReadonlyMap<string, string>>();
  const transpileRecipeDigest = capturedTranspiles === undefined ? undefined : tryTranspileRecipe();
  const cache = new Map<string, unknown>();
  if (Array.isArray(capturedTranspiles))
    for (const entry of capturedTranspiles)
      if (entry !== null && typeof entry === 'object' && typeof entry.key === 'string')
        cache.set(entry.key, entry);
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || sources.has(path)) continue;
    if (path.endsWith('?raw')) {
      const sourcePath = path.slice(0, -4);
      const text = capturedSources?.[sourcePath] ?? readFileSync(sourcePath, 'utf8');
      sources.set(path, `export default ${JSON.stringify(text)};`);
      continue;
    }
    const source = capturedSources?.[path] ?? readFileSync(path, 'utf8');
    if (extname(path) === '.json') {
      // JSON is data, not TypeScript. Parsing preserves own __proto__ keys.
      const json = JSON.stringify(JSON.parse(source));
      // Keep bulk data out of the module's retained JavaScript source. Read
      // only this captured compile artifact, never the live author file.
      const dataName = `${outputName(path)}.json`;
      writeFileSync(join(outputRoot, dataName), json);
      sources.set(
        path,
        `import { readFileSync } from 'node:fs';\nexport default JSON.parse(readFileSync(new URL('./${dataName}', import.meta.url), 'utf8'));\n`,
      );
      continue;
    }
    const resolvedImports = new Map<string, string>();
    const collectRuntimeImports = (sourceFile: ts.SourceFile): ts.SourceFile => {
      const visit = (node: ts.Node): void => {
        const specifier =
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
            ? node.moduleSpecifier.text
            : ts.isCallExpression(node) &&
                node.expression.kind === ts.SyntaxKind.ImportKeyword &&
                node.arguments.length === 1 &&
                node.arguments[0] !== undefined &&
                ts.isStringLiteral(node.arguments[0])
              ? node.arguments[0].text
              : undefined;
        if (specifier !== undefined) {
          const resolved = specifier.startsWith('.')
            ? resolveRelativeImport(path, specifier)
            : resolveBareImport(path, specifier);
          // Node builtins are valid native specifiers. Every other surviving
          // import must resolve from its authored importer before relocation.
          if (resolved === undefined && !isBuiltin(specifier)) {
            throw {
              code: 'pack-module-not-found',
              expected: 'a runtime module resolvable from the original Pack source',
              hint: 'Correct the import relative to detail.sourcePath, or install the named package in the project, then rebuild.',
              detail: { sourcePath: path, specifier },
            } satisfies PackAuthoringError;
          }
          const target =
            resolved === undefined
              ? undefined
              : specifier.endsWith('?raw')
                ? `${resolved}?raw`
                : resolved;
          if (target !== undefined) {
            resolvedImports.set(specifier, target);
            if (specifier.startsWith('.') || /\.(?:ts|tsx|mts|cts)$/.test(target)) {
              pending.push(target);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return sourceFile;
    };
    // Collect surviving dependencies after type erasure. Captured author
    // source remains the inventory authority, including type-only files.
    const cacheKey =
      transpileRecipeDigest === undefined
        ? undefined
        : snapshotTranspileKey(path, transpileTextDigest(source), transpileRecipeDigest);
    const cached = cacheKey === undefined ? undefined : cache.get(cacheKey);
    const reusableText =
      transpileRecipeDigest !== undefined &&
      validSnapshotTranspileText(cached, path, source, transpileRecipeDigest)
        ? cached
        : undefined;
    const hit = reusableText !== undefined;
    const transpiled =
      reusableText !== undefined
        ? { outputText: reusableText.outputText, diagnostics: [] }
        : ts.transpileModule(source, {
            fileName: path,
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
              moduleResolution: ts.ModuleResolutionKind.Bundler,
              isolatedModules: true,
              sourceMap: false,
            },
            transformers: { after: [() => collectRuntimeImports] },
            reportDiagnostics: true,
          });
    const errors =
      transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ) ?? [];
    if (errors.length > 0) {
      throw new Error(
        `ScriptablePack TypeScript transpile failed for ${path}: ${errors
          .map((diagnostic) => {
            const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
            const location =
              position === undefined
                ? path
                : `${path}:${position.line + 1}:${position.character + 1}`;
            return `${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
          })
          .join('; ')}`,
      );
    }
    // Only derived text is reusable. Resolve every surviving import again in this load.
    if (hit)
      collectRuntimeImports(
        ts.createSourceFile(
          path,
          transpiled.outputText,
          ts.ScriptTarget.ES2022,
          true,
          ts.ScriptKind.JS,
        ),
      );
    if (transpileRecipeDigest !== undefined && capturedSources?.[path] !== undefined)
      completedTranspiles.push(
        snapshotTranspileText(path, source, transpileRecipeDigest, transpiled.outputText),
      );
    sources.set(path, transpiled.outputText);
    imports.set(path, resolvedImports);
  }

  // Final membership keeps bare and relative aliases of one compiled file on
  // the same module instance. Reparse emitted JS without another transpile.
  const printer = ts.createPrinter();
  for (const [path, source] of sources) {
    const replacements = imports.get(path) ?? new Map<string, string>();
    if (replacements.size === 0) {
      writeFileSync(join(outputRoot, outputName(path)), source);
      continue;
    }
    const rewriteRuntimeImports: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const target = replacements.get(node.moduleSpecifier.text);
          if (target !== undefined) {
            const rewrittenSpecifier = ts.factory.createStringLiteral(
              resolvedModuleSpecifier(target, sources, loadId),
            );
            // Captured JSON is emitted as a JavaScript module. Keep unrelated
            // attributes observable, but remove the native JSON format claim.
            let attributes = node.attributes;
            if (attributes !== undefined && sources.has(target) && extname(target) === '.json') {
              const elements = attributes.elements.filter(
                (attribute) =>
                  !(
                    attribute.name.text === 'type' &&
                    ts.isStringLiteral(attribute.value) &&
                    attribute.value.text === 'json'
                  ),
              );
              attributes =
                elements.length === 0
                  ? undefined
                  : ts.factory.updateImportAttributes(
                      attributes,
                      ts.factory.createNodeArray(elements),
                    );
            }
            return ts.isImportDeclaration(node)
              ? ts.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  node.importClause,
                  rewrittenSpecifier,
                  attributes,
                )
              : ts.factory.updateExportDeclaration(
                  node,
                  node.modifiers,
                  node.isTypeOnly,
                  node.exportClause,
                  rewrittenSpecifier,
                  attributes,
                );
          }
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const target = replacements.get(node.arguments[0].text);
          if (target !== undefined) {
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              ts.factory.createStringLiteral(resolvedModuleSpecifier(target, sources, loadId)),
            ]);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
    const transformed = ts.transform(
      ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS),
      [rewriteRuntimeImports],
    );
    try {
      const rewritten = transformed.transformed[0];
      if (rewritten === undefined) throw new Error(`ScriptablePack rewrite failed for ${path}`);
      writeFileSync(join(outputRoot, outputName(path)), printer.printFile(rewritten));
    } finally {
      transformed.dispose();
    }
  }
  return join(outputRoot, outputName(resolve(entryPath)));
}

async function loadDefinition(task: {
  readonly sourcePath: string;
  readonly compileRoot: string;
  readonly loadId?: number;
  readonly sources?: Readonly<Record<string, string>>;
  readonly transpiles?: readonly SnapshotTranspileText[];
}): Promise<void> {
  sourcePath = task.sourcePath;
  compileRoot = task.compileRoot;
  capturedSources = task.sources;
  capturedTranspiles = task.transpiles;
  completedTranspiles = [];
  definition = undefined;
  reads.clear();
  try {
    const executablePath = SCRIPTABLE_SOURCE_EXTENSIONS.includes(
      extname(task.sourcePath) as (typeof SCRIPTABLE_SOURCE_EXTENSIONS)[number],
    )
      ? compileModuleClosure(task.sourcePath, task.compileRoot, task.loadId)
      : task.sourcePath;
    const loaded = (await import(
      `${pathToFileURL(executablePath).href}${reusable ? `?load=${task.loadId ?? 0}` : ''}`
    )) as {
      readonly default?: unknown;
    };
    definition = loaded.default as LoadedDefinition | undefined;
    // Preserve only Node's validated bytecode for the next fresh Worker. The
    // module graph and its retained values still die at the existing task fence.
    try {
      flushCompileCache?.();
    } catch {
      // Optional compile-cache I/O must not change the current source result.
    }
    port.postMessage({
      kind: 'loaded',
      ...(capturedTranspiles === undefined ? {} : { transpiles: completedTranspiles }),
      ...(task.loadId === undefined ? {} : { loadId: task.loadId }),
      definition:
        definition === undefined
          ? undefined
          : {
              schemaVersion: definition.schemaVersion,
              packageId: definition.packageId,
              ...(definition.name === undefined ? {} : { name: definition.name }),
              ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
              ...(definition.runtime === undefined ? {} : { runtime: definition.runtime }),
              ...(definition.sceneComponents === undefined
                ? {}
                : { sceneComponents: serializableSceneComponents(definition.sceneComponents) }),
              ...undeclaredFields(definition),
            },
    });
  } finally {
    // postMessage has already cloned the derived text for the host snapshot.
    // Build and delayed imports use the compiled closure on disk, not these
    // load-only strings. workerData also owns the initial single-use payload.
    capturedSources = undefined;
    capturedTranspiles = undefined;
    completedTranspiles = [];
    delete workerMode.sources;
    delete workerMode.transpiles;
  }
}

async function handleMessage(message: unknown): Promise<void> {
  if (message === null || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.kind === 'asset-result' && typeof value.readId === 'number') {
    reads.get(value.readId)?.(value.result);
    reads.delete(value.readId);
    return;
  }
  if (
    reusable &&
    value.kind === 'load' &&
    typeof value.sourcePath === 'string' &&
    typeof value.compileRoot === 'string' &&
    typeof value.loadId === 'number'
  ) {
    try {
      await loadDefinition({
        sourcePath: value.sourcePath,
        compileRoot: value.compileRoot,
        loadId: value.loadId,
        ...(value.sources === undefined
          ? {}
          : { sources: value.sources as Record<string, string> }),
        ...(value.transpiles === undefined
          ? {}
          : { transpiles: value.transpiles as readonly SnapshotTranspileText[] }),
      });
    } catch (error) {
      port.postMessage({ kind: 'load-threw', loadId: value.loadId, error: failure(error) });
    }
    return;
  }
  if (value.kind !== 'build' || typeof value.buildId !== 'number') return;
  if (typeof definition?.build !== 'function') {
    port.postMessage({
      kind: 'build-result',
      buildId: value.buildId,
      result: { ok: false, error: { message: 'default export has no build function' } },
    });
    return;
  }
  try {
    const context =
      value.context !== null && typeof value.context === 'object'
        ? (value.context as { readonly packageId?: unknown; readonly values?: unknown })
        : undefined;
    const buildContext = {
      ...(Array.isArray(context?.packageId)
        ? { packageId: new Uint8Array(context.packageId as number[]) }
        : {}),
      ...(context?.values !== undefined ? { values: context.values } : {}),
      readByGuid(guid: Uint8Array): Promise<unknown> {
        const readId = nextReadId++;
        port.postMessage({ kind: 'asset-read', buildId: value.buildId, readId, guid });
        return new Promise((resolve) => reads.set(readId, resolve));
      },
    };
    const result = await definition.build(buildContext);
    if (
      result !== null &&
      typeof result === 'object' &&
      'ok' in result &&
      result.ok &&
      'value' in result &&
      result.value !== null &&
      typeof result.value === 'object'
    ) {
      for (const output of Object.values(result.value)) {
        if (
          output !== null &&
          typeof output === 'object' &&
          'kind' in output &&
          output.kind === 'plugin'
        ) {
          const validated = validatePluginAssetSource(output);
          if (!validated.ok) throw validated.error;
        }
      }
    }
    port.postMessage({
      kind: 'build-result',
      buildId: value.buildId,
      result:
        result !== null && typeof result === 'object' && 'ok' in result && !result.ok
          ? { ...result, error: failure(result.error) }
          : result,
    });
  } catch (error) {
    port.postMessage({ kind: 'build-threw', buildId: value.buildId, error: failure(error) });
  }
}

port.on('message', (message: unknown) => {
  void handleMessage(message);
});

if (!reusable && sourcePath !== undefined && compileRoot !== undefined) {
  try {
    await loadDefinition({
      sourcePath,
      compileRoot,
      ...(capturedSources === undefined ? {} : { sources: capturedSources }),
      ...(capturedTranspiles === undefined ? {} : { transpiles: capturedTranspiles }),
    });
  } catch (error) {
    port.postMessage({ kind: 'load-threw', error: failure(error) });
  }
}
