#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViteInvocation, resolveViteCli } from './lib/app-build-launcher.mjs';

const viteArgs = process.argv.slice(2);
if (viteArgs[0] !== 'build' && viteArgs[0] !== 'dev') {
  throw new Error('usage: node scripts/vite-app.mjs <build|dev> [vite options]');
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const invocation = createViteInvocation({
  app: { directory: process.cwd() },
  viteCliPath: resolveViteCli(root),
  viteArgs,
});
const result = spawnSync(invocation.command, invocation.args, invocation.options);
if (result.error) throw result.error;
if (result.signal) throw new Error(`Vite exited by ${result.signal}`);
process.exitCode = result.status ?? 1;
