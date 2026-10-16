import { createToolRuntime } from './runtime.js';
import type {
  JsonValue,
  ToolContribution,
  ToolDescriptor,
  ToolExecutor,
  ToolRun,
  ToolRunOptions,
} from './types.js';

export type ToolCommandPath = readonly string[];

export interface ToolCommandDescriptor<TArgs = unknown, TResult = unknown>
  extends ToolDescriptor<TArgs, TResult> {
  readonly path: ToolCommandPath;
}

export interface ToolCommandNode {
  readonly name: string;
  readonly path: string;
  readonly summary: string;
  readonly children?: readonly ToolCommandNode[];
  readonly leaf?: Pick<
    ToolDescriptor,
    'title' | 'realm' | 'inputSchema' | 'outputSchema' | 'example'
  > & {
    readonly inputDescription?: string;
    readonly outputDescription?: string;
    readonly capabilities: readonly string[];
    readonly errors: readonly string[];
  };
}

export interface ToolCommandHelp {
  readonly path: string;
  readonly summary?: string;
  readonly nodes: readonly ToolCommandNode[];
  readonly leaf?: ToolCommandNode['leaf'];
}

export type ToolCommandErrorCode =
  | 'tool-command-invalid-path'
  | 'tool-command-conflict'
  | 'tool-command-not-found';

export class ToolCommandError extends Error {
  readonly code: ToolCommandErrorCode;
  readonly path: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: ToolCommandErrorCode,
    path: string,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'ToolCommandError';
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

export interface ToolCommandRegistry {
  readonly contributions: readonly ToolContribution[];
  readonly list: (path?: ToolCommandPath) => readonly ToolCommandNode[];
  readonly tree: (path?: ToolCommandPath | string) => readonly ToolCommandNode[];
  readonly describe: (path: ToolCommandPath | string) => ToolCommandDescriptor | undefined;
  readonly help: (path?: ToolCommandPath | string, tree?: boolean) => ToolCommandHelp;
  readonly get: (path: ToolCommandPath | string) => ToolContribution | undefined;
  readonly run: <TResult = unknown>(
    path: ToolCommandPath | string,
    args: unknown,
    options?: ToolRunOptions,
  ) => ToolRun<TResult> | undefined;
}

function normalizePath(path: ToolCommandPath | string): string[] {
  const segments = typeof path === 'string' ? path.split(/\s+/).filter(Boolean) : [...path];
  if (
    (segments.length === 0 && typeof path === 'string') ||
    segments.some((segment) => !/^[a-z][a-z0-9-]*$/.test(segment))
  ) {
    throw new ToolCommandError(
      'tool-command-invalid-path',
      typeof path === 'string' ? path : segments.join(' '),
      'command paths must contain lower-case name segments',
    );
  }
  return segments;
}

function descriptorPath(descriptor: ToolDescriptor): string[] {
  const path = normalizePath(descriptor.path ?? descriptor.id.split('.'));
  if (path.length === 0) {
    throw new ToolCommandError(
      'tool-command-invalid-path',
      '',
      'command declarations must contain at least one name segment',
    );
  }
  return path;
}

function pathKey(path: ToolCommandPath): string {
  return path.join(' ');
}

function schemaValue(describe: string | undefined): JsonValue | undefined {
  if (describe === undefined) return undefined;
  try {
    const value = JSON.parse(describe) as unknown;
    return value !== null && typeof value === 'object' ? (value as JsonValue) : undefined;
  } catch {
    return undefined;
  }
}

function nodeForDescriptor(
  descriptor: ToolDescriptor,
  path: ToolCommandPath,
  includeLeaf = true,
): ToolCommandNode {
  const inputSchema = descriptor.inputSchema ?? schemaValue(descriptor.argsSchema.describe);
  const outputSchema = descriptor.outputSchema ?? schemaValue(descriptor.resultSchema.describe);
  const node: ToolCommandNode = {
    name: path[path.length - 1] as string,
    path: pathKey(path),
    summary: descriptor.summary,
  };
  if (includeLeaf) {
    return {
      ...node,
      leaf: {
        title: descriptor.title,
        realm: descriptor.realm,
        ...(inputSchema === undefined
          ? descriptor.argsSchema.describe === undefined
            ? {}
            : { inputDescription: descriptor.argsSchema.describe }
          : { inputSchema }),
        ...(outputSchema === undefined
          ? descriptor.resultSchema.describe === undefined
            ? {}
            : { outputDescription: descriptor.resultSchema.describe }
          : { outputSchema }),
        capabilities: [...(descriptor.capabilities ?? [])],
        errors: [...(descriptor.errors ?? [])],
        ...(descriptor.example === undefined ? {} : { example: descriptor.example }),
      },
    };
  }
  return node;
}

interface Registered {
  readonly path: readonly string[];
  readonly contribution: ToolContribution;
}

function compareRegistered(left: Registered, right: Registered): number {
  return pathKey(left.path).localeCompare(pathKey(right.path));
}

function hasPrefix(left: ToolCommandPath, right: ToolCommandPath): boolean {
  return left.length < right.length && left.every((segment, index) => segment === right[index]);
}

function findNode(
  registered: readonly Registered[],
  path: ToolCommandPath,
): Registered | undefined {
  return registered.find(
    (candidate) =>
      candidate.path.length === path.length &&
      candidate.path.every((segment, index) => segment === path[index]),
  );
}

function descendants(registered: readonly Registered[], path: ToolCommandPath): Registered[] {
  return registered.filter((candidate) => hasPrefix(path, candidate.path));
}

function projectNodes(
  registered: readonly Registered[],
  path: ToolCommandPath,
  recursive: boolean,
): ToolCommandNode[] {
  const children = new Map<string, Registered | undefined>();
  for (const candidate of registered) {
    if (
      candidate.path.length <= path.length ||
      !path.every((segment, index) => candidate.path[index] === segment)
    )
      continue;
    const next = candidate.path[path.length] as string;
    const existing = children.get(next);
    if (
      existing === undefined ||
      candidate.path.length < (existing?.path.length ?? Number.MAX_SAFE_INTEGER)
    )
      children.set(next, candidate.path.length === path.length + 1 ? candidate : undefined);
  }
  return [...children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, exact]) => {
      const childPath = [...path, name];
      if (exact !== undefined)
        return nodeForDescriptor(exact.contribution.descriptor, childPath, false);
      const node: ToolCommandNode = {
        name,
        path: pathKey(childPath),
        summary: descendants(registered, childPath)[0]?.contribution.descriptor.summary ?? '',
      };
      if (recursive) return { ...node, children: projectNodes(registered, childPath, true) };
      return node;
    });
}

