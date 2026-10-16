import type { ExecFileOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Pick<ExecFileOptions, 'windowsVerbatimArguments'>;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** Keep executable-format differences at one boundary for all DevKit commands. */
export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): CommandInvocation {
  if (platform !== 'win32' || /\.exe$/i.test(command)) {
    return { file: command, args, options: {} };
  }
  return {
    file: comSpec,
    args: ['/d', '/s', '/c', command, ...args],
    options: { windowsVerbatimArguments: false },
  };
}

export function execFileCommand(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<CommandOutput> {
  const manager = options.env?.npm_execpath ?? process.env.npm_execpath;
  const invocation =
    command === 'pnpm' &&
    manager &&
    /^pnpm(?:-native)?(?:\.[cm]?js|\.exe)?$/i.test(basename(manager))
      ? commandInvocation(
          ['.js', '.cjs', '.mjs'].includes(extname(manager)) ? process.execPath : manager,
          [...(['.js', '.cjs', '.mjs'].includes(extname(manager)) ? [manager] : []), ...args],
        )
      : commandInvocation(command, args);
  const execOptions = {
    ...options,
    encoding: 'utf8' as const,
    ...invocation.options,
  };
  return Promise.resolve()
    .then(() => execFileAsync(invocation.file, [...invocation.args], execOptions))
    .catch((cause: unknown) => {
      // pnpm 12's npm package exposes a no-shebang shell entry point. macOS
      // returns ENOEXEC instead of retrying that script through a shell.
      if (
        process.platform !== 'darwin' ||
        cause === null ||
        typeof cause !== 'object' ||
        !('code' in cause) ||
        cause.code !== 'ENOEXEC'
      ) {
        throw cause;
      }
      return execFileAsync('/bin/sh', ['-c', 'exec "$0" "$@"', command, ...args], execOptions);
    })
    .then((result) => ({
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }));
}
