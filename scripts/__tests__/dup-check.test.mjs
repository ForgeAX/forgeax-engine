// dup-check.test.mjs (M2 / T-007 red-first TDD anchor)
//
// Drives T-008/T-009/T-010/T-011 to green via subprocess-only assertions
// (the M1 skeleton spawns jscpd and runs to completion at module load,
// so direct ES-module imports of named exports are deferred to T-008's
// restructuring; T-008 adds a CLI-guard + named exports + a --skip-jscpd
// flag, at which point this same test surface keeps holding through
// stable subprocess I/O contracts).
//
// Coverage:
//   (a) PASS path: empty duplicates -> exit 0, stdout PASS marker,
//       stderr clean.
//   (b) FAIL path: 1 clone -> exit 1, stderr has the
//       'pathA:lineA-lineA <-> pathB:lineB-lineB (lines=N, tokens=M, format=F)'
//       arrow dump and the [reason] / [rerun] / [hint] 3-section footer
//       (D-P7).
//   (c) file-pair allow-list match drop: clone listed in
//       config/jscpd.json#filePairIgnore -> drop -> exit 0.
//   (d) F-2 boundary trio:
//       (i)  self-clone {a, a}: kept by default; allow-list {a, a} drops.
//       (ii) trio mutual A<->B / A<->C / B<->C: 3 distinct clones; allow
//            -listing one drops only that one.
//       (iii) order-flip {Y, X} matches allow-list entry {X, Y} via
//             unordered-set semantics.
//   (e) wrapper internal exception (JSON parse error / file missing) ->
//       exit 2 + stderr [reason] dup-check: wrapper internal error.
//
// The wrapper recognises:
//   --skip-jscpd                 (T-008+) skip the jscpd subprocess and
//                                jump straight into report-parsing.
//   --report-path <path>         (already in M1) override report file.
//   --allow-pair <pathA::pathB>  (T-009+) repeated, in-test injection
//                                point for filePairIgnore so fixtures do
//                                not have to mutate the real config/jscpd.json.
//
// AC anchors:
//   AC-05 / AC-06 / AC-16 / AC-20 / AC-21 / AC-22
// Plan anchors:
//   D-P1 / D-P6 / D-P7 / §7.2 / §7.3
// Research anchors:
//   F-2 (jscpd JSON shape) / F-3 (grep-gate idiom)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const WRAPPER = resolve(__dirname, '..', 'dup-check.mjs');
const FIX = (name) => resolve(__dirname, '..', '__fixtures__', name);

function runWrapper(args = []) {
  return spawnSync(process.execPath, [WRAPPER, '--skip-jscpd', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// ---------------------------------------------------------------------------
// (a) PASS path
// ---------------------------------------------------------------------------

describe('PASS path (T-008 + T-011 anchor)', () => {
  it('exits 0 for empty duplicates fixture', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-pass.json')]);
    expect(r.status).toBe(0);
  });

  it('emits the (dup-check) PASS marker on stdout', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-pass.json')]);
    expect(r.stdout).toMatch(/\(dup-check\)\s+PASS/);
  });

  it('keeps stderr silent on PASS (AC-05)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-pass.json')]);
    expect(r.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// (b) FAIL path: arrow dump + 3-section footer
// ---------------------------------------------------------------------------

describe('FAIL path arrow dump + footer (T-010 anchor)', () => {
  it('exits 1 when at least one clone survives post-process', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.status).toBe(1);
  });

  it('dumps one path:line <-> path:line line per kept clone (AC-06)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.stderr).toMatch(
      /apps\/foo\/src\/main\.ts:10-40\s+<->\s+apps\/bar\/src\/main\.ts:5-35\s+\(lines=30,\s+tokens=100,\s+format=typescript\)/,
    );
  });

  it('dumps one arrow line per clone in a trio (3 arrows, AC-06)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-trio.json')]);
    const arrowCount = (r.stderr.match(/<->/g) ?? []).length;
    expect(arrowCount).toBe(3);
  });

  it('emits the 3-section [reason] / [rerun] / [hint] footer (D-P7)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.stderr).toMatch(/\[reason\]/);
    expect(r.stderr).toMatch(/\[rerun\]\s+pnpm dup-check/);
    expect(r.stderr).toMatch(/\[hint\]/);
  });

  it('hint surfaces the three-way fix path (extract / filePairIgnore / minLines)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.stderr).toMatch(/extract/i);
    expect(r.stderr).toMatch(/filePairIgnore|file-pair|\.jscpd\.json/);
    expect(r.stderr).toMatch(/minLines/);
  });

  it('reason line counts the surviving clones (D-P7 wording)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    // wording per D-P7: '[reason] dup-check: <N> clone(s) detected (threshold=0)'
    expect(r.stderr).toMatch(/\[reason\]\s+dup-check:\s+1\s+clone\(s\)\s+detected/);
  });
});

// ---------------------------------------------------------------------------
// (c) file-pair allow-list drop (T-009 anchor)
// ---------------------------------------------------------------------------

describe('allow-list match drop (T-009 anchor)', () => {
  it('drops a clone whose unordered pair is in the allow-list -> exit 0', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-single.json'),
      '--allow-pair',
      'apps/foo/src/main.ts::apps/bar/src/main.ts',
    ]);
    expect(r.status).toBe(0);
  });

  it('without an allow-list the same fixture exits 1', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) F-2 boundary trio
