import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export function startViewerDevServer(root) {
  const vite = spawn(
    'pnpm',
    ['--filter', '@forgeax/engine-rhi-debug-viewer', 'dev', '--', '--host', '127.0.0.1'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  let url;
  vite.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write('[vite] ' + text);
    const match = text.match(/Local:\s+(http:\/\/[^\s]+)/);
    if (match) url = match[1];
  });
  vite.stderr.on('data', (chunk) => process.stderr.write('[vite-err] ' + chunk.toString()));

  return {
    async waitForReady() {
      const deadline = Date.now() + 30000;
      while (url === undefined && Date.now() < deadline) await sleep(200);
      if (url === undefined) throw new Error('Vite did not become ready in 30s');
      return url;
    },
    async stop() {
      if (vite.pid !== undefined) {
        if (process.platform === 'win32') {
          vite.kill('SIGTERM');
        } else {
          try {
            process.kill(-vite.pid, 'SIGTERM');
          } catch {
            vite.kill('SIGTERM');
          }
        }
      }
      await sleep(250);
    },
  };
}
