import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProfileComparisonError } from './compare.js';
import { compareProfileCaptures } from './compare.js';
import type { ProfileModel } from './model.js';
import { buildProfileModel } from './model.js';
import type { ProfileSource } from './types.js';

export interface ProfilerCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type CliArguments =
  | ({ readonly filePath?: string } & (
      | { readonly kind: 'summary' }
      | { readonly kind: 'frame'; readonly frameId: number }
      | { readonly kind: 'phase'; readonly source: ProfileSource; readonly phase: string }
    ))
  | { readonly kind: 'compare'; readonly leftFilePath: string; readonly rightFilePath: string };

type CompareArtifactSide = ProfileComparisonError['detail']['side'];

type CliError = {
  readonly code:
    | 'cli-arguments-invalid'
    | 'cli-input-empty'
    | 'cli-input-file-read-failed'
    | 'cli-input-invalid-json'
    | 'cli-query-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly argument?: string;
    readonly path?: string;
    readonly side?: CompareArtifactSide;
    readonly message: string;
  };
};

function output(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parsePositiveSafeInteger(value: string, argument: string): number | CliError {
  const parsed = /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      code: 'cli-query-invalid',
      expected: `${argument} is a positive safe integer`,
      hint: `Pass a positive safe integer to ${argument}.`,
      detail: { argument, message: `received ${value}` },
    };
  }
  return parsed;
}

type ParseState = {
  kind: CliArguments['kind'];
  frameId: number | undefined;
  source: ProfileSource | undefined;
  phase: string | undefined;
  filePath: string | undefined;
  leftFilePath: string | undefined;
  rightFilePath: string | undefined;
};

function consumeFlag(
  state: ParseState,
  argument: string,
  value: string | undefined,
): CliError | undefined {
  if (value === undefined || value.startsWith('--')) {
    return {
      code: 'cli-arguments-invalid',
      expected: `${argument} is followed by a value`,
      hint: `Provide a value after ${argument}.`,
      detail: { argument, message: 'missing argument value' },
    };
  }
  if (argument === '--file') state.filePath = value;
  if (argument === '--left-file') state.leftFilePath = value;
  if (argument === '--right-file') state.rightFilePath = value;
  if (argument === '--frame-id') {
    const parsed = parsePositiveSafeInteger(value, argument);
    if (typeof parsed !== 'number') return parsed;
    state.frameId = parsed;
  }
  if (argument === '--source') {
    if (value !== 'app' && value !== 'render') {
      return {
        code: 'cli-arguments-invalid',
        expected: '--source is app or render',
        hint: 'Pass app or render as the phase source.',
        detail: { argument, message: `received ${value}` },
      };
    }
    state.source = value;
  }
  if (argument === '--phase') state.phase = value;
  return undefined;
}

function selectQuery(state: ParseState): CliArguments | CliError {
  const { kind, filePath, leftFilePath, rightFilePath, frameId, source, phase } = state;
  const hasPhase = source !== undefined || phase !== undefined;
  if (kind === 'compare') {
    if (
      leftFilePath === undefined ||
      rightFilePath === undefined ||
      filePath !== undefined ||
      frameId !== undefined ||
      hasPhase
    ) {
      return {
        code: 'cli-arguments-invalid',
        expected: 'compare requires --left-file and --right-file and no single-artifact selectors',
        hint: 'Pass compare --left-file <path> --right-file <path>.',
        detail: { message: 'invalid compare input selectors' },
      };
    }
    return { kind, leftFilePath, rightFilePath };
  }
  if (leftFilePath !== undefined || rightFilePath !== undefined) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'compare is the only command that accepts --left-file and --right-file',
      hint: 'Use compare --left-file <path> --right-file <path> for two artifacts.',
      detail: { message: 'compare file selectors used with another command' },
    };
  }
  const file = filePath === undefined ? {} : { filePath };
  if (kind === 'summary') {
    return frameId === undefined && !hasPhase
      ? { kind, ...file }
      : {
          code: 'cli-arguments-invalid',
          expected: 'summary has no frame or phase selectors',
          hint: 'Use frame or phase when selecting a lower-level projection.',
          detail: { message: 'summary received a lower-level selector' },
        };
  }
  if (kind === 'frame') {
    return frameId !== undefined && !hasPhase
      ? { kind, frameId, ...file }
      : {
          code: 'cli-arguments-invalid',
          expected: 'frame requires --frame-id and no phase selectors',
          hint: 'Pass frame --frame-id <positive-safe-integer>.',
          detail: { message: 'invalid frame selector' },
        };
  }
  return source !== undefined && phase !== undefined && frameId === undefined
    ? { kind, source, phase, ...file }
    : {
        code: 'cli-arguments-invalid',
        expected: 'phase requires --source and --phase and no frame selector',
        hint: 'Pass phase --source <app|render> --phase <name>.',
        detail: { message: 'invalid phase selector' },
      };
}

