import { writeSync } from 'node:fs';
import process from 'node:process';

// The uploader sets its final exit code before its network handles may close.
// Let its diagnostics flush, then release the runner so the next attempt can start.
let failedAt;
setInterval(() => {
  const exitCode = Number(process.exitCode ?? 0);
  if (exitCode === 0) {
    failedAt = undefined;
    return;
  }
  const now = performance.now();
  failedAt ??= now;
  if (now - failedAt < 5_000) return;
  try {
    writeSync(2, '[artifact-upload] Failed attempt still running after 5 seconds; exiting.\n');
  } finally {
    process.exit(exitCode);
  }
}, 1_000).unref();
