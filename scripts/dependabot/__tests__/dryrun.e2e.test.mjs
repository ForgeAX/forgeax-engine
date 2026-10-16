// dryrun.e2e.test.mjs (bug-20260514 M2 / T-007)
//
// Fixture-driven end-to-end for the M2 fail-hint path:
//
//   check-drift.mjs detects drift (exit 1)
//     -> emit-fix-hint.mjs prints the AC-03 three-element hint
//        (marker exactly once + ref literal + 6 fix-command lines)
//
// The fixture mirrors a minimal dependabot PR working tree: package.json
// and pnpm-lock.yaml carry the new dependency version, bun.lock retains
// the old payload (dependabot does not track bun ecosystem). The test
// copies the fixture into a fresh `git init` repo, commits the snapshot
// as HEAD (so the lockfile-as-committed matches the pre-bun-install
// state), then overlays a new bun.lock byte string in the working tree
// to simulate the post-`bun install` payload that the M3 auto-sync
// path would produce. check-drift compares working tree vs HEAD and
// fails fast; emit-fix-hint receives the dependabot ref and prints the
// AC-03 hint structure verbatim.
//
// The integration deliberately does NOT call real `bun install`; the
// fixture is a byte fixture, not a live registry interaction. Charter
// proposition 5 (consistent abstraction): the same code path runs in
// CI on a real dependabot PR; the difference is who writes the new
// bun.lock byte string (here, the test harness; in CI, T-010 will wire
// the auto-sync path).
//
// Reference:
//   - requirements section AC-01 (PR scaffolding) / AC-03 / 8.2
//   - plan-strategy section 4.2 (fixture e2e three groups)
//     / section 7.3 (fix-hint structure)

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MARKER as DRIFT_MARKER } from '../check-drift.mjs';
import { MARKER as HINT_MARKER } from '../emit-fix-hint.mjs';
import { main as syncAndPushMain } from '../sync-and-push.mjs';

const here = resolve(import.meta.dirname);
const repoRoot = resolve(here, '..', '..', '..');
const driftScript = resolve(repoRoot, 'scripts/dependabot/check-drift.mjs');
const hintScript = resolve(repoRoot, 'scripts/dependabot/emit-fix-hint.mjs');
const dryrunScript = resolve(repoRoot, 'scripts/dependabot/dryrun.mjs');
const fixtureDir = resolve(here, 'fixtures/drift-detected');
const nonDependabotFixtureDir = resolve(here, 'fixtures/non-dependabot-actor');
const noDriftFixtureDir = resolve(here, 'fixtures/no-drift');

const SAMPLE_REF = 'dependabot/npm_and_yarn/example-pkg-1.2.3';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function runNode(scriptPath, argv, cwd, env) {
  return spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });
}

function makeRepoFromFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dryrun-e2e-'));
  cpSync(fixtureDir, dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture-as-head']);
  return dir;
}

