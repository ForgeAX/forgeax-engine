#!/usr/bin/env node
// scripts/dependabot/check-doc-anchor.mjs (bug-20260514 M4 / T-014)
// FORGEAX_BUN_LOCK_OUT_OF_SYNC self-describing doc-anchor grep gate.
// Asserts the four single-hop anchors that bind CI log -> workflow ->
// AGENTS.md (plan-strategy 7.4 progressive disclosure). Zero npm deps;
// node:* stdlib only. AGENTS.md > Conventions > Dual lockfile.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MARKER = 'FORGEAX_BUN_LOCK_OUT_OF_SYNC';
export const WORKFLOW_FILENAME = 'sync-bun-lock-on-dependabot.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILENAME}`;
export const AGENTS_MD = 'AGENTS.md';
export const HEADER_LINES = 12;

export const ANCHORS = [
  {
    id: 'A1-marker-in-agents-md',
    file: AGENTS_MD,
    literal: MARKER,
    where: 'whole-file',
    why: 'AGENTS.md anchor segment must mention the marker for grep -F discovery',
  },
  {
    id: 'A2-workflow-filename-in-agents-md',
    file: AGENTS_MD,
    literal: WORKFLOW_FILENAME,
    where: 'whole-file',
    why: 'AGENTS.md must point to the workflow file for marker -> workflow single hop',
  },
  {
    id: 'A3-marker-in-workflow',
    file: WORKFLOW_PATH,
    literal: MARKER,
    where: 'whole-file',
    why: 'workflow must carry the marker so CI log grep aligns with the file',
  },
  {
    id: 'A4-agents-md-in-workflow-header',
    file: WORKFLOW_PATH,
    literal: 'AGENTS.md',
    where: 'header',
    why: 'workflow header must reference AGENTS.md so workflow -> doc reverse hop is single-jump',
  },
];

function readSafe(rootDir, file) {
  const p = resolve(rootDir, file);
  try {
    return { ok: true, text: readFileSync(p, 'utf8') };
  } catch (err) {
    return { ok: false, reason: `${file} unreadable: ${err.code ?? err.message}` };
  }
}

function headerWindow(text, lines) {
  return text.split(/\r?\n/).slice(0, lines).join('\n');
}

export function runChecks(rootDir) {
  const cache = new Map();
  function load(file) {
    if (!cache.has(file)) cache.set(file, readSafe(rootDir, file));
    return cache.get(file);
  }
  const missing = [];
  for (const a of ANCHORS) {
    const f = load(a.file);
    if (!f.ok) {
      missing.push({ id: a.id, file: a.file, literal: a.literal, reason: f.reason });
      continue;
    }
    const haystack = a.where === 'header' ? headerWindow(f.text, HEADER_LINES) : f.text;
    if (!haystack.includes(a.literal)) {
      missing.push({
        id: a.id,
        file: a.file,
        literal: a.literal,
        reason: `literal not found in ${a.where === 'header' ? `first ${HEADER_LINES} lines of ` : ''}${a.file}`,
      });
    }
  }
  return { ok: missing.length === 0, missing };
}

function formatStderr(missing) {
  const lines = ['[check-doc-anchor] FAIL: doc-anchor drift detected'];
  for (const m of missing) {
    lines.push(`  ${m.id}: literal ${JSON.stringify(m.literal)} ${m.reason}`);
  }
  lines.push(
    '  Hint: AGENTS.md > Conventions > Dual lockfile must mention the marker + workflow filename;',
  );
  lines.push(`  workflow header (first ${HEADER_LINES} lines) must reference AGENTS.md.`);
  return `${lines.join('\n')}\n`;
}

export function main(argv) {
  const cwd = argv[0] ? resolve(argv[0]) : process.cwd();
  const r = runChecks(cwd);
  if (r.ok) {
    return {
      exitCode: 0,
      stdout: `[check-doc-anchor] OK: all ${ANCHORS.length} doc anchors hit\n`,
      stderr: '',
    };
  }
  return { exitCode: 1, stdout: '', stderr: formatStderr(r.missing) };
}

/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = main(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
/* v8 ignore stop */