function parseState(kind: ParseState['kind'] = 'summary'): ParseState {
  return {
    kind,
    frameId: undefined,
    source: undefined,
    phase: undefined,
    filePath: undefined,
    leftFilePath: undefined,
    rightFilePath: undefined,
  };
}

function parseArguments(args: readonly string[]): CliArguments | CliError {
  const state = parseState();
  let index = 0;
  const first = args[0];
  if (first === 'summary' || first === 'frame' || first === 'phase' || first === 'compare') {
    state.kind = first;
    index = 1;
  } else if (first !== undefined && !first.startsWith('--')) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'command is summary, frame, phase, or compare',
      hint: 'Use summary, frame --frame-id <id>, phase --source <source> --phase <name>, or compare --left-file <path> --right-file <path>.',
      detail: { argument: first, message: 'unknown command' },
    };
  }
  while (index < args.length) {
    const argument = args[index] as string;
    if (
      !['--file', '--left-file', '--right-file', '--frame-id', '--source', '--phase'].includes(
        argument,
      )
    ) {
      return {
        code: 'cli-arguments-invalid',
        expected: 'all arguments are declared CLI flags',
        hint: 'Remove the unknown flag and use the documented summary, frame, phase, or compare form.',
        detail: { argument, message: 'unknown argument' },
      };
    }
    const error = consumeFlag(state, argument, args[index + 1]);
    if (error !== undefined) return error;
    index += 2;
  }
  return selectQuery(state);
}

