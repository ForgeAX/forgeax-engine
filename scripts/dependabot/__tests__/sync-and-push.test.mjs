// sync-and-push.test.mjs (bug-20260514 M3 / T-008)
//
// Drives scripts/dependabot/sync-and-push.mjs (T-009) via TDD red-green
// (plan-strategy section 4.1). Pure unit coverage of the fail-fast subgraph
// using an injected `spawn` deps object so no real `bun install` /
// `git push` runs and no network access is needed.
//
// Cases (plan-strategy section 4.3 / 2.7 / requirements AC-02 / AC-06 /
// AC-07 / risks R-Token-Insufficient / R-Race-Main-Advance /
// R-Bun-Install-Flake / R-No-Op-Empty-Commit):
//
//   (1) bun install --ignore-scripts non-zero exit
//       -> spawn emit-fix-hint --ref=<ref>, then exit 1
//   (2) git push --force-with-lease non-zero exit
//       -> spawn emit-fix-hint --ref=<ref>, then exit 1
//   (3) bun install + git diff non-empty + git commit + git push all ok
//       -> commit message literal 'chore(deps): sync bun.lock for
//          dependabot bump', author config injected as
//          github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>,
//          push uses --force-with-lease + origin HEAD:<ref>; exit 0
//   (4) bun install ok but `git diff --quiet -- bun.lock` exit 0 (no diff)
//       -> no-op exit 0, NO commit / push spawned
//
// Plus:
//   (5) check-drift early exit 0 (no drift) -> sync-and-push exits 0 no-op,
//       no bun install invoked.
//   (6) actor != 'dependabot[bot]' -> defense-in-depth early exit 0 no-op,
//       NO drift / install / commit / push spawned. (T-011 anchor;
//       workflow `if:` G1 is the primary gate, this is the second layer.)
//   (7) self-test mode (no GITHUB_HEAD_REF / no --ref / no GITHUB_ACTOR
//       set, OR --self-test argv) prints a banner and exits 0 so the
//       milestoneCISweep gate `node scripts/dependabot/sync-and-push.mjs`
//       can run on main without a fake dependabot context.
//
// Reference:
//   - requirements section AC-02 / AC-06 / AC-07
//   - plan-strategy section 2.5 (commit message + author) / 2.7 (--force-with-lease)
//     / 4.3 (key test points) / 7.3 (error message structure shared marker)
//   - charter proposition 4 (explicit failure > silent)

import { describe, expect, it } from 'vitest';

import {
  COMMIT_AUTHOR_EMAIL,
  COMMIT_AUTHOR_NAME,
  COMMIT_MESSAGE,
  main,
} from '../sync-and-push.mjs';

const REF = 'dependabot/npm_and_yarn/example-pkg-1.2.3';

// ---------------------------------------------------------------------------
// Spawn mock harness. The real script delegates every external call through
// the injected `spawn(cmd, args, opts)` so tests can route by command.
// Each case configures a queue of responders and asserts the resulting
// invocation log byte-for-byte (commit message + author + --force-with-lease
// argv literal).
// ---------------------------------------------------------------------------

function makeSpawn(handlers) {
  const calls = [];
  function spawn(cmd, args, opts = {}) {
    calls.push({ cmd, args: [...args], opts });
    for (const h of handlers) {
      const r = h(cmd, args, opts);
      if (r !== undefined) return r;
    }
    return { status: 0, stdout: '', stderr: '' };
  }
  return { spawn, calls };
}

function isCheckDrift(cmd, args) {
  return cmd === process.execPath && args.some((a) => a.endsWith('check-drift.mjs'));
}
function isEmitHint(cmd, args) {
  return cmd === process.execPath && args.some((a) => a.endsWith('emit-fix-hint.mjs'));
}
function isBunInstall(cmd, args) {
  return cmd === 'bun' && args[0] === 'install';
}
function isGitDiff(cmd, args) {
  return cmd === 'git' && args.includes('diff');
}
function isGitCommit(cmd, args) {
  return cmd === 'git' && args.includes('commit');
}
function isGitPush(cmd, args) {
  return cmd === 'git' && args[0] === 'push';
}

