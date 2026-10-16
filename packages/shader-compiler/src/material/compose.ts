import {
  createMaterialError,
  err,
  type MaterialDynamicInputLayout,
  type MaterialError,
  type MaterialSurfaceModel,
  ok,
  type Result,
  type StandardLayerPlan,
} from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CompileResult } from '../compile.js';
import {
  generateMaterialDynamicInputAccessor,
  materialDynamicInputModuleId,
} from './dynamic-input.js';
import {
  buildMaterialSourceCatalog,
  type MaterialSourceCatalog,
  type MaterialSourceInput,
} from './source-catalog.js';
import {
  SINGLE_LAYER_MEDIUM_SURFACE_MODULE,
  validateSurfaceDependency,
  validateSurfaceSource,
} from './surface-contract.js';
import type { MaterialVariantContext } from './variant-context.js';

// Pure source utilities are also imported by browser material oracles. Resolve
// the native implementation only in Node; both hash the same canonical UTF-8.
const digestUtf8 =
  typeof process !== 'undefined' && process.versions?.node !== undefined
    ? await import('node:crypto').then(
        ({ createHash }) =>
          (source: string) =>
            createHash('sha256').update(source).digest('hex'),
      )
    : (source: string) => bytesToHex(sha256(new TextEncoder().encode(source)));

export interface MaterialComposeRequest {
  readonly material: string;
  readonly pass: string;
  readonly source: string;
  readonly imports?: Readonly<Record<string, string>>;
  readonly moduleSlots?: Readonly<Record<string, string>>;
  readonly context?: MaterialVariantContext;
  readonly layerPlan?: StandardLayerPlan;
}

