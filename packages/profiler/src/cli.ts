import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProfileComparisonProjection } from './compare.js';
import { compareProfileCaptures } from './compare.js';
import type { ProfileModel } from './model.js';
import { buildProfileModel } from './model.js';
import type { ProfileSource } from './types.js';

export interface ProfilerCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type CliCommand =
  | { readonly kind: 'summary' }
  | { readonly kind: 'frame'; readonly frameId: number }
  | { readonly kind: 'phase'; readonly source: ProfileSource; readonly phase: string }
  | { readonly kind: 'compare' };

type CliArguments = {
  readonly command: CliCommand;
  readonly filePath?: string;
  readonly leftFilePath?: string;
  readonly rightFilePath?: string;
};

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
    readonly side?: 'left' | 'right';
    readonly message: string;
  };
};

function output(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parsePositiveSafeInteger(value: string, argument: string): number | CliError {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return {
      code: 'cli-query-invalid',
      expected: `${argument} is a positive safe integer`,
      hint: `Pass a positive safe integer to ${argument}.`,
      detail: { argument, message: `received ${value}` },
    };
  }
  const parsed = Number(value);
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
  kind: 'summary' | 'frame' | 'phase' | 'compare';
  frameId: number | undefined;
  source: ProfileSource | undefined;
  phase: string | undefined;
  filePath: string | undefined;
  leftFilePath: string | undefined;
  rightFilePath: string | undefined;
};

function consumeFlag(args: readonly string[], index: number, state: ParseState): number | CliError {
  const argument = args[index] as string;
  const value = args[index + 1];
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
  return index + 2;
}

function validateCommand(state: ParseState): CliError | undefined {
  const hasCompareFile = state.leftFilePath !== undefined || state.rightFilePath !== undefined;
  if (state.kind === 'compare') {
    if (
      state.leftFilePath === undefined ||
      state.rightFilePath === undefined ||
      state.filePath !== undefined ||
      state.frameId !== undefined ||
      state.source !== undefined ||
      state.phase !== undefined
    ) {
      return {
        code: 'cli-arguments-invalid',
        expected: 'compare requires --left-file and --right-file and no single-artifact selectors',
        hint: 'Pass compare --left-file <path> --right-file <path>.',
        detail: { message: 'invalid compare input selectors' },
      };
    }
    return undefined;
  }
  if (hasCompareFile) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'compare is the only command that accepts --left-file and --right-file',
      hint: 'Use compare --left-file <path> --right-file <path> for two artifacts.',
      detail: { message: 'compare file selectors used with another command' },
    };
  }
  if (
    state.kind === 'summary' &&
    (state.frameId !== undefined || state.source !== undefined || state.phase !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'summary has no frame or phase selectors',
      hint: 'Use frame or phase when selecting a lower-level projection.',
      detail: { message: 'summary received a lower-level selector' },
    };
  }
  if (
    state.kind === 'frame' &&
    (state.frameId === undefined || state.source !== undefined || state.phase !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'frame requires --frame-id and no phase selectors',
      hint: 'Pass frame --frame-id <positive-safe-integer>.',
      detail: { message: 'invalid frame selector' },
    };
  }
  if (
    state.kind === 'phase' &&
    (state.source === undefined || state.phase === undefined || state.frameId !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'phase requires --source and --phase and no frame selector',
      hint: 'Pass phase --source <app|render> --phase <name>.',
      detail: { message: 'invalid phase selector' },
    };
  }
  return undefined;
}

function toCliArguments(state: ParseState): CliArguments {
  if (state.kind === 'summary') {
    return {
      command: { kind: state.kind },
      ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
    };
  }
  if (state.kind === 'frame') {
    return {
      command: { kind: state.kind, frameId: state.frameId as number },
      ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
    };
  }
  if (state.kind === 'compare') {
    return {
      command: { kind: state.kind },
      leftFilePath: state.leftFilePath as string,
      rightFilePath: state.rightFilePath as string,
    };
  }
  return {
    command: {
      kind: state.kind,
      source: state.source as ProfileSource,
      phase: state.phase as string,
    },
    ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
  };
}

