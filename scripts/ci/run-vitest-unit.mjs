#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, '../..');
const boundedRunner = path.join(scriptDir, 'run-split-vitest-coverage.mjs');

export function propagateChildResult(
  child,
  {
    kill = (pid, signal) => process.kill(pid, signal),
    setExitCode = (code) => {
      process.exitCode = code;
    },
  } = {},
) {
  if (child.error) {
    setExitCode(1);
    return;
  }
  if (child.signal) {
    kill(process.pid, child.signal);
    return;
  }
  setExitCode(child.status ?? 1);
}

export function dispatch(
  argv,
  {
    spawnSyncImpl = spawnSync,
    kill,
    setExitCode,
    writeStderr = (message) => process.stderr.write(message),
  } = {},
) {
  const coverage = argv.includes('--coverage');
  const childArgs = [
    boundedRunner,
    ...(coverage ? [] : ['--non-coverage']),
    ...argv.filter((argument) => argument !== '--' && argument !== '--coverage'),
  ];

  let child;
  try {
    child = spawnSyncImpl(process.execPath, childArgs, {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
  } catch (error) {
    writeStderr(`[vitest] unit dispatcher failed: ${error.message}\n`);
    (
      setExitCode ??
      ((code) => {
        process.exitCode = code;
      })
    )(1);
    return;
  }

  if (child.error) writeStderr(`[vitest] unit dispatcher failed: ${child.error.message}\n`);
  propagateChildResult(child, { kill, setExitCode });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === scriptPath) dispatch(process.argv.slice(2));