export interface MaterialComposedSource {
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export interface ComposedMaterial {
  readonly material: string;
  readonly pass: string;
  readonly wgsl: string;
  readonly bindings: readonly unknown[];
  readonly deps: readonly string[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

export type MaterialComposeCompiler = (
  request: MaterialComposeRequest,
) => Promise<MaterialComposedSource | CompileResult>;

export type SurfaceCompositionStage =
  | 'slot-resolution'
  | 'source-closure'
  | 'surface-validation'
  | 'parameter-generation';

export interface SurfaceCompositionRequest {
  readonly material: string;
  readonly pass: string;
  readonly templateModule: string;
  readonly surfaceModule?: string;
  readonly sources: MaterialSourceCatalog;
  readonly generatedParameters?: string;
  /** Selected template contract; omitted keeps the Standard Surface ABI. */
  readonly surfaceModel?: MaterialSurfaceModel;
  /** Producer-derived page ABI, inlined into the selected Surface closure. */
  readonly dynamicInput?: MaterialDynamicInputLayout;
}

export interface SurfaceComposition {
  readonly source: string;
  readonly templateModule: string;
  readonly surfaceModule: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly sourceClosure: readonly string[];
  readonly sourceClosureDigest: string;
  readonly stages: readonly SurfaceCompositionStage[];
  /**
   * Whether the selected Surface or any module it imports reads
   * `SurfaceInput.vertexColor`. A Surface that never reads it gains nothing
   * from the vertex-colour program variant, whose only effect is the extra
   * COLOR_0 fetch and interpolants.
   */
  readonly readsVertexColor: boolean;
}

/** Strip WGSL comments so documentation never counts as a read. */
function stripWgslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** True when the Surface source refers to the `vertexColor` SurfaceInput field. */
export function surfaceSourceReadsVertexColor(source: string): boolean {
  return /\bvertexColor\b/.test(stripWgslComments(source));
}

export interface StandardSourcePreparationRequest {
  readonly material: string;
  readonly pass?: string;
  readonly templateModule: string;
  readonly templatePath: string;
  readonly templateSource: string;
  readonly surfaceModule?: string;
  readonly sourceRecords: readonly MaterialSourceInput[];
  readonly generatedParameters?: string;
}

export interface PreparedStandardSource {
  readonly source: string;
  readonly imports: Readonly<Record<string, string>>;
  readonly sourceClosure: readonly string[];
  readonly sourceClosureDigest: string;
}

const IMPORT_RE = /^\s*#import\s+([A-Za-z0-9_:-]+)/gm;

const DEFINE_IMPORT_PATH_RE = /^\s*#define_import_path[^\n]*\n?/m;

interface ImportDirective {
  readonly line: string;
  readonly moduleId: string;
  readonly moduleAlias?: string;
  readonly symbols: readonly { readonly imported: string; readonly local: string }[];
}

function importedModules(source: string): readonly string[] {
  return [...source.matchAll(IMPORT_RE)]
    .map((match) => match[1]?.replace(/::$/, '').split('::{')[0])
    .filter((module): module is string => module !== undefined);
}

function importDirectives(source: string): readonly ImportDirective[] {
  const directiveRe =
    /^\s*#import\s+([A-Za-z0-9_:-]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?(?:\s*\{([^}]*)\})?[^\n]*\n?/gm;
  return [...source.matchAll(directiveRe)].flatMap((match) => {
    const rawModule = match[1];
    if (rawModule === undefined) return [];
    const moduleId = rawModule.replace(/::$/, '');
    const symbols = (match[3] ?? '')
      .split(',')
      .map((symbol) => symbol.trim())
      .filter((symbol) => symbol.length > 0)
      .map((symbol) => {
        const alias = /^([A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(symbol);
        return {
          imported: alias?.[1] ?? symbol,
          local: alias?.[2] ?? alias?.[1] ?? symbol,
        };
      });
    const moduleAlias =
      match[2] ?? (symbols.length === 0 ? moduleId.split('::').at(-1) : undefined);
    return [
      {
        line: match[0],
        moduleId,
        ...(moduleAlias === undefined ? {} : { moduleAlias }),
        symbols,
      },
    ];
  });
}

/** Imported symbols cannot be diagnosed by parsing an unlinked module alone. */
export function isImportedWgslSymbol(source: string, symbol: string): boolean {
  return importDirectives(source).some(
    (directive) =>
      directive.moduleAlias === symbol || directive.symbols.some((entry) => entry.local === symbol),
  );
}

interface WgslToken {
  readonly kind: 'identifier' | 'symbol';
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface WgslScope {
  parent: number;
  readonly locals: Map<string, number>;
}

interface TopLevelDeclaration {
  readonly index: number;
  readonly name: string;
  readonly keyword: string;
}

const TOP_LEVEL_DECLARATION_KEYWORDS = new Set([
  'alias',
  'const',
  'fn',
  'override',
  'struct',
  'var',
]);

/** Tokenize just enough WGSL to bind identifiers without touching comments, strings, or directives. */
function tokenizeWgsl(source: string): readonly WgslToken[] {
  const tokens: WgslToken[] = [];
  let index = 0;
  let lineStart = true;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '\n') {
      index += 1;
      lineStart = true;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (lineStart && character === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      lineStart = false;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      let commentDepth = 1;
      while (index < source.length && commentDepth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          commentDepth++;
          index += 2;
        } else if (source[index] === '*' && source[index + 1] === '/') {
          commentDepth--;
          index += 2;
        } else {
          if (source[index] === '\n') lineStart = true;
          index++;
        }
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        const closed = source[index] === quote;
        index += 1;
        if (closed) break;
      }
      lineStart = false;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (identifier !== null) {
      const text = identifier[0];
      tokens.push({ kind: 'identifier', text, start: index, end: index + text.length });
      index += text.length;
      lineStart = false;
      continue;
    }
    tokens.push({ kind: 'symbol', text: character, start: index, end: index + 1 });
    index += 1;
    lineStart = false;
  }
  return tokens;
}

/** After conditional projection, WGSL enables precede injected declarations. */
export function hoistWgslEnables(source: string): string {
  const tokens = tokenizeWgsl(source);
  const ranges: Array<{ start: number; end: number }> = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.text === '{') depth++;
    else if (token.text === '}') depth--;
    else if (depth === 0 && token.text === 'enable') {
      let end = index + 1;
      while (end < tokens.length && tokens[end]?.text !== ';') end++;
      const terminator = tokens[end];
      if (terminator !== undefined) {
        ranges.push({ start: token.start, end: terminator.end });
        index = end;
      }
    }
  }
  if (ranges.length === 0) return source;
  const header = ranges.map(({ start, end }) => source.slice(start, end)).join('\n');
  let body = source;
  for (const { start, end } of ranges.reverse()) body = body.slice(0, start) + body.slice(end);
  return `${header}\n${body}`;
}

function nextIdentifier(tokens: readonly WgslToken[], start: number): number | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.kind === 'identifier') return index;
    if (tokens[index]?.text === ';' || tokens[index]?.text === '{' || tokens[index]?.text === '}') {
      return undefined;
    }
  }
  return undefined;
}

function skipAngleGroup(tokens: readonly WgslToken[], start: number): number {
  if (tokens[start]?.text !== '<') return start;
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (text === '<') depth += 1;
    else if (text === '>') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return tokens.length;
}

function topLevelDeclarations(tokens: readonly WgslToken[]): readonly TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (braces === 0 && parentheses === 0 && brackets === 0 && token.kind === 'identifier') {
      if (TOP_LEVEL_DECLARATION_KEYWORDS.has(token.text)) {
        let cursor = index + 1;
        if (token.text === 'override' && tokens[cursor]?.text === 'fn') cursor += 1;
        if (token.text === 'var') cursor = skipAngleGroup(tokens, cursor);
        const nameIndex = nextIdentifier(tokens, cursor);
        const name = nameIndex === undefined ? undefined : tokens[nameIndex]?.text;
        if (nameIndex !== undefined && name !== undefined) {
          declarations.push({ index: nameIndex, name, keyword: token.text });
        }
      }
    }
    if (token.text === '{') braces += 1;
    else if (token.text === '}') braces = Math.max(0, braces - 1);
    else if (token.text === '(') parentheses += 1;
    else if (token.text === ')') parentheses = Math.max(0, parentheses - 1);
    else if (token.text === '[') brackets += 1;
    else if (token.text === ']') brackets = Math.max(0, brackets - 1);
  }
  return declarations;
}

