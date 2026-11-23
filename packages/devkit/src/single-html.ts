import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '@forgeax/engine-types';
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse } from 'parse5';
import ts from 'typescript';
import { type ESTree, type Plugin, parseAst, Visitor, build as viteBuild } from 'vite';
import { publishChecksummedFile } from './archive.js';
import { staticPackEntryUrlPrefix } from './build/execution-workers.js';
import { DIST_MANIFEST_FILE, type DistArtifact, type DistManifest, mediaType } from './dist.js';
import { createEngineWorkspaceResolverForProject } from './host.js';
import {
  GENERATED_PREFIX,
  isImportMetaUrl,
  linkSingleHtmlModules,
  singleHtmlModuleLoaderSource,
} from './single-html-module-links.js';
import { prepareSingleHtmlStorage } from './single-html-storage.js';
import type { CommandError, CommandResult } from './types.js';
import { completeCommand } from './types.js';

const SINGLE_HTML_FORMAT = 'forgeax-single-html-game' as const;
const ENTRY_RESOURCE_PATH = `${GENERATED_PREFIX}entry.mjs`;
const RESOURCE_ELEMENTS = new Set(['img', 'source', 'video', 'audio', 'link']);
const RESOURCE_ATTRIBUTES = new Set(['src', 'poster', 'href']);

export interface SingleHtmlBundleArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly moduleLinks?: readonly {
    readonly kind: 'import' | 'url';
    readonly start: number;
    readonly end: number;
    readonly path: string;
  }[];
}

export interface SingleHtmlBundle {
  readonly entrySource: string;
  readonly artifacts: readonly SingleHtmlBundleArtifact[];
}

export interface SingleHtmlPackageOptions {
  readonly distRoot: string;
  readonly output: string;
  readonly manifest: DistManifest;
  readonly bundle: SingleHtmlBundle;
}

export interface SingleHtmlPackageResult {
  readonly schemaVersion: '1.0.0';
  readonly format: typeof SINGLE_HTML_FORMAT;
  readonly target: 'file';
  readonly project: DistManifest['project'];
  readonly base: DistManifest['base'];
  readonly html: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly checksumPath: string;
  readonly distManifestSha256: string;
  readonly embeddedAssets: number;
  readonly run: {
    readonly local: string;
    readonly shared: string;
  };
}

class SingleHtmlError extends Error implements CommandError {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'SingleHtmlError';
  }
}

function errorResult(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: new SingleHtmlError(code, expected, hint, detail) };
}

function toErrorResult(
  cause: unknown,
  code: string,
  expected: string,
  hint: string,
): CommandResult<never> {
  if (cause instanceof SingleHtmlError) return { ok: false, error: cause };
  return errorResult(code, expected, hint, {
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}

function normalizePath(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? value);
  } catch {
    return undefined;
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function safeScriptText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function contentTypeForDataUri(value: string): string {
  const semicolon = value.indexOf(';');
  return semicolon < 0 ? value : value.slice(0, semicolon);
}

function dataUri(bytes: Uint8Array, type: string): string {
  return `data:${contentTypeForDataUri(type)};base64,${Buffer.from(bytes).toString('base64')}`;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

type ParsedElement = DefaultTreeAdapterTypes.Element;
type ParsedNode = DefaultTreeAdapterTypes.Node;
type ElementLocation = NonNullable<ParsedElement['sourceCodeLocation']>;
type LocatedElement = ParsedElement & {
  sourceCodeLocation: ElementLocation & {
    startTag: NonNullable<ElementLocation['startTag']>;
  };
};

function attributeValueRange(
  source: string,
  location: { readonly startOffset: number; readonly endOffset: number },
): { readonly startOffset: number; readonly endOffset: number } | undefined {
  const raw = source.slice(location.startOffset, location.endOffset);
  const equals = raw.indexOf('=');
  if (equals < 0) return undefined;
  let cursor = equals + 1;
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  const quote = raw[cursor] === '"' || raw[cursor] === "'" ? raw[cursor] : undefined;
  if (quote !== undefined) {
    const start = cursor + 1;
    const end = raw.lastIndexOf(quote);
    return end <= start
      ? undefined
      : { startOffset: location.startOffset + start, endOffset: location.startOffset + end };
  }
  return {
    startOffset: location.startOffset + cursor,
    endOffset: location.endOffset,
  };
}

function hasSourceTag(node: ParsedNode): node is LocatedElement {
  return defaultTreeAdapter.isElementNode(node) && node.sourceCodeLocation?.startTag !== undefined;
}

function locatedElements(source: string): readonly LocatedElement[] {
  const elements: LocatedElement[] = [];
  function visit(node: ParsedNode): void {
    if (hasSourceTag(node)) elements.push(node);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(source, { sourceCodeLocationInfo: true }));
  return elements;
}

function attributeValue(element: ParsedElement, name: string): string | undefined {
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

function isModuleScript(element: ParsedElement): boolean {
  return (
    element.tagName.toLowerCase() === 'script' &&
    attributeValue(element, 'type')?.toLowerCase() === 'module'
  );
}

function hasLinkRel(element: ParsedElement, rel: 'stylesheet' | 'modulepreload'): boolean {
  return (
    element.tagName.toLowerCase() === 'link' &&
    attributeValue(element, 'rel')?.toLowerCase().split(/\s+/).includes(rel) === true
  );
}

function resourceForPath(
  path: string | undefined,
  resources: ReadonlyMap<string, SingleHtmlBundleArtifact>,
): SingleHtmlBundleArtifact | undefined {
  const lookup = path === undefined ? undefined : normalizePath(path);
  if (lookup === undefined) return undefined;
  const direct = resources.get(lookup);
  if (direct !== undefined) return direct;
  const suffix = `/${lookup}`;
  let match: SingleHtmlBundleArtifact | undefined;
  for (const [candidate, resource] of resources) {
    if (!candidate.endsWith(suffix)) continue;
    if (match !== undefined) return undefined;
    match = resource;
  }
  return match;
}

function resourcePath(reference: string, basePath: string): string | undefined {
  try {
    return normalizePath(new URL(reference, `https://forgeax.invalid/${basePath}`).pathname);
  } catch {
    return undefined;
  }
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  const unique = new Map<string, Replacement>();
  for (const replacement of replacements) {
    unique.set(`${replacement.start}:${replacement.end}`, replacement);
  }
  const ordered = [...unique.values()].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      throw new Error(
        `single-html AST replacements overlap (${previous.start}:${previous.end} and ${current.start}:${current.end})`,
      );
    }
  }
  return ordered
    .reverse()
    .reduce(
      (value, replacement) =>
        value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end),
      source,
    );
}

function inlineCss(
  css: string,
  cssPath: string,
  resources: ReadonlyMap<string, SingleHtmlBundleArtifact>,
): CommandResult<string> {
  const replacements: Replacement[] = [];
  const pattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  for (;;) {
    const match = pattern.exec(css);
    if (match === null) break;
    const reference = match[2]?.trim();
    if (
      reference === undefined ||
      reference.length === 0 ||
      reference.startsWith('data:') ||
      reference.startsWith('#')
    ) {
      continue;
    }
    if (/^(?:https?:|blob:)/i.test(reference)) {
      return errorResult(
        'single-html-css-external-resource',
        'CSS URL references to be embedded or data/blob URLs',
        'Move the CSS resource into the verified dist closure before packaging.',
        { cssPath, reference },
      );
    }
    const path = resourcePath(reference, cssPath);
    const resource = resourceForPath(path, resources);
    if (resource === undefined) {
      return errorResult(
        'single-html-css-asset-missing',
        'every local CSS URL to resolve to an embedded dist artifact',
        'Add the referenced asset to the project asset closure and rebuild.',
        { cssPath, reference, path: path ?? null },
      );
    }
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `url(${dataUri(resource.bytes, resource.mediaType)})`,
    });
  }
  return { ok: true, value: applyReplacements(css, replacements) };
}

