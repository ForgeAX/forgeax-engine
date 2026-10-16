import type { ChildProcess } from 'node:child_process';

export function startAuthority(options?: { timeoutMs?: number; port?: number }): Promise<{
  readonly startupAttempts: number;
  process: ChildProcess;
  port: number;
  kill: () => Promise<void>;
}>;
export function stopAuthority(
  process: ChildProcess,
  options?: { directory?: string; timeoutMs?: number },
): Promise<void>;