interface WgslBindingAnalysis {
  readonly declarations: ReadonlySet<number>;
  readonly localDeclarations: ReadonlySet<number>;
  readonly scopes: readonly WgslScope[];
  readonly scopeAt: readonly number[];
  readonly structFields: ReadonlySet<number>;
}

function analyzeWgslBindings(
  tokens: readonly WgslToken[],
  declarations: readonly TopLevelDeclaration[],
): WgslBindingAnalysis {
  const scopes: WgslScope[] = [{ parent: -1, locals: new Map() }];
  const scopeAt: number[] = [];
  const openingScopes = new Map<number, number>();
  let currentScope = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    scopeAt[index] = currentScope;
    if (token.text === '{') {
      const child = scopes.length;
      scopes.push({ parent: currentScope, locals: new Map() });
      openingScopes.set(index, child);
      currentScope = child;
    } else if (token.text === '}') {
      currentScope = scopes[currentScope]?.parent ?? 0;
    }
  }

  // A `for` initializer has its own lexical scope. Re-parent the already
  // discovered body scope under a virtual loop scope so its declarations are
  // visible to the condition/continuing/body, but not after the loop.
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== 'for' || tokens[index + 1]?.text !== '(') continue;
    let depth = 0;
    let closeParen = index + 1;
    for (; closeParen < tokens.length; closeParen += 1) {
      const text = tokens[closeParen]?.text;
      if (text === '(') depth += 1;
      else if (text === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const bodyBrace = closeParen + 1;
    const bodyScope = openingScopes.get(bodyBrace);
    if (bodyScope === undefined) continue;
    const loopScope = scopes.length;
    scopes.push({ parent: scopeAt[index] ?? 0, locals: new Map() });
    for (let cursor = index; cursor <= closeParen; cursor += 1) scopeAt[cursor] = loopScope;
    const bodyScopeState = scopes[bodyScope];
    if (bodyScopeState === undefined) continue;
    bodyScopeState.parent = loopScope;
  }

  const declarationIndices = new Set(declarations.map((declaration) => declaration.index));
  const localDeclarationIndices = new Set<number>();
  const structFields = new Set<number>();
  for (const declaration of declarations) {
    if (declaration.keyword !== 'struct') continue;
    let openBrace = declaration.index + 1;
    while (openBrace < tokens.length && tokens[openBrace]?.text !== '{') openBrace += 1;
    if (openBrace >= tokens.length) continue;
    let depth = 0;
    for (let cursor = openBrace; cursor < tokens.length; cursor += 1) {
      const text = tokens[cursor]?.text;
      if (text === '{') depth += 1;
      else if (text === '}') {
        depth -= 1;
        if (depth === 0) break;
      } else if (
        depth > 0 &&
        tokens[cursor]?.kind === 'identifier' &&
        tokens[cursor + 1]?.text === ':'
      ) {
        structFields.add(cursor);
      }
    }
  }
  const addLocal = (scope: number, name: string | undefined, visibleFrom: number) => {
    if (name !== undefined && name.length > 0 && scopes[scope] !== undefined) {
      const existing = scopes[scope].locals.get(name);
      scopes[scope].locals.set(name, Math.min(existing ?? visibleFrom, visibleFrom));
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'identifier' || !['const', 'let', 'var'].includes(token.text)) continue;
    const scope = scopeAt[index] ?? 0;
    if (scope === 0) continue;
    let cursor = index + 1;
    if (token.text === 'var') cursor = skipAngleGroup(tokens, cursor);
    const name = tokens[cursor]?.kind === 'identifier' ? tokens[cursor]?.text : undefined;
    if (name === undefined || cursor >= tokens.length) continue;
    localDeclarationIndices.add(cursor);
    let statementEnd = cursor + 1;
    while (
      statementEnd < tokens.length &&
      tokens[statementEnd]?.text !== ';' &&
      tokens[statementEnd]?.text !== '}'
    ) {
      statementEnd += 1;
    }
    addLocal(scope, name, statementEnd + 1);
  }

  for (const declaration of declarations) {
    if (declaration.keyword !== 'fn') continue;
    let openParen = declaration.index + 1;
    while (openParen < tokens.length && tokens[openParen]?.text !== '(') openParen += 1;
    if (openParen >= tokens.length) continue;
    let depth = 0;
    let closeParen = openParen;
    for (; closeParen < tokens.length; closeParen += 1) {
      const text = tokens[closeParen]?.text;
      if (text === '(') depth += 1;
      else if (text === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    let bodyBrace = closeParen + 1;
    while (bodyBrace < tokens.length && tokens[bodyBrace]?.text !== '{') bodyBrace += 1;
    const bodyScope = openingScopes.get(bodyBrace);
    if (bodyScope === undefined) continue;
    for (let parameter = openParen + 1; parameter < closeParen; parameter += 1) {
      if (tokens[parameter]?.kind !== 'identifier' || tokens[parameter + 1]?.text !== ':') continue;
      localDeclarationIndices.add(parameter);
      addLocal(bodyScope, tokens[parameter]?.text, bodyBrace + 1);
    }
  }
  return {
    declarations: declarationIndices,
    localDeclarations: localDeclarationIndices,
    scopes,
    scopeAt,
    structFields,
  };
}

function isShadowed(
  analysis: WgslBindingAnalysis,
  scope: number,
  tokenIndex: number,
  name: string,
): boolean {
  let current = scope;
  while (current >= 0) {
    const visibleFrom = analysis.scopes[current]?.locals.get(name);
    if (visibleFrom !== undefined && tokenIndex >= visibleFrom) return true;
    current = analysis.scopes[current]?.parent ?? -1;
  }
  return false;
}

function rewriteBoundIdentifiers(
  source: string,
  ownRenames: ReadonlyMap<string, string>,
  importedRenames: ReadonlyMap<string, string>,
): string {
  if (ownRenames.size === 0 && importedRenames.size === 0) return source;
  const tokens = tokenizeWgsl(source);
  const declarations = topLevelDeclarations(tokens);
  const analysis = analyzeWgslBindings(tokens, declarations);
  const replacements = new Map(importedRenames);
  for (const [name, replacement] of ownRenames) replacements.set(name, replacement);
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== 'identifier') continue;
    const replacement = replacements.get(token.text);
    if (
      replacement === undefined ||
      tokens[index - 1]?.text === '.' ||
      analysis.structFields.has(index)
    ) {
      continue;
    }
    const scope = analysis.scopeAt[index] ?? 0;
    if (analysis.localDeclarations.has(index)) continue;
    if (!analysis.declarations.has(index) && isShadowed(analysis, scope, index, token.text))
      continue;
    edits.push({ start: token.start, end: token.end, replacement });
  }
  let result = source;
  for (const edit of edits.reverse()) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  return result;
}

