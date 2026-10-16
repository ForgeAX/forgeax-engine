// emit-fix-hint.test.mjs (bug-20260514 M2 / T-004)
//
// Drives scripts/dependabot/emit-fix-hint.mjs (T-005) via TDD red-green
// (plan-strategy section 4.1). Asserts the AC-03 three-element output
// contract literally, so future edits cannot drift the marker / ref / fix
// command sequence without breaking this test:
//
//   (1) marker `FORGEAX_BUN_LOCK_OUT_OF_SYNC` appears in stdout exactly once
//   (2) stdout has a `ref: dependabot/npm_and_yarn/<exact>` line; ref is
//       injected from env (`GITHUB_HEAD_REF`) or argv (`--ref=...`), never
//       inferred from prose
//   (3) stdout has a `commands:` block with 6 shell lines, byte-equal to
//       the literal sequence pinned by plan-strategy section 7.3
//   (4) stdout includes GitHub Actions log command prefixes
//       `::error title=` and `::group::FIX_INSTRUCTIONS` / `::endgroup::`
//
// Reference:
//   - requirements section AC-03 / 8.2 (three-element fail-safe path)
//   - plan-strategy section 4.3 (marker literal exactly once)
//     / section 7.3 (error message structure)
//   - charter proposition 4 (explicit failure > silent)

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildHint, MARKER, main } from '../emit-fix-hint.mjs';

const here = resolve(import.meta.dirname);
const repoRoot = resolve(here, '..', '..', '..');
const script = resolve(repoRoot, 'scripts/dependabot/emit-fix-hint.mjs');

const SAMPLE_REF = 'dependabot/npm_and_yarn/example-pkg-1.2.3';

const COMMAND_LINES = (ref) => [
  `  git fetch origin ${ref}:_dependabot_fix`,
  '  git checkout _dependabot_fix',
  '  bun install --ignore-scripts',
  '  git add bun.lock',
  '  git commit -m "chore(deps): sync bun.lock for dependabot bump"',
  `  git push origin HEAD:${ref}`,
];

function runScript(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_HEAD_REF: '', ...env },
  });
}

describe('emit-fix-hint.mjs (T-004 contract)', () => {
  it('(1) marker appears exactly once on stdout when ref is injected via --ref', () => {
    const r = runScript([`--ref=${SAMPLE_REF}`], {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(1);
    const matches = r.stdout.match(new RegExp(MARKER, 'g'));
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);

    const hint = buildHint(SAMPLE_REF);
    const inMatches = hint.match(new RegExp(MARKER, 'g'));
    expect(inMatches.length).toBe(1);
  });

  it('(2) ref line is injected from --ref argv, not inferred', () => {
    const r = runScript([`--ref=${SAMPLE_REF}`], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`ref: ${SAMPLE_REF}`);

    const hint = buildHint(SAMPLE_REF);
    expect(hint).toContain(`ref: ${SAMPLE_REF}`);
  });

  it('(2b) ref line is injected from GITHUB_HEAD_REF env when --ref not given', () => {
    const r = runScript([], { GITHUB_HEAD_REF: SAMPLE_REF });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`ref: ${SAMPLE_REF}`);
  });

  it('(3) commands block has 6 literal shell lines pinned by plan-strategy 7.3', () => {
    const r = runScript([`--ref=${SAMPLE_REF}`], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('commands:\n');
    for (const line of COMMAND_LINES(SAMPLE_REF)) {
      expect(r.stdout).toContain(`${line}\n`);
    }

    const hint = buildHint(SAMPLE_REF);
    for (const line of COMMAND_LINES(SAMPLE_REF)) {
      expect(hint).toContain(`${line}\n`);
    }
  });

  it('(3b) commands block lines appear in pinned order', () => {
    const hint = buildHint(SAMPLE_REF);
    const lines = COMMAND_LINES(SAMPLE_REF);
    let cursor = 0;
    for (const line of lines) {
      const next = hint.indexOf(line, cursor);
      expect(next, `expected "${line}" after position ${cursor}`).toBeGreaterThanOrEqual(cursor);
      cursor = next + line.length;
    }
  });

  it('(4) GitHub Actions log command prefixes present', () => {
    const r = runScript([`--ref=${SAMPLE_REF}`], {});
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=');
    expect(r.stdout).toContain(`::error title=${MARKER}::`);
    expect(r.stdout).toContain('::group::FIX_INSTRUCTIONS');
    expect(r.stdout).toContain('::endgroup::');
  });

  it('(5) self-test mode (no ref) emits hint with placeholder ref and exits 0', () => {
    // Sweep entry `node scripts/dependabot/emit-fix-hint.mjs` (no argv, no env)
    // must succeed -- otherwise the M2 milestoneCISweep last gate goes red on
    // a script whose business is to be red. Self-test mode prints the hint
    // template with a placeholder ref so the marker / commands contract still
    // self-validates, then exits 0.
    const r = runScript([], {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    const matches = r.stdout.match(new RegExp(MARKER, 'g'));
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);
    expect(r.stdout).toMatch(/^ref: dependabot\/npm_and_yarn\//m);
  });

  it('(6) main() returns structured { exitCode, stdout } for in-process callers', () => {
    const real = main([`--ref=${SAMPLE_REF}`], {});
    expect(real.exitCode).toBe(1);
    expect(real.stdout).toContain(MARKER);
    expect(real.stdout).toContain(`ref: ${SAMPLE_REF}`);

    const selfTest = main([], {});
    expect(selfTest.exitCode).toBe(0);
    expect(selfTest.stdout).toContain(MARKER);
  });
});
