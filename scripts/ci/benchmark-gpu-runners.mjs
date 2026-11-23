#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const ageLimit = 7 * 24 * 60 * 60 * 1000;
const stepBySuite = {
  browser: 'Vitest browser project (RHI/engine API integration — shard)',
  dawn: 'Vitest dawn project (real GPU — *.dawn.test.ts)',
};

function isSuccessfulCandidateRun(run, head) {
  return (
    run.head_sha === head &&
    run.event === 'pull_request' &&
    run.path?.split('@')[0] === '.github/workflows/ci.yml' &&
    run.status === 'completed' &&
    run.conclusion === 'success'
  );
}

function sample(run, job, head, name, now) {
  const suite = name.startsWith('vitest-browser-') ? 'browser' : 'dawn';
  const step = job.steps?.find(({ name }) => name === stepBySuite[suite]);
  const started = Date.parse(job.started_at);
  const queued = Date.parse(job.created_at);
  const completed = Date.parse(job.completed_at);
  const execution = Date.parse(step?.completed_at) - Date.parse(step?.started_at);
  if (
    !isSuccessfulCandidateRun(run, head) ||
    job.name !== name ||
    job.status !== 'completed' ||
    job.conclusion !== 'success' ||
    job.head_sha !== head ||
    job.run_id !== run.id ||
    job.run_attempt !== run.run_attempt ||
    !job.labels?.includes('heavy') ||
    !job.runner_name ||
    step?.conclusion !== 'success' ||
    !(execution > 0 && started >= queued && completed >= started && now >= completed) ||
    now - completed > ageLimit
  )
    return undefined;
  return { runner: job.runner_name, queueMs: started - queued, executionMs: execution };
}

export function benchmarkGpuRunners(runs, { head, name, budgetMs, now = Date.now() }) {
  const byRunner = new Map();
  for (const { run, jobs } of new Map(runs.map((row) => [row.run.id, row])).values()) {
    const candidates = jobs.filter((job) => job.name === name);
    const evidence = candidates.length === 1 && sample(run, candidates[0], head, name, now);
    if (!evidence) continue;
    const rows = byRunner.get(evidence.runner) ?? [];
    rows.push(evidence);
    byRunner.set(evidence.runner, rows);
  }
  return [...byRunner.entries()]
    .map(([runner, rows]) => {
      const p95 = (values) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
      const executionP95Ms = p95(rows.map(({ executionMs }) => executionMs));
      const queueP95Ms = p95(rows.map(({ queueMs }) => queueMs));
      return {
        runner,
        count: rows.length,
        executionP95Ms,
        queueP95Ms,
        qualified: rows.length >= 2 && executionP95Ms <= budgetMs,
      };
    })
    .sort((a, b) => a.executionP95Ms - b.executionP95Ms);
}

function main() {
  const [repo, head, name, budget, ...ids] = process.argv.slice(2);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') ||
    !/^[0-9a-f]{40}$/.test(head ?? '') ||
    !/^vitest-(?:browser-shard-[0-3]|dawn-[1-4]-of-4)$/.test(name ?? '') ||
    !/^\d+$/.test(budget ?? '') ||
    !Number.isSafeInteger(Number(budget) * 1000) ||
    Number(budget) <= 0 ||
    ids.length === 0 ||
    ids.length > 20 ||
    ids.some((id) => !/^\d+$/.test(id))
  )
    throw new Error(
      'usage: benchmark-gpu-runners.mjs OWNER/REPO HEAD JOB BUDGET_SECONDS RUN_ID...',
    );
  const get = (endpoint) =>
    JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 10_000 }));
  const runs = [...new Set(ids)].map((id) => {
    const url = `repos/${repo}/actions/runs/${id}`;
    const run = get(url);
    return { run, jobs: get(`${url}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs };
  });
  console.log(
    JSON.stringify(
      benchmarkGpuRunners(runs, { head, name, budgetMs: Number(budget) * 1000 }),
      null,
      2,
    ),
  );
}

if (import.meta.main) main();
