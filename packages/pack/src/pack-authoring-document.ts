import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { PackageId } from './guid.js';
import {
  type PackParameterDefinition,
  type PackParameterValue,
  parsePackSourceJson,
} from './pack-authoring.js';
import type { PackDraftDocument, PackDraftField } from './pack-authoring-draft.js';
import {
  type PackAuthoringLiteral,
  packAuthoringLiteral,
  packSourceFailure,
  packSourceRevision,
  patchPackLiterals,
  patchPackLiteralValues,
  readPackAuthoringDeclaration,
  readPackLiteral,
} from './pack-authoring-literals.js';

export interface PackDraftSource {
  readonly generator?: {
    readonly sourcePath: string;
    readonly source: string;
    readonly paths?: readonly string[];
  };
  readonly document: PackDraftDocument;
  readonly source: string;
  readonly generationSource: string;
  readonly literals: ReadonlyMap<string, PackAuthoringLiteral>;
  write(changes: ReadonlyMap<string, PackParameterValue>): string;
}

export interface PackDraftSourceOptions {
  readonly generator?: {
    readonly sourcePath: string;
    readonly source: string;
    readonly paths?: readonly string[];
  };
  /** Existing inheritance owner provides effective descriptors/defaults for an instance. */
  readonly inherited?: readonly PackParameterDefinition[];
  /** Domain decides whether a direct field can bypass generation. */
  readonly liveField?: (
    kind: string,
    path: readonly string[],
    value: PackParameterValue,
  ) => boolean;
}

function valueType(value: unknown): PackParameterDefinition['type'] | undefined {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number' && Number.isFinite(value)) return 'f64';
  if (typeof value === 'string') return 'string';
  if (
    Array.isArray(value) &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part))
  ) {
    return ({ 2: 'vec2', 3: 'vec3', 4: 'vec4' } as const)[value.length as 2 | 3 | 4];
  }
  return undefined;
}

function key(path: readonly string[]): string {
  return JSON.stringify(path);
}

/** Canonical code identity excludes parameter defaults; effective generation values form the other input. */
function codeIdentity(source: string): string {
  const declaration = readPackAuthoringDeclaration('generation.pack.ts', source).unwrap();
  const projected = patchPackLiterals(
    source,
    [...declaration.defaults.values()].map(({ start, end }) => ({ start, end, text: 'null' })),
  );
  const file = ts.createSourceFile('generation.pack.ts', projected, ts.ScriptTarget.Latest, true);
  return packSourceRevision(ts.createPrinter({ removeComments: true }).printFile(file));
}

