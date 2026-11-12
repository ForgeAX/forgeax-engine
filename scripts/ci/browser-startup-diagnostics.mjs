/** Test-server lifecycle evidence. Does not alter deadlines or retry decisions. */
export function browserStartupDiagnostics(owner, enabled = Boolean(process.env.CI)) {
  if (!enabled) return [];
  const began = performance.now();
  let phase = 'config';
  const emit = () => {
    process.stderr.write(
      `[browser-startup] ${JSON.stringify({
        owner,
        pid: process.pid,
        phase,
        elapsedMs: Math.round(performance.now() - began),
        heapUsedBytes: process.memoryUsage().heapUsed,
      })}\n`,
    );
  };
  const mark = (next) => {
    phase = next;
    emit();
  };
  let timer;
  const stop = () => clearTimeout(timer);
  return [
    {
      name: `forgeax-browser-startup-${owner}`,
      enforce: 'pre',
      configResolved() {
        mark('config-resolved');
        timer = setTimeout(emit, 60_000);
        timer.unref?.();
      },
      configureServer() {
        mark('configure-server');
        return () => mark('configure-server-complete');
      },
      buildStart: {
        order: 'pre',
        handler() {
          mark('build-start');
        },
      },
      closeBundle() {
        stop();
      },
    },
    {
      name: `forgeax-browser-startup-ready-${owner}`,
      enforce: 'post',
      buildStart: {
        order: 'post',
        sequential: true,
        handler() {
          mark('build-ready');
          stop();
        },
      },
    },
  ];
}