type SingleHtmlEntry = { readonly kind: 'source' | 'file'; readonly value: string };
function collectEntrySource(html: string, distRoot: string): CommandResult<SingleHtmlEntry> {
  const entries = locatedElements(html).filter(isModuleScript);
  const external = entries.filter((element) => attributeValue(element, 'src') !== undefined);
  const inline = entries.filter((element) => attributeValue(element, 'src') === undefined);
  if (external.length === 0 && inline.length === 0) {
    return errorResult(
      'single-html-entry-missing',
      'production index.html to contain one module entry',
      'Rebuild the game with a module entry in its generated host.',
    );
  }
  if (inline.length > 1 || (inline.length > 0 && external.length > 0)) {
    return errorResult(
      'single-html-entry-ambiguous',
      'production index.html to contain local module entries or one inline entry',
      'Keep inline startup code in one entry, or use ordered local production modules.',
      { external: external.length, inline: inline.length },
    );
  }
  if (external.length > 1) {
    const imports: string[] = [];
    for (const element of external) {
      const src = attributeValue(element, 'src');
      const path =
        src === undefined || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
          ? undefined
          : normalizePath(src);
      if (path === undefined) {
        return errorResult(
          'single-html-entry-external',
          'every module entry to be a project-local dist artifact',
          'Rebuild the generated host with local production modules.',
          { src: src ?? null },
        );
      }
      imports.push(`import ${JSON.stringify(resolve(distRoot, path))};`);
    }
    // A single module graph preserves document order and evaluates shared dependencies once.
    return { ok: true, value: { kind: 'source', value: imports.join('\n') } };
  }
  const element = external[0] ?? inline[0];
  if (element === undefined) throw new Error('single-html entry selection was unexpectedly empty');
  const src = attributeValue(element, 'src');
  if (src === undefined) {
    const { startTag, endTag } = element.sourceCodeLocation;
    return {
      ok: true,
      value: {
        kind: 'source',
        value: html.slice(startTag.endOffset, endTag?.startOffset ?? startTag.endOffset),
      },
    };
  }
  if (/^(?:https?:|file:|data:|blob:)/i.test(src)) {
    return errorResult(
      'single-html-entry-external',
      'the module entry to be a project-local dist artifact',
      'Rebuild the game so the generated host points at a local production module.',
      { src },
    );
  }
  return { ok: true, value: { kind: 'file', value: src } };
}

const singleHtmlViteOptions = {
  configFile: false,
  base: './',
  logLevel: 'error',
  worker: { format: 'es' },
  build: {
    write: false,
    target: 'esnext',
    minify: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      preserveEntrySignatures: 'strict',
    },
  },
} as const;

function bundleFiles(output: Awaited<ReturnType<typeof viteBuild>>): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const result of Array.isArray(output) ? output : [output]) {
    if (!('output' in result)) throw new TypeError('single-html requires a completed Vite build');
    for (const file of result.output) {
      const source = file.type === 'chunk' ? file.code : file.source;
      files.set(file.fileName, typeof source === 'string' ? Buffer.from(source) : source);
    }
  }
  return files;
}

/** Vite copies public inputs before writing emitted files, outside its bundle output. */
async function includePublicFiles(directory: string, files: Map<string, Uint8Array>, prefix = '') {
  const names = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
    if (!prefix && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')) return [];
    throw cause;
  });
  for (const name of names.sort()) {
    const path = resolve(directory, name);
    const output = prefix + name;
    if ((await stat(path)).isDirectory()) await includePublicFiles(path, files, `${output}/`);
    else if (!files.has(output)) files.set(output, await readFile(path));
  }
}

function isPreloadHelperSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.split(/[?#]/, 1)[0] ?? value;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.startsWith('preload-helper-') && name.endsWith('.js');
}

function isLocalChunkImport(source: {
  readonly type?: string;
  readonly value?: unknown;
  readonly expressions?: readonly unknown[];
  readonly quasis?: readonly {
    readonly value: { readonly cooked?: string | null; readonly raw: string };
  }[];
}): boolean {
  const value =
    source.type === 'TemplateLiteral' && source.expressions?.length === 0
      ? (source.quasis?.[0]?.value.cooked ?? source.quasis?.[0]?.value.raw)
      : source.value;
  return typeof value === 'string' && /^(?:\.{1,2}\/|\/)/.test(value);
}

interface StaticImportSource {
  readonly type?: string;
  readonly expressions?: readonly unknown[];
  readonly start: number;
  readonly end: number;
  readonly value?: unknown;
}

function isStaticImportSource(source: unknown): source is StaticImportSource {
  if (typeof source !== 'object' || source === null) return false;
  const candidate = source as StaticImportSource;
  return (
    candidate.type === 'Literal' ||
    candidate.type === 'StringLiteral' ||
    (candidate.type === 'TemplateLiteral' && candidate.expressions?.length === 0)
  );
}

type SingleHtmlProgram = ReturnType<typeof parseAst>;

function preloadDependencyReplacements(code: string): Replacement[] {
  const fileName = resolve('forgeax-single-html-input.js');
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, types: [] };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => (resolve(path) === fileName ? source : undefined);
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const bindings = new Set<ts.Symbol>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isPreloadHelperSource(statement.moduleSpecifier.text)
    )
      continue;
    const imports = statement.importClause?.namedBindings;
    if (imports === undefined || !ts.isNamedImports(imports)) continue;
    for (const specifier of imports.elements) {
      const symbol = checker.getSymbolAtLocation(specifier.name);
      if (symbol !== undefined) bindings.add(symbol);
    }
  }
  const replacements: Replacement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const dependencies = node.arguments[1];
      if (symbol !== undefined && bindings.has(symbol) && dependencies !== undefined) {
        replacements.push({
          start: dependencies.getStart(source),
          end: dependencies.end,
          value: 'void 0',
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return replacements;
}

function runtimeImport(start: number): Replacement {
  return { start, end: start + 'import'.length, value: 'globalThis.__forgeaxImport' };
}

function dynamicImportReplacements(
  program: SingleHtmlProgram,
  beforeBundling: boolean,
  replacements: Replacement[] = [],
): readonly Replacement[] {
  new Visitor({
    ImportExpression(node) {
      // Keep local chunk imports until the bundler has linked them.
      if (!beforeBundling || !isLocalChunkImport(node.source))
        replacements.push(runtimeImport(node.start));
    },
  }).visit(program);
  return replacements;
}

function programReplacements(program: SingleHtmlProgram, code: string): readonly Replacement[] {
  const hasPreloadImport = program.body.some(
    (node) => node.type === 'ImportDeclaration' && isPreloadHelperSource(node.source.value),
  );
  // Minified imports can share a name with unrelated nested functions. Resolve
  // their lexical symbols instead of rewriting every same-spelled call.
  return dynamicImportReplacements(
    program,
    true,
    hasPreloadImport ? preloadDependencyReplacements(code) : [],
  );
}

function residualImportStart(code: string): number | undefined {
  let residualStart: number | undefined;
  new Visitor({
    ImportExpression(node) {
      residualStart ??= node.start;
    },
  }).visit(parseAst(code));
  return residualStart;
}

function isJavaScriptOutputAsset(fileName: string): boolean {
  return /\.(?:c?js|mjs)$/i.test(fileName);
}

function isRelativeStaticModuleSource(source: unknown): boolean {
  if (!isStaticImportSource(source)) return false;
  return typeof source.value === 'string' && /^(?:\.\/|\.\.\/)/.test(source.value);
}

function hasStaticJavaScriptImports(code: string): boolean {
  let found = false;
  try {
    new Visitor({
      ImportDeclaration(node) {
        if (isRelativeStaticModuleSource(node.source)) found = true;
      },
      ExportNamedDeclaration(node) {
        if (isRelativeStaticModuleSource(node.source)) found = true;
      },
      ExportAllDeclaration(node) {
        if (isRelativeStaticModuleSource(node.source)) found = true;
      },
    }).visit(parseAst(code));
  } catch {
    return false;
  }
  return found;
}

const GENERATED_GRAPH_DIRECTORY = 'generated/';

type StaticGraphNamespace = 'raw' | 'generated';

type StaticGraphArtifactIndex = ReadonlyMap<string, SingleHtmlBundleArtifact>;
type StaticGraphAddress = { readonly namespace: StaticGraphNamespace; readonly path: string };

function graphAddress(path: string): StaticGraphAddress {
  return path.startsWith(GENERATED_PREFIX)
    ? { namespace: 'generated', path: path.slice(GENERATED_PREFIX.length) }
    : { namespace: 'raw', path };
}

function graphEntry(path: string): string {
  const address = graphAddress(path);
  return `${address.namespace}/${address.path}`;
}

function graphAddressFromId(root: string, id: string): StaticGraphAddress | undefined {
  const relativeId = relative(root, id).split(sep).join('/');
  const split = relativeId.indexOf('/');
  if (split < 0) return undefined;
  const namespace = relativeId.slice(0, split);
  return namespace === 'raw' || namespace === 'generated'
    ? { namespace, path: relativeId.slice(split + 1) }
    : undefined;
}

function resolveStaticGraphImport(
  source: string,
  importerNamespace: StaticGraphNamespace,
  importerPath: string,
  index: StaticGraphArtifactIndex,
): StaticGraphAddress | undefined {
  if (!/^(?:\.\/|\.\.\/)/.test(source)) return undefined;
  const path = resourcePath(source, importerPath);
  if (path === undefined) return undefined;
  if (path.startsWith(GENERATED_PREFIX) && importerNamespace === 'raw') return undefined;
  const sameNamespace = { namespace: importerNamespace, path };
  if (index.has(embeddedStaticGraphPath(sameNamespace))) return sameNamespace;
  // A generated bootstrap is emitted in the generated namespace, but its
  // project-relative loader can remain a raw dist artifact. Resolve that
  // cross-namespace edge by canonical path only; never fall back to a
  // basename or suffix match.
  if (importerNamespace === 'generated' && !path.startsWith(GENERATED_PREFIX) && index.has(path)) {
    return { namespace: 'raw', path };
  }
  return undefined;
}

function embeddedStaticGraphPath(target: StaticGraphAddress): string {
  return target.namespace === 'generated' ? `${GENERATED_PREFIX}${target.path}` : target.path;
}

function staticGraphResolverPlugin(graphRoot: string, index: StaticGraphArtifactIndex): Plugin {
  return {
    name: 'forgeax-single-html-static-graph-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer === undefined) return null;
      const address = graphAddressFromId(graphRoot, importer);
      if (address === undefined) return null;
      const target = resolveStaticGraphImport(source, address.namespace, address.path, index);
      if (target === undefined) return null;
      return resolve(graphRoot, target.namespace, target.path);
    },
  };
}

function isEmbeddedImportCall(callee: ESTree.CallExpression['callee']): boolean {
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'globalThis' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === '__forgeaxImport'
  );
}

