#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PKG_ROOT, verifyCurrent } from './verify-current.mjs';

function isCurrent(dirName) {
  try {
    verifyCurrent(dirName);
    return true;
  } catch {
    return false;
  }
}

function mirrorPair(fromDir, toDir) {
  const srcRoot = resolve(PKG_ROOT, fromDir);
  const dstRoot = resolve(PKG_ROOT, toDir);
  mkdirSync(dstRoot, { recursive: true });
  copyFileSync(resolve(srcRoot, 'modeling_kernel.wasm'), resolve(dstRoot, 'modeling_kernel.wasm'));
  copyFileSync(resolve(srcRoot, 'provenance.json'), resolve(dstRoot, 'provenance.json'));
}

if (isCurrent('pkg')) {
  if (!isCurrent('dist')) mirrorPair('pkg', 'dist');
} else if (isCurrent('dist')) {
  mirrorPair('dist', 'pkg');
} else {
  execFileSync('bash', [resolve(PKG_ROOT, 'build.sh')], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
  verifyCurrent('pkg');
  mirrorPair('pkg', 'dist');
}

verifyCurrent('dist');
verifyCurrent('pkg');
