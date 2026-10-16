#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { generateIcons } from './generate-icons.mjs';
import { pnpmCommand } from '../../../scripts/lib/pnpm-command.mjs';

const appRoot = new URL('../', import.meta.url);
generateIcons();

const bundle =
  process.platform === 'darwin' ? 'app' : process.platform === 'win32' ? 'nsis' : 'appimage';
const [command, ...args] = pnpmCommand();
const result = spawnSync(command, [...args, 'exec', 'tauri', 'build', '--bundles', bundle], {
  cwd: appRoot,
  stdio: 'inherit',
  shell: false,
});
process.exit(result.status ?? 1);