function parseArguments(args: readonly string[]): CliArguments | CliError {
  const state: ParseState = {
    kind: 'summary',
    frameId: undefined,
    source: undefined,
    phase: undefined,
    filePath: undefined,
    leftFilePath: undefined,
    rightFilePath: undefined,
  };
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
    const nextIndex = consumeFlag(args, index, state);
    if (typeof nextIndex !== 'number') return nextIndex;
    index = nextIndex;
  }
  return validateCommand(state) ?? toCliArguments(state);
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

function withSide(side: 'left' | 'right', error: CliError): CliError {
  return { ...error, detail: { ...error.detail, side } };
}

function readCompareArtifact(filePath: string, side: 'left' | 'right'): unknown | CliError {
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
  command: Exclude<CliCommand, { readonly kind: 'compare' }>,
  model: ProfileModel,
): Record<string, unknown> {
  if (command.kind === 'summary') {
    return { query: 'summary', ...model.summary, phases: model.phases };
  }
  if (command.kind === 'frame') {
    return {
      query: 'frame',
      schemaVersion: model.summary.schemaVersion,
      captureId: model.summary.captureId,
      timeUnit: model.summary.timeUnit,
      frameId: command.frameId,
      completeness: model.completeness,
      frame: model.frames.find((entry) => entry.frameId === command.frameId) ?? null,
    };
  }
  const phaseSummary = model.phases.find(
    (entry) => entry.source === command.source && entry.phase === command.phase,
  );
  return {
    query: 'phase',
    schemaVersion: model.summary.schemaVersion,
    captureId: model.summary.captureId,
    timeUnit: model.summary.timeUnit,
    source: command.source,
    phase: command.phase,
    completeness: model.completeness,
    phaseSummary: phaseSummary ?? null,
    children: model.phases.filter(
      (entry) => entry.parentSource === command.source && entry.parentPhase === command.phase,
    ),
  };
}

function projectComparison(value: ProfileComparisonProjection): Record<string, unknown> {
  return { query: 'compare', ...value };
}

export function runProfilerCli(args: readonly string[], stdin: string): ProfilerCliResult {
  const parsedArguments = parseArguments(args);
  if ('code' in parsedArguments) {
    return { stdout: '', stderr: output({ error: parsedArguments }), exitCode: 2 };
  }
  if (parsedArguments.command.kind === 'compare') {
    const left = readCompareArtifact(parsedArguments.leftFilePath as string, 'left');
    if (isCliError(left)) return { stdout: '', stderr: output({ error: left }), exitCode: 2 };
    const right = readCompareArtifact(parsedArguments.rightFilePath as string, 'right');
    if (isCliError(right)) return { stdout: '', stderr: output({ error: right }), exitCode: 2 };
    const comparison = compareProfileCaptures(left, right);
    if (!comparison.ok) {
      return { stdout: '', stderr: output({ error: comparison.error }), exitCode: 1 };
    }
    return {
      stdout: output(projectComparison(comparison.value)),
      stderr: '',
      exitCode: 0,
    };
  }
  const input = readArtifact(parsedArguments.filePath, stdin);
  if (typeof input !== 'string') {
    return { stdout: '', stderr: output({ error: input }), exitCode: 2 };
  }
  const artifact = parseArtifact(input);
  if (isCliError(artifact)) return { stdout: '', stderr: output({ error: artifact }), exitCode: 2 };
  const model = buildProfileModel(artifact);
  if (!model.ok) return { stdout: '', stderr: output({ error: model.error }), exitCode: 1 };
  return {
    stdout: output(projectModel(parsedArguments.command, model.value)),
    stderr: '',
    exitCode: 0,
  };
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