function replaceQualifiedModuleReferences(
  source: string,
  moduleAlias: string,
  renames: ReadonlyMap<string, string>,
): string {
  const escaped = moduleAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(
    new RegExp(`\\b${escaped}\\s*::\\s*([A-Za-z_][A-Za-z0-9_]*)`, 'g'),
    (full, name: string) => renames.get(name) ?? full,
  );
}

function stableSurfaceHelperPrefix(moduleId: string): string {
  const digest = digestUtf8(moduleId).slice(0, 16);
  return `fxSurfaceHelper_${digest}_`;
}

function removeCanonicalImports(
  source: string,
  modules: ReadonlySet<string>,
): { readonly source: string; readonly aliases: ReadonlyMap<string, string> } {
  const aliases = new Map<string, string>();
  let result = source;
  for (const directive of importDirectives(source)) {
    if (!modules.has(directive.moduleId)) continue;
    for (const symbol of directive.symbols) aliases.set(symbol.local, symbol.imported);
    result = result.replace(directive.line, '');
  }
  return { source: result, aliases };
}

const SURFACE_INPUT_FIELDS = [
  ['positionOS', 'vec3<f32>'],
  ['positionWS', 'vec3<f32>'],
  ['geometricNormalWS', 'vec3<f32>'],
  ['vertexNormalWS', 'vec3<f32>'],
  ['tangentWS', 'vec4<f32>'],
  ['viewDirectionWS', 'vec3<f32>'],
  ['uv0', 'vec2<f32>'],
  ['uv1', 'vec2<f32>'],
  ['uv2', 'vec2<f32>'],
  ['uv3', 'vec2<f32>'],
  ['uv4', 'vec2<f32>'],
  ['uv5', 'vec2<f32>'],
  ['uv6', 'vec2<f32>'],
  ['uv7', 'vec2<f32>'],
  ['vertexColor', 'vec4<f32>'],
  ['frontFacing', 'bool'],
  ['uvFootprint0', 'vec4<f32>'],
  ['uvFootprint1', 'vec4<f32>'],
  ['frameTime', 'f32'],
] as const;

const SURFACE_DATA_FIELDS = [
  ['baseColor', 'vec3<f32>'],
  ['normalWS', 'vec3<f32>'],
  ['metallic', 'f32'],
  ['roughness', 'f32'],
  ['emissive', 'vec3<f32>'],
  ['occlusion', 'f32'],
  ['opacity', 'f32'],
  ['alphaClipThreshold', 'f32'],
] as const;

