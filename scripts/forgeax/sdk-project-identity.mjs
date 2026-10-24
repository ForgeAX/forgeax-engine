#!/usr/bin/env node
// Generated games may change their package identity after installation. pnpm
// records name/version in its workspace state, so the project policy must
// reconcile that once without touching the lockfile, while a genuine
// dependency edit stays a visible, non-mutating frozen-install failure.
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DRIFT_DEPENDENCY = 'left-pad';
const DRIFT_MESSAGE = /specifiers in the lockfile don't match specifiers in package\.json/;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Throws `sdk-game-identity-*` when the generated project policy regresses. */
export async function verifyProjectIdentityReconcile(project, env = process.env) {
  // pnpm disables recursive install verification in its child environment.
  // This is an independent consumer command, so use the project's own policy.
  const projectEnv = { ...env };
  delete projectEnv.pnpm_config_verify_deps_before_run;
  const manifestPath = resolve(project, 'package.json');
  const lockPath = resolve(project, 'pnpm-lock.yaml');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const originalLock = await readFile(lockPath, 'utf8');
  const manifest = JSON.parse(originalManifest);
  const command = (extra) =>
    execFileAsync('pnpm', ['exec', 'forgeax', 'dev', 'status', '--json'], {
      cwd: project,
      env: { ...projectEnv, ...extra },
      maxBuffer: 16 * 1024 * 1024,
    });
  const lockUnchanged = async (stage) => {
    if ((await readFile(lockPath, 'utf8')) !== originalLock)
      throw new Error(`sdk-game-identity-lockfile-rewritten: ${stage}`);
  };
  const write = (value) => writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await write({ ...manifest, name: `${manifest.name}-renamed`, version: '0.0.1' });
    const reconciled = await command({ CI: '' });
    if (reconciled.stderr.includes('out of sync'))
      throw new Error(`sdk-game-identity-rename-warning: ${reconciled.stderr}`);
    const quiet = await command({ CI: '' });
    if (quiet.stderr.trim() !== '')
      throw new Error(`sdk-game-identity-rename-not-reconciled: ${quiet.stderr}`);
    await lockUnchanged('rename');

    await write({
      ...manifest,
      devDependencies: { ...manifest.devDependencies, [DRIFT_DEPENDENCY]: '1.3.0' },
    });
    for (const ci of ['true', '']) {
      const drift = await command({ CI: ci });
      if (!DRIFT_MESSAGE.test(drift.stderr))
        throw new Error(`sdk-game-identity-drift-hidden (CI=${ci}): ${drift.stderr}`);
      await lockUnchanged(`drift CI=${ci}`);
      if (await exists(resolve(project, 'node_modules', DRIFT_DEPENDENCY)))
        throw new Error(`sdk-game-identity-drift-installed (CI=${ci})`);
    }
  } finally {
    await writeFile(manifestPath, originalManifest);
    await command({ CI: '' }).catch(() => undefined);
  }
  await lockUnchanged('restore');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const project = process.argv[2];
  if (project === undefined) {
    process.stderr.write('usage: sdk-project-identity.mjs <generated-game>\n');
    process.exitCode = 2;
  } else {
    await verifyProjectIdentityReconcile(resolve(project));
    process.stdout.write(
      'sdk-game-identity: rename reconciled, drift visible, lockfile unchanged\n',
    );
  }
}