function staticGraphImporterPlugin(graphRoot: string, index: StaticGraphArtifactIndex): Plugin {
  return {
    name: 'forgeax-single-html-static-graph-importer',
    enforce: 'pre',
    transform(code, id) {
      const sourcePath = id.split(/[?#]/, 1)[0] ?? id;
      const address = graphAddressFromId(graphRoot, sourcePath);
      if (address === undefined) return null;
      let program: SingleHtmlProgram;
      try {
        program = parseAst(code);
      } catch {
        return null;
      }
      const replacements: Replacement[] = [];
      const replacementFor = (source: unknown): Replacement | undefined => {
        if (!isStaticImportSource(source) || typeof source.value !== 'string') return undefined;
        const target = resolveStaticGraphImport(
          source.value,
          address.namespace,
          address.path,
          index,
        );
        if (target === undefined) return undefined;
        return {
          start: source.start,
          end: source.end,
          value: JSON.stringify(embeddedStaticGraphPath(target)),
        };
      };
      new Visitor({
        ImportExpression(node) {
          const replacement = replacementFor(node.source);
          if (replacement !== undefined) replacements.push(runtimeImport(node.start), replacement);
        },
        CallExpression(node) {
          if (!isEmbeddedImportCall(node.callee)) return;
          const replacement = replacementFor(node.arguments[0]);
          if (replacement !== undefined) replacements.push(replacement);
        },
      }).visit(program);
      return replacements.length === 0 ? null : applyReplacements(code, replacements);
    },
  };
}

function duplicateResource(path: string) {
  return errorResult(
    'single-html-asset-duplicate',
    'embedded resource paths to be unique',
    'Repair the generated bundle path collision before packaging.',
    { path },
  );
}

async function closeStaticJavaScriptGraphs(
  temporaryRoot: string,
  initial: readonly SingleHtmlBundleArtifact[],
): Promise<CommandResult<Map<string, SingleHtmlBundleArtifact>>> {
  const artifacts = new Map<string, SingleHtmlBundleArtifact>();
  for (const artifact of initial) {
    if (artifacts.has(artifact.path)) return duplicateResource(artifact.path);
    artifacts.set(artifact.path, artifact);
  }
  const candidates = [...artifacts.values()].filter(
    (artifact) =>
      isJavaScriptOutputAsset(artifact.path) && artifact.path.startsWith(GENERATED_PREFIX),
  );
  const candidate = candidates[0];
  if (
    candidate === undefined ||
    !candidates.some((artifact) =>
      hasStaticJavaScriptImports(Buffer.from(artifact.bytes).toString('utf8')),
    )
  )
    return { ok: true, value: artifacts };

  {
    const graphRoot = resolve(temporaryRoot, 'static-graph');
    const outputRoot = resolve(graphRoot, 'out');
    await mkdir(graphRoot, { recursive: true });
    for (const artifact of artifacts.values()) {
      const destination = resolve(graphRoot, graphEntry(artifact.path));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, artifact.bytes);
    }
    const entryNames = new Map(
      candidates.map((artifact) => {
        const entry = graphEntry(artifact.path);
        return [resolve(graphRoot, entry), entry];
      }),
    );
    let output: Map<string, Uint8Array>;
    try {
      output = bundleFiles(
        await viteBuild({
          ...singleHtmlViteOptions,
          root: graphRoot,
          plugins: [
            ...(['raw', 'generated'] as const).map((namespace) =>
              prebuiltWorkerPlugin(
                resolve(graphRoot, namespace),
                (path) => {
                  if (!artifacts.has(`${GENERATED_PREFIX}${path}`))
                    throw new Error(
                      `single-html Worker entry is outside the prepared closure: ${path}`,
                    );
                  return `forgeax-resource:///${GENERATED_PREFIX}${path}`;
                },
                false,
              ),
            ),
            staticGraphResolverPlugin(graphRoot, artifacts),
            staticGraphImporterPlugin(graphRoot, artifacts),
            singleHtmlBundlePlugin(GENERATED_GRAPH_DIRECTORY),
          ],
          build: {
            ...singleHtmlViteOptions.build,
            outDir: outputRoot,
            rolldownOptions: {
              ...singleHtmlViteOptions.build.rolldownOptions,
              input: [...entryNames.keys()],
              output: {
                entryFileNames: (chunk) =>
                  entryNames.get(chunk.facadeModuleId ?? '') ??
                  `${GENERATED_GRAPH_DIRECTORY}assets/[name]-[hash].mjs`,
                chunkFileNames: `${GENERATED_GRAPH_DIRECTORY}assets/[name]-[hash].mjs`,
                assetFileNames: `${GENERATED_GRAPH_DIRECTORY}assets/[name]-[hash][extname]`,
              },
            },
          },
        }),
      );
    } catch (cause) {
      return toErrorResult(
        cause,
        'single-html-static-graph-failed',
        'the emitted JavaScript artifacts to retain one shared native module graph',
        'Repair the generated JavaScript graph or inspect the bundler diagnostic before packaging.',
      );
    }

    const outputRelativePaths = [...output.keys()].sort();
    if (!output.has(graphEntry(candidate.path))) {
      return errorResult(
        'single-html-static-graph-entry-missing',
        'the static graph bundler to emit the original artifact path',
        'Inspect the generated static graph output and preserve its artifact entry.',
        { path: candidate.path, outputPaths: outputRelativePaths },
      );
    }
    for (const [outputPath, bytes] of output) {
      if (!outputPath.startsWith(GENERATED_GRAPH_DIRECTORY)) {
        return errorResult(
          'single-html-static-graph-namespace-missing',
          'static graph output paths to retain their source namespace',
          'Inspect the static graph bundler output and preserve its raw/generated namespace.',
          { path: candidate.path, outputPath },
        );
      }
      const canonicalOutputPath = outputPath.slice(GENERATED_GRAPH_DIRECTORY.length);
      const embeddedPath = `${GENERATED_PREFIX}${canonicalOutputPath}`;
      const previous = artifacts.get(embeddedPath);
      artifacts.set(embeddedPath, {
        path: embeddedPath,
        bytes,
        mediaType: previous?.mediaType ?? mediaType(canonicalOutputPath),
      });
    }
    return { ok: true, value: artifacts };
  }
}

function singleHtmlBundlePlugin(outputPrefix = ''): Plugin {
  return {
    name: 'forgeax-single-html-bundle-runtime',
    enforce: 'post',
    transform: {
      order: 'post',
      handler(code) {
        let program: SingleHtmlProgram;
        try {
          program = parseAst(code);
        } catch {
          return null;
        }
        const replacements = programReplacements(program, code);
        return replacements.length === 0 ? null : applyReplacements(code, replacements);
      },
    },
    generateBundle(_outputOptions, bundle) {
      for (const output of Object.values(bundle)) {
        if (
          output.type === 'asset' &&
          (!isJavaScriptOutputAsset(output.fileName) || output.source === undefined)
        )
          continue;
        const source = output.type === 'chunk' ? output.code : output.source;
        const code = typeof source === 'string' ? source : Buffer.from(source).toString('utf8');
        const rewritten = applyReplacements(code, dynamicImportReplacements(parseAst(code), false));
        if (output.type === 'chunk') output.code = rewritten;
        else output.source = rewritten;
        const residualStart = residualImportStart(rewritten);
        if (residualStart !== undefined)
          this.error(
            `single-html bundle left a native dynamic import in ${output.fileName} at ${residualStart}`,
          );
      }
    },
    resolveFileUrl: ({ fileName }) => {
      const path = fileName.startsWith(outputPrefix)
        ? fileName.slice(outputPrefix.length)
        : fileName;
      return JSON.stringify(`${GENERATED_PREFIX}${path}`);
    },
  };
}

function staticSpecifier(source: ESTree.Expression | ESTree.SpreadElement | undefined) {
  if (source?.type === 'Literal') return source.value;
  if (source?.type === 'TemplateLiteral' && source.expressions.length === 0)
    return source.quasis[0]?.value.cooked;
  return undefined;
}

function localModuleUrl(argument: ESTree.Expression | ESTree.SpreadElement, importer: string) {
  const url = workerUrlExpression(argument);
  if (url === undefined) return undefined;
  const source = url.arguments[0],
    base = url.arguments[1];
  const specifier = staticSpecifier(source);
  if (typeof specifier !== 'string' || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier))
    return undefined;
  if (!isImportMetaUrl(base)) return undefined;
  const path = resourcePath(specifier, importer);
  return path === undefined || source === undefined ? undefined : { url, source, path };
}

