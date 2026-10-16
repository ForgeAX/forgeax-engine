import {
  copyPackData,
  decodePackBlob,
  type FixedPackPublication,
  validateFixedPackPublication,
  validatePackBlob,
  verifyPackProgram,
} from '@forgeax/engine-pack/runtime';
import {
  type AnyScriptablePackDefinition,
  AssetGuid,
  definePackageId,
  PackageId,
  type PackInstanceJson,
  parsePackSourceJson,
  validatePackDefinition,
} from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
import type {
  RuntimePackContent,
  RuntimePackSnapshot,
  RuntimeScriptablePackSource,
} from './runtime-pack.js';
import { decodeRuntimePackData } from './runtime-pack-data.js';
import { scriptablePackFingerprint as fingerprint } from './scriptable-pack-fingerprint.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected a data record');
  return value as Record<string, unknown>;
}
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const object = record(value);
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) throw new TypeError(`unknown field ${key}`);
  return object;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length) throw new TypeError('expected non-empty text');
}
function digest(value: unknown): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value))
    throw new TypeError('expected a SHA256 content identity');
}
function guid(value: unknown): void {
  text(value);
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok || AssetGuid.format(parsed.value) !== value)
    throw new TypeError('expected a canonical asset GUID');
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('expected an array');
  return value;
}
export function runtimeGeneratorDefinition(
  source: RuntimeScriptablePackSource,
  build: unknown,
): AnyScriptablePackDefinition {
  const { kind: _kind, source: _source, program: _program, packageId, ...definition } = source;
  return validatePackDefinition({
    ...definition,
    packageId: definePackageId(packageId),
    build,
  }).unwrap();
}
function content(value: unknown): void {
  const input = fields(value, ['source', 'programs', 'blobs', 'dependencies']);
  const source = record(input.source);
  text(source.packageId);
  if (PackageId.format(definePackageId(source.packageId)) !== source.packageId)
    throw new TypeError('expected a canonical packageId');
  if (source.kind === 'scriptable-pack-source') {
    fields(source, [
      'schemaVersion',
      'kind',
      'source',
      'packageId',
      'parameters',
      'runtime',
      'program',
      'sceneComponents',
    ]);
    text(source.source);
    text(source.program);
    runtimeGeneratorDefinition(source as unknown as RuntimeScriptablePackSource, () => ok({}));
    if (!source.runtime || !Object.hasOwn(record(input.programs), source.program))
      throw new TypeError('generator requires runtime capability and its local program');
  } else if (parsePackSourceJson(source).unwrap().format !== 'direct')
    throw new TypeError('expected a direct Pack source');
  for (const [name, value] of Object.entries(
    input.programs === undefined ? {} : record(input.programs),
  )) {
    text(name);
    const program = fields(value, ['artifact', 'source']);
    const artifact = verifyPackProgram(program.artifact as never).unwrap();
    if (program.source !== undefined) {
      const original = fields(program.source, ['entry', 'export', 'modules', 'imports']);
      text(original.entry);
      text(original.export);
      if (original.export !== artifact.export)
        throw new TypeError('source export differs from its artifact');
      const modules = record(original.modules);
      if (!Object.hasOwn(modules, original.entry))
        throw new TypeError('missing original entry module');
      for (const [path, source] of Object.entries(modules)) {
        if (
          !/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:ts|mts|js|mjs)$/.test(
            path,
          ) ||
          typeof source !== 'string'
        )
          throw new TypeError('expected original module paths and source text');
      }
      for (const [name, identity] of Object.entries(
        original.imports === undefined ? {} : record(original.imports),
      )) {
        text(name);
        text(identity);
      }
      const emitted = (path: string) => path.replace(/\.mts$/, '.mjs').replace(/\.ts$/, '.js');
      if (
        emitted(original.entry) !== artifact.entry ||
        fingerprint(Object.keys(modules).map(emitted).sort()) !==
          fingerprint(Object.keys(artifact.modules).sort()) ||
        fingerprint(original.imports ?? {}) !== fingerprint(artifact.imports ?? {})
      )
        throw new TypeError('source closure differs from its artifact');
      for (const [path, text] of Object.entries(modules))
        if (/\.(?:js|mjs)$/.test(path) && artifact.modules[path] !== text)
          throw new TypeError('JavaScript original differs from its executable module');
    }
  }
  for (const [path, values] of Object.entries(
    input.blobs === undefined ? {} : record(input.blobs),
  )) {
    if (
      !/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path) ||
      path.split('/').some((part) => part === '..' || part === '.')
    )
      throw new TypeError(`invalid blob path ${path}`);
    validatePackBlob(values);
    if (!(values instanceof Uint8Array)) record(input.blobs)[path] = decodePackBlob(values);
  }
  for (const [id, version] of Object.entries(
    input.dependencies === undefined ? {} : record(input.dependencies),
  )) {
    guid(id);
    digest(version);
  }
}
export function parseRuntimePackContent(value: unknown): RuntimePackContent {
  const copy = copyPackData(value);
  content(copy);
  return copy as RuntimePackContent;
}
function instance(value: unknown): void {
  const parsed = parsePackSourceJson(value).unwrap();
  if (parsed.format !== 'instance') throw new TypeError('expected a Pack instance');
  const source = record(value);
  for (const field of ['packageId', 'parent']) {
    const id = source[field];
    text(id);
    if (PackageId.format(definePackageId(id)) !== id)
      throw new TypeError(`expected a canonical ${field}`);
  }
}
export function parseRuntimePackInstance(value: unknown): PackInstanceJson {
  const copy = copyPackData(value);
  instance(copy);
  return copy as PackInstanceJson;
}
/** Structural validation precedes dependency recovery or any current publication. */
export function parseRuntimePackSnapshot(value: unknown): RuntimePackSnapshot {
  const copy = fields(decodeRuntimePackData(copyPackData(value) as object), [
    'schemaVersion',
    'packs',
    'instances',
    'recipeRoots',
    'closure',
  ]);
  if (copy.schemaVersion !== 'runtime-pack-source/2') throw new TypeError('unsupported snapshot');
  for (const pack of list(copy.packs)) content(pack);
  for (const item of list(copy.instances)) instance(item);
  for (const root of copy.recipeRoots === undefined ? [] : list(copy.recipeRoots)) digest(root);
  if (copy.closure !== undefined) {
    const closure = fields(copy.closure, ['contents', 'recipes', 'bindings']);
    for (const [id, value] of Object.entries(record(closure.contents))) {
      digest(id);
      content(value);
    }
    for (const [id, value] of Object.entries(record(closure.recipes))) {
      digest(id);
      const recipe = fields(value, ['content', 'instance', 'fixed', 'outputs', 'dependencies']);
      if ('fixed' in recipe) {
        if ('content' in recipe || 'instance' in recipe)
          throw new TypeError('fixed recipe cannot contain authoring inputs');
        validateFixedPackPublication(recipe.fixed as FixedPackPublication).unwrap();
      } else {
        digest(recipe.content);
        if (recipe.instance !== undefined) instance(recipe.instance);
      }
      const outputs = list(recipe.outputs);
      if (!outputs.length) throw new TypeError('fixed recipes require outputs');
      const seen = new Set<string>();
      for (const item of outputs) {
        const output = fields(item, ['guid', 'sourceKey', 'kind', 'digest', 'refs']);
        guid(output.guid);
        text(output.sourceKey);
        text(output.kind);
        digest(output.digest);
        for (const ref of list(output.refs)) guid(ref);
        if (seen.has(String(output.guid))) throw new TypeError('duplicate recipe output');
        seen.add(String(output.guid));
      }
      for (const [id, recipeId] of Object.entries(record(recipe.dependencies))) {
        guid(id);
        digest(recipeId);
      }
    }
    for (const [id, value] of Object.entries(record(closure.bindings))) {
      digest(id);
      for (const [guidKey, recipeId] of Object.entries(record(value))) {
        guid(guidKey);
        digest(recipeId);
      }
    }
  }
  return copy as unknown as RuntimePackSnapshot;
}