describe('sync-and-push.mjs (T-008 fail-fast subgraph)', () => {
  it('(1) bun install --ignore-scripts non-zero -> spawn emit-fix-hint + exit 1', () => {
    const { spawn, calls } = makeSpawn([
      (cmd, args) => (isCheckDrift(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
      (cmd, args) =>
        isBunInstall(cmd, args) ? { status: 1, stdout: '', stderr: 'enoent' } : undefined,
      (cmd, args) => (isEmitHint(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
    ]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode, JSON.stringify(calls)).toBe(1);

    const installCall = calls.find((c) => isBunInstall(c.cmd, c.args));
    expect(installCall).toBeDefined();
    expect(installCall.args).toEqual(['install', '--ignore-scripts']);

    const hintCall = calls.find((c) => isEmitHint(c.cmd, c.args));
    expect(hintCall, 'emit-fix-hint must be spawned on bun install failure').toBeDefined();
    expect(hintCall.args.some((a) => a === `--ref=${REF}`)).toBe(true);

    expect(calls.find((c) => isGitCommit(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isGitPush(c.cmd, c.args))).toBeUndefined();
  });

  it('(2) git push --force-with-lease non-zero -> spawn emit-fix-hint + exit 1', () => {
    const { spawn, calls } = makeSpawn([
      (cmd, args) => (isCheckDrift(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
      (cmd, args) => (isBunInstall(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
      (cmd, args) =>
        isGitDiff(cmd, args) ? { status: 1, stdout: 'M bun.lock\n', stderr: '' } : undefined,
      (cmd, args) => (isGitCommit(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
      (cmd, args) =>
        isGitPush(cmd, args) ? { status: 128, stdout: '', stderr: 'rejected' } : undefined,
      (cmd, args) => (isEmitHint(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
    ]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode, JSON.stringify(calls)).toBe(1);

    const pushCall = calls.find((c) => isGitPush(c.cmd, c.args));
    expect(pushCall).toBeDefined();
    expect(pushCall.args.some((a) => a.startsWith('--force-with-lease'))).toBe(true);
    expect(pushCall.args).toContain('origin');
    expect(pushCall.args.some((a) => a === `HEAD:${REF}`)).toBe(true);

    const hintCall = calls.find((c) => isEmitHint(c.cmd, c.args));
    expect(hintCall, 'emit-fix-hint must be spawned on push failure').toBeDefined();
    expect(hintCall.args.some((a) => a === `--ref=${REF}`)).toBe(true);
  });

  it('(3) install + diff + commit + push all ok -> commit msg / author / lease literal; exit 0', () => {
    const { spawn, calls } = makeSpawn([
      (cmd, args) => (isCheckDrift(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
      (cmd, args) => (isBunInstall(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
      (cmd, args) =>
        isGitDiff(cmd, args) ? { status: 1, stdout: 'M bun.lock\n', stderr: '' } : undefined,
      (cmd, args) => (isGitCommit(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
      (cmd, args) => (isGitPush(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
    ]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode, JSON.stringify(calls)).toBe(0);

    const commitCall = calls.find((c) => isGitCommit(c.cmd, c.args));
    expect(commitCall).toBeDefined();
    // Author injected via -c user.name / -c user.email (not env, not amend).
    expect(commitCall.args).toContain(`user.name=${COMMIT_AUTHOR_NAME}`);
    expect(commitCall.args).toContain(`user.email=${COMMIT_AUTHOR_EMAIL}`);
    // Commit message literal byte-equal to plan-strategy 2.5 / emit-fix-hint contract.
    expect(commitCall.args).toContain('-m');
    expect(commitCall.args).toContain(COMMIT_MESSAGE);
    // Path-scoped commit so other working-tree changes are never picked up.
    expect(commitCall.args.some((a) => a === '--' || a === 'bun.lock')).toBe(true);

    const pushCall = calls.find((c) => isGitPush(c.cmd, c.args));
    expect(pushCall).toBeDefined();
    expect(pushCall.args.some((a) => a.startsWith('--force-with-lease'))).toBe(true);
    expect(pushCall.args).toContain('origin');
    expect(pushCall.args).toContain(`HEAD:${REF}`);

    expect(calls.find((c) => isEmitHint(c.cmd, c.args))).toBeUndefined();
  });

  it('(4) bun install ok + git diff exit 0 (no diff) -> no-op exit 0, no commit / push', () => {
    const { spawn, calls } = makeSpawn([
      (cmd, args) => (isCheckDrift(cmd, args) ? { status: 1, stdout: '', stderr: '' } : undefined),
      (cmd, args) => (isBunInstall(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
      (cmd, args) => (isGitDiff(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
    ]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode, JSON.stringify(calls)).toBe(0);

    expect(calls.find((c) => isGitCommit(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isGitPush(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isEmitHint(c.cmd, c.args))).toBeUndefined();
  });

  it('(5) check-drift exit 0 (no drift) -> sync-and-push exit 0 no-op, bun install never spawned', () => {
    const { spawn, calls } = makeSpawn([
      (cmd, args) => (isCheckDrift(cmd, args) ? { status: 0, stdout: '', stderr: '' } : undefined),
    ]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode).toBe(0);

    expect(calls.find((c) => isBunInstall(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isGitCommit(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isGitPush(c.cmd, c.args))).toBeUndefined();
    expect(calls.find((c) => isEmitHint(c.cmd, c.args))).toBeUndefined();
  });

  it('(6) actor != dependabot[bot] -> defense-in-depth early exit 0 no-op', () => {
    const { spawn, calls } = makeSpawn([]);

    const r = main([`--ref=${REF}`], { GITHUB_ACTOR: 'human-user' }, spawn);
    expect(r.exitCode).toBe(0);

    // Nothing spawned at all -- workflow if: G1 is the primary gate but
    // the script self-defends so even a misconfigured workflow cannot push.
    expect(calls.length).toBe(0);
  });

  it('(7) self-test mode (no ref, no env) prints banner and exits 0 for milestoneCISweep', () => {
    const { spawn, calls } = makeSpawn([]);
    const r = main([], {}, spawn);
    expect(r.exitCode).toBe(0);
    expect(calls.length).toBe(0);
    expect(typeof r.stdout).toBe('string');
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('(7b) explicit --self-test flag is a tolerated alias for milestoneCISweep', () => {
    const { spawn, calls } = makeSpawn([]);
    const r = main(['--self-test'], { GITHUB_ACTOR: 'dependabot[bot]' }, spawn);
    expect(r.exitCode).toBe(0);
    expect(calls.length).toBe(0);
  });
});
