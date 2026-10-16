#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const root = resolve(option('--root', '.'));
const destination = resolve(root, option('--destination', 'shared-app-inputs'));
const archive = resolve(
  root,
  option('--archive', 'shared-app-inputs-transfer/shared-app-inputs.tar.gz'),
);

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

const manifest = join(destination, 'manifest.json');
const payload = join(destination, 'assets', 'payload');
if (!isFile(archive)) {
  // Several focused gates can share one source checkout. The first
  // projection consumes the archive; later projections should be idempotent.
  if (isFile(manifest) && !existsSync(payload)) {
    process.stdout.write(`shared app inputs already unpacked at ${destination}\n`);
    process.exit(0);
  }
  throw new Error(`shared input archive is missing: ${archive}`);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
rmSync(archive, { force: true });

for (const required of [
  manifest,
  join(destination, 'assets', 'catalog.json'),
  join(destination, 'shaders', 'manifest.json'),
]) {
  if (!isFile(required)) throw new Error(`shared input archive omitted required file: ${required}`);
}
if (existsSync(payload)) {
  throw new Error(`catalog-only shared input archive unexpectedly contains payload: ${payload}`);
}

process.stdout.write(`unpacked shared app inputs into ${destination}\n`);
