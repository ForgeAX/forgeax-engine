#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// CI setup and local package-manager selection consume the same version pin.
const version = readFileSync(new URL('../.pnpm-version', import.meta.url), 'utf8').trim();
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.packageManager, `pnpm@${version}`, 'pnpm pins must match');
console.log(`pnpm pin aligned: ${version}`);
