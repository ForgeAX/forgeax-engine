#!/usr/bin/env node
// scripts/lint/grep-image-kind-convergence.mjs — feat-20260629-importer-self-declared-fold-contract M3 / w8 (D-2).
//
// Reverse grep gate: detects `"kind": "image"` in .meta.json sidecar files
// under forgeax-engine-assets/, packages/, and apps/.  After P1 (M2) migrated
// all 183 submodule sidecars + 16 source sites from image -> texture, and D-1
// (M3 / w7) removed the closed enum from meta.schema.json, a stray
// `"kind": "image"` in any .meta.json sidecar would silently pass schema
// validation.  This gate catches regressions: any .meta.json containing
// `"kind": "image"` after P1+M3 is a missed migration.
//
// Invocation:
//   node scripts/lint/grep-image-kind-convergence.mjs
//
// Exit:
//   0 — zero `"kind": "image"` hits in .meta.json files (pass).
//   1 — at least one violation; file list printed to stdout with `::error::`
//       prefix so downstream CI runners surface the violation.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

export function imageKindSidecars(roots) {
  const hits = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.meta.json') &&
        /"kind": *"image"/.test(readFileSync(path, 'utf8'))
      )
        hits.push(path);
    }
  }
  for (const root of roots) visit(root);
  return hits.sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hits = imageKindSidecars(
    ['forgeax-engine-assets', 'packages', 'apps'].map((root) => resolve(REPO_ROOT, root)),
  );
  if (hits.length > 0) {
    console.error(
      '::error::prohibited "kind": "image" in .meta.json sidecars; migrate to kind:texture:',
    );
    for (const path of hits) console.error(`::error::  ${relative(REPO_ROOT, path)}`);
    process.exitCode = 1;
  } else console.log('grep-image-kind-convergence: pass (no image sidecars)');
}
