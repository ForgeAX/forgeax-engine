#!/usr/bin/env node
// scripts/lint/grep-pass-kind.mjs - feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w8.
//
// Reverse grep gate: detects 'shadow-depth-only' string literals in readable source
// files under packages/ and apps/ (excluding dist/ and node_modules). Binary files
// are skipped to match ripgrep's default behavior.
// The literal was renamed to 'shadow-caster' in w7; this gate ensures no regressions.
//
// Invocation:
//   node scripts/lint/grep-pass-kind.mjs
//
// Exit:
//   0 -- zero 'shadow-depth-only' literals found (pass).
//   1 -- at least one violation; file list printed to stdout with '::error::' prefix
//        so downstream CI runners surface the violation in their issue tracker.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const EXCLUDED_DIRECTORIES = new Set(['dist', 'node_modules']);
const SEARCH_LITERAL = "'shadow-depth-only'";
const hits = [];

function scanDirectory(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        scanDirectory(resolve(directory, entry.name));
      }
      continue;
    }
    if (!entry.isFile()) continue;

    const filePath = resolve(directory, entry.name);
    const bytes = readFileSync(filePath);
    // Match ripgrep's binary-file behavior so bundled textures and other
    // binary assets do not become false-positive source hits.
    if (bytes.includes(0)) continue;
    const source = bytes.toString('utf8');
    const displayPath = relative(REPO_ROOT, filePath).split(sep).join('/');
    source.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(SEARCH_LITERAL)) {
        hits.push(`${displayPath}:${index + 1}:${line}`);
      }
    });
  }
}

for (const root of ['apps', 'packages']) {
  scanDirectory(resolve(REPO_ROOT, root));
}

const output = hits.join('\n');

if (output.length > 0) {
  // Check if all hits are comment-only documentation explaining the rename.
  // The types/index.ts JSDoc comment and the pipeline-cache-keying test comment
  // explaining the rename history are the sole allowed residues.
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const allowed = lines.every(
    (line) => line.includes('renamed from') || line.includes('The pre-rename value'),
  );

  if (!allowed) {
    const header = "linter(grep): prohibited string literal 'shadow-depth-only' found in source:";
    console.log(`::error::${header}`);
    for (const line of lines) {
      console.log(`::error::  ${line}`);
    }
    console.log(
      "Use 'shadow-caster' instead (renamed in feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w7).",
    );
    process.exit(1);
  }
}

// Clean exit -- zero violations (or only allowed comment residue).
process.exit(0);
