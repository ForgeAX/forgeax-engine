// check-drift.test.mjs (bug-20260514 M1 / T-001)
//
// Drives scripts/dependabot/check-drift.mjs (T-002) via TDD red-green
// (plan-strategy section 4.1). Three paths covered:
//
//   (1) working tree bun.lock byte-equal to git show HEAD:bun.lock -> exit 0,
//       no marker on stdout, stderr empty (or only whitespace-equivalent).
//   (2) bytes differ -> exit 1, stdout contains the literal marker
//       'FORGEAX_BUN_LOCK_OUT_OF_SYNC' plus the two side byte lengths
//       (working tree size + HEAD blob size).
//   (3) bun.lock missing in working tree OR not tracked at HEAD -> exit 1,
//       stderr contains an explicit reason string identifying which side
//       was missing.
//
// All three paths use a vitest-managed temporary git repository fixture
// (mkdtempSync + git init + git commit) so no real `bun install` runs and
// no network access is needed. The fixture seeds two different bun.lock
// payloads to keep the byte-difference assertion deterministic.
//
// Reference:
//   - requirements section AC-01 / AC-02 / 7 (drift detector self-error
//     must be explicit)
//   - research section 1.4 (pnpm run sync drift fallback fact)
//   - plan-strategy section 4.1 strict TDD red-green-refactor scope /
//     section 4.4 unit coverage >= 90%

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkDrift, MARKER } from '../check-drift.mjs';

const here = resolve(import.meta.dirname);
const repoRoot = resolve(here, '..', '..', '..');
const script = resolve(repoRoot, 'scripts/dependabot/check-drift.mjs');

function runScript(cwd) {
  return spawnSync(process.execPath, [script, cwd], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function runInProc(cwd) {
  // In-process call so vitest v8 coverage instruments the implementation.
  // Mirrors runScript so each spawn assertion has a coverage-instrumented twin.
  return checkDrift(cwd);
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-drift-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

describe('check-drift.mjs (T-001 three paths)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempRepo();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('(1) bytes equal: exit 0, no drift marker on stdout', () => {
    const payload = 'lockfile-payload-A\n';
    writeFileSync(join(tmp, 'bun.lock'), payload);
    git(tmp, ['add', 'bun.lock']);
    git(tmp, ['commit', '-q', '-m', 'seed']);

    const r = runScript(tmp);
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain(MARKER);

    const inproc = runInProc(tmp);
    expect(inproc.exitCode).toBe(0);
    expect(inproc.stdout).not.toContain(MARKER);
  });

  it('(2) bytes differ: exit 1, stdout contains marker + both byte lengths', () => {
    const seed = 'lockfile-payload-A\n';
    writeFileSync(join(tmp, 'bun.lock'), seed);
    git(tmp, ['add', 'bun.lock']);
    git(tmp, ['commit', '-q', '-m', 'seed']);

    // Working tree drifts away from HEAD blob (different bytes + length).
    const drifted = 'lockfile-payload-B-with-extra-bytes\n';
    writeFileSync(join(tmp, 'bun.lock'), drifted);

    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(MARKER);
    expect(r.stdout).toContain(String(Buffer.byteLength(drifted)));
    expect(r.stdout).toContain(String(Buffer.byteLength(seed)));

    const inproc = runInProc(tmp);
    expect(inproc.exitCode).toBe(1);
    expect(inproc.stdout).toContain(MARKER);
    expect(inproc.stdout).toContain(String(Buffer.byteLength(drifted)));
    expect(inproc.stdout).toContain(String(Buffer.byteLength(seed)));
  });

  it('(3a) working tree bun.lock missing: exit 1, stderr explains missing side', () => {
    const seed = 'lockfile-payload-A\n';
    writeFileSync(join(tmp, 'bun.lock'), seed);
    git(tmp, ['add', 'bun.lock']);
    git(tmp, ['commit', '-q', '-m', 'seed']);
    unlinkSync(join(tmp, 'bun.lock'));

    const r = runScript(tmp);
    expect(r.status).toBe(1);
    // stderr must explain which side was missing in machine-grep-friendly form.
    expect(r.stderr).toMatch(/bun\.lock/);
    expect(r.stderr.toLowerCase()).toMatch(/working|missing|not found|absent/);

    const inproc = runInProc(tmp);
    expect(inproc.exitCode).toBe(1);
    expect(inproc.stderr).toMatch(/bun\.lock/);
    expect(inproc.stderr.toLowerCase()).toMatch(/working|missing|not found|absent/);
  });

  it('(3b) HEAD has no bun.lock blob: exit 1, stderr explains missing HEAD side', () => {
    // Repo with one commit but no bun.lock tracked.
    writeFileSync(join(tmp, 'README'), 'placeholder\n');
    git(tmp, ['add', 'README']);
    git(tmp, ['commit', '-q', '-m', 'seed-without-bun-lock']);
    // Add a working-tree bun.lock to make sure the failure is HEAD-side only.
    writeFileSync(join(tmp, 'bun.lock'), 'wt-only\n');

    const r = runScript(tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HEAD/);
    expect(r.stderr).toMatch(/bun\.lock/);

    const inproc = runInProc(tmp);
    expect(inproc.exitCode).toBe(1);
    expect(inproc.stderr).toMatch(/HEAD/);
    expect(inproc.stderr).toMatch(/bun\.lock/);
  });

  it('(3c) bun.lock is a directory (readFileSync EISDIR): exit 1, stderr explains unreadable', () => {
    // Cover the readFileSync error branch by replacing the lockfile with a
    // directory entry of the same name; statSync succeeds but readFileSync
    // fails with EISDIR.
    mkdirSync(join(tmp, 'bun.lock'));
    // HEAD has no commits so the working-tree-side error fires first.
    const inproc = runInProc(tmp);
    expect(inproc.exitCode).toBe(1);
    expect(inproc.stderr.toLowerCase()).toMatch(/unreadable/);
    expect(inproc.stderr).toMatch(/bun\.lock/);
  });
});