export function commandPath(descriptor: ToolDescriptor): ToolCommandPath {
  return descriptorPath(descriptor);
}

export function defineCommand<TArgs, TResult>(
  descriptor: Omit<ToolCommandDescriptor<TArgs, TResult>, 'id'> & { readonly id?: string },
  execute: ToolExecutor<TArgs, TResult>,
): ToolContribution<TArgs, TResult> {
  const path = descriptorPath(descriptor as ToolDescriptor);
  return {
    descriptor: {
      ...descriptor,
      id: descriptor.id ?? path.join('.'),
      path,
    },
    execute,
  } as ToolContribution<TArgs, TResult>;
}

export function createToolCommandRegistry(
  contributions: readonly ToolContribution[],
): ToolCommandRegistry {
  const registered: Registered[] = [];
  const byPath = new Map<string, ToolContribution>();
  for (const contribution of contributions) {
    const path = descriptorPath(contribution.descriptor);
    const key = pathKey(path);
    if (
      byPath.has(key) ||
      registered.some(
        (candidate) => hasPrefix(candidate.path, path) || hasPrefix(path, candidate.path),
      )
    ) {
      throw new ToolCommandError(
        'tool-command-conflict',
        key,
        'command paths cannot collide with a leaf or its descendants',
        { path: key },
      );
    }
    byPath.set(key, contribution);
    registered.push({ path, contribution });
  }
  registered.sort(compareRegistered);
  const runtime = createToolRuntime(registered.map((entry) => entry.contribution));
  const find = (pathInput: ToolCommandPath | string): Registered | undefined => {
    const path = normalizePath(pathInput);
    return findNode(registered, path);
  };
  const help = (pathInput?: ToolCommandPath | string, recursive = false): ToolCommandHelp => {
    const path = pathInput === undefined ? [] : normalizePath(pathInput);
    const exact = path.length === 0 ? undefined : findNode(registered, path);
    const descendant = path.length === 0 ? registered : descendants(registered, path);
    if (path.length > 0 && exact === undefined && descendant.length === 0) {
      let parent = path.slice(0, -1);
      while (parent.length > 0 && descendants(registered, parent).length === 0)
        parent = parent.slice(0, -1);
      throw new ToolCommandError(
        'tool-command-not-found',
        pathKey(path),
        'command path was not found',
        {
          parent: pathKey(parent),
          candidates: projectNodes(registered, parent, false).map((node) => node.name),
        },
      );
    }
    const leaf =
      exact === undefined ? undefined : nodeForDescriptor(exact.contribution.descriptor, path).leaf;
    const summary = exact?.contribution.descriptor.summary;
    return {
      path: pathKey(path),
      ...(summary === undefined ? {} : { summary }),
      nodes: projectNodes(registered, path, recursive || exact !== undefined),
      ...(leaf === undefined ? {} : { leaf }),
    };
  };
  return {
    contributions: registered.map((entry) => entry.contribution),
    list: (path = []) => projectNodes(registered, path, false),
    tree: (path: ToolCommandPath | string = []) =>
      projectNodes(registered, normalizePath(path), true),
    describe: (pathInput) =>
      find(pathInput)?.contribution.descriptor as ToolCommandDescriptor | undefined,
    help,
    get: (pathInput) => find(pathInput)?.contribution,
    run: <TResult = unknown>(
      pathInput: ToolCommandPath | string,
      args: unknown,
      options?: ToolRunOptions,
    ): ToolRun<TResult> | undefined => {
      const contribution = find(pathInput)?.contribution;
      if (contribution === undefined) return undefined;
      return runtime.run(contribution, args, options) as ToolRun<TResult>;
    },
  };
}
