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
import { ignoreProjectState } from './project-state-ignore.js';
import { discoverRhiDebugOperations } from './rhi-debug/operations.js';
import type { ToolClient } from './tools/client.js';

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
  readonly root: string;
  readonly json: boolean;
  readonly tree: boolean;
  readonly detail: boolean;
  readonly helpRequested: boolean;
  readonly input?: unknown;
  readonly args: Record<string, unknown>;
}

type ParsedCliResult =
  | { readonly ok: true; readonly value: ParsedCli }
  | { readonly ok: false; readonly error: unknown };

/** Exact built-in owner controls do not consume project command contracts. */
function ownerControlDiscovery(
  parsed: ParsedCliResult,
): Parameters<typeof createDevkitCliStartup>[1] {
  return parsed.ok &&
    !parsed.value.helpRequested &&
    parsed.value.args.help !== true &&
    parsed.value.path.length === 2 &&
    ((parsed.value.path[0] === 'backend' &&
      ['start', 'status', 'stop'].includes(parsed.value.path[1] ?? '')) ||
      (parsed.value.path[0] === 'dev' &&
        ['start', 'status', 'stop', 'reload'].includes(parsed.value.path[1] ?? '')))
    ? async () => []
    : undefined;
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
  if (flag === '--root') {
    state.root = next;
  } else if (flag === '--input') {
    state.inputRaw = next;
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
    // `help "project preview"` names the same path as `help project preview`; outside
    // help a token may be a positional value, so it stays whole.
    if (helpRequested) state.path.push(...flag.split(/\s+/).filter((part) => part !== ''));
    else state.path.push(flag);
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
    flagsSeen: false,
  };
  const helpRequested = argv[0] === 'help';
  const tokens = helpRequested ? argv.slice(1) : argv;
  for (let index = 0; index < tokens.length; index += 1)
    index += applyCliToken(state, tokens, index, helpRequested);
  if (state.inputRaw !== undefined && state.flagsSeen) {
    throw new Error('--input cannot be combined with named command flags');
  }
  const input = state.inputRaw === undefined ? undefined : parseInput(state.inputRaw, state.root);
  return {
    path: state.path,
    root: state.root,
    json: state.json,
    tree: state.tree,
    detail: state.detail,
    helpRequested,
    ...(state.inputRaw === undefined ? {} : { input }),
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
    } else if (property.type === 'number' || property.type === 'integer') {
      const number = Number(value);
      const valid =
        property.type === 'number' ? Number.isFinite(number) : Number.isSafeInteger(number);
      if (!valid)
        throw new Error(
          `--${key} expects ${property.type === 'number' ? 'a number' : 'an integer'}`,
        );
      output[key] = number;
    } else if (property.type === 'array' || property.type === 'object') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`--${key} expects JSON`);
      }
      const array = Array.isArray(parsed);
      if (property.type === 'array' && !array) throw new Error(`--${key} expects a JSON array`);
      if (property.type === 'object' && (parsed === null || typeof parsed !== 'object' || array))
        throw new Error(`--${key} expects a JSON object`);
      output[key] = parsed;
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
  let projectRoot: string | undefined;
  try {
    // Select the project before Host startup so an external --root creates one
    // Host for that target. A malformed request still starts the default Host
    // before returning its parse failure; discovery and dispatch remain behind
    // the Host lifecycle.
    let parsedResult: ParsedCliResult;
    try {
      parsedResult = { ok: true, value: parseArgs(argv) };
    } catch (error) {
      parsedResult = { ok: false, error };
    }
    // The serving owner validates its project during start/reload. The command
    // client only dispatches that operation; inventory here duplicates its scan
    // and retains an unrelated snapshot throughout startup. Recovery controls
    // also remain usable with broken project/Host Packs. Help and extension
    // paths retain ordinary discovery.
    cli = createDevkitCliStartup(
      parsedResult.ok ? parsedResult.value.root : process.cwd(),
      ownerControlDiscovery(parsedResult),
    );
    startup = await createHostStartup({ startupPlugins: [createToolApiPlugin(), cli.plugin] });
    if (!parsedResult.ok) throw parsedResult.error;
    const parsed = parsedResult.value;
    projectRoot = parsed.root;
    const present = (result: UnifiedCliResult, args?: unknown): UnifiedCliResult =>
      options.presentation === 'compact' && !parsed.detail
        ? compactCliResult(result, { root: parsed.root, args, tree: parsed.tree })
        : result;
    rawCommand = parsed.path.join(' ');
    const client = await cli.service.ready();
    if (parsed.helpRequested) {
      return present({
        ok: true,
        command: rawCommand || 'help',
        value: client.help(parsed.path, parsed.tree),
      });
    }
    const { path: commandPath, leaf } = resolveInvocation(client, parsed.path);
    const command = commandPath.join(' ');
    if (leaf === undefined || parsed.args.help === true) {
      return present({
        ok: true,
        command: command || 'help',
        value: client.help(commandPath, parsed.tree),
      });
    }
    const effectiveSchema = strictInputSchema(leaf.inputSchema as ToolJsonSchema | undefined);
    const positional = positionalArgs(command, parsed.args, parsed.path.slice(commandPath.length));
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
    // Commands create `.forgeax/` on demand; keep it out of git whichever made it.
    await ignoreProjectState(projectRoot);
  }
}

/** The longest command prefix owns the remaining positional inputs. */
function resolveInvocation(client: ToolClient, tokens: readonly string[]) {
  for (let length = tokens.length; length > 0; length--) {
    const path = tokens.slice(0, length);
    try {
      const { leaf } = client.help(path);
      if (leaf !== undefined || length === tokens.length) return { path, leaf };
    } catch {
      // Shorten a path with positional arguments before reporting an unknown command.
    }
  }
  return { path: tokens, leaf: undefined };
}

/** Positional aliases published by the CLI; named inputs still use each command schema. */
const positionalNames = new Map<string, readonly string[]>([
  ['asset guid', ['packageId', 'key']],
  ['asset import', ['path']],
  ['asset inspect', ['subject']],
  ['asset resolve', ['subject']],
  ['project new', ['root']],
  ['sdk install', ['root']],
  ['project play', ['script']],
  ['project engine use-local', ['path']],
  ...discoverRhiDebugOperations()
    .filter(({ inputSchema }) => inputSchema.required?.includes('artifact'))
    .map(({ name }) => [name.replace('.', ' '), ['artifact']] as const),
]);

function positionalArgs(
  command: string,
  flags: Record<string, unknown>,
  positionals: readonly string[],
): Record<string, unknown> {
  const args = { ...flags };
  const names = positionalNames.get(command) ?? [];
  if (positionals.length > names.length) {
    throw new Error(
      names.length === 0
        ? `unexpected positional argument for ${command}: ${positionals[0]}`
        : `too many positional arguments for ${command}: ${positionals.slice(names.length).join(' ')}`,
    );
  }
  for (const [index, value] of positionals.entries()) {
    const name = names[index];
    if (name !== undefined) args[name] = value;
  }
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
