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
