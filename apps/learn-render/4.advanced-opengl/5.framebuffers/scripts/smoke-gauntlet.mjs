#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pnpmCommand } from '../../../../../scripts/lib/pnpm-command.mjs';

const packageName = '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const [manager, ...prefix] = pnpmCommand();

for (const script of ['smoke', 'smoke:browser', 'smoke:browser-live']) {
  const result = spawnSync(manager, [...prefix, '--filter', packageName, script], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