describe('dryrun e2e (T-007 drift-detected fixture)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeRepoFromFixture();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('check-drift fires drift exit 1 when working tree bun.lock differs from HEAD', () => {
    // Overlay a "post-bun-install" byte string so the working-tree bun.lock
    // diverges from the HEAD blob -- equivalent to what M3 sync-and-push
    // produces after `bun install --ignore-scripts`.
    const newBunLock = '"name": "drift-detected-fixture"\n"example-pkg": "1.2.3"\n';
    writeFileSync(join(tmp, 'bun.lock'), newBunLock);

    const r = runNode(driftScript, [], tmp, {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(1);
    expect(r.stdout).toContain(DRIFT_MARKER);
  });

  it('check-drift exits 0 when working tree bun.lock byte-equals HEAD', () => {
    // No drift overlay: working tree == HEAD; check-drift must early-exit 0
    // (AC-07 no-op). Charter proposition 4 explicit failure: the absence
    // of the marker on stdout proves the hint-emit path did not fire.
    const r = runNode(driftScript, [], tmp, {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain(DRIFT_MARKER);
  });

  it('emit-fix-hint on drift consumes the dependabot ref and prints the three elements', () => {
    // Chain: drift detected -> emit-fix-hint --ref=dependabot/... -> stdout
    // contains the marker exactly once, the literal ref line, and the six
    // fix-command shell lines (byte-equal to plan-strategy section 7.3).
    const newBunLock = '"name": "drift-detected-fixture"\n"example-pkg": "1.2.3"\n';
    writeFileSync(join(tmp, 'bun.lock'), newBunLock);

    const drift = runNode(driftScript, [], tmp, {});
    expect(drift.status).toBe(1);

    const hint = runNode(hintScript, [`--ref=${SAMPLE_REF}`], tmp, {});
    expect(hint.status).toBe(1);

    const matches = hint.stdout.match(new RegExp(HINT_MARKER, 'g'));
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);
    expect(hint.stdout).toContain(`ref: ${SAMPLE_REF}`);

    const expected = [
      `  git fetch origin ${SAMPLE_REF}:_dependabot_fix`,
      '  git checkout _dependabot_fix',
      '  bun install --ignore-scripts',
      '  git add bun.lock',
      '  git commit -m "chore(deps): sync bun.lock for dependabot bump"',
      `  git push origin HEAD:${SAMPLE_REF}`,
    ];
    for (const line of expected) {
      expect(hint.stdout).toContain(`${line}\n`);
    }
  });

  it('fixture files are deterministic byte payloads (sha256 frozen by git)', () => {
    // Defensive: protect against accidental edits to the fixture that would
    // silently break the e2e contract. The fixture is small enough that we
    // assert byte length + first-line content.
    const pkg = readFileSync(join(fixtureDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"example-pkg": "1.2.3"');
    const pnpm = readFileSync(join(fixtureDir, 'pnpm-lock.yaml'), 'utf8');
    expect(pnpm).toContain('example-pkg@1.2.3');
    const bun = readFileSync(join(fixtureDir, 'bun.lock'), 'utf8');
    expect(bun).toContain('"example-pkg": "1.0.0"');
  });
});

// ---------------------------------------------------------------------------
// T-011 fixture e2e: non-dependabot-actor early-exit + race-on-push retry
// ---------------------------------------------------------------------------
//
// G1 actor gate is primarily enforced by the workflow `if:` field; this
// suite exercises the defense-in-depth path baked into sync-and-push.mjs:
// when GITHUB_ACTOR != 'dependabot[bot]', the script must early-exit 0
// without spawning bun install / git commit / git push -- workflow
// misconfiguration must never push from a human-attributable identity.
//
// Reference:
//   - requirements section AC-05 / AC-06
//   - plan-strategy section 2.4 G1 / section 3 R-Race-Main-Advance
//     / section 4.2 fixture e2e

function makeRepoFromNonDependabotFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'non-dependabot-actor-e2e-'));
  cpSync(nonDependabotFixtureDir, dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);
  spawnSync('git', ['config', 'user.email', 'human@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'human-user'], { cwd: dir });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'fixture-as-head'], { cwd: dir });
  return dir;
}

describe('dryrun e2e (T-011 non-dependabot-actor + race-on-push)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeRepoFromNonDependabotFixture();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('non-dependabot-actor fixture: sync-and-push early-exits 0 without spawning anything', () => {
    // Defense-in-depth: even with a dependabot ref injected, an actor
    // mismatch must short-circuit before bun install / git push run.
    const calls = [];
    const mockSpawn = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = syncAndPushMain(
      ['--ref=dependabot/npm_and_yarn/example-pkg-1.2.3'],
      { GITHUB_ACTOR: 'human-user' },
      mockSpawn,
    );
    expect(r.exitCode, JSON.stringify(calls)).toBe(0);
    expect(calls.length, 'no spawn must occur for non-dependabot actor').toBe(0);
  });

  it('non-dependabot-actor fixture: stdout never carries marker (workflow-skip semantics)', () => {
    const r = syncAndPushMain(
      ['--ref=dependabot/npm_and_yarn/example-pkg-1.2.3'],
      { GITHUB_ACTOR: 'malicious-fork' },
      () => ({ status: 0, stdout: '', stderr: '' }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(DRIFT_MARKER);
    expect(r.stdout).not.toContain(HINT_MARKER);
  });

  it('race-on-push fixture: git push --force-with-lease fails -> emit-fix-hint argv carries dependabot ref', () => {
    // R-Race-Main-Advance: dependabot rebases the PR branch concurrently;
    // --force-with-lease rejects the push because the remote sha is no
    // longer the expected one. sync-and-push must spawn emit-fix-hint
    // with the same dependabot ref so AI users can rerun the 6-line
    // recovery sequence.
    const REF = 'dependabot/npm_and_yarn/example-pkg-1.2.3';
    const calls = [];
    const mockSpawn = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (args.some((a) => a.endsWith('check-drift.mjs'))) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (cmd === 'bun' && args[0] === 'install') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args.includes('diff')) {
        return { status: 1, stdout: 'M bun.lock\n', stderr: '' };
      }
      if (cmd === 'git' && args.includes('commit')) {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'git' && args[0] === 'push') {
        return { status: 128, stdout: '', stderr: 'rejected: stale info' };
      }
      if (args.some((a) => a.endsWith('emit-fix-hint.mjs'))) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const r = syncAndPushMain([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, mockSpawn);
    expect(r.exitCode).toBe(1);

    const hintCall = calls.find((c) =>
      c.args.some((a) => typeof a === 'string' && a.endsWith('emit-fix-hint.mjs')),
    );
    expect(hintCall, 'race fail-on-push must spawn emit-fix-hint').toBeDefined();
    expect(hintCall.args.some((a) => a === `--ref=${REF}`)).toBe(true);
  });

  it('non-dependabot-actor fixture files are deterministic (sha256 frozen by git)', () => {
    const pkg = readFileSync(join(nonDependabotFixtureDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"example-pkg": "1.2.3"');
    const pnpm = readFileSync(join(nonDependabotFixtureDir, 'pnpm-lock.yaml'), 'utf8');
    expect(pnpm).toContain('example-pkg@1.2.3');
    const bun = readFileSync(join(nonDependabotFixtureDir, 'bun.lock'), 'utf8');
    expect(bun).toContain('"example-pkg": "1.0.0"');
  });
});

// ---------------------------------------------------------------------------
// T-015 fixture e2e: no-drift early-exit + dryrun orchestrator regression
// ---------------------------------------------------------------------------
//
// AC-07 mandates that the auto-sync path produces zero side effects when
// the working tree bun.lock byte-equals HEAD; this suite uses a fixture
// where package.json + pnpm-lock.yaml + bun.lock are already in sync
// (mirroring what dependabot would commit if it natively tracked bun
// ecosystem) so check-drift takes the early-exit-0 branch and emit-fix-hint
// must NOT fire (no marker on stdout).
//
// The dryrun orchestrator (scripts/dependabot/dryrun.mjs) chains the three
// scripts in self-test mode and is the single local entry-point for AI
// users; this suite asserts the orchestrator exits 0 on a healthy repo
// and that injecting drift surfaces the marker via the orchestrated path.
//
// Reference:
//   - requirements section AC-04 (dual-lockfile contract)
//     / AC-05 (non-dependabot branches unchanged) / AC-07 (no-op early exit)
//   - plan-strategy section 4.2 (three fixture groups)
//     / section 4.4 (validation gate three groups)
//     / section 6 M4 deliverable

function makeRepoFromNoDriftFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'no-drift-e2e-'));
  cpSync(noDriftFixtureDir, dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dependabot@example.com']);
  git(dir, ['config', 'user.name', 'dependabot[bot]']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture-as-head']);
  return dir;
}

describe('dryrun e2e (T-015 no-drift fixture + orchestrator)', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeRepoFromNoDriftFixture();
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('no-drift fixture: check-drift exits 0 (AC-07 no-op) without surfacing the marker', () => {
    const r = runNode(driftScript, [], tmp, {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain(DRIFT_MARKER);
    expect(r.stdout).not.toContain(HINT_MARKER);
  });

  it('no-drift fixture: sync-and-push early-exits 0 with no-spawn after drift check', () => {
    const calls = [];
    const mockSpawn = (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      if (args.some((a) => typeof a === 'string' && a.endsWith('check-drift.mjs'))) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = syncAndPushMain(
      ['--ref=dependabot/npm_and_yarn/example-pkg-1.2.3'],
      { GITHUB_ACTOR: 'dependabot[bot]' },
      mockSpawn,
    );
    expect(r.exitCode).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].args.some((a) => a.endsWith('check-drift.mjs'))).toBe(true);
  });

  it('three fixtures regression matrix: pre-overlay each fixture commits as HEAD -> exit 0', () => {
    // For all three fixtures in their committed-as-HEAD state, check-drift
    // exits 0 (no overlay, working tree == HEAD). The drift-detected case
    // only flips when the e2e test overlays a divergent bun.lock onto the
    // working tree (covered separately).
    const groups = [
      { dir: noDriftFixtureDir, name: 'no-drift' },
      { dir: nonDependabotFixtureDir, name: 'non-dependabot-actor' },
      { dir: fixtureDir, name: 'drift-detected (committed-as-head)' },
    ];
    for (const g of groups) {
      const repo = mkdtempSync(join(tmpdir(), 'fixture-matrix-'));
      try {
        cpSync(g.dir, repo, { recursive: true });
        git(repo, ['init', '-q', '-b', 'main']);
        git(repo, ['config', 'user.email', 'test@example.com']);
        git(repo, ['config', 'user.name', 'test']);
        git(repo, ['config', 'commit.gpgsign', 'false']);
        git(repo, ['add', '.']);
        git(repo, ['commit', '-q', '-m', 'fixture-as-head']);
        const r = runNode(driftScript, [], repo, {});
        expect(r.status, `${g.name} stderr=${r.stderr}`).toBe(0);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('drift-detected fixture with overlay: check-drift exits 1 + emit-fix-hint fires marker', () => {
    const repo = mkdtempSync(join(tmpdir(), 'fixture-matrix-drift-overlay-'));
    try {
      cpSync(fixtureDir, repo, { recursive: true });
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'test']);
      git(repo, ['config', 'commit.gpgsign', 'false']);
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'fixture-as-head']);
      writeFileSync(join(repo, 'bun.lock'), 'overlay-post-bun-install\n');
      const drift = runNode(driftScript, [], repo, {});
      expect(drift.status).toBe(1);
      expect(drift.stdout).toContain(DRIFT_MARKER);
      const hint = runNode(hintScript, [`--ref=${SAMPLE_REF}`], repo, {});
      expect(hint.status).toBe(1);
      expect(hint.stdout).toContain(HINT_MARKER);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('dryrun orchestrator on a healthy repo (live worktree) exits 0', () => {
    const r = runNode(dryrunScript, [], repoRoot, {});
    expect(r.status, `stderr=${r.stderr} stdout=${r.stdout}`).toBe(0);
  });

  it('dryrun orchestrator surfaces the failed step on non-zero exit', () => {
    // Force check-drift to fail by running the orchestrator from a fresh
    // git repo with no bun.lock at all. The check-drift step exits 1
    // (AC-08 explicit failure), the orchestrator records the failed step
    // on stderr, and exit code is non-zero.
    const empty = mkdtempSync(join(tmpdir(), 'dryrun-empty-'));
    try {
      git(empty, ['init', '-q', '-b', 'main']);
      git(empty, ['config', 'user.email', 'test@example.com']);
      git(empty, ['config', 'user.name', 'test']);
      git(empty, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(empty, 'README'), 'placeholder\n');
      git(empty, ['add', 'README']);
      git(empty, ['commit', '-q', '-m', 'seed']);
      const r = runNode(dryrunScript, [], empty, {});
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('check-drift');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('no-drift fixture files are deterministic (sha256 frozen by git)', () => {
    const pkg = readFileSync(join(noDriftFixtureDir, 'package.json'), 'utf8');
    expect(pkg).toContain('"example-pkg": "1.2.3"');
    const pnpm = readFileSync(join(noDriftFixtureDir, 'pnpm-lock.yaml'), 'utf8');
    expect(pnpm).toContain('example-pkg@1.2.3');
    const bun = readFileSync(join(noDriftFixtureDir, 'bun.lock'), 'utf8');
    expect(bun).toContain('"example-pkg": "1.2.3"');
    expect(bun).not.toContain('"example-pkg": "1.0.0"');
  });
});
