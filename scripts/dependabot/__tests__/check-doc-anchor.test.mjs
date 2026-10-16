// check-doc-anchor.test.mjs (bug-20260514 M4 / T-013)
//
// Drives scripts/dependabot/check-doc-anchor.mjs (T-014) via TDD red-green
// (plan-strategy section 4.1 / 4.3 / 7.4). Asserts the four single-hop
// grep anchors that bind the discoverability triangle:
//
//   (1) AGENTS.md contains the literal marker `FORGEAX_BUN_LOCK_OUT_OF_SYNC`
//   (2) AGENTS.md contains the literal workflow filename
//       `sync-bun-lock-on-dependabot.yml` (marker -> workflow single hop)
//   (3) .github/workflows/sync-bun-lock-on-dependabot.yml contains the
//       literal marker (forward hop, log -> workflow grep alignment)
//   (4) The workflow header (first 12 lines) contains the literal
//       `AGENTS.md` (workflow -> doc reverse hop, charter proposition 1
//       progressive disclosure)
//
// Each assertion is asserted both on the live repo files (positive case)
// and on a temp-fixture mutation that violates exactly one anchor at a
// time (negative case), so the script's fail-fast stderr message is
// machine-grep-friendly: any drift surfaces the offending anchor by
// literal name.
//
// Reference:
//   - requirements section AC-08 (self-describing docs)
//   - plan-strategy section 3 R-AGENTS-Md-Drift (grep gate fail-fast)
//     / section 4.3 / section 7.4 (four single-hop link checks)
//   - charter proposition 1 (progressive disclosure single-hop reach)

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGENTS_MD,
  ANCHORS,
  main as cdaMain,
  HEADER_LINES,
  MARKER,
  runChecks,
  WORKFLOW_FILENAME,
  WORKFLOW_PATH,
} from '../check-doc-anchor.mjs';

const here = resolve(import.meta.dirname);
const repoRoot = resolve(here, '..', '..', '..');
const script = resolve(repoRoot, 'scripts/dependabot/check-doc-anchor.mjs');

