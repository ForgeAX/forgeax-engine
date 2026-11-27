import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { sha256 } from '@forgeax/engine-types';
import ts from 'typescript';
import { isFilesystemPathWithin } from '../filesystem-path.js';
import type { DevKitAppOptions } from '../plugin-build.js';

type Declaration = NonNullable<DevKitAppOptions['renderFeatures']>[number];

function requireJsonProperty(value: object, key: string, descriptor: PropertyDescriptor): void {
  if (!descriptor.enumerable || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) {
    throw new TypeError('Render feature config cannot contain properties omitted by JSON');
  }
  if (!('value' in descriptor))
    throw new TypeError('Render feature config cannot contain accessors');
}

function requireDataConfig(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new TypeError('Render feature config must contain finite JSON data without cycles');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Render feature config requires plain data objects');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0)
    throw new TypeError('Render feature config cannot contain symbol keys');
  ancestors.add(value);
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && key === 'length') continue;
      requireJsonProperty(value, key, descriptor);
      requireDataConfig(descriptor.value, ancestors);
    }
    if (Array.isArray(value))
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index))
          throw new TypeError('Render feature config cannot contain sparse arrays');
      }
  } finally {
    ancestors.delete(value);
  }
}

function validFeatureModule(module: unknown): boolean {
  return (
    typeof module === 'string' &&
    module.startsWith('./') &&
    !module.includes('\\') &&
    !module.includes('?') &&
    !module.includes('#') &&
    /\.(?:ts|mts|js|mjs)$/.test(module)
  );
}

/** Construction-time project declarations, not live World-owned GPU objects. */
export function validateRenderFeatureContributions(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value))
    throw new TypeError('devkitAppOptions.renderFeatures must be an array');
  const ids = new Set<string>();
  for (const row of value) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !['id', 'module', 'export', 'config'].includes(key)) ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      !validFeatureModule(row.module) ||
      typeof row.export !== 'string' ||
      !/^[A-Za-z_$][\w$]*$/.test(row.export) ||
      (row.config !== undefined &&
        (!row.config || typeof row.config !== 'object' || Array.isArray(row.config)))
    ) {
      throw new TypeError(
        'Each render feature requires a unique id, project-relative module, named factory export and data config',
      );
    }
    ids.add(row.id);
    if (row.config !== undefined) requireDataConfig(row.config);
  }
}

function projectFile(root: string, candidate: string): string {
  const file = realpathSync(candidate);
  if (!isFilesystemPathWithin(root, file))
    throw new TypeError('Project render feature modules must remain inside the project');
  return file;
}

function importedFile(root: string, parent: string, specifier: string): string {
  const raw = resolve(dirname(parent), specifier.split('?')[0] ?? '');
  const candidates = [raw];
  if (/\.[cm]?js$/.test(raw))
    candidates.push(raw.replace(/\.[cm]?js$/, '.ts'), raw.replace(/\.[cm]?js$/, '.mts'));
  if (!extname(raw))
    candidates.push(
      ...['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'].map((suffix) => raw + suffix),
    );
  const found = candidates.find(existsSync);
  if (!found) throw new TypeError(`Project render feature input is missing: ${specifier}`);
  return projectFile(root, found);
}

/** Include factory code, authored WGSL and data in the same source admission
 * identity as plugin programs. Names alone cannot admit changed GPU kernels. */
export function renderFeatureSourceInputs(
  root: string,
  declarations: readonly Declaration[] = [],
): readonly (readonly [string, string])[] {
  const canonicalRoot = realpathSync(root),
    seen = new Map<string, string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    const bytes = readFileSync(file);
    seen.set(file, `sha256:${sha256(bytes)}`);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const add = (specifier: string): void => {
      if (specifier.startsWith('.')) visit(importedFile(canonicalRoot, file, specifier));
    };
    const walk = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        add(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument))
          throw new TypeError('Render feature factory imports must declare their source module');
        add(argument.text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  for (const declaration of declarations)
    visit(projectFile(canonicalRoot, resolve(canonicalRoot, declaration.module)));
  return [...seen]
    .map(([file, digest]) => [relative(canonicalRoot, file).split(sep).join('/'), digest] as const)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Every execution/render realm constructs its own contribution. Source plugins
 * may provide typed capabilities so the game borrows the exact source-resource
 * token captured by the feature, including compiled Pack program boundaries. */
export function gameRenderFeaturesSource(
  root: string,
  generated: string,
  declarations: readonly Declaration[] = [],
): string {
  validateRenderFeatureContributions(declarations);
  const imports = declarations.map((row, index) => {
    const file = projectFile(realpathSync(root), resolve(root, row.module));
    const path = relative(generated, file).split(sep).join('/');
    return `import * as feature${index} from ${JSON.stringify(path.startsWith('.') ? path : `./${path}`)};`;
  });
  return `${imports.join('\n')}
import type { RenderFeature } from '@forgeax/engine/render';
import type { Plugin } from '@forgeax/engine/plugin';
import type { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
type VfxProviders = NonNullable<NonNullable<Parameters<typeof createVfxRuntimeHost>[0]>['providers']>;
type VfxProvidersForWorld = NonNullable<NonNullable<Parameters<typeof createVfxRuntimeHost>[0]>['providersForWorld']>;
interface Contribution { readonly features: readonly RenderFeature[]; readonly plugin?: Plugin.Object;
  readonly vfxProviders?: VfxProviders; readonly vfxProvidersForWorld?: VfxProvidersForWorld }
export function createGameRenderFeatures() {
  const contributions: Contribution[] = [];
  ${declarations
    .map(
      (row, index) => `{
    const factory = feature${index}[${JSON.stringify(row.export)}];
    if (typeof factory !== 'function') throw new TypeError(${JSON.stringify(`Render feature factory export is missing: ${row.id}`)});
    const contribution = factory(${JSON.stringify(row.config ?? {})}) as Contribution;
    if (!Array.isArray(contribution?.features) || contribution.features.length === 0 || contribution.features.some(feature => !feature))
      throw new TypeError(${JSON.stringify(`Render feature contribution requires its feature list: ${row.id}`)});
    contributions.push(contribution);
  }`,
    )
    .join('\n')}
  return { features: contributions.flatMap(row => row.features), plugins: contributions.flatMap(row => row.plugin ? [row.plugin] : []),
    vfxProviders: contributions.flatMap(row => row.vfxProviders ?? []),
    vfxProvidersForWorld: (world: Parameters<VfxProvidersForWorld>[0]) => contributions.flatMap(row => row.vfxProvidersForWorld?.(world) ?? []) };
}
`;
}
