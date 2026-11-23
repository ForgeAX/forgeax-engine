import type { ChildProcess, ExecFileOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Pick<ExecFileOptions, 'windowsVerbatimArguments'>;
}

interface CommandOutput {
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

const BACKEND_HEAP_MIB_DEFAULT = 8192;

/**
 * V8 heap flag for the detached backend. The startup cook (shader compile, material and
 * particle producers) can pass Node's default old-space limit on large projects and die
 * with "JavaScript heap out of memory". Admit at most a quarter of the available
 * machine/container memory, capped at 8 GiB. The build child inherits this limit;
 * the remaining half reserves browser, native and other host allocations.
 * Keep an explicit caller limit. It travels in NODE_OPTIONS, not
 * execArgv, because worker threads reject --max-old-space-size inherited as an exec flag.
 */
export function backendHeapEnv(
  env: NodeJS.ProcessEnv,
  totalBytes: number,
  constrainedBytes = 0,
): NodeJS.ProcessEnv {
  if (/--max-old-space-size/.test(env.NODE_OPTIONS ?? '')) return env;
  const admittedBytes = constrainedBytes > 0 ? Math.min(totalBytes, constrainedBytes) : totalBytes;
  const quarterMib = Math.max(1, Math.floor(admittedBytes / 4 / (1024 * 1024)));
  const flag = `--max-old-space-size=${String(Math.min(BACKEND_HEAP_MIB_DEFAULT, quarterMib))}`;
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, flag].filter(Boolean).join(' ') };
}

/** Escalate a child shutdown after two seconds and optionally wait for the forced exit. */
export async function stopChildProcess(child: ChildProcess, forceExitGraceMs = 0): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const settled = () => {
      clearTimeout(timer);
      child.off('exit', settled);
      resolveStop();
    };
    let timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (forceExitGraceMs === 0) settled();
      else {
        timer = setTimeout(settled, forceExitGraceMs);
        timer.unref();
      }
    }, 2_000);
    child.once('exit', settled);
    child.kill('SIGTERM');
  });
}