/** Read once on open/refresh/save. Dragging never reparses or rewrites source text. */
export function readPackDraftSource(
  sourcePath: string,
  source: string,
  options: PackDraftSourceOptions = {},
): PackDraftSource {
  if (sourcePath.endsWith('.pack.ts')) {
    const declaration = readPackAuthoringDeclaration(sourcePath, source).unwrap();
    const fields = declaration.parameters.map((parameter) => {
      const literal = declaration.defaults.get(parameter.name);
      if (!literal)
        throw packSourceFailure(sourcePath, `Missing parameter default ${parameter.name}`);
      return { ...parameter, path: literal.path };
    });
    return {
      source,
      generationSource: declaration.generationSource,
      literals: declaration.defaults,
      document: {
        sourcePath,
        revision: declaration.revision,
        packageId: declaration.packageId,
        format: 'pack.ts',
        fields,
        generationIdentity: codeIdentity(declaration.generationSource),
      },
      write(changes) {
        const updated = patchPackLiteralValues(
          sourcePath,
          source,
          declaration.defaults,
          changes,
        ).unwrap();
        readPackAuthoringDeclaration(sourcePath, updated).unwrap();
        return updated;
      },
    };
  }
  if (!sourcePath.endsWith('.pack.json'))
    throw packSourceFailure(sourcePath, 'expected .pack.ts or .pack.json');
  const parsed = parsePackSourceJson(JSON.parse(source)).unwrap();
  const file = ts.parseJsonText(sourcePath, source);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement))
    throw packSourceFailure(sourcePath, 'invalid JSON document');
  const literals = new Map<string, PackAuthoringLiteral>();
  const visit = (node: ts.Node, path: string[]) => {
    if (path.length > 32) throw packSourceFailure(sourcePath, 'author field exceeds maximum depth');
    const value = readPackLiteral(node);
    if (valueType(value)) literals.set(key(path), packAuthoringLiteral(file, node, path, value));
    else if (ts.isObjectLiteralExpression(node))
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name))
          throw packSourceFailure(sourcePath, 'JSON properties must have literal names');
        visit(property.initializer, [...path, property.name.text]);
      }
    else if (ts.isArrayLiteralExpression(node) && path.at(-1) === 'overrides')
      node.elements.forEach((element, index) => {
        visit(element, [...path, String(index)]);
      });
    // Large data arrays belong to generation and are not expanded into thousands of controls.
  };
  visit(statement.expression, []);
  const fields: PackDraftField[] = [];
  if (parsed.format === 'instance') {
    if (!options.inherited)
      throw packSourceFailure(
        sourcePath,
        'instance requires its existing parent parameter declarations',
      );
    for (const parameter of options.inherited) {
      const value = parsed.values[parameter.name] ?? parameter.default;
      fields.push({
        ...parameter,
        default: value as PackParameterValue,
        path: ['values', parameter.name],
      });
    }
  } else {
    for (const literal of literals.values()) {
      const [root, asset, payload, ...path] = literal.path;
      if (root !== 'assets' || !asset || payload !== 'payload' || path.length === 0) continue;
      const entry = parsed.assets[asset];
      const type = valueType(literal.value);
      if (!entry || !type) throw packSourceFailure(sourcePath, 'Invalid author field');
      const kind = entry.kind;
      fields.push({
        name: key(literal.path),
        path: literal.path,
        type,
        default: literal.value as PackParameterValue,
        ...(options.liveField?.(kind, path, literal.value as PackParameterValue)
          ? { apply: { asset, path } }
          : {}),
      });
    }
  }
  const identity = JSON.parse(source);
  if (parsed.format === 'instance') delete identity.values;
  else
    for (const field of fields) {
      let container = identity;
      for (const part of field.path.slice(0, -1)) container = container[part];
      const leaf = field.path.at(-1);
      if (leaf === undefined) throw packSourceFailure(sourcePath, 'Empty field path');
      container[leaf] = null;
    }
  const document: PackDraftDocument = {
    sourcePath,
    revision: packSourceRevision(source),
    packageId: PackageId.format(parsed.packageId),
    format: parsed.format,
    fields,
    generationIdentity: packSourceRevision(
      JSON.stringify([
        identity,
        fields.map((field) => [field.name, field.type, field.apply]),
        options.generator
          ? readPackDraftSource(options.generator.sourcePath, options.generator.source).document
              .generationIdentity
          : null,
      ]),
    ),
  };
  return {
    source,
    generationSource: source,
    document,
    literals,
    ...(options.generator ? { generator: options.generator } : {}),
    write(changes) {
      if (parsed.format === 'instance') {
        const json = JSON.parse(source);
        for (const [name, value] of changes) json.values[name] = value;
        return `${JSON.stringify(json, null, 2)}\n`;
      }
      const updated = patchPackLiteralValues(sourcePath, source, literals, changes).unwrap();
      parsePackSourceJson(JSON.parse(updated)).unwrap();
      return updated;
    },
  };
}

export class PackSourceRevisionConflict extends Error {
  constructor(readonly revision: string) {
    super('Pack source changed before it could be saved');
  }
}

export async function assertPackSourceRevision(path: string, expected: string): Promise<void> {
  const revision = packSourceRevision(await readFile(path, 'utf8'));
  if (revision !== expected) throw new PackSourceRevisionConflict(revision);
}

const sourceWrites = new Map<string, Promise<void>>();

export async function writePackSourceAtomically(
  path: string,
  source: string,
  options: { readonly expectedRevision?: string; readonly validate?: () => Promise<void> } = {},
): Promise<void> {
  const identity = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' || options.expectedRevision !== undefined) throw error;
    return path;
  });
  const previous = sourceWrites.get(identity) ?? Promise.resolve();
  const write = previous
    .catch(() => {})
    .then(async () => {
      const temporary = resolve(dirname(path), `.${randomUUID()}.pack-source.tmp`);
      try {
        const mode = options.expectedRevision === undefined ? undefined : (await stat(path)).mode;
        await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx', mode });
        await options.validate?.();
        if (options.expectedRevision !== undefined)
          await assertPackSourceRevision(path, options.expectedRevision);
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  sourceWrites.set(identity, write);
  try {
    await write;
  } finally {
    if (sourceWrites.get(identity) === write) sourceWrites.delete(identity);
  }
}
