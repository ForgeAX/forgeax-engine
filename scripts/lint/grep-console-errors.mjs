#!/usr/bin/env node
// scripts/lint/grep-console-errors.mjs - feat-20260608-ci-time-cut M5 w15.
//
// Prereq: pnpm install && pnpm build (resolves @forgeax/* workspace symlinks
// when standalone-invoked outside `pnpm lint:grep`).
//
// Static guard against drift in the @forgeax/engine-remote
// InspectorErrorCode closed union and the 6 hint templates locked at
// requirements 10.2 (feat-20260513 plan-decisions round 2 F-1: 4 typed-sugar
// add-only members withdrawn; back to feat-20260511-inspector-p0-spike
// 6-member lock-in).
//
// Two-layer split (round-2 fix-up of M5 w15):
//   - This grep gate owns the STATIC surface: 6-member union literal +
//     4 withdrawn members forbidden + 4-field readonly declaration on
//     InspectorError + "extends Error" instanceof boundary clause.
//   - packages/console/src/__tests__/errors.test.ts owns the RUNTIME
//     surface: instanceof / JSON.stringify roundtrip / instantiation +
//     .message composition / exhaustive switch describeCode.
//
// Original w15 strip moved both surfaces here; reviewer round 1 issue #2
// reinstated the runtime subset to vitest because grep cannot exercise
// `new InspectorError({...})` / `instanceof Error` / JSON.stringify.
//
// Behaviour: scan packages/remote/src/errors.ts for the 6-member union and
// the InspectorError class shape; exit 0 on success, exit 1 with concrete
// failure list otherwise.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const ERRORS_TS = resolve(REPO_ROOT, 'packages', 'remote', 'src', 'errors.ts');

const failures = [];
const src = readFileSync(ERRORS_TS, 'utf8');

// RemoteErrorCode closed union: 4 members (feat-20260629-inspector-two-layer-model
// D-5; route-B eval drops script-timeout, sandbox dismantling drops
// inspector-write-denied, console-* renamed server-*).
const REQUIRED_CODES = [
  'script-syntax-error',
  'script-runtime-error',
  'server-startup-failed',
  'server-not-running',
];

for (const code of REQUIRED_CODES) {
  if (!src.includes(`'${code}'`)) {
    failures.push(`packages/remote/src/errors.ts missing RemoteErrorCode member '${code}'`);
  }
}

// Forbid members deleted by the radical collapse (route-B + sandbox removal +
// console->server rename); their reappearance signals a regression.
const FORBIDDEN_CODES = [
  'script-timeout',
  'inspector-write-denied',
  'console-startup-failed',
  'console-not-running',
];
for (const code of FORBIDDEN_CODES) {
  if (src.includes(`'${code}'`)) {
    failures.push(
      `packages/remote/src/errors.ts re-introduces deleted RemoteErrorCode member '${code}' (feat-20260629-inspector-two-layer-model)`,
    );
  }
}

// RemoteError class exposes the 4-field surface (.code / .expected / .hint / .message).
for (const field of ['code', 'expected', 'hint']) {
  const re = new RegExp(`readonly\\s+${field}\\s*:`);
  if (!re.test(src)) {
    failures.push(
      `packages/remote/src/errors.ts RemoteError class missing readonly ${field} field`,
    );
  }
}

// Class extends Error so `instanceof Error` keeps working at the JSON-RPC boundary.
if (!/class\s+RemoteError\s+extends\s+Error\b/.test(src)) {
  failures.push(
    `packages/remote/src/errors.ts RemoteError class no longer "extends Error" (instanceof boundary contract)`,
  );
}

if (failures.length === 0) {
  console.log(
    `grep-console-errors: pass (4 closed-union members + 4 deleted forbidden + class shape)`,
  );
  process.exit(0);
} else {
  console.error('grep-console-errors: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
