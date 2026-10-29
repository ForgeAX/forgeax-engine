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
import { compactCliResult } from './cli-presentation.js';

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
  /** Compact presentation only: value fields left out, restored by `flag`. */
  readonly omitted?: { readonly fields: readonly string[]; readonly flag: '--detail' };
}

export interface UnifiedCliOptions {
  /**
   * `full` (default) returns owner values unchanged. `compact` is the `forgeax`
   * process presentation: it bounds large values unless the call passes `--detail`.
   */
  readonly presentation?: 'full' | 'compact';
}

interface ParsedCli {
  readonly path: readonly string[];
  readonly positionals: readonly string[];
  readonly root: string;
  readonly json: boolean;
  readonly tree: boolean;
  readonly detail: boolean;
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

interface CliParseState {
  readonly path: string[];
  readonly args: Record<string, unknown>;
  root: string;
  json: boolean;
  tree: boolean;
  detail: boolean;
  inputRaw: string | undefined;
  inputSeen: boolean;
  flagsSeen: boolean;
}

const CLI_BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['--json', '--tree', '--detail', '--help']);

/** `--name=value` splits at the first `=`; other tokens carry no inline value. */
function splitCliToken(token: string): { readonly flag: string; readonly inline?: string } {
  const equals = token.startsWith('--') ? token.indexOf('=') : -1;
  return equals < 0
    ? { flag: token }
    : { flag: token.slice(0, equals), inline: token.slice(equals + 1) };
}

function applyBooleanFlag(state: CliParseState, flag: string, inline: string | undefined): void {
  if (inline !== undefined && inline !== 'true' && inline !== 'false') {
    throw new Error(`${flag} expects true or false`);
  }
  const enabled = inline !== 'false';
  if (flag === '--json') state.json = enabled;
  else if (flag === '--tree') state.tree = enabled;
  else if (flag === '--detail') state.detail = enabled;
  else state.args.help = enabled;
}

/** Applies one valued flag and returns how many following tokens it consumed. */
function applyValueFlag(
  state: CliParseState,
  flag: string,
  inline: string | undefined,
  following: string | undefined,
): number {
  const key = flagKey(flag);
  const next = inline ?? following;
  if (next === undefined || (inline === undefined && next.startsWith('--'))) {
    if (flag === '--root' || flag === '--input') throw new Error(`${flag} requires a value`);
    state.args[key] = true;
    state.flagsSeen = true;
    return 0;
  }
  if (flag === '--root') state.root = next;
  else if (flag === '--input') {
    state.inputRaw = next;
    state.inputSeen = true;
  } else {
    state.args[key] = next;
    state.flagsSeen = true;
  }
  return inline === undefined ? 1 : 0;
}

/** Consumes the token at `index`; returns how many following tokens it also consumed. */
function applyCliToken(
  state: CliParseState,
  tokens: readonly string[],
  index: number,
  helpRequested: boolean,
): number {
  const { flag, inline } = splitCliToken(tokens[index] as string);
  if (flag === '-h') {
    state.args.help = true;
    return 0;
  }
  if (!flag.startsWith('--')) {
    state.path.push(flag);
    return 0;
  }
  if (CLI_BOOLEAN_FLAGS.has(flag)) {
    applyBooleanFlag(state, flag, inline);
    return 0;
  }
  if (helpRequested && flag !== '--root' && flag !== '--input') {
    throw new Error(`unknown help flag ${flag}`);
  }
  return applyValueFlag(state, flag, inline, tokens[index + 1]);
}

function parseArgs(argv: readonly string[]): ParsedCli {
  const state: CliParseState = {
    path: [],
    args: {},
    root: process.cwd(),
    json: false,
    tree: false,
    detail: false,
    inputRaw: undefined,
    inputSeen: false,
    flagsSeen: false,
  };
  const helpRequested = argv[0] === 'help';
  const tokens = helpRequested ? argv.slice(1) : argv;
  for (let index = 0; index < tokens.length; index += 1)
    index += applyCliToken(state, tokens, index, helpRequested);
  if (state.inputSeen && state.flagsSeen) {
    throw new Error('--input cannot be combined with named command flags');
  }
  const input = state.inputRaw === undefined ? undefined : parseInput(state.inputRaw, state.root);
  return {
    path: state.path,
    positionals: [],
    root: state.root,
    json: state.json,
    tree: state.tree,
    detail: state.detail,
    helpRequested,
    ...(state.inputSeen ? { input } : {}),
    args: state.args,
  };
}

function errorResult(error: unknown, command?: string): UnifiedCliResult {
  if (error !== null && typeof error === 'object') {
    const candidate = error as {
      readonly code?: unknown;
      readonly detail?: unknown;
      readonly message?: unknown;
      readonly expected?: unknown;
      readonly hint?: unknown;
    };
    if (candidate.code === 'operation-history-write-failed') {
      return {
        ok: false,
        ...(command === undefined ? {} : { command }),
        error: {
          code: candidate.code,
          expected: String(candidate.expected),
          hint: String(candidate.hint),
          detail: candidate.detail,
        },
      };
    }
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

export async function runUnifiedCli(
  argv: readonly string[],
  options: UnifiedCliOptions = {},
): Promise<UnifiedCliResult> {
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
    const present = (result: UnifiedCliResult, args?: unknown): UnifiedCliResult =>
      options.presentation === 'compact' && !parsed.detail
        ? compactCliResult(result, { root: parsed.root, args, tree: parsed.tree })
        : result;
    rawCommand = parsed.path.join(' ');
    const client = await cli.service.ready();
    let commandPath = parsed.path;
    let positionals = parsed.positionals;
    if (parsed.helpRequested) {
      return present({
        ok: true,
        command: rawCommand || 'help',
        value: client.help(parsed.path, parsed.tree),
      });
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
      return present({
        ok: true,
        command: command || 'help',
        value: client.help(commandPath, parsed.tree),
      });
    }
    const help = client.help(commandPath, false);
    if (help.leaf === undefined) {
      return present({ ok: true, command, value: client.help(commandPath, parsed.tree) });
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
    return present(terminalResult(command, terminal), args);
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
          : command === 'project play'
            ? 'script'
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
