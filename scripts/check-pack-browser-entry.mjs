#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const rootArgument = process.argv.indexOf('--root');
const root = rootArgument === -1 ? process.cwd() : process.argv[rootArgument + 1];
const rootIndex = join(root, 'packages/pack/dist/index.mjs');
if (!existsSync(rootIndex)) {
  console.error(`missing browser-reachable Pack entry: ${rootIndex}`);
  process.exit(1);
}

const source = readFileSync(rootIndex, 'utf8');
const forbidden = /(?:node:crypto|from ['"]crypto['"]|require\(['"]crypto['"]\))/;
if (forbidden.test(source)) {
  console.error(`Pack root entry contains a Node crypto dependency: ${rootIndex}`);
  process.exit(1);
}

console.log('Pack browser entry gate: PASS');
