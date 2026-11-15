import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function declaration(body, key) {
  const lines = String(body ?? '').split(/\r?\n/).filter(line => line.startsWith(`${key}:`));
  return lines.length === 1 ? lines[0].slice(key.length + 1).trim() : undefined;
}

const browserNames = Array.from({ length: 4 }, (_, shard) => `browser (${shard})`);
const suiteNames = ['architecture', 'build', ...browserNames, 'bootstrap'];
const reusableNames = new Set(['architecture', 'build', ...browserNames]);
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const ancestral = comparison => ['ahead', 'identical'].includes(comparison.status);

function freshChecks(body) {
  const lines = String(body ?? '').split(/\r?\n/).filter(line => line.startsWith('CI-Repair-Rerun:'));
  if (lines.length === 0) return new Set();
  if (lines.length !== 1) throw new Error('CI-Repair-Rerun requires exactly one declaration');
  const names = lines[0].slice('CI-Repair-Rerun:'.length).split(',').map(name => name.trim());
  if (names.some(name => !reusableNames.has(name)) || new Set(names).size !== names.length)
    throw new Error('CI-Repair-Rerun requires unique exact architecture, build or browser check names');
  return new Set(names);
}

async function qualifiedRun(run, repository, pr, request) {
  if (run.repository?.full_name !== repository || run.event !== 'pull_request' ||
    run.status !== 'completed' || run.path !== '.github/workflows/ci.yml' || !isSha(run.head_sha))
    return false;
  if (run.pull_requests?.some(candidate => candidate.number === pr.number)) return true;
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 0 ||
    run.head_repository?.full_name !== repository || !pr.head?.ref || run.head_branch !== pr.head.ref)
    return false;
  // GitHub clears merged run memberships. Only an empty list can use the same
  // source repository/branch and an independently confirmed commit association.
  const associated = await request(`/commits/${run.head_sha}/pulls`);
  return associated.some(candidate => candidate.number === pr.number &&
    candidate.head?.repo?.full_name === repository && candidate.head?.ref === pr.head.ref);
}

async function mergedQualification(event, repository, request) {
  if (event.ref !== 'refs/heads/main' || !isSha(event.after)) return undefined;
  const prs = await request(`/commits/${event.after}/pulls`);
  const pr = prs.find(candidate => candidate.merged_at && candidate.merge_commit_sha === event.after &&
    candidate.base?.ref === 'main' && candidate.head?.repo?.full_name === repository);
  if (!pr || !isSha(pr.head.sha)) return undefined;
  const [merged, source] = await Promise.all([
    request(`/commits/${event.after}`), request(`/commits/${pr.head.sha}`),
  ]);
  if (!isSha(merged.commit?.tree?.sha) || merged.commit.tree.sha !== source.commit?.tree?.sha)
    return undefined;
  const runs = await request(`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`);
  if (runs.total_count > 100) throw new Error('Post-merge qualification requires complete run history');
  const run = runs.workflow_runs.find(candidate => candidate.repository?.full_name === repository &&
    candidate.event === 'pull_request' && candidate.head_sha === pr.head.sha);
  // The API returns newest first. A later failure or pending attempt blocks
  // promotion even if an older run at that head succeeded.
  return run?.conclusion === 'success' && await qualifiedRun(run, repository, pr, request)
    ? { pr, run } : undefined;
}

async function jobOrigin(run, job, repository, pr, request) {
  const name = job.name;
  const visited = new Set();
  for (let depth = 0; depth < 16; depth++) {
    const key = `${run.id}:${job.id}`;
    if (visited.has(key)) throw new Error('CI provenance cycle');
    visited.add(key);
    const prefix = `Reuse ${name}: `;
    const step = job.steps?.find(step => step.conclusion === 'success' && step.name.startsWith(prefix));
    if (!step) return `run ${run.id} job ${job.id} source ${run.head_sha}`;
    const inherited = /^run (\d+) job (\d+) source ([0-9a-f]{40})$/.exec(step.name.slice(prefix.length));
    if (!inherited) throw new Error('Malformed inherited CI provenance');
    const [originalRun, originalJob] = await Promise.all([
      request(`/actions/runs/${inherited[1]}`), request(`/actions/jobs/${inherited[2]}`),
    ]);
    if (!await qualifiedRun(originalRun, repository, pr, request) || originalRun.head_sha !== inherited[3] ||
      originalJob.run_id !== originalRun.id || originalJob.name !== name || originalJob.conclusion !== 'success')
      throw new Error('Inherited CI provenance failed qualification');
    if (!ancestral(await request(`/compare/${originalRun.head_sha}...${pr.head.sha}`)))
      throw new Error('Inherited source must be ancestral');
    run = originalRun;
    job = originalJob;
  }
  throw new Error('CI provenance depth exceeded');
}

