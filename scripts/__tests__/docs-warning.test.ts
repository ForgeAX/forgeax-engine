// docs-warning.test.ts (M4 t4.6) — lint-style guardrail.
//
// Reverse-asserts that both README.md and CONTRIBUTING.md contain the
// literal strings "bun run test" (the recommended invocation) AND "bun test"
// (the anti-example we explicitly warn against). If a future edit deletes the
// warning, this test goes red.
//
// Why a *.test.ts and not a CI grep step:
//   - Local TDD loop sees the regression instantly via `vitest run`.
//   - Failure message points at the exact file (better DX than `grep` exit code).
//   - Reuses the existing dual-pipeline test runner — no new tooling.
//
// References:
//   - plan-strategy §4.3 — README warning text MUST be exercised by a unit
//     test that asserts the literal warning string is present.
//   - plan-strategy §K-6 / research §F-6 — "bun test" silently degrades the
//     suite; the docs MUST steer readers to "bun run test".
//   - plan-decisions §L-5 — placement is `scripts/__tests__/`; root vitest
//     config's `test.projects` adds `'scripts'` to pick this up.
//   - requirements §AC-12 / §AC-13 — reverse assertions on docs content.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const readmePath = resolve(repoRoot, 'README.md');
const contributingPath = resolve(repoRoot, 'CONTRIBUTING.md');

function readDoc(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('docs-warning lint (t4.6)', () => {
  it('README.md contains the recommended invocation `bun run test`', () => {
    const text = readDoc(readmePath);
    expect(text).toContain('bun run test');
  });

  it('README.md still warns against the anti-example `bun test`', () => {
    const text = readDoc(readmePath);
    expect(text).toContain('bun test');
  });

  it('CONTRIBUTING.md contains the recommended invocation `bun run test`', () => {
    const text = readDoc(contributingPath);
    expect(text).toContain('bun run test');
  });

  it('CONTRIBUTING.md still warns against the anti-example `bun test`', () => {
    const text = readDoc(contributingPath);
    expect(text).toContain('bun test');
  });
});
