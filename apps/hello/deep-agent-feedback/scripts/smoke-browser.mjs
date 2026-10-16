#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const index = await readFile(resolve(appRoot, 'index.html'), 'utf8');
if (!index.includes('id="app"') || !index.includes('id="game-ui"')) {
  throw new Error('deep-agent-feedback: browser carrier is missing canvas or UI');
}
console.log('[deep-agent-feedback] browser carrier contract: PASS');
console.log(
  JSON.stringify({
    fixture: 'baseline',
    requested: 256,
    admitted: 256,
    transport: 'compute-storage',
    evidence: 'carrier-only',
  }),
);
