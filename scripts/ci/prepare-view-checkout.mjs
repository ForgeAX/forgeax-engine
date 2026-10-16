#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { hasExpandedSource } from '../lib/source-repository.mjs';
import { submoduleGitEnvironment } from './submodule-git-environment.mjs';

const root = process.cwd();
if (hasExpandedSource(root, 'tools/view', 'package.json')) {
  console.log('[view-checkout] expanded source already present');
} else {
  const result = spawnSync(
    'git',
    ['submodule', 'update', '--init', '--depth=1', '--', 'tools/view'],
    {
      cwd: root,
      env: submoduleGitEnvironment(root, 'tools/view'),
      stdio: 'inherit',
    },
  );
  if (result.error) console.error(`[view-checkout] ${result.error.message}`);
  process.exitCode = result.status ?? 1;
}
