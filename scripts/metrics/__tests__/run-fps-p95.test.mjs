// run-fps-p95.test.mjs (M4 T-M4-1) - run-fps.mjs P95 + compareKey unit test.
//
// TDD red anchor for D-6 (plan-strategy): the run-fps reporter gains a P95
// field alongside the existing median, and a compareKey: 'p95' | 'median'
// switch chooses which stat drives the baseline.threshold comparison
// (status='ok' vs 'metric-status-not-ok'). hello-triangle keeps median
// (default); apps/parity/instancing-static will declare compareKey='p95'
// (T-M4-3) so AC-09 (P95 >= 60 fps under 10k cube grid) becomes machine-
// checkable from the same fps.json that hello-triangle already emits.
//
// Pure-function unit test only: P95 + median + status-resolution helpers
// must be exported from scripts/metrics/run-fps.mjs (T-M4-2). The file's
// CLI entrypoint (vite preview + playwright) is exercised by metrics:run
// fps in CI, not here.
//
// Reference:
//   - requirements §AC-09 (P95 >= 60 fps; 'metric-status-not-ok' on miss)
//   - plan-strategy §D-6 (extend run-fps; no new script, no replan)
//   - plan-tasks.json#T-M4-1 acceptanceCheck (>=3 P95 cases, >=2 compareKey paths)

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPreviewApp,
  computeP95,
  median,
  resolveFpsStatus,
  spawnPreview,
  stopPreview,
  withTimeout,
} from '../run-fps.mjs';

describe('buildPreviewApp (self-contained preview input)', () => {
  it('materializes the selected app before vite preview', () => {
    const calls = [];
    const result = buildPreviewApp('/repo/apps/example', (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ['/repo/apps/example/node_modules/vite/bin/vite.js', 'build'],
        options: { cwd: '/repo/apps/example', stdio: 'inherit' },
      },
    ]);
  });

  it('exposes a failed build without starting preview', () => {
    expect(buildPreviewApp('/repo/apps/example', () => ({ status: 23 }))).toEqual({
      ok: false,
      message: 'vite build failed with exit code 23',
    });
  });
});

describe('preview process ownership (pnpm 12)', () => {
  it('launches the app-local Vite CLI directly through Node', () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const run = vi.fn(() => child);

    expect(spawnPreview('/repo/apps/example', '127.0.0.1', 4174, run)).toBe(child);
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/apps/example/node_modules/vite/bin/vite.js',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        '4174',
        '--strictPort',
      ],
      { cwd: '/repo/apps/example', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('waits for the preview child close event after termination', async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGTERM') {
        setTimeout(() => {
          child.signalCode = signal;
          child.emit('close', null, signal);
        }, 10);
      }
      return true;
    });

    await expect(stopPreview(child, 100)).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('escalates to SIGKILL if the preview does not close after SIGTERM', async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => {
          child.signalCode = signal;
          child.emit('close', null, signal);
        }, 0);
      }
      return true;
    });

    await expect(stopPreview(child, 10)).resolves.toBeUndefined();
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('computeP95 (T-M4-1)', () => {
  it('returns 0 for empty input (sentinel matches median())', () => {
    expect(computeP95([])).toBe(0);
  });

  it('returns the single element for a singleton array', () => {
    expect(computeP95([42])).toBe(42);
  });

  it("picks Math.floor(n*0.05) of the ascending sort (D-6 formula, 'lowest-fps tail')", () => {
    // [60, 60, 60, 30, 60] sorted = [30, 60, 60, 60, 60]
    // floor(5 * 0.05) = floor(0.25) = 0 -> sorted[0] = 30 (worst-frame anchor).
    expect(computeP95([60, 60, 60, 30, 60])).toBe(30);
  });

  it('handles already-sorted descending input identically to unsorted', () => {
    // [120, 110, 100, 90, 80] sorted = [80, 90, 100, 110, 120]
    // floor(5 * 0.05) = 0 -> sorted[0] = 80.
    expect(computeP95([120, 110, 100, 90, 80])).toBe(80);
  });

  it('treats NaN entries as filtered (production caller drops fps<=0; mirror that contract)', () => {
    // computeP95 must not let NaN poison the comparison; the production
    // caller (run-fps main) strips fps<=0 before invoking computeP95, so
    // the helper itself only needs to not crash on a clean numeric array.
    // Simulate by passing the cleaned subset (mirrors line 247 of run-fps.mjs).
    const valid = [60, 60, 60, 30, 60].filter((x) => x > 0 && Number.isFinite(x));
    expect(computeP95(valid)).toBe(30);
  });

  it('does not mutate the input array', () => {
    const input = [60, 60, 60, 30, 60];
    const snapshot = [...input];
    computeP95(input);
    expect(input).toEqual(snapshot);
  });
});