// ---------------------------------------------------------------------------

describe('F-2 boundary: self-clone (d.i, T-009 anchor)', () => {
  it('keeps a self-clone {a, a} when allow-list does NOT list it', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-self-clone.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /packages\/math\/src\/quat\.ts:525-558\s+<->\s+packages\/math\/src\/quat\.ts:516-154/,
    );
  });

  it('drops a self-clone {a, a} when allow-list DOES list {a, a}', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-self-clone.json'),
      '--allow-pair',
      'packages/math/src/quat.ts::packages/math/src/quat.ts',
    ]);
    expect(r.status).toBe(0);
  });
});

describe('F-2 boundary: trio mutual (d.ii, T-009 anchor)', () => {
  it('lists 3 distinct clones with no allow-list', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-trio.json')]);
    expect(r.status).toBe(1);
    const arrowCount = (r.stderr.match(/<->/g) ?? []).length;
    expect(arrowCount).toBe(3);
  });

  it('allow-listing only A<->B leaves A<->C and B<->C reported (exit 1, 2 arrows)', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-trio.json'),
      '--allow-pair',
      'packages/A.ts::packages/B.ts',
    ]);
    expect(r.status).toBe(1);
    const arrowCount = (r.stderr.match(/<->/g) ?? []).length;
    expect(arrowCount).toBe(2);
    expect(r.stderr).toMatch(/packages\/A\.ts:1-30\s+<->\s+packages\/C\.ts/);
    expect(r.stderr).toMatch(/packages\/B\.ts:1-30\s+<->\s+packages\/C\.ts/);
  });

  it('allow-listing all three pairs -> exit 0', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-trio.json'),
      '--allow-pair',
      'packages/A.ts::packages/B.ts',
      '--allow-pair',
      'packages/A.ts::packages/C.ts',
      '--allow-pair',
      'packages/B.ts::packages/C.ts',
    ]);
    expect(r.status).toBe(0);
  });
});

describe('F-2 boundary: order-flip (d.iii, T-009 anchor)', () => {
  it('allow-list pair (X, Y) drops fixture clone reported as (Y, X)', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-order-flip.json'),
      '--allow-pair',
      'packages/X.ts::packages/Y.ts',
    ]);
    expect(r.status).toBe(0);
  });

  it('allow-list pair (Y, X) also drops the same fixture (set semantics)', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-order-flip.json'),
      '--allow-pair',
      'packages/Y.ts::packages/X.ts',
    ]);
    expect(r.status).toBe(0);
  });

  it('allow-list mismatch (X, Z) leaves (Y, X) clone reported -> exit 1', () => {
    const r = runWrapper([
      '--report-path',
      FIX('jscpd-report-order-flip.json'),
      '--allow-pair',
      'packages/X.ts::packages/Z.ts',
    ]);
    expect(r.status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) wrapper internal error (T-011 anchor)
// ---------------------------------------------------------------------------

describe('wrapper internal error (T-011 anchor)', () => {
  it('missing report file -> exit 2 + structured [reason] / [rerun] / [hint]', () => {
    const r = runWrapper(['--report-path', FIX('does-not-exist.json')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\[reason\]\s+dup-check:\s+wrapper internal error/);
    expect(r.stderr).toMatch(/\[rerun\]\s+pnpm dup-check/);
    expect(r.stderr).toMatch(/\[hint\]/);
  });

  it('JSON parse error -> exit 2 + structured stderr', () => {
    // The wrapper itself is not JSON; pointing --report-path at it forces
    // JSON.parse to throw, which the wrapper catches and surfaces as exit 2.
    const r = runWrapper(['--report-path', WRAPPER]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/\[reason\]\s+dup-check:\s+wrapper internal error/);
  });
});

// ---------------------------------------------------------------------------
// AC-22: JSON report path stdout passthrough (D-P6 candidate b)
// ---------------------------------------------------------------------------

describe('AC-22 / D-P6: JSON report path stdout self-discovery', () => {
  it('PASS path mentions the JSON report path on a stdout/stderr stream', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-pass.json')]);
    expect(r.status).toBe(0);
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).toMatch(/JSON report saved to .*jscpd-report-pass\.json/);
  });

  it('FAIL path also mentions the JSON report path (self-discovery survives FAIL)', () => {
    const r = runWrapper(['--report-path', FIX('jscpd-report-single.json')]);
    expect(r.status).toBe(1);
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).toMatch(/JSON report saved to .*jscpd-report-single\.json/);
  });
});

// ---------------------------------------------------------------------------
// AC-20: source code does not contain soft-fail / continue-on-error
// escape hatches. Static gate; lives in the test suite so a CI run flags
// any future regression.
// ---------------------------------------------------------------------------

describe('AC-20: hard-fail invariant (static source scan)', () => {
  it('wrapper source contains no || true / continue-on-error / soft-fail / allow-fail', () => {
    const src = readFileSync(WRAPPER, 'utf8');
    expect(src).not.toMatch(/\|\|\s*true\b/);
    expect(src).not.toMatch(/continue-on-error/);
    expect(src).not.toMatch(/soft-fail/);
    expect(src).not.toMatch(/allow-fail/);
  });
});
