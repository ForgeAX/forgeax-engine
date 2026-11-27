import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkGpuRunners } from '../benchmark-gpu-runners.mjs';

test('GPU routing evidence needs two recent original executions of the same workload', () => {
  const head = 'a'.repeat(40);
  const name = 'vitest-browser-shard-0';
  const now = Date.parse('2026-11-21T09:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const row = (id, { executed = true, sha = head, old = false, execution = 1000 } = {}) => {
    const done = old ? now - 8 * 86_400_000 : now - 100;
    return {
      run: {
        id,
        head_sha: sha,
        event: 'pull_request',
        path: '.github/workflows/ci.yml',
        status: 'completed',
        conclusion: 'success',
        run_attempt: 1,
      },
      jobs: [
        {
          name,
          head_sha: sha,
          run_id: id,
          run_attempt: 1,
          status: 'completed',
          conclusion: 'success',
          runner_name: 'runner',
          labels: ['heavy'],
          created_at: iso(done - execution - 100),
          started_at: iso(done - execution),
          completed_at: iso(done),
          steps: [
            {
              name: 'Vitest browser project (RHI/engine API integration — shard)',
              conclusion: executed ? 'success' : 'skipped',
              started_at: iso(done - execution),
              completed_at: iso(done),
            },
          ],
        },
      ],
    };
  };
  const options = { head, name, budgetMs: 1200, now };
  const first = row(1);
  assert.deepEqual(
    benchmarkGpuRunners(
      [
        first,
        first,
        row(2, { executed: false }),
        row(3, { sha: 'b'.repeat(40) }),
        row(4, { old: true }),
        row(5, { execution: 1100 }),
      ],
      options,
    ),
    [{ runner: 'runner', count: 2, executionP95Ms: 1100, queueP95Ms: 100, qualified: true }],
  );
  assert.equal(benchmarkGpuRunners([first, first], options)[0].qualified, false);
  assert.equal(
    benchmarkGpuRunners([first, row(6, { execution: 1300 })], options)[0].qualified,
    false,
  );
});