/** Preserve executed provenance for repairs and identical-tree main promotion. */
export async function ciContext(event, repository, request) {
  const merged = event.pull_request ? undefined : await mergedQualification(event, repository, request);
  const pr = event.pull_request ?? merged?.pr;
  const engine = declaration(pr?.body, 'Engine-Revision');
  if (engine !== undefined && !isSha(engine)) throw new Error('Engine-Revision must be one full commit SHA');
  // The final green exact-tree PR run has already consumed its fresh declarations.
  const fresh = event.pull_request ? freshChecks(pr.body) : new Set();
  const result = {
    engine_ref: engine ?? 'main', architecture_reused: 'false', architecture_origin: '',
    build_origin: '', build_artifact_run: '', browser_origins: JSON.stringify(Object.fromEntries(browserNames.map((_, shard) => [shard, '']))),
    view_shards: JSON.stringify(browserNames.map((_, shard) => shard)),
  };
  const anchor = declaration(pr?.body, 'CI-Repair-From');
  if (!merged && (pr === undefined || anchor === undefined || !/^\d+$/.test(anchor))) return result;
  const run = merged?.run ?? await request(`/actions/runs/${anchor}`);
  if (!await qualifiedRun(run, repository, pr, request)) throw new Error('CI repair requires a completed run from this PR');
  if (!ancestral(await request(`/compare/${run.head_sha}...${pr.head.sha}`)))
    throw new Error('CI repair source must be ancestral');
  const history = await request(`/actions/runs/${run.id}/jobs?per_page=100`);
  if (history.total_count > 100 || history.total_count !== history.jobs.length)
    throw new Error('CI repair requires complete job history');
  const find = name => history.jobs.filter(job => job.name === name);
  const architecture = find('architecture');
  if (!fresh.has('architecture') && architecture.length === 1 && architecture[0].conclusion === 'success') {
    result.architecture_reused = 'true';
    result.architecture_origin = await jobOrigin(run, architecture[0], repository, pr, request);
  }
  if (merged && suiteNames.some(name =>
    find(name).length !== 1 || find(name)[0].conclusion !== 'success')) return result;
  const origin = async name => {
    const matching = find(name);
    return !fresh.has(name) && matching.length === 1 && matching[0].conclusion === 'success'
      ? jobOrigin(run, matching[0], repository, pr, request) : '';
  };
  result.build_origin = await origin('build');
  const origins = JSON.parse(result.browser_origins);
  for (const [shard, name] of browserNames.entries())
    origins[shard] = await origin(name);
  result.browser_origins = JSON.stringify(origins);
  // Fresh browsers borrow the build's exact Engine SHA, never a floating branch.
  if (!isSha(engine) && Object.values(origins).some(value => value === '')) result.build_origin = '';
  if (result.build_origin && Object.values(origins).some(value => value === '')) {
    const [, originalRun, originalSource] = /^run (\d+) job \d+ source ([0-9a-f]{40})$/.exec(result.build_origin);
    let artifacts;
    try {
      artifacts = await request(`/actions/runs/${originalRun}/artifacts?per_page=100`);
    } catch {
      console.warn('Original build artifacts could not be verified; a fresh build is required');
      result.build_origin = '';
      return result;
    }
    if (artifacts.total_count > 100 || artifacts.total_count !== artifacts.artifacts.length)
      throw new Error('CI repair requires complete build artifact history');
    const matching = artifacts.artifacts.filter(artifact => artifact.name === 'paired-shader-inputs');
    if (matching.length === 1 && matching[0].expired === false && matching[0].size_in_bytes > 0 &&
      matching[0].workflow_run?.id === Number(originalRun) && matching[0].workflow_run.head_sha === originalSource)
      result.build_artifact_run = originalRun;
    else result.build_origin = '';
  }
  return result;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const request = async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`CI provenance request failed: HTTP ${response.status}`);
    return response.json();
  };
  const context = await ciContext(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), repository, request);
  for (const [key, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Paired Engine declaration: ${context.engine_ref}\n\nArchitecture: ${context.architecture_origin || 'fresh execution'}\n\nBuild: ${context.build_origin || 'fresh execution'}\n\nBrowser origins: ${context.browser_origins}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
