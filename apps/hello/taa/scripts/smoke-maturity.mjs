#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const kind = process.argv[2] ?? 'quality';
if (!['quality', 'performance', 'motion', 'capture', 'resources', 'hotspot', 'texture', 'surfaces', 'deformation', 'load-step', 'load-step-balanced'].includes(kind)) throw new Error('usage: smoke-maturity.mjs quality|performance|motion|capture|resources|hotspot|texture|surfaces|deformation|load-step|load-step-balanced');
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project=dawn', `packages/runtime/src/__tests__/taa-maturity${kind === 'quality' ? '' : kind === 'capture' ? '-rhi' : kind === 'load-step-balanced' ? '-load-step' : `-${kind}`}.dawn.test.ts`, '--maxWorkers=1'], {
  cwd: resolve(import.meta.dirname, '../../../..'),
  env: { ...process.env, TAA_MATURITY: kind }, stdio: 'inherit',
});
process.exitCode = result.status ?? 1;
