// dispatch-bench.test.mjs (M3 w11) - dispatchBench retry-once unit test.
//
// Drives the implementation of scripts/metrics/run-all.mjs `dispatchBench`
// (M3 w12) via TDD. Three fixture scenarios exercise the bench-result.json
// autodetect + retry-exactly-once state machine (plan-strategy K-6 + AC-09):
//
//   (i)   missing bench-result.json + spawn success simulator ->
//         dispatchBench returns status='ok', spawn call count == 1
//   (ii)  missing bench-result.json + spawn failure simulator ->
//         dispatchBench returns status='unavailable' (top aggregator turns
//         to 'metric-status-not-ok'), spawn call count == 1
//   (iii) existing bench-result.json ->
//         spawn NOT invoked (autodetect only kicks in for missing scenario)
//
// Design (plan-strategy K-6 + plan-tasks w12 description):
//   `dispatchBench(_pkgName, pkgRoot, decl, { spawnFn })` accepts an optional
//   `spawnFn` injection hook. When omitted it defaults to node:child_process
//   spawnSync; the test injects a `vi.fn()` spy to count invocations + force
//   exit-code outcomes. Function-local retry counter guarantees the spawn
//   happens at most once per dispatch (charter proposition 4 explicit failure
//   over hidden retries).
//
// Reference:
//   - requirements §AC-09 (round 2 explicit retry semantics)
//   - research §Finding 9 (dispatchBench seam + spawn semantics + pnpm filter
//     call shape)
//   - plan-strategy §2 K-6 (inline retry + function-local counter) + §4.1 TDD
//     stance (a) + §4.2 unit layer + OQ-2 landing candidate

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchBench, METRIC_KINDS } from '../run-all.mjs';

let pkgRoot;

beforeEach(() => {
  pkgRoot = mkdtempSync(`${tmpdir()}/forgeax-dispatch-bench-`);
});

afterEach(() => {
  if (pkgRoot && existsSync(pkgRoot)) {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
});

function writeBenchResult(root, json) {
  const path = resolve(root, 'bench-result.json');
  writeFileSync(path, JSON.stringify(json), 'utf8');
  return path;
}

function fakeBenchPayload(medianMs) {
  return {
    files: [
      {
        filepath: 'src/foo.bench.ts',
        groups: [
          {
            fullName: 'micro suite',
            benchmarks: [{ median: medianMs }],
          },
        ],
      },
    ],
  };
}

describe('dispatchBench retry-once semantics (M3 w11 / K-6 / AC-09)', () => {
  it('exposes all five metric kinds to the dispatcher contract', () => {
    expect(METRIC_KINDS).toHaveLength(5);
    expect(new Set(METRIC_KINDS)).toEqual(
      new Set(['bundle-size', 'fps', 'bench', 'gate', 'spike-report']),
    );
  });

  it('(i) missing artefact + spawn success -> status=ok, spawn called exactly once', () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      // Simulator: pretend the spawned pnpm command produced bench-result.json
      writeBenchResult(pkgRoot, fakeBenchPayload(0.001));
      return { status: 0, stdout: '', stderr: '' };
    });
    const decl = { enabled: true };
    const result = dispatchBench('math', pkgRoot, decl, { spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn.mock.calls[0][0]).toBe('pnpm');
    expect(spawnFn.mock.calls[0][1]).toEqual(['-F', '@forgeax/engine-math', 'bench:json']);
    expect(result.kind).toBe('bench');
    expect(result.status).toBe('ok');
    expect(typeof result.value).toBe('number');
  });

  it('(ii) missing artefact + spawn failure -> status=unavailable, spawn called exactly once', () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      // Simulator: pnpm exits non-zero, bench-result.json never appears
      return { status: 1, stdout: '', stderr: 'mock bench failure' };
    });
    const decl = { enabled: true };
    const result = dispatchBench('math', pkgRoot, decl, { spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe('bench');
    expect(result.status).toBe('unavailable');
    expect(result.details.spawnExit).not.toBe(0);
  });

  it('(iii) existing artefact -> spawn NOT invoked (autodetect skipped)', () => {
    writeBenchResult(pkgRoot, fakeBenchPayload(0.002));
    const spawnFn = vi.fn();
    const decl = { enabled: true };
    const result = dispatchBench('math', pkgRoot, decl, { spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(spawnFn).toHaveBeenCalledTimes(0);
    expect(result.kind).toBe('bench');
    expect(result.status).toBe('ok');
  });

  it('dispatches the package that owns the missing benchmark artefact', () => {
    const spawnFn = vi.fn().mockImplementation(() => {
      writeBenchResult(pkgRoot, fakeBenchPayload(0.001));
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = dispatchBench('engine-vfx', pkgRoot, { enabled: true }, { spawnFn });

    expect(spawnFn.mock.calls[0][1]).toEqual(['-F', '@forgeax/engine-vfx', 'bench:json']);
    expect(result.status).toBe('ok');
  });

  it('(iv) default spawn injection - dispatchBench exported with optional spawnFn parameter', () => {
    // Structural assertion: importing dispatchBench from run-all.mjs works and
    // accepts the (_pkgName, pkgRoot, decl, opts?) signature shape. Without
    // injecting a spawnFn the dispatcher must still operate as a pure
    // dispatcher (no crash on signature mismatch).
    expect(typeof dispatchBench).toBe('function');
    expect(dispatchBench.length).toBeGreaterThanOrEqual(3);
    // Sanity round-trip: invoking with existing artefact + no opts uses the
    // real spawnSync default but is short-circuited by the artefact check.
    writeBenchResult(pkgRoot, fakeBenchPayload(0.003));
    const decl = { enabled: true };
    const result = dispatchBench('math', pkgRoot, decl);
    expect(result.kind).toBe('bench');
    expect(result.status).toBe('ok');
    // spawnSync exists in this scope to prove the test file does not depend
    // on the injection hook in the success path (charter proposition 5
    // consistent abstraction: default path = production path).
    expect(typeof spawnSync).toBe('function');
  });
});