function runScript(cwd) {
  return spawnSync(process.execPath, [script, cwd], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-anchor-'));
  // Mirror the real repo layout enough for the script to find both files.
  cpSync(join(repoRoot, 'AGENTS.md'), join(dir, 'AGENTS.md'));
  const wfDir = join(dir, '.github', 'workflows');
  spawnSync('mkdir', ['-p', wfDir]);
  cpSync(
    join(repoRoot, '.github', 'workflows', 'sync-bun-lock-on-dependabot.yml'),
    join(wfDir, 'sync-bun-lock-on-dependabot.yml'),
  );
  return dir;
}

function withFixtureMutation(mutate) {
  const dir = makeFixtureRepo();
  try {
    mutate(dir);
    return runChecks(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-doc-anchor.mjs (T-013 four grep anchors)', () => {
  it('exports the canonical anchor literals (SSOT contract)', () => {
    expect(MARKER).toBe('FORGEAX_BUN_LOCK_OUT_OF_SYNC');
    expect(WORKFLOW_FILENAME).toBe('sync-bun-lock-on-dependabot.yml');
    expect(ANCHORS.length).toBe(4);
    // Each anchor declares a literal + which file is being grepped.
    for (const a of ANCHORS) {
      expect(typeof a.literal).toBe('string');
      expect(a.literal.length).toBeGreaterThan(0);
      expect(typeof a.file).toBe('string');
      expect(a.file.length).toBeGreaterThan(0);
      expect(typeof a.id).toBe('string');
    }
  });

  it('(positive) live repo: all four anchors hit -> exit 0, empty stderr', () => {
    const r = runScript(repoRoot);
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('(positive) runChecks(repoRoot) returns ok=true with no missing anchors', () => {
    const r = runChecks(repoRoot);
    expect(r.ok).toBe(true);
    expect(r.missing.length).toBe(0);
  });

  it('(1) AGENTS.md missing marker literal -> exit 1, stderr names the anchor', () => {
    const r = withFixtureMutation((dir) => {
      const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      // Strip every marker occurrence from AGENTS.md only; workflow keeps it.
      const stripped = text.split(MARKER).join('REDACTED');
      writeFileSync(join(dir, 'AGENTS.md'), stripped);
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.id === 'A1-marker-in-agents-md')).toBe(true);
    const msg = r.missing.map((m) => m.literal).join('\n');
    expect(msg).toContain(MARKER);
  });

  it('(2) AGENTS.md missing workflow filename literal -> exit 1, stderr names the anchor', () => {
    const r = withFixtureMutation((dir) => {
      const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      const stripped = text.split(WORKFLOW_FILENAME).join('REDACTED.yml');
      writeFileSync(join(dir, 'AGENTS.md'), stripped);
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.id === 'A2-workflow-filename-in-agents-md')).toBe(true);
  });

  it('(3) workflow yaml missing marker literal -> exit 1, stderr names the anchor', () => {
    const r = withFixtureMutation((dir) => {
      const wfPath = join(dir, '.github', 'workflows', WORKFLOW_FILENAME);
      const text = readFileSync(wfPath, 'utf8');
      const stripped = text.split(MARKER).join('REDACTED');
      writeFileSync(wfPath, stripped);
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.id === 'A3-marker-in-workflow')).toBe(true);
  });

  it('(4) workflow header (first 12 lines) missing AGENTS.md literal -> exit 1', () => {
    const r = withFixtureMutation((dir) => {
      const wfPath = join(dir, '.github', 'workflows', WORKFLOW_FILENAME);
      const text = readFileSync(wfPath, 'utf8');
      const lines = text.split('\n');
      // Strip 'AGENTS.md' from the first 12 lines only; rest of the file
      // unchanged. Anchor 4 looks at the header window specifically.
      for (let i = 0; i < Math.min(12, lines.length); i += 1) {
        lines[i] = lines[i].replaceAll('AGENTS.md', 'REDACTED.md');
      }
      writeFileSync(wfPath, lines.join('\n'));
    });
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.id === 'A4-agents-md-in-workflow-header')).toBe(true);
  });

  it('CLI exit code mirrors runChecks: positive -> 0, negative -> 1 with stderr', () => {
    const tmp = makeFixtureRepo();
    try {
      // Positive run on the freshly copied fixture (untouched).
      const okRun = spawnSync(process.execPath, [script, tmp], { encoding: 'utf8' });
      expect(okRun.status, `stderr=${okRun.stderr}`).toBe(0);

      // Mutate to break anchor 1 then re-run.
      const text = readFileSync(join(tmp, 'AGENTS.md'), 'utf8');
      writeFileSync(join(tmp, 'AGENTS.md'), text.split(MARKER).join('REDACTED'));
      const failRun = spawnSync(process.execPath, [script, tmp], { encoding: 'utf8' });
      expect(failRun.status).toBe(1);
      expect(failRun.stderr).toContain(MARKER);
      expect(failRun.stderr).toContain('A1-marker-in-agents-md');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('main([cwd]) returns structured ok result on a healthy fixture', () => {
    const tmp = makeFixtureRepo();
    try {
      const r = cdaMain([tmp]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('OK');
      expect(r.stderr).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('main([cwd]) returns exitCode=1 and stderr with anchor ids on drift', () => {
    const tmp = makeFixtureRepo();
    try {
      const text = readFileSync(join(tmp, 'AGENTS.md'), 'utf8');
      writeFileSync(join(tmp, 'AGENTS.md'), text.split(MARKER).join('REDACTED'));
      const r = cdaMain([tmp]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('FAIL');
      expect(r.stderr).toContain(MARKER);
      expect(r.stderr).toContain('Hint:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('main([]) falls back to process.cwd() (covers default-arg branch)', () => {
    // Run with the repoRoot as cwd so the live anchors hit (= ok=true).
    const orig = process.cwd();
    try {
      process.chdir(repoRoot);
      const r = cdaMain([]);
      expect(r.exitCode).toBe(0);
    } finally {
      process.chdir(orig);
    }
  });

  it('runChecks surfaces unreadable AGENTS.md as missing entries', () => {
    // Empty temp dir: neither AGENTS.md nor workflow file exists -> all 4
    // anchors land in the missing list with file-unreadable reason. Covers
    // readSafe error branch + missing-due-to-IO path.
    const tmp = mkdtempSync(join(tmpdir(), 'check-doc-anchor-empty-'));
    try {
      const r = runChecks(tmp);
      expect(r.ok).toBe(false);
      // Each missing entry must reference its anchor literal verbatim, so an
      // AI user grepping the stderr can identify which anchor regressed.
      const ids = r.missing.map((m) => m.id);
      expect(ids).toContain('A1-marker-in-agents-md');
      expect(ids).toContain('A2-workflow-filename-in-agents-md');
      expect(ids).toContain('A3-marker-in-workflow');
      expect(ids).toContain('A4-agents-md-in-workflow-header');
      for (const m of r.missing) {
        expect(m.reason.toLowerCase()).toMatch(/unreadable|not found|enoent/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('exposes AGENTS_MD / WORKFLOW_PATH / HEADER_LINES constants for callers', () => {
    expect(AGENTS_MD).toBe('AGENTS.md');
    expect(WORKFLOW_PATH).toBe(`.github/workflows/${WORKFLOW_FILENAME}`);
    expect(HEADER_LINES).toBeGreaterThanOrEqual(10);
    expect(HEADER_LINES).toBeLessThanOrEqual(20);
  });
});
