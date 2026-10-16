import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHostStartup } from '@forgeax/engine-host';
import { createToolApiPlugin } from '@forgeax/engine-plugin';
import {
  type ArtifactRef,
  parseToolJsonSchema,
  type ToolJsonSchema,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { createDevkitCliStartup } from './cli-host.js';

export interface UnifiedCliResult {
  readonly ok: boolean;
  readonly command?: string;
  readonly value?: unknown;
  /** Evidence refs remain discoverable even when a command fails. */
  readonly artifacts?: readonly ArtifactRef[];
  readonly error?: {
    readonly code: string;
    readonly expected?: string;
    readonly hint?: string;
    readonly detail?: unknown;
  };
}

interface ParsedCli {
  readonly path: readonly string[];
  readonly positionals: readonly string[];
  readonly root: string;
  readonly json: boolean;
  readonly tree: boolean;
  readonly helpRequested: boolean;
  readonly input?: unknown;
  readonly args: Record<string, unknown>;
}

function flagKey(value: string): string {
  return value.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function parseInput(raw: string, root: string): unknown {
  let source = raw === '-' ? readFileSync(0, 'utf8') : raw;
  try {
    if (raw !== '-') return JSON.parse(source) as unknown;
  } catch {
    source = readFileSync(resolve(root, raw), 'utf8');
  }
  if (source.trim().length === 0) throw new Error('JSON input is empty');
  return JSON.parse(source) as unknown;
}

function parseArgs(argv: readonly string[]): ParsedCli {
  const path: string[] = [];
  const args: Record<string, unknown> = {};
  let root = process.cwd();
  let json = false;
  let tree = false;
  let input: unknown;
  let inputRaw: string | undefined;
  let inputSeen = false;
  let flagsSeen = false;
  const helpRequested = argv[0] === 'help';
  const tokens = helpRequested ? argv.slice(1) : argv;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const value = equals < 0 ? token : token.slice(0, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    if (value === '-h') {
      args.help = true;
      continue;
    }
    if (!value.startsWith('--')) {
      path.push(value);
      continue;
    }
    if (value === '--json' || value === '--tree' || value === '--help') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') {
        throw new Error(`${value} expects true or false`);
      }
      const enabled = inline !== 'false';
      if (value === '--json') json = enabled;
      else if (value === '--tree') tree = enabled;
      else args.help = enabled;
      continue;
    }
    if (helpRequested && value !== '--root' && value !== '--input') {
      throw new Error(`unknown help flag ${value}`);
    }
    const key = flagKey(value);
    const next = inline ?? tokens[index + 1];
    if (next === undefined || (inline === undefined && next.startsWith('--'))) {
      if (value === '--root' || value === '--input') throw new Error(`${value} requires a value`);
      args[key] = true;
      flagsSeen = true;
      continue;
    }
    if (inline === undefined) index += 1;
    if (value === '--root') root = next;
    else if (value === '--input') {
      inputRaw = next;
      inputSeen = true;
    } else {
      args[key] = next;
      flagsSeen = true;
    }
  }
  if (inputSeen && flagsSeen) {
    throw new Error('--input cannot be combined with named command flags');
  }
  if (inputRaw !== undefined) input = parseInput(inputRaw, root);
  return {
    path,
    positionals: [],
    root,
    json,
    tree,
    helpRequested,
    ...(inputSeen ? { input } : {}),
    args,
  };
}

function errorResult(error: unknown, command?: string): UnifiedCliResult {
  if (error !== null && typeof error === 'object') {
    const candidate = error as {
      readonly code?: unknown;
      readonly detail?: unknown;
      readonly message?: unknown;
    };
    if (typeof candidate.code === 'string' && candidate.code.startsWith('tool-command-')) {
      return {
        ok: false,
        ...(command === undefined ? {} : { command }),
        error: {
          code: candidate.code,
          expected: 'the requested command path to be present in the assembled command tree',
          hint:
            typeof candidate.message === 'string'
              ? candidate.message
              : 'Inspect help for the valid parent paths.',
          ...(candidate.detail === undefined ? {} : { detail: candidate.detail }),
        },
      };
    }
  }
  return {
    ok: false,
    ...(command === undefined ? {} : { command }),
    error: {
      code: 'cli-parse-error',
      expected: 'a valid command path and input object',
      hint: error instanceof Error ? error.message : String(error),
      detail: { message: error instanceof Error ? error.message : String(error) },
    },
  };
}

