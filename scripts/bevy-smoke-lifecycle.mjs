import { writeSync } from 'node:fs';

// Standard Dawn smokes hand their lifetime to bevy-demo.mjs. Keep the child
// alive after a successful module evaluation so the parent can reap the native
// WebGPU process with SIGKILL. File descriptor 3 is a private control pipe;
// unlike stdout, it cannot be delayed behind buffered smoke evidence.
function reportExit(code) {
  try {
    writeSync(3, `${code}\n`);
  } catch {
    // The lifecycle module is also safe when loaded without the parent pipe.
  }
}

const nativeExit = process.exit.bind(process);
const keepAlive = setInterval(() => {
  if (process.exitCode !== undefined && process.exitCode !== 0) {
    clearInterval(keepAlive);
    reportExit(process.exitCode);
    nativeExit(process.exitCode);
  }
}, 10);

process.exit = (code = 0) => {
  if (code === 0) {
    reportExit(0);
    process.exitCode = 0;
    return;
  }
  reportExit(code);
  nativeExit(code);
};