const MEDIUM_SURFACE_INPUT_FIELDS = [
  ['positionOS', 'vec3<f32>'],
  ['positionWS', 'vec3<f32>'],
  ['geometricNormalWS', 'vec3<f32>'],
  ['tangentWS', 'vec4<f32>'],
  ['viewDirectionWS', 'vec3<f32>'],
  ['uv0', 'vec2<f32>'],
  ['uv1', 'vec2<f32>'],
  ['uv2', 'vec2<f32>'],
  ['uv3', 'vec2<f32>'],
  ['uv4', 'vec2<f32>'],
  ['uv5', 'vec2<f32>'],
  ['uv6', 'vec2<f32>'],
  ['uv7', 'vec2<f32>'],
  ['vertexColor', 'vec4<f32>'],
  ['frontFacing', 'bool'],
  ['frameTime', 'f32'],
  ['instanceIndex', 'u32'],
  ['eventRangeStart', 'u32'],
  ['eventRangeCount', 'u32'],
] as const;

const MEDIUM_SURFACE_DATA_FIELDS = [
  ['normalWS', 'vec3<f32>'],
  ['roughness', 'f32'],
  ['coverage', 'f32'],
  ['foam', 'f32'],
  ['absorption', 'vec3<f32>'],
  ['scattering', 'vec3<f32>'],
  ['ior', 'f32'],
  ['phaseG', 'f32'],
  ['maxDistanceMeters', 'f32'],
] as const;

