#!/usr/bin/env node
// feat-20260517-spawn-default-fallback / M4 / t15.
//
// AC-12 grep gate: assert that the EcsErrorCode closed union in
// packages/ecs/src/errors.ts has exactly 48 members. The M2 approved
// baseline is 43 existing members plus the three ECS time/schedule scope
// codes (time-delta-invalid, time-config-invalid, schedule-scope-mismatch),
// verify hotfix resource-protected, and the M1 visibility enum write code.
//
// The gate parses the `export type EcsErrorCode = ...` block: every
// `| 'kebab-code'` literal arm contributes 1 to the count, and every
// referenced sub-union name (e.g. ScheduleMutationErrorCode) contributes
// the number of literal arms in its own `export type X = ...` block.
// Comments / blank lines / trailing-`;` close the block. SCREAMING_SNAKE
// codes are also single-quoted literals so they count uniformly.
//
// On count mismatch the gate exits non-zero with a structured
// [reason] / [rerun] / [hint] triple. Mirrors the shape of
// check-fallback-helper-ssot.mjs (sibling gate from this same loop M1).
//
// Usage:
//   node packages/ecs/scripts/check-ecs-error-code-count.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ERRORS_TS = resolve(HERE, '..', 'src', 'errors.ts');
const EXPECTED_COUNT = 48;

/** @param {string} src @param {string} typeName */
function parseUnionLiterals(src, typeName) {
  const startRe = new RegExp(
    `(?:^|\\n)\\s*export\\s+type\\s+${typeName}\\s*=`,
    'm',
  );
  const startMatch = startRe.exec(src);
  if (!startMatch) {
    return { literals: [], references: [] };
  }
  const startIdx = startMatch.index + startMatch[0].length;
  // First: strip line + block comments from the source tail so terminator
  // detection is not fooled by `;` characters appearing inside
  // human-readable comments (e.g. trailing `feat-20260514;` annotations).
  const tail = src.slice(startIdx);
  const cleanedTail = tail
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  // Collect chars until a top-level `;`, ignoring `'...'` and `<...>` depth.
  let i = 0;
  let buf = '';
  let depthAngle = 0;
  let inStr = false;
  while (i < cleanedTail.length) {
    const ch = cleanedTail[i];
    if (ch === "'") {
      inStr = !inStr;
      buf += ch;
      i++;
      continue;
    }
    if (!inStr) {
      if (ch === ';' && depthAngle === 0) break;
      if (ch === '<') depthAngle++;
      else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
    }
    buf += ch;
    i++;
  }
  const stripped = buf;

  const literals = [];
  const references = [];

  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Match `| 'literal'` arms.
    const litRe = /\|\s*'([^']+)'/g;
    let m;
    while ((m = litRe.exec(line)) !== null) {
      literals.push(m[1]);
    }
    // Match `| Identifier` arms (sub-union references).
    const refRe = /\|\s*([A-Z][A-Za-z0-9_]*)\b/g;
    while ((m = refRe.exec(line)) !== null) {
      references.push(m[1]);
    }
  }

  return { literals, references };
}

/** @param {string} src */
function countEcsErrorCode(src) {
  const seen = new Set();
  const literalsAll = [];
  const stack = ['EcsErrorCode'];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const { literals, references } = parseUnionLiterals(src, name);
    for (const lit of literals) literalsAll.push(lit);
    for (const ref of references) {
      if (!seen.has(ref)) stack.push(ref);
    }
  }
  return literalsAll;
}

const src = readFileSync(ERRORS_TS, 'utf8');
const members = countEcsErrorCode(src);
const actualCount = members.length;

const baseline = `EcsErrorCode members: ${actualCount}`;
console.log(baseline);

if (actualCount !== EXPECTED_COUNT) {
  console.error('');
  console.error(
    `[reason] EcsErrorCode member count drift detected: expected ${EXPECTED_COUNT} (M2 approved 43 -> 46 baseline plus M1 visibility validation), found ${actualCount}.`,
  );
  console.error(
    `[rerun]  node packages/ecs/scripts/check-ecs-error-code-count.mjs`,
  );
  console.error(
    `[hint]   M2 approves three codes over the 43-member baseline and M1 approves component-field-invalid-value. Any further EcsErrorCode member requires a new approved decision and an updated EXPECTED_COUNT.`,
  );
  console.error('');
  console.error('Members observed:');
  for (const m of members) console.error(`  - ${m}`);
  process.exit(1);
}

process.exit(0);