function coerceNamedArgs(
  args: Record<string, unknown>,
  schema: ToolJsonSchema | undefined,
): Record<string, unknown> {
  if (schema === undefined || schema.type !== 'object') return args;
  const properties = schema.properties ?? {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const property = properties[key];
    if (property === undefined)
      throw new Error(
        `unknown command flag --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      );
    if (typeof value !== 'string') {
      output[key] = value;
      continue;
    }
    if (
      value === 'null' &&
      (property.type === 'null' || (Array.isArray(property.type) && property.type.includes('null')))
    ) {
      output[key] = null;
      continue;
    }
    if (property.type === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`--${key} expects true or false`);
      output[key] = value === 'true';
    } else if (property.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`--${key} expects a number`);
      output[key] = parsed;
    } else if (property.type === 'integer') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error(`--${key} expects an integer`);
      output[key] = parsed;
    } else if (property.type === 'array' || property.type === 'object') {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (property.type === 'array' && !Array.isArray(parsed))
          throw new Error(`--${key} expects a JSON array`);
        if (
          property.type === 'object' &&
          (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        )
          throw new Error(`--${key} expects a JSON object`);
        output[key] = parsed;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('--')) throw error;
        throw new Error(`--${key} expects JSON`);
      }
    } else {
      output[key] = value;
    }
  }
  return output;
}

function strictInputSchema(schema: ToolJsonSchema | undefined): ToolJsonSchema | undefined {
  if (schema === undefined) return undefined;
  if (
    schema.type !== 'object' ||
    schema.properties === undefined ||
    schema.additionalProperties !== undefined
  ) {
    return schema;
  }
  return { ...schema, additionalProperties: false };
}

export async function runUnifiedCli(argv: readonly string[]): Promise<UnifiedCliResult> {
  let startup: Awaited<ReturnType<typeof createHostStartup>> | undefined;
  let cli: ReturnType<typeof createDevkitCliStartup> | undefined;
  let rawCommand = '';
  try {
    // Select the project before Host startup so an external --root creates one
    // Host for that target. A malformed request still starts the default Host
    // before returning its parse failure; discovery and dispatch remain behind
    // the Host lifecycle.
    let parsedResult:
      | { readonly ok: true; readonly value: ParsedCli }
      | { readonly ok: false; readonly error: unknown };
    try {
      parsedResult = { ok: true, value: parseArgs(argv) };
    } catch (error) {
      parsedResult = { ok: false, error };
    }
    cli = createDevkitCliStartup(parsedResult.ok ? parsedResult.value.root : process.cwd());
    startup = await createHostStartup({ startupPlugins: [createToolApiPlugin(), cli.plugin] });
    if (!parsedResult.ok) throw parsedResult.error;
    const parsed = parsedResult.value;
    rawCommand = parsed.path.join(' ');
    const client = await cli.service.ready();
    let commandPath = parsed.path;
    let positionals = parsed.positionals;
    if (parsed.helpRequested) {
      return {
        ok: true,
        command: rawCommand || 'help',
        value: client.help(parsed.path, parsed.tree),
      };
    }
    if (parsed.path.length > 0) {
      for (let length = parsed.path.length; length > 0; length -= 1) {
        const candidate = parsed.path.slice(0, length);
        try {
          const candidateHelp = client.help(candidate);
          const remaining = [...parsed.path.slice(length), ...parsed.positionals];
          if (remaining.length > 0 && candidateHelp.leaf === undefined) {
            throw new Error(
              `unknown command path after ${candidate.join(' ')}: ${remaining.join(' ')}`,
            );
          }
          commandPath = candidate;
          positionals = remaining;
          break;
        } catch {
          // The longest valid prefix is the command; remaining values are inputs.
        }
      }
    }
    const command = commandPath.join(' ');
    if (commandPath.length === 0 || parsed.args.help === true) {
      return { ok: true, command: command || 'help', value: client.help(commandPath, parsed.tree) };
    }
    const help = client.help(commandPath, false);
    if (help.leaf === undefined) {
      return { ok: true, command, value: client.help(commandPath, parsed.tree) };
    }
    const effectiveSchema = strictInputSchema(help.leaf?.inputSchema as ToolJsonSchema | undefined);
    const positional = positionalArgs(command, parsed.args, positionals);
    // The global selector remains an argument only for commands declaring it.
    // Project plugins must receive the same selected root as built-in commands.
    const namedArgs =
      effectiveSchema?.properties?.root === undefined
        ? positional
        : { ...positional, root: positional.root ?? resolve(parsed.root) };
    const rawArgs: unknown = parsed.input ?? namedArgs;
    const args = parsed.input === undefined ? coerceNamedArgs(namedArgs, effectiveSchema) : rawArgs;
    // Global output policy reaches only owners that declare it, including --input calls.
    if (
      effectiveSchema?.properties?.json !== undefined &&
      args !== null &&
      typeof args === 'object' &&
      !Array.isArray(args)
    ) {
      Object.assign(args, { json: parsed.json });
    }
    const schema = effectiveSchema;
    if (schema !== undefined) {
      const checked = parseToolJsonSchema(args, schema);
      if (!checked.ok) throw new Error(checked.error);
    }
    const terminal = await client.runPath(command, args);
    return terminalResult(command, terminal);
  } catch (error) {
    return errorResult(error, rawCommand);
  } finally {
    await startup?.dispose();
  }
}

function positionalArgs(
  command: string,
  flags: Record<string, unknown>,
  positionals: readonly string[],
): Record<string, unknown> {
  const args = { ...flags };
  const positionalName =
    command === 'asset import'
      ? 'path'
      : command === 'asset inspect' || command === 'asset resolve'
        ? 'subject'
        : command === 'project new' || command === 'sdk install'
          ? 'root'
          : command === 'project engine use-local'
            ? 'path'
            : undefined;
  if (positionalName === undefined) {
    if (positionals.length > 0) {
      throw new Error(`unexpected positional argument for ${command}: ${positionals[0]}`);
    }
    return args;
  }
  if (positionals.length > 1) {
    throw new Error(
      `too many positional arguments for ${command}: ${positionals.slice(1).join(' ')}`,
    );
  }
  const first = positionals[0];
  if (first !== undefined) args[positionalName] = first;
  return args;
}

function terminalResult(command: string, terminal: ToolTerminal<unknown>): UnifiedCliResult {
  if (terminal.outcome === 'succeeded') {
    return { ok: true, command, value: terminal.result, artifacts: terminal.artifacts };
  }
  return {
    ok: false,
    command,
    artifacts: terminal.artifacts,
    error: {
      code:
        terminal.failure.code === 'tool-domain-failed'
          ? terminal.failure.detail.code
          : terminal.failure.code,
      expected: terminal.failure.expected,
      hint: terminal.failure.hint,
      detail:
        terminal.failure.code === 'tool-domain-failed'
          ? terminal.failure.detail.payload
          : terminal.failure.detail,
    },
  };
}
