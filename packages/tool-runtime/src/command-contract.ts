import { type ToolJsonSchema, toolJsonSchema } from './json-schema.js';
import type { ToolContribution, ToolDescriptor, ToolEvidenceKind, ToolExecutor } from './types.js';
import { TOOL_REALMS } from './types.js';

export interface ToolCommandDeclaration
  extends Pick<ToolDescriptor, 'id' | 'path' | 'title' | 'summary' | 'realm'> {
  readonly argsSchema?: string;
  readonly resultSchema?: string;
  readonly evidence?: readonly ToolEvidenceKind[];
  readonly executor?: string;
  readonly exportName?: string;
}
export interface ToolCommandContract {
  readonly schemaVersion: '1.0.0';
  readonly commands: readonly ToolCommandDeclaration[];
}
export function defineToolCommandContract(
  commands: readonly ToolCommandDeclaration[],
): ToolCommandContract {
  const value = { schemaVersion: '1.0.0' as const, commands: [...commands] };
  if (!isToolCommandContract(value))
    throw new TypeError('invalid or duplicate tool command declaration');
  return value;
}
function jsonTree(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (
    typeof value !== 'object' ||
    ancestors.has(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Array.isArray(value) &&
    (Object.keys(value).length !== value.length ||
      Object.keys(value).some((key, index) => key !== String(index)))
  )
    return false;
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      !jsonTree(descriptor.value, ancestors)
    )
      return false;
  }
  ancestors.delete(value);
  return true;
}
export function isToolCommandContract(value: unknown): value is ToolCommandContract {
  if (!jsonTree(value) || value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const contract = value as Partial<ToolCommandContract>;
  if (
    Object.keys(contract).some((key) => !['schemaVersion', 'commands'].includes(key)) ||
    contract.schemaVersion !== '1.0.0' ||
    !Array.isArray(contract.commands)
  )
    return false;
  const ids = new Set<string>(),
    paths = new Set<string>();
  return contract.commands.every((command: ToolCommandDeclaration) => {
    if (
      command === null ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      Object.keys(command).some(
        (key) =>
          ![
            'id',
            'path',
            'title',
            'summary',
            'realm',
            'argsSchema',
            'resultSchema',
            'evidence',
            'executor',
            'exportName',
          ].includes(key),
      ) ||
      typeof command.id !== 'string' ||
      !command.id.trim() ||
      ids.has(command.id) ||
      typeof command.title !== 'string' ||
      !command.title.trim() ||
      typeof command.summary !== 'string' ||
      !TOOL_REALMS.includes(command.realm)
    )
      return false;
    const path = command.path ?? command.id.split('.');
    if (
      !Array.isArray(path) ||
      !path.length ||
      path.some((part) => typeof part !== 'string' || !part.trim()) ||
      paths.has(path.join(' '))
    )
      return false;
    ids.add(command.id);
    paths.add(path.join(' '));
    if (
      command.evidence !== undefined &&
      (!Array.isArray(command.evidence) ||
        command.evidence.some((kind) => !['rhi-tape', 'profile-capture', 'png'].includes(kind)))
    )
      return false;
    if (
      (command.executor !== undefined &&
        (typeof command.executor !== 'string' || !command.executor.trim())) ||
      (command.exportName !== undefined &&
        (typeof command.exportName !== 'string' || !command.exportName.trim() || !command.executor))
    )
      return false;
    try {
      for (const value of [command.argsSchema, command.resultSchema]) {
        if (value !== undefined && (typeof value !== 'string' || !jsonTree(schema(value))))
          return false;
      }
    } catch {
      return false;
    }
    return true;
  });
}

function schema(value: string | undefined): ToolJsonSchema | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new TypeError('tool schema must be a JSON object');
  return parsed;
}
/** One descriptor projection for discovery and delivered native registration. */
export function commandContribution(
  declaration: ToolCommandDeclaration,
  load?: () => Promise<ToolExecutor<unknown, unknown>>,
): ToolContribution<unknown, unknown> {
  const input = schema(declaration.argsSchema);
  const output = schema(declaration.resultSchema);
  return {
    descriptor: {
      id: declaration.id,
      title: declaration.title,
      summary: declaration.summary,
      realm: declaration.realm,
      ...(declaration.path ? { path: declaration.path } : {}),
      argsSchema: toolJsonSchema(input ?? {}),
      resultSchema: toolJsonSchema(output ?? {}),
      evidence: declaration.evidence ?? [],
      capabilities: [],
      errors: ['tool-capability-unavailable'],
    },
    execute: async (args, context) => {
      if (!load)
        return {
          ok: false,
          error: {
            code: 'tool-capability-unavailable',
            expected: 'a delivered executor registered by an active native provider',
            hint: 'build and activate the owning plugin asset',
            detail: { capability: declaration.id, realm: declaration.realm },
          },
        };
      return (await load())(args, context);
    },
  };
}
