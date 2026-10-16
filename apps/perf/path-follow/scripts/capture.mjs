import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve(process.env.FORGEAX_PATH_EVIDENCE ?? 'artifacts/path-follow');
const run = (script, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname], {
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code ?? signal}`)),
    );
  });
await run('capture-one.mjs', { FORGEAX_PATH_EVIDENCE: directory });
await run('replay.mjs', { FORGEAX_PATH_EVIDENCE: directory });
if (process.env.FORGEAX_PATH_SKIP_PUBLIC !== '1') {
  const env = {
    FORGEAX_PATH_EVIDENCE: resolve(directory, 'public-only'),
    FORGEAX_PATH_URL: process.env.FORGEAX_PATH_PUBLIC_URL ?? 'http://127.0.0.1:5417',
    FORGEAX_PATH_REIMPORT: '0',
  };
  await run('capture-one.mjs', env);
  await run('replay.mjs', env);
  await run('production.mjs', { FORGEAX_PATH_EVIDENCE: directory });
}