/** Publish prebuilt Worker and Pack entries into the compiler graph of their consumers. */
function prebuiltWorkerPlugin(
  distRoot: string,
  entryUrl: (path: string, emit: (id: string, fileName: string) => void) => string,
  rewriteImports = true,
): Plugin {
  return {
    name: 'forgeax-single-html-prebuilt-workers',
    enforce: 'pre',
    transform(code, id) {
      const importer = relative(distRoot, id.split(/[?#]/, 1)[0] ?? id)
        .split(sep)
        .join('/');
      if (importer.startsWith('../') || !isJavaScriptOutputAsset(importer)) return null;
      let program: SingleHtmlProgram;
      try {
        program = parseAst(code);
      } catch {
        return null;
      }
      const emitChunk = (id: string, fileName: string) => {
        this.emitFile({ type: 'chunk', id, fileName, preserveSignature: 'strict' });
      };
      const handledUrls = new Set<number>();
      const replacements: Replacement[] = [];
      const rewritePackEntry = (
        node: Extract<ESTree.Expression, { type: 'Literal' | 'TemplateLiteral' }>,
      ) => {
        const specifier = staticSpecifier(node);
        if (typeof specifier !== 'string' || !specifier.startsWith(staticPackEntryUrlPrefix))
          return;
        const path = normalizePath(specifier.slice(staticPackEntryUrlPrefix.length));
        if (path === undefined) throw new Error('Invalid static Pack entry URL');
        replacements.push({
          start: node.start,
          end: node.end,
          value: JSON.stringify(entryUrl(path, emitChunk)),
        });
      };
      new Visitor({
        Literal: rewritePackEntry,
        TemplateLiteral: rewritePackEntry,
        CallExpression(node) {
          if (!rewriteImports) return;
          if (!isEmbeddedImportCall(node.callee)) return;
          const source = node.arguments[0];
          const specifier = staticSpecifier(source);
          if (typeof specifier !== 'string' || !/^(?:\.\/|\.\.\/)/.test(specifier)) return;
          const path = resourcePath(specifier, importer);
          if (path !== undefined && source !== undefined)
            replacements.push({
              start: source.start,
              end: source.end,
              value: JSON.stringify(`forgeax-resource:///${path}`),
            });
        },
        NewExpression(node) {
          const worker =
            node.callee.type === 'Identifier' &&
            ['Worker', 'SharedWorker'].includes(node.callee.name);
          const argument = worker ? node.arguments[0] : node;
          if (argument === undefined) return;
          const target = localModuleUrl(argument, importer);
          if (target === undefined || handledUrls.has(target.url.start)) return;
          if (!worker && !isJavaScriptOutputAsset(target.path)) return;
          handledUrls.add(target.url.start);
          const generated = entryUrl(target.path, emitChunk);
          const source = worker ? argument : target.source;
          replacements.push({
            start: source.start,
            end: source.end,
            value: JSON.stringify(worker ? generated : `forgeax-resource:///${target.path}`),
          });
        },
      }).visit(program);
      return replacements.length === 0 ? null : applyReplacements(code, replacements);
    },
  };
}

export async function bundleSingleHtmlEntry(
  distRootInput: string,
  indexHtml: string,
  projectRoot?: string,
): Promise<CommandResult<SingleHtmlBundle>> {
  const distRoot = await realpath(resolve(distRootInput));
  const selected = collectEntrySource(indexHtml, distRoot);
  if (!selected.ok) return selected;
  const { kind, value: source } = selected.value;
  const entryPath = kind === 'file' ? normalizePath(source) : undefined;
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-bundle-'));
  try {
    let inputPath: string | undefined;
    if (entryPath !== undefined) {
      const candidate = resolve(distRoot, entryPath);
      try {
        const candidateInfo = await stat(candidate);
        if (candidateInfo.isFile()) inputPath = candidate;
      } catch {
        // A missing path is reported by Vite below as a bundle failure; keep
        // inline source handling deterministic rather than guessing from text.
      }
    }
    if (inputPath === undefined) {
      inputPath = resolve(temporaryRoot, 'inline-entry.mjs');
      await writeFile(inputPath, source, 'utf8');
    }
    const outputRoot = resolve(temporaryRoot, 'dist');
    const resolver: Plugin | undefined =
      projectRoot === undefined
        ? undefined
        : await createEngineWorkspaceResolverForProject(projectRoot);
    const workers = new Set<string>();
    inputPath = await realpath(inputPath);
    const output = bundleFiles(
      await viteBuild({
        ...singleHtmlViteOptions,
        root: distRoot,
        plugins: [
          prebuiltWorkerPlugin(distRoot, (path, emit) => {
            if (!workers.has(path)) {
              workers.add(path);
              emit(resolve(distRoot, path), path);
            }
            return `forgeax-resource:///${GENERATED_PREFIX}${path}`;
          }),
          singleHtmlBundlePlugin(),
          ...(resolver === undefined ? [] : [resolver]),
        ],
        experimental: {
          renderBuiltUrl: (filename: string) =>
            `forgeax-resource:///${GENERATED_PREFIX}${filename}`,
        },
        build: {
          ...singleHtmlViteOptions.build,
          outDir: outputRoot,
          sourcemap: false,
          modulePreload: false,
          rolldownOptions: {
            ...singleHtmlViteOptions.build.rolldownOptions,
            input: inputPath,
            output: {
              entryFileNames: 'entry.mjs',
              chunkFileNames: 'assets/[name]-[hash].mjs',
              assetFileNames: 'assets/[name]-[hash][extname]',
            },
          },
        },
      }),
    );
    const entry = 'entry.mjs';
    const entryBytes = output.get(entry);
    if (entryBytes === undefined) {
      return errorResult(
        'single-html-bundle-entry-missing',
        'Vite to emit exactly one entry.mjs',
        'Inspect the production entry and the single-html bundler output.',
        { outputRoot, paths: [...output.keys()].sort() },
      );
    }
    await includePublicFiles(resolve(distRoot, 'public'), output);
    output.delete(entry);
    return completeCommand({
      entrySource: Buffer.from(entryBytes).toString('utf8'),
      artifacts: [...output].map(([path, bytes]) => ({
        path: `${GENERATED_PREFIX}${path}`,
        bytes,
        mediaType: mediaType(path),
      })),
    });
  } catch (cause) {
    return toErrorResult(
      cause,
      'single-html-bundle-failed',
      'the production main and Worker entries to converge into one shared module graph',
      'Repair the production entry or inspect the Vite/Rolldown diagnostic before packaging.',
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function workerBootstrapSource(): string {
  const runtime = workerRuntimeSource();
  return `const __forgeaxQueuedMessages=[];
let __forgeaxWorkerStarted=false;
let __forgeaxWorkerReady=false;
let __forgeaxNextRequest=0;
const __forgeaxPendingRequests=new Map();
const __forgeaxForwardedRequests=new Map();
const __forgeaxReplay=(event)=>{globalThis.dispatchEvent(new MessageEvent('message',{data:event.data,ports:event.ports,origin:event.origin,lastEventId:event.lastEventId}));};
const __forgeaxRequestResource=(path,kind)=>new Promise((resolve,reject)=>{const requestId=String(++__forgeaxNextRequest);__forgeaxPendingRequests.set(requestId,{resolve,reject});try{globalThis.postMessage({__forgeaxResourceRequest:{requestId,path:String(path),kind:String(kind)}});}catch(cause){__forgeaxPendingRequests.delete(requestId);reject(cause);}});
const __forgeaxForwardRequest=(request,worker,token)=>{const requestId='f:'+token+':'+String(request.requestId);__forgeaxForwardedRequests.set(requestId,{worker,requestId:String(request.requestId)});globalThis.postMessage({__forgeaxResourceRequest:{requestId,path:String(request.path),kind:String(request.kind)}});};
const __forgeaxForwardTelemetry=(value)=>{try{globalThis.postMessage(value);}catch{}};
const __forgeaxHandleResponse=(response)=>{const requestId=String(response.requestId);const pending=__forgeaxPendingRequests.get(requestId);if(pending!==undefined){__forgeaxPendingRequests.delete(requestId);pending.resolve(response);return true;}const forwarded=__forgeaxForwardedRequests.get(requestId);if(forwarded!==undefined){__forgeaxForwardedRequests.delete(requestId);const forwardedResponse={...response,requestId:forwarded.requestId};try{const transfer=forwardedResponse.data instanceof ArrayBuffer?[forwardedResponse.data]:[];forwarded.worker.postMessage({__forgeaxResourceResponse:forwardedResponse},transfer);}catch{}return true;}return false;};
const __forgeaxStart=async(init)=>{const runtime=(${runtime});await runtime(init,__forgeaxRequestResource,__forgeaxForwardRequest,__forgeaxForwardTelemetry);__forgeaxWorkerReady=true;for(const event of __forgeaxQueuedMessages.splice(0))__forgeaxReplay(event);};
globalThis.addEventListener('message',(event)=>{const response=event.data?.__forgeaxResourceResponse;if(response!==undefined){if(__forgeaxHandleResponse(response))event.stopImmediatePropagation?.();return;}const init=event.data?.__forgeaxWorkerInit;if(init!==undefined){event.stopImmediatePropagation?.();if(!__forgeaxWorkerStarted){__forgeaxWorkerStarted=true;void __forgeaxStart(init);}return;}if(!__forgeaxWorkerReady){event.stopImmediatePropagation?.();__forgeaxQueuedMessages.push({data:event.data,ports:[...event.ports],origin:event.origin,lastEventId:event.lastEventId});}}, {capture:true});`;
}

function workerRuntimeSource(): string {
  return `(async (init, requestResource, forwardRequest, forwardTelemetry) => {
globalThis.process??={env:{},versions:{},platform:'browser',argv:[]};
const nativeURL=globalThis.URL;
const nativeFetch=globalThis.fetch?.bind(globalThis);
const nativePostMessage=globalThis.postMessage?.bind(globalThis);
const nativeWorker=globalThis.Worker;
const sourcePath=String(init.sourcePath??'');
const bootstrapURL=String(init.bootstrapURL??'');
const normalize=(value)=>{try{return decodeURIComponent(String(value).split(/[?#]/,1)[0]).replaceAll('\\\\','/').replace(/^\\/+/, '');}catch{return undefined;}};
const withoutBundle=(value)=>String(value).replace(/^__forgeax-bundle\\//,'');
const resolveInput=(value)=>{try{const raw=String(value);if(raw.startsWith('__forgeax-bundle/'))return {kind:'resource',path:raw,url:new nativeURL('forgeax-resource:///'+raw)};const url=value instanceof nativeURL?value:new nativeURL(raw,'https://forgeax.invalid/'+sourcePath);if(url.protocol==='data:'||url.protocol==='blob:')return {kind:'native',url};if((url.protocol==='http:'||url.protocol==='https:')&&/^[a-z][a-z0-9+.-]*:/i.test(raw))return {kind:'external',url};const path=normalize(url.pathname);return path===undefined?{kind:'missing',url}:{kind:'resource',path,url};}catch{return {kind:'missing'};}};
const resourceURL=(value)=>{try{const url=new nativeURL(String(value),'https://forgeax.invalid/'+sourcePath);if(url.protocol!=='http:'&&url.protocol!=='https:')return url;const path=normalize(url.pathname);return path===undefined?url:new nativeURL('forgeax-resource:///'+withoutBundle(path));}catch{return new nativeURL(String(value),'https://forgeax.invalid/'+sourcePath);}};
class ForgeaxURL extends nativeURL{constructor(input,base){if(base!==undefined&&/^(?:blob:|data:)/i.test(String(base))&&!/^[a-z][a-z0-9+.-]*:/i.test(String(input))){super(resourceURL(input));return;}super(input,base);}}
globalThis.URL=ForgeaxURL;
const note=(kind,specifier)=>{try{nativePostMessage?.({__forgeaxResourceMiss:{kind,specifier:String(specifier)}});}catch{}};
const noteHit=()=>{try{nativePostMessage?.({__forgeaxResourceHit:1});}catch{}};
const noteExternal=(kind,specifier)=>{try{nativePostMessage?.({__forgeaxExternalRequest:{kind,specifier:String(specifier)}});}catch{}};
const load=async(value,kind)=>{const resolved=resolveInput(value);if(resolved.kind==='native')return {native:true,url:resolved.url};if(resolved.kind==='external'){noteExternal(kind,value);throw new TypeError('forgeax single-html external resource blocked');}if(resolved.kind!=='resource'){note(kind,value);throw new TypeError('forgeax single-html worker resource miss');}const result=await requestResource(resolved.path,kind);if(result?.ok!==true){note(kind,value);throw new TypeError('forgeax single-html worker resource miss');}noteHit();return {native:false,path:result.path??resolved.path,data:new Uint8Array(result.data),moduleLinks:result.moduleLinks??[],mime:result.mime??'application/octet-stream'};};
if(typeof nativeFetch==='function')globalThis.fetch=(input,init)=>load(input,'fetch').then((value)=>value.native?nativeFetch(value.url,init):new Response(value.data,{status:200,headers:{'Content-Type':value.mime}}));
const moduleURL=(${singleHtmlModuleLoaderSource()})(path=>load('forgeax-resource:///'+path,'import'),source=>nativeURL.createObjectURL(new Blob([source],{type:'text/javascript'})));
globalThis.__forgeaxImport=async(value)=>{const resolved=resolveInput(value);if(resolved.kind==='native')return import(resolved.url);if(resolved.kind!=='resource'){await load(value,'import');throw new TypeError('forgeax single-html module unavailable');}return import(await moduleURL(resolved.path));};
let childToken=0;
const attachWorker=(worker)=>{const token=String(++childToken);worker.addEventListener('message',(event)=>{const request=event.data?.__forgeaxResourceRequest;if(request!==undefined){forwardRequest(request,worker,token);event.stopImmediatePropagation?.();return;}if(event.data?.__forgeaxResourceMiss||event.data?.__forgeaxResourceHit||event.data?.__forgeaxExternalRequest){forwardTelemetry(event.data);event.stopImmediatePropagation?.();return;}},{capture:true});return worker;};
const nativeWorkerURL=(input)=>{try{const url=input instanceof nativeURL?input:new nativeURL(String(input),'https://forgeax.invalid/'+sourcePath);return /^(?:blob:|data:)$/i.test(url.protocol);}catch{return false;}};
if(typeof nativeWorker==='function')globalThis.Worker=class extends nativeWorker{constructor(input,options){if(nativeWorkerURL(input)){super(input,options);return;}const resolved=resolveInput(input);if(resolved.kind!=='resource'){if(resolved.kind==='external')noteExternal('worker',input);else note('worker',input);throw new TypeError('forgeax single-html worker resource miss');}super(bootstrapURL,options);attachWorker(this);this.postMessage({__forgeaxWorkerInit:{sourcePath:resolved.path,bootstrapURL}});}};
await globalThis.__forgeaxImport('forgeax-resource:///'+sourcePath);
})`;
}

function runtimeBootstrap(decoderSource: string): string {
  const bootstrapSource = workerBootstrapSource();
  return `(() => {
  ${decoderSource}
  globalThis.process ??= { env: {}, versions: {}, platform: 'browser', argv: [] };
  const nativeURL = globalThis.URL;
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  const assetManifestNode = document.getElementById('forgeax-asset-payload');
  const assetManifest = JSON.parse((assetManifestNode?.textContent || '[]').trim());
  const assetDataNodes = [...document.querySelectorAll('script[data-forgeax-asset-index]')];
  const entries = assetManifest.map((entry) => ({ ...entry, node: assetDataNodes[entry.index] })).filter((entry) => entry.node !== undefined);
  const decodeStored = (entry) => { const binary = atob(entry.node.textContent || ''); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index); return bytes; };
  const sharedDecoded = new Map();
  const bodyOf = (entry) => {
    if (entry.encoding === 'zstd') {
      const shared = entry.offset !== undefined;
      let bytes = shared ? sharedDecoded.get(entry.index) : undefined;
      if (bytes === undefined) {
        bytes = __forgeaxZstd.decompress(decodeStored(entry));
        if (bytes.byteLength !== entry.decodedByteLength) throw new TypeError('forgeax single-html decoded size mismatch');
        if (shared) sharedDecoded.set(entry.index, bytes);
      }
      if (!shared) return bytes;
      if (!Number.isSafeInteger(entry.offset) || !Number.isSafeInteger(entry.length) || entry.offset < 0 || entry.length < 0 || entry.offset + entry.length > bytes.byteLength) throw new TypeError('forgeax single-html resource range invalid');
      // A fetch/Worker transfer owns its bytes; it cannot detach or mutate the shared archive.
      return bytes.slice(entry.offset, entry.offset + entry.length);
    }
    const stored = decodeStored(entry);
    return entry.encoding === 'gzip' ? new Blob([stored]).stream().pipeThrough(new DecompressionStream('gzip')) : stored;
  };
  const decode = async (entry) => { const body = bodyOf(entry); return body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer()); };
  const normalize = (value) => { try { return decodeURIComponent(String(value).split(/[?#]/, 1)[0]).replaceAll('\\\\', '/').replace(/^\\/+/, ''); } catch { return undefined; } };
  const withoutBundle = (value) => String(value).replace(/^__forgeax-bundle\\//, '');
  const lookup = (input) => {
    const raw = normalize(input);
    const direct = entries.find((entry) => entry.path === raw);
    if (direct !== undefined) return direct;
    if (raw?.startsWith('__forgeax-bundle/')) {
      const original = entries.find((entry) => entry.path === withoutBundle(raw));
      if (original !== undefined) return original;
    }
    let url; try { url = input instanceof nativeURL ? input : new nativeURL(String(input), document.baseURI); } catch { return undefined; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return undefined;
    const path = normalize(url.pathname); if (path === undefined) return undefined;
    const exact = entries.find((entry) => entry.path === path); if (exact !== undefined) return exact;
    const normalized = withoutBundle(path);
    if (normalized !== path) {
      const original = entries.find((entry) => entry.path === normalized); if (original !== undefined) return original;
    }
    const suffix = entries.filter((entry) => path.endsWith('/' + entry.path));
    const longest = suffix.reduce((length, entry) => Math.max(length, entry.path.length), 0);
    const qualified = suffix.filter((entry) => entry.path.length === longest);
    if (qualified.length === 1) return qualified[0];
    const name = normalized.slice(normalized.lastIndexOf('/') + 1);
    const matches = entries.filter((entry) => entry.path.slice(entry.path.lastIndexOf('/') + 1) === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const lookupModule = input => {const entry=lookup(input); if(entry === undefined)return undefined; return entry.path.startsWith('__forgeax-bundle/') ? entry : (entries.find(row=>row.path==='__forgeax-bundle/'+entry.path) ?? entry);};
  const resourceMisses = [];
  const externalRequests = [];
  let resourceHits = 0;
  const noteMiss = (kind, specifier) => { resourceMisses.push({ kind, specifier: String(specifier), realm: 'main' }); };
  const noteExternal = (kind, specifier) => { externalRequests.push({ kind, specifier: String(specifier), realm: 'main' }); };
  const response = (entry) => { resourceHits += 1; return new Response(bodyOf(entry), { status: 200, headers: { 'Content-Type': entry.mime } }); };
  const ownedBlobUrls = new Set();
  const makeBlobUrl = (${singleHtmlModuleLoaderSource()})(async path => {
    const entry = lookup(path);
    if (entry === undefined) throw new TypeError('forgeax single-html static module missing: ' + path);
    return {data:await decode(entry),moduleLinks:entry.moduleLinks};
  }, source => {
    const url = nativeURL.createObjectURL(new Blob([source], {type:'text/javascript'}));
    ownedBlobUrls.add(url);
    return url;
  });
  const workerBootstrapSource = ${JSON.stringify(bootstrapSource)};
  const workerBootstrapUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(workerBootstrapSource);
  const forgeaxImport = async (specifier) => { const entry = lookupModule(specifier); if (entry === undefined) { const text = String(specifier); if (/^(?:https?:)/i.test(text)) noteExternal('import', text); else noteMiss('import', text); throw new TypeError('forgeax single-html resource miss'); } const url = await makeBlobUrl(entry.path); resourceHits += 1; return import(url); };
  globalThis.__forgeaxImport = forgeaxImport;
  const external = (input) => { try { const url = input instanceof nativeURL ? input : new nativeURL(String(input), document.baseURI); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } };
  if (typeof nativeFetch === 'function') globalThis.fetch = (input, init) => { const entry = lookup(input); if (entry !== undefined) return Promise.resolve(response(entry)); if (/^(?:data:|blob:)/i.test(String(input))) return nativeFetch(input, init); if (external(input)) { noteExternal('fetch', input); return Promise.reject(new TypeError('forgeax single-html blocked an external request')); } noteMiss('fetch', input); return Promise.reject(new TypeError('forgeax single-html resource miss')); };
  const sendResource = async (worker, request) => { const entry = request.kind === 'import' ? lookupModule(request.path) : lookup(request.path); if (entry === undefined) { worker.postMessage({ __forgeaxResourceResponse: { requestId: String(request.requestId), ok: false } }); return; } try { const decoded = await decode(entry); const data = decoded.byteOffset === 0 && decoded.byteLength === decoded.buffer.byteLength ? decoded : decoded.slice(); worker.postMessage({ __forgeaxResourceResponse: { requestId: String(request.requestId), ok: true, path:entry.path, moduleLinks:entry.moduleLinks, mime: entry.mime, data: data.buffer } }, [data.buffer]); } catch { worker.postMessage({ __forgeaxResourceResponse: { requestId: String(request.requestId), ok: false } }); } };
  const nativeWorker = globalThis.Worker;
  const nativeWorkerURL = (input) => { try { const url = input instanceof nativeURL ? input : new nativeURL(String(input), document.baseURI); return /^(?:blob:|data:)$/i.test(url.protocol); } catch { return false; } };
  const attachWorker = (worker) => { worker.addEventListener('message', (event) => { const request = event.data?.__forgeaxResourceRequest; if (request !== undefined) { sendResource(worker, request); event.stopImmediatePropagation?.(); return; } const miss = event.data?.__forgeaxResourceMiss; if (miss !== undefined) { resourceMisses.push({ ...miss, realm: 'worker' }); event.stopImmediatePropagation?.(); return; } const externalRequest = event.data?.__forgeaxExternalRequest; if (externalRequest !== undefined) { externalRequests.push({ ...externalRequest, realm: 'worker' }); event.stopImmediatePropagation?.(); return; } const hit = event.data?.__forgeaxResourceHit; if (typeof hit === 'number' && Number.isFinite(hit)) { resourceHits += hit; event.stopImmediatePropagation?.(); } }, { capture: true }); return worker; };
  if (typeof nativeWorker === 'function') globalThis.Worker = class extends nativeWorker { constructor(input, options) { if (nativeWorkerURL(input)) { super(input, options); return; } const entry = lookup(input); if (entry === undefined) { const text = String(input); if (external(input)) noteExternal('worker', text); else noteMiss('worker', text); throw new TypeError('forgeax single-html worker resource miss'); } super(workerBootstrapUrl, options); attachWorker(this); this.postMessage({ __forgeaxWorkerInit: { sourcePath: entry.path, bootstrapURL: workerBootstrapUrl } }); } };
  const witness = () => ({ ready: document.documentElement.dataset.forgeaxSingleHtmlReady === 'true', resourceHits, resourceMisses: resourceMisses.slice(), externalRequests: externalRequests.slice() });
  globalThis.__forgeaxSingleHtml = { lookup, entries: entries.map(({ path, mime }) => ({ path, mime })), witness };
  globalThis.addEventListener('pagehide', () => { for (const url of ownedBlobUrls) nativeURL.revokeObjectURL(url); ownedBlobUrls.clear(); }, { once: true });
  document.documentElement.dataset.forgeaxSingleHtmlReady = 'true';
})();`;
}

function distResources(
  distRoot: string,
  manifest: DistManifest,
): Promise<SingleHtmlBundleArtifact[]> {
  const rows: readonly (DistArtifact | { readonly path: string })[] = [
    ...manifest.artifacts,
    { path: DIST_MANIFEST_FILE },
  ];
  return Promise.all(
    rows
      .filter((artifact) => artifact.path !== 'index.html')
      .map(async (artifact) => ({
        path: artifact.path,
        bytes: await readFile(resolve(distRoot, artifact.path)),
        mediaType: 'mediaType' in artifact ? artifact.mediaType : mediaType(artifact.path),
      })),
  );
}

async function buildHtml(
  indexHtml: string,
  resources: Map<string, SingleHtmlBundleArtifact>,
  entrySource: string,
): Promise<CommandResult<{ readonly html: string; readonly embeddedAssets: number }>> {
  if (resources.has(ENTRY_RESOURCE_PATH)) return duplicateResource(ENTRY_RESOURCE_PATH);
  resources.set(ENTRY_RESOURCE_PATH, {
    path: ENTRY_RESOURCE_PATH,
    bytes: Buffer.from(entrySource),
    mediaType: 'text/javascript',
  });

  const replacements: Replacement[] = [];
  for (const element of locatedElements(indexHtml)) {
    const name = element.tagName.toLowerCase();
    const { startTag, endTag, attrs } = element.sourceCodeLocation;
    const range = { start: startTag.startOffset, end: (endTag ?? startTag).endOffset };
    if (isModuleScript(element) || hasLinkRel(element, 'modulepreload')) {
      replacements.push({ ...range, value: '' });
      continue;
    }
    if (hasLinkRel(element, 'stylesheet')) {
      const href = attributeValue(element, 'href');
      if (href === undefined) {
        return errorResult(
          'single-html-stylesheet-missing',
          'stylesheet link to contain href',
          'Repair the generated HTML stylesheet link.',
        );
      }
      const path = resourcePath(href, 'index.html');
      const stylesheet = resourceForPath(path, resources);
      if (stylesheet === undefined) {
        return errorResult(
          'single-html-css-asset-missing',
          'stylesheet link to resolve to an embedded artifact',
          'Add the stylesheet to the dist closure and rebuild.',
          { href, path: path ?? null },
        );
      }
      const css = inlineCss(
        Buffer.from(stylesheet.bytes).toString('utf8'),
        stylesheet.path,
        resources,
      );
      if (!css.ok) return css;
      replacements.push({
        ...range,
        value: `<style data-forgeax-inline-css>${css.value}</style>`,
      });
      continue;
    }
    if (name === 'style') {
      const start = startTag.endOffset;
      const end = endTag?.startOffset ?? start;
      const css = inlineCss(indexHtml.slice(start, end), 'index.html', resources);
      if (!css.ok) return css;
      replacements.push({ start, end, value: css.value });
      continue;
    }
    const resourceAttribute = RESOURCE_ELEMENTS.has(name)
      ? element.attrs.find((candidate) => RESOURCE_ATTRIBUTES.has(candidate.name.toLowerCase()))
      : undefined;
    const resourceAttributeLocation =
      resourceAttribute === undefined ? undefined : attrs?.[resourceAttribute.name.toLowerCase()];
    const resourceAttributeRange =
      resourceAttribute === undefined || resourceAttributeLocation === undefined
        ? undefined
        : attributeValueRange(indexHtml, resourceAttributeLocation);
    if (
      resourceAttribute?.value !== undefined &&
      resourceAttributeRange !== undefined &&
      !/^(?:data:|blob:|#)/i.test(resourceAttribute.value)
    ) {
      const path = resourcePath(resourceAttribute.value, 'index.html');
      const embedded = resourceForPath(path, resources);
      if (embedded === undefined) {
        return errorResult(
          'single-html-asset-missing',
          'every local HTML resource to resolve to an embedded dist artifact',
          'Add the referenced asset to the project closure and rebuild.',
          { value: resourceAttribute.value, path: path ?? null },
        );
      }
      replacements.push({
        start: resourceAttributeRange.startOffset,
        end: resourceAttributeRange.endOffset,
        value: dataUri(embedded.bytes, embedded.mediaType),
      });
      continue;
    }
    if (name === 'script' && attributeValue(element, 'src') !== undefined) {
      return errorResult(
        'single-html-script-external',
        'non-module script sources to be absent from the generated host',
        'Move the script into the production module entry before packaging.',
        { src: attributeValue(element, 'src') },
      );
    }
  }

  const orderedResources = [...resources.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const storage = await prepareSingleHtmlStorage(linkSingleHtmlModules(orderedResources), sha256);
  const assetManifestSource = JSON.stringify(storage.entries);
  const assetManifestNode = `<script type="application/json" id="forgeax-asset-payload" data-forgeax-asset-payload>${safeScriptText(assetManifestSource)}</script>`;
  const assetDataNodes = storage.bodies
    .map(
      (resource, index) =>
        `<script type="application/octet-stream" data-forgeax-asset-index="${index}">${Buffer.from(resource.bytes).toString('base64')}</script>`,
    )
    .join('');
  const assetNode = `${assetManifestNode}${assetDataNodes}`;
  const bootstrap = `<script type="application/javascript">${safeScriptText(runtimeBootstrap(storage.decoder))}</script>`;
  const entry = `<script type="module">await globalThis.__forgeaxImport(${JSON.stringify(`forgeax-resource:///${ENTRY_RESOURCE_PATH}`)});</script>`;
  const withResources = applyReplacements(indexHtml, replacements);
  const body = `${assetNode}${bootstrap}${entry}`;
  const html = withResources.includes('</body>')
    ? withResources.replace(/<\/body>/i, () => `${body}</body>`)
    : `${withResources}${body}`;
  return { ok: true, value: { html, embeddedAssets: resources.size } };
}

export async function writeSingleHtml(
  options: SingleHtmlPackageOptions,
): Promise<CommandResult<SingleHtmlPackageResult>> {
  const distRoot = resolve(options.distRoot);
  const output = resolve(options.output);
  let staticGraphRoot: string | undefined;
  try {
    staticGraphRoot = await realpath(
      await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-static-')),
    );
    const indexHtml = await readFile(resolve(distRoot, 'index.html'), 'utf8');
    const resources = await distResources(distRoot, options.manifest);
    const closed = await closeStaticJavaScriptGraphs(staticGraphRoot, [
      ...resources,
      ...options.bundle.artifacts,
    ]);
    if (!closed.ok) return closed;
    const built = await buildHtml(indexHtml, closed.value, options.bundle.entrySource);
    if (!built.ok) return built;
    const bytes = Buffer.from(built.value.html, 'utf8');
    const manifestBytes = await readFile(resolve(distRoot, DIST_MANIFEST_FILE));
    const { checksumPath, ...html } = await publishChecksummedFile(output, bytes);
    return completeCommand({
      schemaVersion: '1.0.0',
      format: SINGLE_HTML_FORMAT,
      target: 'file',
      project: options.manifest.project,
      base: options.manifest.base,
      html,
      checksumPath,
      distManifestSha256: sha256(manifestBytes),
      embeddedAssets: built.value.embeddedAssets,
      run: {
        local: pathToFileURL(output).href,
        shared: 'send the HTML file and open it in a desktop Chrome with WebGPU support',
      },
    });
  } catch (cause) {
    return toErrorResult(
      cause,
      'single-html-write-failed',
      'the single HTML candidate and adjacent SHA-256 to be written atomically',
      'Repair the dist closure or output directory, then retry packaging.',
    );
  } finally {
    if (staticGraphRoot !== undefined) await rm(staticGraphRoot, { recursive: true, force: true });
  }
}

export function packageFormatError(format: string): CommandResult<never> {
  return errorResult(
    'package-format-unsupported',
    'package format to be web-zip, single-html, tauri or native',
    'Use web-zip for HTTPS hosting or single-html for a self-contained file:// delivery.',
    { format },
  );
}

export function packageOutputError(
  output: string,
  format: 'web-zip' | 'single-html',
): CommandResult<never> {
  const expectedSuffix = format === 'single-html' ? '.html' : '.zip';
  return errorResult(
    'package-output-suffix-mismatch',
    `package output to end with ${expectedSuffix}`,
    `Use a ${expectedSuffix} output path for ${format}.`,
    { output, format },
  );
}

function workerUrlExpression(
  argument: ESTree.Expression | ESTree.SpreadElement,
): ESTree.NewExpression | undefined {
  const url =
    argument?.type === 'MemberExpression' &&
    !argument.computed &&
    argument.property.type === 'Identifier' &&
    argument.property.name === 'href'
      ? argument.object
      : argument;
  if (
    url?.type !== 'NewExpression' ||
    url.callee.type !== 'Identifier' ||
    url.callee.name !== 'URL'
  )
    return undefined;
  return url;
}
