import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';

function findCorepackEntrypoint(execPath, env) {
  const directories = [dirname(execPath), ...(env.PATH ?? env.Path ?? '').split(delimiter)];
  const roots = new Set();
  for (const directory of directories.filter(Boolean)) {
    roots.add(resolve(directory, 'node_modules', 'corepack'));
    roots.add(resolve(directory, '..', 'node_modules', 'corepack'));
    roots.add(resolve(directory, '..', 'corepack'));
  }
  for (const root of roots) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
      const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.corepack;
      if (manifest.name === 'corepack' && typeof entry === 'string') {
        const entrypoint = resolve(root, entry);
        if (existsSync(entrypoint)) return entrypoint;
      }
    } catch {}
  }
  return undefined;
}

export function readPnpmVersion(
  packageManager,
  {
    cwd,
    platform = process.platform,
    execPath = process.execPath,
    env = process.env,
    execFileSyncImpl = execFileSync,
  } = {},
) {
  try {
    let command;
    let args;
    if (platform === 'win32') {
      if (typeof packageManager !== 'string' || !packageManager.startsWith('pnpm@')) return null;
      const corepackEntrypoint = findCorepackEntrypoint(execPath, env);
      if (!corepackEntrypoint) return null;
      command = execPath;
      args = [corepackEntrypoint, packageManager, '--version'];
    } else {
      command = 'pnpm';
      args = ['--version'];
    }

    const options = { cwd, encoding: 'utf8', shell: false };
    if (env !== process.env) options.env = env;
    return execFileSyncImpl(command, args, options).trim();
  } catch {
    return null;
  }
}