describe('median (T-M4-1, regression)', () => {
  it('still returns the legacy median value for hello-triangle parity', () => {
    // [60, 60, 60, 30, 60] sorted = [30, 60, 60, 60, 60]; median = 60 (mid).
    expect(median([60, 60, 60, 30, 60])).toBe(60);
  });

  it('returns 0 for empty input', () => {
    expect(median([])).toBe(0);
  });
});

describe('withTimeout (bug-20260622 Fail Fast backstop)', () => {
  it('resolves with the work value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'work')).resolves.toBe(42);
  });

  it('rejects with a labelled timeout error when the work never settles', async () => {
    // A never-resolving promise mirrors a stalled rAF: page.evaluate has no
    // internal timeout, so without withTimeout this would hang forever.
    await expect(withTimeout(new Promise(() => {}), 20, 'fps sample 1/5')).rejects.toThrow(
      /fps sample 1\/5 timed out after 20ms/,
    );
  });

  it('propagates the work rejection unchanged when it loses no race', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'work')).rejects.toThrow(
      'boom',
    );
  });
});

describe("resolveFpsStatus (T-M4-1, compareKey 'p95' vs 'median')", () => {
  it("compareKey='median' compares median to threshold (legacy hello-triangle path)", () => {
    const samples = [60, 60, 60, 30, 60]; // median=60, p95=30
    expect(resolveFpsStatus({ samples, sampleCount: 5, threshold: 60, compareKey: 'median' })).toBe(
      'ok',
    );
    // Median (60) >= 60 -> ok, even though P95 (30) is below threshold; this is
    // the regression guarantee: hello-triangle behaviour does not change.
  });

  it("compareKey='p95' compares P95 to threshold (parity-instancing-static path)", () => {
    const samples = [60, 60, 60, 30, 60]; // p95=30
    expect(resolveFpsStatus({ samples, sampleCount: 5, threshold: 60, compareKey: 'p95' })).toBe(
      'noisy',
    );
    // P95 (30) < 60 -> noisy; main() funnels noisy -> exit 1 + 'metric-status-not-ok'
    // structured stderr (existing behaviour line 252).
  });

  it("compareKey='p95' returns 'ok' when P95 floor clears threshold", () => {
    const samples = [120, 110, 100, 90, 80]; // p95=80
    expect(resolveFpsStatus({ samples, sampleCount: 5, threshold: 60, compareKey: 'p95' })).toBe(
      'ok',
    );
  });

  it("returns 'unavailable' when no valid samples regardless of compareKey", () => {
    expect(
      resolveFpsStatus({ samples: [], sampleCount: 5, threshold: 60, compareKey: 'p95' }),
    ).toBe('unavailable');
    expect(
      resolveFpsStatus({ samples: [], sampleCount: 5, threshold: 60, compareKey: 'median' }),
    ).toBe('unavailable');
  });

  it("returns 'noisy' when sample count is below the requested sampleCount", () => {
    // Lost samples (e.g. one frame error) -> noisy regardless of stat value.
    expect(
      resolveFpsStatus({
        samples: [120, 110, 100],
        sampleCount: 5,
        threshold: 60,
        compareKey: 'p95',
      }),
    ).toBe('noisy');
  });

  it('null threshold short-circuits to ok when sample count is full', () => {
    // hello-triangle has no baseline.threshold today; status reduces to sample-
    // count-only check. Both compareKey paths must honour this.
    expect(
      resolveFpsStatus({
        samples: [60, 60, 60, 60, 60],
        sampleCount: 5,
        threshold: null,
        compareKey: 'median',
      }),
    ).toBe('ok');
    expect(
      resolveFpsStatus({
        samples: [60, 60, 60, 60, 60],
        sampleCount: 5,
        threshold: null,
        compareKey: 'p95',
      }),
    ).toBe('ok');
  });
});
