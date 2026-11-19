/** Stdio ownership ends on EOF, signals, or the disappearance of its native host. */
export function bindStdioLifetime(close, { watchParent = false } = {}) {
  const parent = process.ppid;
  let closing;
  let timer;
  const retire = () => {
    clearInterval(timer);
    return closing ??= Promise.resolve().then(close);
  };
  const exit = () => { void retire().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); };
  process.stdin.once('end', exit);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, exit);
  if (watchParent) {
    // A surviving orphan is reparented by the OS. Capturing ppid before work
    // avoids relying on a model-provided identifier or another daemon.
    timer = setInterval(() => { if (process.ppid !== parent || parent <= 1) exit(); }, 1000);
    timer.unref();
  }
  return retire;
}