function readArtifact(filePath: string | undefined, stdin: string): string | CliError {
  if (filePath !== undefined) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (error) {
      return {
        code: 'cli-input-file-read-failed',
        expected: 'the requested artifact file is readable',
        hint: 'Check the artifact path and permissions, or omit --file to read stdin.',
        detail: {
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (stdin.trim().length === 0) {
    return {
      code: 'cli-input-empty',
      expected: 'stdin contains one ProfileCapture JSON object',
      hint: 'Pipe a ProfileCapture artifact to stdin or pass --file <path>.',
      detail: { message: 'no artifact input was provided' },
    };
  }
  return stdin;
}

function withSide(side: CompareArtifactSide, error: CliError): CliError {
  return { ...error, detail: { ...error.detail, side } };
}

function readCompareArtifact(filePath: string, side: CompareArtifactSide): unknown | CliError {
  const input = readArtifact(filePath, '');
  if (typeof input !== 'string') return withSide(side, input);
  const artifact = parseArtifact(input);
  return isCliError(artifact) ? withSide(side, artifact) : artifact;
}

function parseArtifact(input: string): unknown | CliError {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    return {
      code: 'cli-input-invalid-json',
      expected: 'input is one JSON object',
      hint: 'Regenerate the artifact as JSON and retry.',
      detail: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function isCliError(value: unknown): value is CliError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.startsWith('cli-')
  );
}

function projectModel(
  command: Exclude<CliArguments, { readonly kind: 'compare' }>,
  model: ProfileModel,
): Record<string, unknown> {
  if (command.kind === 'summary') {
    return { query: 'summary', ...model.summary, phases: model.phases };
  }
  const { schemaVersion, captureId, timeUnit, completeness } = model.summary;
  const identity = { schemaVersion, captureId, timeUnit };
  if (command.kind === 'frame') {
    return {
      query: 'frame',
      ...identity,
      frameId: command.frameId,
      completeness,
      frame: model.frames.find((entry) => entry.frameId === command.frameId) ?? null,
    };
  }
  const phaseSummary = model.phases.find(
    (entry) => entry.source === command.source && entry.phase === command.phase,
  );
  return {
    query: 'phase',
    ...identity,
    source: command.source,
    phase: command.phase,
    completeness,
    phaseSummary: phaseSummary ?? null,
    children: model.phases.filter(
      (entry) => entry.parentSource === command.source && entry.parentPhase === command.phase,
    ),
  };
}

function queryFailure(exitCode: 1 | 2, error: CliError | ProfileComparisonError | ModelError) {
  return { ok: false as const, error, exitCode };
}

type ModelError = Extract<ReturnType<typeof buildProfileModel>, { ok: false }>['error'];

/** Run the CLI query without serializing the result for an in-process consumer. */
export function runProfilerQuery(args: readonly string[], stdin: string) {
  return executeQuery(parseArguments(args), stdin);
}

/** Use the profiler's selection and artifact rules from an in-process tool. */
export function runProfilerToolQuery(
  kind: CliArguments['kind'],
  input: Readonly<Record<string, unknown>>,
) {
  const state = parseState(kind);
  const fields =
    kind === 'compare'
      ? { '--left-file': input.leftFile, '--right-file': input.rightFile }
      : {
          '--file': input.artifact,
          ...(kind === 'frame' && typeof input.frameId === 'number'
            ? { '--frame-id': String(input.frameId) }
            : {}),
          ...(kind === 'phase' ? { '--source': input.source, '--phase': input.phase } : {}),
        };
  for (const [flag, value] of Object.entries(fields)) {
    if (typeof value !== 'string') continue;
    const error = consumeFlag(state, flag, value);
    if (error !== undefined) return queryFailure(2, error);
  }
  const args = selectQuery(state);
  const stdin =
    kind === 'compare' || state.filePath !== undefined
      ? ''
      : JSON.stringify(input.capture ?? input.artifact ?? input.input ?? input);
  return executeQuery(args, stdin);
}

function executeQuery(parsedArguments: CliArguments | CliError, stdin: string) {
  if ('code' in parsedArguments) return queryFailure(2, parsedArguments);
  if (parsedArguments.kind === 'compare') {
    const left = readCompareArtifact(parsedArguments.leftFilePath, 'left');
    if (isCliError(left)) return queryFailure(2, left);
    const right = readCompareArtifact(parsedArguments.rightFilePath, 'right');
    if (isCliError(right)) return queryFailure(2, right);
    const comparison = compareProfileCaptures(left, right);
    return comparison.ok
      ? { ok: true as const, value: { query: 'compare', ...comparison.value } }
      : queryFailure(1, comparison.error);
  }
  const input = readArtifact(parsedArguments.filePath, stdin);
  if (typeof input !== 'string') return queryFailure(2, input);
  const artifact = parseArtifact(input);
  if (isCliError(artifact)) return queryFailure(2, artifact);
  const model = buildProfileModel(artifact);
  return model.ok
    ? { ok: true as const, value: projectModel(parsedArguments, model.value) }
    : queryFailure(1, model.error);
}

export function runProfilerCli(args: readonly string[], stdin: string): ProfilerCliResult {
  const result = runProfilerQuery(args, stdin);
  return result.ok
    ? { stdout: output(result.value), stderr: '', exitCode: 0 }
    : { stdout: '', stderr: output({ error: result.error }), exitCode: result.exitCode };
}

export function readCliInput(args: readonly string[], readStdin: () => string): string {
  return args.some((argument) => ['--file', '--left-file', '--right-file'].includes(argument))
    ? ''
    : readStdin();
}

export function main(): void {
  const args = process.argv.slice(2);
  const result = runProfilerCli(
    args,
    readCliInput(args, () => readFileSync(0, 'utf8')),
  );
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main();
}