function validateSurfaceAbi(
  request: SurfaceCompositionRequest,
  source: { readonly path: string; readonly source: string },
): Result<true, MaterialError> {
  const check = (structName: string, fields: readonly (readonly [string, string])[]) => {
    const body = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`, 'm').exec(
      source.source,
    )?.[1];
    if (body === undefined) return `missing struct ${structName}`;
    let cursor = 0;
    for (const [index, [name, type]] of fields.entries()) {
      const suffix = index === fields.length - 1 ? '(?:\\s*,|\\s*$)' : '\\s*,';
      const field = new RegExp(`\\b${name}\\s*:\\s*${type.replace(/[<>]/g, '\\$&')}${suffix}`).exec(
        body.slice(cursor),
      );
      if (field === null) return `${structName}.${name} must be ${type}`;
      cursor += (field.index ?? 0) + field[0].length;
    }
    return undefined;
  };
  const medium = request.surfaceModel === 'single-layer-medium';
  const actual = medium
    ? (check('SingleLayerMediumSurfaceInput', MEDIUM_SURFACE_INPUT_FIELDS) ??
      check('SingleLayerMediumSurfaceData', MEDIUM_SURFACE_DATA_FIELDS))
    : (check('SurfaceInput', SURFACE_INPUT_FIELDS) ?? check('SurfaceData', SURFACE_DATA_FIELDS));
  if (actual !== undefined) {
    return err(
      createMaterialError('material-surface-abi-mismatch', {
        code: 'material-surface-abi-mismatch',
        material: request.material,
        pass: request.pass,
        source: source.path,
        slot: 'surface',
        expected: medium
          ? 'single_layer_medium_surface_v1 canonical SingleLayerMediumSurfaceInput/SingleLayerMediumSurfaceData field order'
          : 'surface_v1 canonical SurfaceInput/SurfaceData field order',
        actual,
        action: 'repair-surface-export',
      }),
    );
  }
  return ok(true);
}

/**
 * Lower the selected Surface and ABI into the Standard entry. Keeping both
 * structs in the entry gives the compiler one lexical material namespace and
 * avoids a second import path for the authored Surface ABI.
 */
function inlineSurfaceImplementation(
  templateSource: string,
  selectedSource: string,
  surfaceAbiSource: string,
  generatedParameters: string,
  useParameterModuleImport = false,
  inlineHelpers: readonly { readonly moduleId: string; readonly source: string }[] = [],
  surfaceAbiModule = 'forgeax_material::surface_v1',
  dynamicInputSource = '',
): string {
  // Keep every remaining import in its original preprocessor context. Moving
  // guarded imports to the entry header would make optional cluster/projector
  // modules unconditional and would change the variant's binding contract.
  const templateImports = removeCanonicalImports(
    templateSource,
    new Set(['forgeax_material::slot::surface', surfaceAbiModule, 'forgeax_material::parameters']),
  );
  const templateBody = rewriteBoundIdentifiers(
    templateImports.source
      .replace(/^\s*#pragma\s+material_slot\s+surface[^\n]*\n?/gm, '')
      .replace(DEFINE_IMPORT_PATH_RE, ''),
    new Map(),
    templateImports.aliases,
  );
  const selectedImports = removeCanonicalImports(
    selectedSource,
    new Set([
      'forgeax_material::surface_v1',
      surfaceAbiModule,
      ...(useParameterModuleImport ? [] : ['forgeax_material::parameters']),
    ]),
  );
  const selectedBody = selectedImports.source.replace(DEFINE_IMPORT_PATH_RE, '');
  const inlineHelperIds = new Set(inlineHelpers.map((helper) => helper.moduleId));
  const helperRenames = new Map<string, ReadonlyMap<string, string>>();
  for (const helper of inlineHelpers) {
    const prefix = stableSurfaceHelperPrefix(helper.moduleId);
    const names = new Map<string, string>();
    for (const declaration of topLevelDeclarations(tokenizeWgsl(helper.source))) {
      names.set(declaration.name, `${prefix}${declaration.name}`);
    }
    helperRenames.set(helper.moduleId, names);
  }
  const selectedBodyWithoutInlineHelpers = rewriteInlineImports(
    selectedBody,
    inlineHelperIds,
    helperRenames,
  );
  // A Surface can import pure helpers without importing MaterialParameters.
  // Hoist its leading imports in that case too: late naga_oil imports would
  // otherwise invalidate the template's earlier imported type namespace.
  const selectedHeaderImports = extractLeadingImports(selectedBodyWithoutInlineHelpers);
  const selectedBodyWithoutHeaderImports =
    selectedHeaderImports.length === 0
      ? selectedBodyWithoutInlineHelpers
      : selectedBodyWithoutInlineHelpers.slice(selectedHeaderImports.length);
  const selectedBodyWithCanonicalNames = rewriteBoundIdentifiers(
    selectedBodyWithoutHeaderImports,
    new Map(),
    selectedImports.aliases,
  );
  const abiBody = surfaceAbiSource.replace(DEFINE_IMPORT_PATH_RE, '');
  const parameters = useParameterModuleImport
    ? parameterModuleImport(generatedParameters)
    : generatedParameters.replace(DEFINE_IMPORT_PATH_RE, '');
  const commonImport =
    templateBody.match(/^\s*#import\s+forgeax_view::common[^\n]*\n?/m)?.[0] ?? '';
  const templateWithoutCommonImport =
    commonImport.length === 0 ? templateBody : templateBody.replace(commonImport, '');
  // Keep the template declarations before the selected implementation. WGSL
  // name resolution in naga_oil is declaration-ordered for global resources;
  // placing evaluate_surface ahead of the template's texture declarations
  // would make otherwise valid references (for example baseColorTexture)
  // appear out of scope. The template's remaining imports stay in-place and
  // are still resolved under their original #ifdef guards.
  const helperImports = new Set<string>();
  const helperBodies: string[] = [];
  for (const helper of inlineHelpers) {
    let body = helper.source.replace(DEFINE_IMPORT_PATH_RE, '');
    const importedRenames = new Map<string, string>();
    for (const directive of importDirectives(body)) {
      if (inlineHelperIds.has(directive.moduleId)) {
        const targetRenames = helperRenames.get(directive.moduleId);
        if (directive.moduleAlias !== undefined && targetRenames !== undefined) {
          body = replaceQualifiedModuleReferences(body, directive.moduleAlias, targetRenames);
        }
        for (const symbol of directive.symbols) {
          const renamed = targetRenames?.get(symbol.imported);
          if (renamed !== undefined) importedRenames.set(symbol.local, renamed);
        }
        body = body.replace(directive.line, '');
        continue;
      }
      if (
        directive.moduleId === surfaceAbiModule ||
        directive.moduleId === 'forgeax_material::surface_v1' ||
        directive.moduleId === 'forgeax_material::parameters'
      ) {
        for (const symbol of directive.symbols) importedRenames.set(symbol.local, symbol.imported);
        body = body.replace(directive.line, '');
        continue;
      }
      helperImports.add(directive.line);
      body = body.replace(directive.line, '');
    }
    body = rewriteBoundIdentifiers(
      body,
      helperRenames.get(helper.moduleId) ?? new Map(),
      importedRenames,
    );
    helperBodies.push(body);
  }
  const helperImportPrelude = [...helperImports].join('');
  const helperBody = helperBodies.join('\n');
  const body = useParameterModuleImport
    ? `${selectedBodyWithCanonicalNames}\n${helperBody}\n${templateWithoutCommonImport}`
    : `${templateWithoutCommonImport}\n${selectedBodyWithCanonicalNames}\n${helperBody}`;
  return `${parameters}\n${abiBody}\n${dynamicInputSource}\n${commonImport}${helperImportPrelude}${selectedHeaderImports}${body}`;
}

function rewriteInlineImports(
  source: string,
  modules: ReadonlySet<string>,
  renames: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  if (modules.size === 0) return source;
  let result = source;
  for (const directive of importDirectives(source)) {
    if (!modules.has(directive.moduleId)) continue;
    const targetRenames = renames.get(directive.moduleId);
    const importedRenames = new Map<string, string>();
    if (directive.moduleAlias !== undefined && targetRenames !== undefined) {
      result = replaceQualifiedModuleReferences(result, directive.moduleAlias, targetRenames);
    }
    for (const symbol of directive.symbols) {
      const renamed = targetRenames?.get(symbol.imported);
      if (renamed !== undefined) importedRenames.set(symbol.local, renamed);
    }
    result = result.replace(directive.line, '');
    result = rewriteBoundIdentifiers(result, new Map(), importedRenames);
  }
  return result;
}

/** Hoist only the unguarded import prelude of an inlined Surface module. */
function extractLeadingImports(source: string): string {
  const match = /^(?:(?:\s*\/\/[^\n]*\n|\s*\n)*\s*#import\s+[^\n]+\n?)+/.exec(source);
  return match?.[0] ?? '';
}

/**
 * Keep a composable helper's `material` import on the same generated module as
 * the lowered entry. Inlining the generated declarations into the root while
 * leaving the helper imported creates a second naga_oil module global, so the
 * helper observes a different private scene-row provider. Import the generated
 * type/provider once; the selected Surface's own resource imports are hoisted
 * alongside it so texture and sampler references retain their declared binding
 * identity.
 */
function parameterModuleImport(generatedParameters: string): string {
  const symbols = new Set<string>();
  if (/\bstruct\s+MaterialParameters\b/.test(generatedParameters)) {
    symbols.add('MaterialParameters');
  }
  if (/\bconst\s+MATERIAL_SCENE_ROW_VEC4_COUNT\b/.test(generatedParameters)) {
    symbols.add('MATERIAL_SCENE_ROW_VEC4_COUNT');
  }
  // Only types, layout constants and the material provider belong in the canonical root import.
  // Resource imports remain authored on the selected Surface and are hoisted
  // with its import prelude, avoiding naga_oil's duplicate-global edge cases
  // for scene-only declarations such as sceneMaterials.
  if (/\bvar(?:<[^>]+>)?\s+material\s*:/.test(generatedParameters)) {
    symbols.add('material');
  }
  if (symbols.size === 0) return '';
  return `#import forgeax_material::parameters::{${[...symbols].sort().join(', ')}}`;
}

function hasAuthoredMaterialInterface(source: string): boolean {
  return (
    /\bstruct\s+Material\s*\{/.test(source) &&
    /@group\(1\)\s*@binding\(0\)\s*var<uniform>\s+material\s*:\s*Material\s*;/.test(source)
  );
}

function closureDigest(imports: Readonly<Record<string, string>>): string {
  const preimage = [...Object.entries(imports)]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([module, source]) => `${module}\n${source}`)
    .join('\n');
  return `sha256:${digestUtf8(preimage)}`;
}

/**
 * Hash a material's resolved source closure with the same canonical ordering
 * used by Surface composition. Pack receipts use this helper so the digest
 * is owned by the compiler closure rather than by a second cooker algorithm.
 */
export function digestMaterialSourceClosure(sources: Readonly<Record<string, string>>): string {
  return closureDigest(sources);
}

/**
 * Prepare a Standard template through the same catalog and Surface lowering
 * used by Pack cooking. This keeps the Vite/manifest entry path from feeding
 * naga a second, imported Surface ABI representation.
 */
export function prepareStandardSource(
  request: StandardSourcePreparationRequest,
): Result<PreparedStandardSource, MaterialError> {
  const catalog = buildMaterialSourceCatalog({
    engine: [
      { path: request.templatePath, source: request.templateSource },
      ...request.sourceRecords.filter((record) => record.path !== request.templatePath),
    ],
    project: [],
  });
  if (!catalog.ok) return err(catalog.error);
  const composed = composeSurfaceSource({
    material: request.material,
    pass: request.pass ?? 'Forward',
    templateModule: request.templateModule,
    ...(request.surfaceModule === undefined ? {} : { surfaceModule: request.surfaceModule }),
    sources: catalog.value,
    ...(request.generatedParameters === undefined
      ? {}
      : { generatedParameters: request.generatedParameters }),
  });
  if (!composed.ok) return composed;
  return ok({
    source: composed.value.source,
    imports: composed.value.imports,
    sourceClosure: composed.value.sourceClosure,
    sourceClosureDigest: composed.value.sourceClosureDigest,
  });
}

/** Resolve and validate the sole Standard Surface slot at build time. */
export function composeSurfaceSource(
  request: SurfaceCompositionRequest,
): Result<SurfaceComposition, MaterialError> {
  const template = request.sources.get(request.templateModule);
  if (!template.ok) return err(template.error);
  const selected = request.sources.resolveSurfaceSlot(
    request.material,
    request.pass,
    request.templateModule,
    request.surfaceModule,
  );
  if (!selected.ok) return err(selected.error);

  const validated = validateSurfaceSource({
    material: request.material,
    pass: request.pass,
    source: selected.value.source,
    sourcePath: selected.value.path,
    ...(request.surfaceModel === undefined ? {} : { model: request.surfaceModel }),
  });
  if (!validated.ok) return err(validated.error);

  const surfaceAbiModule =
    request.surfaceModel === 'single-layer-medium'
      ? SINGLE_LAYER_MEDIUM_SURFACE_MODULE
      : 'forgeax_material::surface_v1';
  const surfaceAbi = request.sources.get(surfaceAbiModule);
  if (!surfaceAbi.ok) return err(surfaceAbi.error);
  const validAbi = validateSurfaceAbi(request, surfaceAbi.value);
  if (!validAbi.ok) return validAbi;

  const generatedParameters =
    request.generatedParameters ?? '#define_import_path forgeax_material::parameters\n';
  const dynamicInputSource =
    request.dynamicInput === undefined
      ? ''
      : generateMaterialDynamicInputAccessor(request.dynamicInput);
  const dynamicInputModule =
    request.dynamicInput === undefined
      ? undefined
      : materialDynamicInputModuleId(request.dynamicInput);
  const parameterSource = hasAuthoredMaterialInterface(template.value.source)
    ? ''
    : generatedParameters;
  const imports: Record<string, string> = {};
  const closureSources: Record<string, string> = {
    [request.templateModule]: template.value.source,
    ...(parameterSource.length === 0 ? {} : { 'forgeax_material::parameters': parameterSource }),
    [surfaceAbiModule]: surfaceAbi.value.source,
    [selected.value.moduleId]: selected.value.source,
    ...(dynamicInputModule === undefined ? {} : { [dynamicInputModule]: dynamicInputSource }),
  };
  const queue = [
    ...importedModules(template.value.source).map((module) => ({
      module,
      surfaceDependency: false,
      // The template and selected Surface are inlined into the entry. Their
      // direct parameter imports are removed by inlineSurfaceImplementation;
      // only modules that stay in the composable closure need the generated
      // parameter provider registered below.
      composable: false,
    })),
    ...importedModules(selected.value.source).map((module) => ({
      module,
      surfaceDependency: true,
      composable: false,
    })),
  ];
  const visited = new Set<string>();
  const validatedSurfaceDependencies = new Set<string>();
  let readsVertexColor = surfaceSourceReadsVertexColor(selected.value.source);
  let useParameterModuleImport = false;
  const inlineSurfaceHelpers: Array<{ readonly moduleId: string; readonly source: string }> = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    const module = next.module;
    if (
      module === request.templateModule ||
      module === surfaceAbiModule ||
      module === 'forgeax_material::surface_v1' ||
      module === 'forgeax_material::slot::surface' ||
      module === selected.value.moduleId ||
      module === 'forgeax_material::parameters'
    ) {
      // Surface implementations are inlined into the root entry, so the
      // generated parameter module is normally inlined as well.  A transitive
      // helper, however, remains a naga_oil composable module and may import
      // the parameter provider itself.  Keep that one provider in the closure
      // so the helper resolves against the exact generated source used by the
      // root (including the scene-index private provider).
      if (
        module === 'forgeax_material::parameters' &&
        next.composable &&
        parameterSource.length > 0
      ) {
        imports[module] = parameterSource;
        useParameterModuleImport = true;
      }
      continue;
    }
    const needsSurfaceValidation =
      next.surfaceDependency && !validatedSurfaceDependencies.has(module);
    if (visited.has(module) && !needsSurfaceValidation) continue;
    const record = request.sources.get(module);
    if (!record.ok) return err(record.error);
    if (needsSurfaceValidation && surfaceSourceReadsVertexColor(record.value.source)) {
      readsVertexColor = true;
    }
    if (needsSurfaceValidation) {
      const dependency = validateSurfaceDependency({
        material: request.material,
        pass: request.pass,
        source: record.value.source,
        sourcePath: record.value.path,
      });
      if (!dependency.ok) return err(dependency.error);
      validatedSurfaceDependencies.add(module);
    }
    if (visited.has(module)) continue;
    visited.add(module);
    const surfaceTypedHelper =
      next.surfaceDependency &&
      (importedModules(record.value.source).includes(surfaceAbiModule) ||
        importedModules(record.value.source).includes('forgeax_material::surface_v1'));
    if (surfaceTypedHelper) {
      // naga_oil cannot write back a composable function whose parameter is
      // the Surface ABI (its numbered uv fields are treated as substitution
      // identifiers). Inline that helper into the root entry, where it shares
      // the canonical ABI declaration with the authored Surface. Its own
      // non-ABI imports are hoisted by inlineSurfaceImplementation.
      inlineSurfaceHelpers.push({ moduleId: module, source: record.value.source });
    } else {
      imports[module] = record.value.source;
    }
    closureSources[module] = record.value.source;
    queue.push(
      ...importedModules(record.value.source).map((child) => ({
        module: child,
        surfaceDependency: next.surfaceDependency,
        composable: true,
      })),
    );
  }
  const source = inlineSurfaceImplementation(
    template.value.source,
    selected.value.source,
    surfaceAbi.value.source,
    parameterSource,
    useParameterModuleImport,
    inlineSurfaceHelpers,
    surfaceAbiModule,
    dynamicInputSource,
  );
  const sourceClosure = Object.keys(closureSources).sort();
  return ok({
    source,
    templateModule: request.templateModule,
    surfaceModule: selected.value.moduleId,
    imports,
    sourceClosure,
    sourceClosureDigest: closureDigest(closureSources),
    stages: ['slot-resolution', 'source-closure', 'surface-validation', 'parameter-generation'],
    readsVertexColor,
  });
}
