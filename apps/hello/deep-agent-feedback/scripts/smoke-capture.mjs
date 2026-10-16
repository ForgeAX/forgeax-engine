#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function findForgeax(start) {
  const explicit = process.env.FORGEAX_CLI;
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  let current = resolve(start);
  for (;;) {
    const candidate = resolve(
      current,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'forgeax.cmd' : 'forgeax',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function evidencePath(output) {
  return output.toLowerCase().endsWith('.png')
    ? `${output.slice(0, -4)}.json`
    : `${output}.json`;
}

function parseJsonLine(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // The CLI may emit dependency diagnostics before its JSON envelope.
    }
  }
  return undefined;
}

function run(command, args, cwd) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', rejectResult);
    child.once('exit', (code, signal) =>
      resolveResult({ code: code ?? 1, signal, stdout, stderr }),
    );
  });
}

const projectRoot = resolve(option('--project') ?? process.env.FORGEAX_CAPTURE_PROJECT ?? appRoot);
const output = resolve(
  projectRoot,
  option('--output') ?? 'artifacts/capture/deep-agent-feedback.png',
);
const browser = option('--browser') ?? process.env.FORGEAX_BROWSER_EXECUTABLE;
const report = evidencePath(output);
const forgeax = findForgeax(projectRoot);
if (forgeax === undefined) {
  console.error(
    JSON.stringify({
      status: 'blocked',
      code: 'forgeax-cli-missing',
      projectRoot,
      hint: 'Run from an installed SDK project or set FORGEAX_CLI to its unified forgeax executable.',
    }),
  );
  process.exitCode = 1;
} else {
  const result = await run(
    forgeax,
    [
      'capture',
      '--backend',
      'software',
      '--require-ui',
      '--deterministic',
      '--output',
      output,
      ...(browser === undefined ? [] : ['--browser', browser]),
      '--json',
    ],
    projectRoot,
  );
  const envelope = parseJsonLine(result.stdout);
  let captureReport;
  try {
    captureReport = JSON.parse(await readFile(report, 'utf8'));
  } catch {
    captureReport = undefined;
  }
  const capture = captureReport?.captures?.at(-1);
  const ok =
    result.code === 0 &&
    envelope?.ok === true &&
    captureReport?.ok === true &&
    capture?.ok === true &&
    capture?.pixels?.rendered === true &&
    capture?.runtime?.domUi?.rootChildren > 0;
  const evidence = {
    status: ok ? 'pass' : 'failed',
    projectRoot,
    command: [
      forgeax,
      'capture',
      '--backend',
      'software',
      '--require-ui',
      '--deterministic',
      ...(browser === undefined ? [] : ['--browser', browser]),
    ],
    output,
    report,
    exitCode: result.code,
    signal: result.signal,
    envelope,
    capture: capture
      ? {
          index: capture.index,
          digest: capture.digest,
          pixels: capture.pixels,
          runtime: capture.runtime,
        }
      : null,
    stderr: result.stderr.trim() || null,
  };
  console.log(JSON.stringify(evidence));
  if (!ok) process.exitCode = 1;
}
