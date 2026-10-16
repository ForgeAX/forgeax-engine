#!/usr/bin/env node
// Unified CLI discovery smoke. Domain packages contribute producers, while
// DevKit owns the one public `forgeax` executable.

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..', '..', '..');
const CLI = resolve(ROOT, 'packages/devkit/dist/cli.mjs');
const PROJECT = resolve(ROOT, 'templates/game-3d');

function run(args) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code) => resolveResult({ code, stdout, stderr }));
    child.once('error', (error) => resolveResult({ code: 1, stdout, stderr: String(error) }));
  });
}

const cases = [];
function check(name, result, predicate) {
  const ok = result.code === 0 && predicate(result);
  cases.push({ name, ok, code: result.code, stdout: result.stdout.slice(0, 300), stderr: result.stderr.slice(0, 300) });
  return ok;
}

const tree = await run(['help', '--tree', '--json', '--root', PROJECT]);
check('root-tree-json', tree, (result) => {
  const parsed = JSON.parse(result.stdout);
  return parsed.ok === true && parsed.value.nodes.some((node) => node.name === 'asset') && parsed.value.nodes.some((node) => node.name === 'dev');
});

const atlas = await run(['help', 'asset', 'atlas', '--root', PROJECT]);
check('asset-atlas-leaf-help', atlas, (result) => result.stdout.includes('maxAtlasSize') && result.stdout.includes('asset-atlas-producer'));

const plugins = await run(['project', 'plugin', 'list', '--root', PROJECT, '--json']);
check('project-plugin-json', plugins, (result) => JSON.parse(result.stdout).ok === true);

const summary = { feature: 'unified-cli-live-viewport', casesTotal: cases.length, casesPassed: cases.filter((item) => item.ok).length, casesFailed: cases.filter((item) => !item.ok).length, cases };
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.casesFailed > 0) process.exitCode = 1;
