#!/usr/bin/env node
// AC-08 grep gate: assert that `packages/shader/src/pbr.wgsl` contains
// at least one real CALL SITE of `sampleIblDiffuse(...)` and one real
// call site of `sampleIblSpecular(...)`.
//
// "Call site" definition:
//   - matches the regex /\bsampleIbl(Diffuse|Specular)\s*\(/
//   - on a line that is NOT a comment-only line (does not start with `//`)
//   - AND is NOT an `#import ...` directive
//
// Rationale: round-1 mid Implementer hard-coded ambient = vec3<f32>(0.0)
// with a "M3 placeholder: M4 fills this" comment that never got filled.
// round-2 D-4 forces the real IBL sample call in pbr.wgsl fs_main; this
// grep gate makes that requirement physically un-bluffable (Implementer
// can no longer write a comment that says "wired" without writing the
// actual call).
//
// Spec anchors: feat-20260520-skylight-ibl-cubemap plan-strategy section
// 5.5 (CI command table NEW row) + section 5.1 (AC-08 grep gate row);
// requirements AC-08.
//
// Exit codes: 0 = at least one call site each for sampleIblDiffuse and
// sampleIblSpecular; 1 = either is absent (printed [reason]/[rerun]/[hint]
// triple to stderr).
//
// Zero dependencies — uses only `node:fs` + `node:process` so it can run
// in any CI environment (including portability-bun) without bun/pnpm
// install first.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const TARGET = 'packages/shader/src/pbr.wgsl';

const RE_DIFFUSE = /\bsampleIblDiffuse\s*\(/;
const RE_SPECULAR = /\bsampleIblSpecular\s*\(/;

let source;
try {
  source = readFileSync(TARGET, 'utf8');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[reason] cannot read ${TARGET}: ${msg}\n`);
  process.stderr.write('[rerun] node packages/shader/scripts/check-pbr-ibl-callsite.mjs\n');
  process.stderr.write('[hint] ensure the file exists; gate runs from repo root.\n');
  process.exit(1);
}

const lines = source.split(/\r?\n/);

let diffuseHit = false;
let specularHit = false;
const hits = { diffuse: [], specular: [] };

for (let i = 0; i < lines.length; i += 1) {
  const rawLine = lines[i] ?? '';
  const trimmed = rawLine.trim();
  // Exclude comment-only and #import lines from "real call site" eligibility.
  if (trimmed.startsWith('//') || trimmed.startsWith('#import')) continue;
  if (RE_DIFFUSE.test(rawLine)) {
    diffuseHit = true;
    hits.diffuse.push({ lineNo: i + 1, snippet: trimmed.slice(0, 160) });
  }
  if (RE_SPECULAR.test(rawLine)) {
    specularHit = true;
    hits.specular.push({ lineNo: i + 1, snippet: trimmed.slice(0, 160) });
  }
}

if (!diffuseHit || !specularHit) {
  process.stderr.write(
    `[reason] check-pbr-ibl-callsite: pbr.wgsl missing real IBL sample call site (diffuseHit=${diffuseHit}, specularHit=${specularHit}).\n`,
  );
  process.stderr.write('[rerun] node packages/shader/scripts/check-pbr-ibl-callsite.mjs\n');
  process.stderr.write(
    '[hint] pbr.wgsl fs_main must call sampleIblDiffuse(...) and sampleIblSpecular(...) ' +
      '(not behind comment / not only in #import). See plan-strategy section 5.5 + requirements AC-08; ' +
      'AGENTS.md Demo failures route to engine fixes (hard-coded ambient = vec3<f32>(0.0) placeholder forbidden).\n',
  );
  process.exit(1);
}

process.stdout.write(
  `[check-pbr-ibl-callsite] OK -- pbr.wgsl contains ${hits.diffuse.length} sampleIblDiffuse + ${hits.specular.length} sampleIblSpecular real call site(s).\n`,
);
process.exit(0);
